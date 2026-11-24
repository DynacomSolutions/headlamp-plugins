import { randomUUID } from 'node:crypto';
import { investigate, publicQuestion, raiseScanQuestion } from './findings.js';
import { itemViews, scanIsFresh, updateCleanupNotice, type StorageNotice } from './inventory.js';
import { PARTIAL_CLEANUP, type StorageApply } from './apply.js';
import type { StorageNotifications } from './notifications.js';
import type { StorageQueries, StorageStore } from './store.js';
import { clean, StorageError, type Chat, type ChatTranscript, type Checkpoint, type Child, type Decision, type DecisionRequest, type DriveState, type Evidence, type Investigation, type Question } from './types.js';

const CHAT_TAIL = 24;
const COMPACT_AT = 48;
const CHECKPOINT_ENTRIES = 16;
const CHECKPOINT_TEXT_CHARS = 280;

function checkpointIds(ids: string[], recent: (string[] | undefined)[]): string[] {
  return [...new Set([...ids.slice(-CHECKPOINT_ENTRIES), ...recent.flatMap(entry => entry ?? [])])].slice(-CHECKPOINT_ENTRIES);
}

async function checkpointContext(tx: StorageQueries, evidenceIds: string[], questionIds: string[]) {
  const [evidence, decisions, questions, receipts] = await Promise.all([
    tx.checkpointRecords<Evidence>('evidence', CHECKPOINT_ENTRIES, evidenceIds),
    tx.checkpointRecords<Decision>('decision', CHECKPOINT_ENTRIES),
    tx.checkpointRecords<Question>('question', CHECKPOINT_ENTRIES, questionIds),
    tx.checkpointReceipts(CHECKPOINT_ENTRIES),
  ]);
  return {
    evidence: evidence.map(({ id, driveId, kind, snapshotId, summary }) =>
      ({ id, driveId, kind, snapshotId, summary: summary.slice(0, CHECKPOINT_TEXT_CHARS) })),
    decisions: decisions.map(({ id, driveId, itemId, decision, until, createdAt }) =>
      ({ id, driveId, itemId, decision, until, createdAt })),
    questions: questions.map(({ id, driveId, text, answer }) =>
      ({ id, driveId, text: text.slice(0, CHECKPOINT_TEXT_CHARS), answer: answer?.slice(0, CHECKPOINT_TEXT_CHARS) })),
    receipts: receipts.map(({ id, driveId, itemId, status, reason, bytes }) =>
      ({ id, driveId, itemId, status, reason: reason.slice(0, CHECKPOINT_TEXT_CHARS), bytes })),
  };
}

export class StorageIncident {
  constructor(private readonly deps: {
    store: StorageStore;
    apply: StorageApply;
    notifications: StorageNotifications;
    now: () => number;
    nodes: string[];
  }) {}

  private viewDrive(state: Omit<DriveState, 'items'>, complete: boolean, now: number) {
    if (!complete || !scanIsFresh(state, now)) {
      return { ...state.drive, status: 'incomplete' as const, complete: false, applyEnabled: false, eligibleCount: 0 };
    }
    return { ...state.drive, applyEnabled: this.deps.apply.permitted(state) };
  }

  async parent() {
    const { store, notifications, nodes } = this.deps;
    const now = this.deps.now();
    const [incident, states, notices, coverage, scanStates] = await Promise.all([
      store.parent(), store.driveSummaries(), store.list<StorageNotice>('notice'), notifications.coverage(),
      store.scanStates(nodes, now),
    ]);
    const scans = scanStates.map(({ node, status, completedAt }) => ({ node, status, completedAt }));
    const completeNodes = new Set(scans.filter(scan => scan.status === 'complete').map(scan => scan.node));
    return {
      enabled: true,
      applyEnabled: this.deps.apply.enabled,
      incident,
      drives: states.map(state => this.viewDrive(state, completeNodes.has(state.drive.node), now)),
      notices: await notifications.project(notices, incident.chatId),
      notifications: coverage,
      scans,
    };
  }

