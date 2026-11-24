import { randomUUID } from 'node:crypto';
import { investigate, publicQuestion, raiseScanQuestion } from './findings.js';
import { itemViews, updateCleanupNotice, type StorageNotice } from './inventory.js';
import type { StorageApply } from './apply.js';
import type { StorageNotifications } from './notifications.js';
import type { StorageQueries, StorageStore } from './store.js';
import { clean, StorageError, type Chat, type Child, type Decision, type DecisionRequest, type DriveState, type Evidence, type Investigation } from './types.js';

const CHAT_TAIL = 24;
const COMPACT_AT = 48;

export class StorageIncident {
  constructor(private readonly deps: {
    store: StorageStore;
    apply: StorageApply;
    notifications: StorageNotifications;
    now: () => number;
  }) {}

  private viewDrive(state: Omit<DriveState, 'items'>) {
    return { ...state.drive, applyEnabled: this.deps.apply.permitted(state) };
  }

  async parent() {
    const { store, notifications } = this.deps;
    const [incident, states, notices, coverage] = await Promise.all([
      store.parent(), store.driveSummaries(), store.list<StorageNotice>('notice'), notifications.coverage(),
    ]);
    return {
      enabled: true,
      applyEnabled: this.deps.apply.enabled,
      incident,
      drives: states.map(state => this.viewDrive(state)),
      notices: await notifications.project(notices, incident.chatId),
      notifications: coverage,
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
      const items = itemViews(state, decisions, this.deps.now());
      return {
        drive: this.viewDrive(state),
        current: state.current,
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
    const at = this.deps.now();
    if (request.until && Date.parse(request.until) <= at) throw new StorageError(400, 'Defer must end in the future');
    const result = await this.deps.store.transaction(async tx => {
      const state = await this.findDrive(tx, id, true);
      const item = state.items.find(candidate => candidate.id === request.itemId);
      if (!item) throw new StorageError(404, 'Item not found on this drive');
      const decision: Decision = { ...request, id: randomUUID(), by: actor, createdAt: new Date(at).toISOString(), material: item.decisionMaterial };
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
      if (active.length <= COMPACT_AT) return { id, messages: active.map(row => row.data), checkpoint: previous?.data ?? null };
      const archived = active.slice(0, -CHAT_TAIL);
      const last = archived.at(-1)!;
      const checkpoint = {
        throughMessageId: last.data.id,
        messageCount: (previous?.data.messageCount ?? 0) + archived.length,
        evidenceIds: [...new Set([...(previous?.data.evidenceIds ?? []), ...archived.flatMap(row => row.data.evidenceIds ?? [])])],
        questionIds: [...new Set([...(previous?.data.questionIds ?? []), ...archived.flatMap(row => row.data.questionIds ?? [])])],
      };
      await tx.putCheckpoint(last.seq, checkpoint);
      return { id, messages: active.slice(-CHAT_TAIL).map(row => row.data), checkpoint };
    });
    if (request) notifications.kick();
    return result;
  }
}
