import { randomUUID } from 'node:crypto';
import { itemViews, scanIsFresh } from './inventory.js';
import type { StorageStore } from './store.js';
import type { Scanner } from './transport.js';
import { clean, MAX_APPROVAL_ITEMS, needsMergeEvidence, StorageError, type Approval, type Check, type Decision, type DriveState, type FrozenPlan, type Plan, type Receipt } from './types.js';

const PLAN_MS = 30 * 60_000;

export class StorageApply {
  private readonly running = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: {
    store: StorageStore;
    scanner: Scanner;
    disposable: ReadonlySet<string>;
    enabled: boolean;
    now: () => number;
  }) {}

  get enabled(): boolean {
    return this.deps.enabled && this.deps.disposable.size > 0;
  }

  permitted(state: Pick<DriveState, 'shared' | 'execution' | 'drive' | 'current'>): boolean {
    return this.enabled && state.current.complete && !state.shared && state.execution === 'disposable' && this.deps.disposable.has(state.drive.node);
  }

  async dryRun(driveId: string): Promise<Plan> {
    const { store, now } = this.deps;
    return store.transaction(async tx => {
      const state = await tx.drive(driveId, true);
      if (!state) throw new StorageError(404, 'Drive not found');
      const at = now();
      const complete = (await tx.scanState(state.drive.node, at)).status === 'complete';
      const current = complete ? state.current : { ...state.current, complete: false };
      const views = itemViews({ ...state, current }, await tx.list<Decision>('decision', driveId), at);
      const plan: Plan = {
        id: randomUUID(),
        driveId,
        createdAt: new Date(at).toISOString(),
        expiresAt: new Date(at + PLAN_MS).toISOString(),
        items: views.map(({ id, category, label, bytes, eligible, reason, mergeEvidence }) => ({
          itemId: id, category, label, bytes, mergeEvidence,
          eligible, reason,
        })),
      };
      const planned = new Map(plan.items.map(item => [item.itemId, item.eligible]));
      await tx.savePlan({
        public: plan,
        node: state.drive.node,
        filesystemId: state.drive.filesystemId,
        checks: state.items.filter(item => planned.get(item.id)).map(item => ({
          itemId: item.id, scannerId: item.scannerId, material: item.material, visibility: item.visibility,
        })),
      });
      return plan;
    });
  }

  async approve(planId: string, subset: string[], actor: string): Promise<{ approval: Approval; receipts: Receipt[] }> {
    const { store, now } = this.deps;
    if (!this.enabled) throw new StorageError(503, 'Storage apply is disabled');
    if (subset.length === 0 || subset.length > MAX_APPROVAL_ITEMS || new Set(subset).size !== subset.length) {
      throw new StorageError(400, `Select between 1 and ${MAX_APPROVAL_ITEMS} distinct items`);
    }
    const itemIds = [...subset].sort();
    const result = await store.transaction(async tx => {
      const plan = await tx.plan(planId, true);
      if (!plan) throw new StorageError(404, 'Plan not found');
      const existing = await tx.approvalFor(planId);
      if (existing) {
        if (existing.by !== actor || existing.itemIds.join(',') !== itemIds.join(',')) throw new StorageError(409, 'The plan already has an approval');
        return { approval: existing, receipts: await tx.receipts(existing.id) };
      }
      const state = await tx.drive(plan.public.driveId, true);
      if (!state || !this.permitted(state)) throw new StorageError(503, 'Storage apply is disabled for this drive');
      const at = now();
      if ((await tx.scanState(state.drive.node, at)).status !== 'complete') {
        throw new StorageError(503, 'Wait for a complete scan before approving cleanup');
      }
      if (Date.parse(plan.public.expiresAt) <= at) throw new StorageError(409, 'The plan expired');
      const selected = new Set(itemIds);
      const planned = plan.public.items.filter(item => selected.has(item.itemId));
      const lacksMergeProof = (item: Pick<Plan['items'][number], 'category' | 'mergeEvidence'>) =>
        needsMergeEvidence(item.category) && item.mergeEvidence !== 'verified';
      if (planned.some(lacksMergeProof) || state.items.some(item => selected.has(item.id) && lacksMergeProof(item))) {
        throw new StorageError(409, 'Merge verification unavailable');
      }
      const checks = new Set(plan.checks.map(check => check.itemId));
      if (planned.length !== itemIds.length || planned.some(item => !item.eligible || !checks.has(item.itemId))) {
        throw new StorageError(409, 'The subset contains an item outside the eligible plan');
      }
      const decisions = await tx.list<Decision>('decision', state.drive.id);
      const allowed = this.revalidate(state, plan, decisions, at);
      const approval: Approval = { id: randomUUID(), planId, driveId: state.drive.id, itemIds, by: actor, createdAt: new Date(at).toISOString() };
      const pending = new Set((await tx.cleanupReceipts(state.drive.id)).map(({ data }) => data.itemId));
      const receipts = itemIds.map((itemId): Receipt => {
        const current = allowed.has(itemId) && !pending.has(itemId);
        return {
          id: randomUUID(), approvalId: approval.id, planId, driveId: state.drive.id, itemId,
          status: current ? 'queued' : 'stale',
          reason: current ? 'Awaiting verified scanner receipt' : 'The item changed or has an active approval',
          bytes: 0, updatedAt: approval.createdAt,
        };
      });
      await tx.putApproval(approval);
      await tx.putReceipts(receipts);
      return { approval, receipts };
    });
    if (result.receipts.some(receipt => receipt.status === 'queued')) void this.run(result.approval.id);
    return result;
  }

  async retryPending(): Promise<boolean> {
    if (!this.enabled) return true;
    const pending = await this.deps.store.pending();
    const result = await Promise.all(pending.map(id => this.run(id)));
    return result.every(Boolean);
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.running.values());
  }

  private run(id: string): Promise<boolean> {
    const existing = this.running.get(id);
    if (existing) return existing;
    const work = this.dispatch(id).catch(() => false).finally(() => this.running.delete(id));
    this.running.set(id, work);
    return work;
  }

  private revalidate(state: DriveState, plan: FrozenPlan, decisions: Decision[], now: number): Set<string> {
    if (!scanIsFresh(state, now) || state.drive.node !== plan.node || state.drive.filesystemId !== plan.filesystemId) return new Set();
    const checks = new Map(plan.checks.map(check => [check.itemId, check]));
    const eligible = new Set(itemViews(state, decisions, now).filter(item => item.eligible).map(item => item.id));
    return new Set(state.items.filter(item => eligible.has(item.id) && checks.get(item.id)?.material === item.material).map(item => item.id));
  }

  private async dispatch(id: string): Promise<boolean> {
    const { store, scanner, now } = this.deps;
    const prepared = await store.transaction(async tx => {
      const stored = await tx.approval(id, true);
      if (!stored) return;
      const { data: approval } = stored;
      // The drive lock serialises the dispatch boundary with operator decisions.
      const state = await tx.drive(approval.driveId, true);
      const queued = (await tx.receipts(id)).filter(receipt => receipt.status === 'queued');
      if (!queued.length) return;
      if (!state || !this.permitted(state)) return { gated: true } as const;
      if (stored.dispatch) {
        const dispatch = stored.dispatch;
        if (dispatch.node !== state.drive.node || dispatch.filesystemId !== state.drive.filesystemId) return { gated: true } as const;
        return { approval, dispatch };
      }
      const plan = await tx.plan(approval.planId);
      if (!plan) return { gated: true } as const;
      const decisions = await tx.list<Decision>('decision', state.drive.id);
      const at = now();
      if ((await tx.scanState(state.drive.node, at)).status !== 'complete') return { gated: true } as const;
      const valid = this.revalidate(state, plan, decisions, at);
      const allowed = new Set(queued.filter(receipt => valid.has(receipt.itemId)).map(receipt => receipt.itemId));
      const checks = plan.checks.filter(check => allowed.has(check.itemId));
      await tx.putReceipts(queued.filter(receipt => !allowed.has(receipt.itemId)).map(receipt => ({
        ...receipt, status: 'stale', reason: 'The item changed before dispatch', updatedAt: new Date(at).toISOString(),
      })));
      if (!checks.length) return;
      const dispatch = { node: plan.node, filesystemId: plan.filesystemId, checks, startedAt: new Date(at).toISOString() };
      await tx.putDispatch(id, dispatch);
      return { approval, dispatch };
    });
    if (!prepared) return true;
    if ('gated' in prepared) return false;

    const { approval, dispatch } = prepared;
    const selected = new Map<string, Check>(dispatch.checks.map(check => [check.scannerId, check]));
    const result = await scanner.apply(dispatch.node, approval.planId, approval.id, [...selected.keys()].sort());
    if (result.node !== dispatch.node || result.approvalId !== id || result.planId !== approval.planId || result.receipts.some(receipt => !selected.has(receipt.itemId))) return false;
    return store.transaction(async tx => {
      await tx.drive(approval.driveId, true);
      const queued = new Map((await tx.receipts(id)).filter(receipt => receipt.status === 'queued').map(receipt => [receipt.itemId, receipt]));
      const updatedAt = new Date(now()).toISOString();
      const verified = result.receipts.flatMap(receipt => {
        const check = selected.get(receipt.itemId)!;
        const previous = queued.get(check.itemId);
        if (!previous) return [];
        const reason = check.visibility === 'jev' ? clean(receipt.reason) : `Scanner reports ${receipt.status}`;
        return [{ ...previous, status: receipt.status, reason, bytes: receipt.bytes, updatedAt }];
      });
      await tx.putReceipts(verified);
      return !(await tx.receipts(id)).some(receipt => receipt.status === 'queued');
    });
  }
}