  async drive(id: string) {
    return this.deps.store.transaction(async tx => {
      const state = await this.findDrive(tx, id);
      const history = await tx.history(id);
      const evidence = await tx.list<Evidence>('evidence', id);
      const decisions = await tx.list<Decision>('decision', id);
      const questions = await tx.list<Parameters<typeof publicQuestion>[0]>('question', id);
      const children = await tx.list<Child>('child', id);
      const receipts = await tx.driveReceipts(id);
      const plans = await tx.plans(id);
      const now = this.deps.now();
      const { status } = await tx.scanState(state.drive.node, now);
      const complete = status === 'complete' && scanIsFresh(state, now);
      const current = complete ? state.current : { ...state.current, complete: false, eligibleCount: 0 };
      const partial = new Set(receipts.filter(receipt => receipt.status === 'partial').map(receipt => receipt.itemId));
      const items = itemViews(status === 'complete' ? state : { ...state, current }, decisions, now)
        .map(item => partial.has(item.id) ? { ...item, eligible: false, reason: PARTIAL_CLEANUP } : item);
      const eligibleCount = complete ? items.filter(item => item.eligible).length : 0;
      return {
        drive: { ...this.viewDrive(state, complete, now), eligibleCount },
        current: { ...current, eligibleCount },
        history,
        items,
        evidence,
        decisions: decisions.map(({ material: _material, ...decision }) => decision),
        questions: questions.map(publicQuestion),
        children,
        receipts,
        plans: plans.map(plan => plan.public),
      };
    });
  }

  private async findDrive(tx: StorageQueries, id: string, lock = false) {
    const state = await tx.drive(id, lock);
    if (!state) throw new StorageError(404, 'Drive not found');
    return state;
  }

  async investigate(id: string, request: Investigation) {
    const child = await this.deps.store.transaction(async tx =>
      investigate(tx, await this.findDrive(tx, id, true), request, this.deps.now()));
    this.deps.notifications.kick();
    return child;
  }

  async decide(id: string, request: DecisionRequest, actor: string) {
    const result = await this.deps.store.transaction(async tx => {
      const state = await this.findDrive(tx, id, true);
      const at = this.deps.now();
      if (request.until && Date.parse(request.until) <= at) throw new StorageError(400, 'Defer must end in the future');
      const receipts = await tx.cleanupReceipts(id, { id: request.itemId, scannedAt: state.current.scannedAt });
      if (receipts.some(receipt => receipt.data.status === 'removed')) {
        throw new StorageError(409, 'Cleanup already removed this item. Refresh the inventory and check Cleanup receipts.');
      }
      if (receipts.some(receipt => receipt.data.status === 'partial')) {
        throw new StorageError(409, PARTIAL_CLEANUP);
      }
      const dispatched = receipts.find(receipt => receipt.dispatched);
      if (dispatched) {
        throw new StorageError(409, `Cleanup approval ${dispatched.data.approvalId} is already dispatched. Check Cleanup receipts for the final result.`);
      }
      const item = state.items.find(candidate => candidate.id === request.itemId);
      if (!item) throw new StorageError(404, 'Item not found on this drive');
      const decision: Decision = { ...request, id: randomUUID(), by: actor, createdAt: new Date(at).toISOString(), material: item.decisionMaterial };
      await tx.putReceipts(receipts.map(({ data }) => ({
        ...data, status: 'stale', reason: 'An operator changed the cleanup decision before dispatch', updatedAt: decision.createdAt,
      })));
      await tx.insert(id, 'decision', decision);
      const decisions = await tx.list<Decision>('decision', id);
      await updateCleanupNotice(tx, state, decisions, at);
      await raiseScanQuestion(tx, state, decisions, at);
      const { material: _material, ...view } = decision;
      return view;
    });
    this.deps.notifications.kick();
    return result;
  }

  async answer(id: string, text: string, actor: string) {
    return this.deps.store.transaction(async tx => {
      const question = await tx.get<Parameters<typeof publicQuestion>[0]>('question', id, true);
      if (!question) throw new StorageError(404, 'Question not found');
      const answer = clean(text);
      if (!answer) throw new StorageError(400, 'Answer is empty');
      if (question.answer) {
        if (question.answer !== answer || question.answeredBy !== actor) throw new StorageError(409, 'The question already has an answer');
        return publicQuestion(question);
      }
      const result = { ...question, answer, answeredAt: new Date(this.deps.now()).toISOString(), answeredBy: actor };
      await tx.updateRecord('question', result);
      const notice = (await tx.list<StorageNotice>('notice', question.driveId)).find(row => row.questionId === id);
      if (notice) await tx.clearNotice(notice.id);
      return publicQuestion(result);
    });
  }

  async chat(id: string, request?: { text: string; driveId?: string }): Promise<Chat> {
    const { store, now, notifications } = this.deps;
    const result = await store.transaction(async tx => {
      const parent = await tx.parent();
      if (parent.chatId !== id) throw new StorageError(404, 'Storage chat not found');
      await tx.lock('chat');
      const previous = await tx.checkpoint();
      if (request) {
        const at = now();
        const text = clean(request.text);
        if (!text) throw new StorageError(400, 'Message is empty');
        const createdAt = new Date(at).toISOString();
        const kind = /\b(capacity|reserve|space|forecast|growth)\b/i.test(text) ? 'capacity'
          : /\b(eligibility|eligible|keep|defer|cleanup)\b/i.test(text) ? 'eligibility' : 'inventory';
        const child = request.driveId ? await investigate(tx, await this.findDrive(tx, request.driveId, true), { kind }, at) : undefined;
        const drives = child ? [] : await tx.driveSummaries();
        const notices = child ? [] : await tx.list<StorageNotice>('notice');
        const reply = child?.summary ?? `${drives.length} drives are in the inventory. ${notices.filter(n => n.kind === 'question').length} questions need an answer. Select a drive for a capacity, inventory or eligibility investigation.`;
        await tx.addMessage({ id: randomUUID(), role: 'user', text, createdAt });
        await tx.addMessage({
          id: randomUUID(), role: 'assistant', text: reply, createdAt, a2ui: child?.a2ui,
          evidenceIds: child?.evidenceIds, questionIds: child?.questionIds,
        });
      }
      const active = await tx.messages(previous?.through_seq ?? '0');
      const archived = active.length > COMPACT_AT ? active.slice(0, -CHAT_TAIL) : [];
      const last = archived.at(-1);
      let checkpoint: Checkpoint | null = previous?.data ?? null;
      if (last || (checkpoint && !checkpoint.evidence)) {
        const evidenceIds = checkpointIds(previous?.data.evidenceIds ?? [], archived.map(row => row.data.evidenceIds));
        const questionIds = checkpointIds(previous?.data.questionIds ?? [], archived.map(row => row.data.questionIds));
        checkpoint = {
          throughMessageId: last?.data.id ?? previous!.data.throughMessageId,
          messageCount: (previous?.data.messageCount ?? 0) + archived.length,
          evidenceIds,
          questionIds,
          ...await checkpointContext(tx, evidenceIds, questionIds),
        };
        await tx.putCheckpoint(last?.seq ?? previous!.through_seq, checkpoint);
      }
      return { id, messages: active.slice(archived.length).map(row => row.data), checkpoint };
    });
    if (request) notifications.kick();
    return result;
  }

  async transcript(id: string, before: string | undefined, limit: number): Promise<ChatTranscript> {
    const { store } = this.deps;
    if ((await store.parent()).chatId !== id) throw new StorageError(404, 'Storage chat not found');
    const rows = await store.transcript(before, limit + 1);
    if (!rows) throw new StorageError(404, 'Transcript message not found');
    const messages = rows.slice(0, limit).reverse().map(row => row.data);
    return { id, messages, nextBefore: rows.length > limit ? messages[0].id : null };
  }
}
