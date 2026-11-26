import { randomUUID } from 'node:crypto';
import { mask, maskText } from '../mask.js';
import { chatDiagnosisIds, DEFAULT_TITLE, type Chat, type ChatMessage, type ChatStep, type ChatStore } from '../chats.js';
import type { DiagnosisStore } from '../store.js';
import { ModelCatalogue, UnknownModelError } from './catalogue.js';
import type { ToolHost } from './engine.js';
import type { Message, ToolSpec } from './model.js';
import type { Diagnosis } from './report.js';
import { readSkill } from './skill.js';
import { clip, withReason } from './tools.js';

/** An error with the HTTP status the route answers. */
export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The text of all tool results kept in the history sent to the model. Older results go first. */
const HISTORY_RESULT_CHARS = 120_000;
/** Model calls allowed beyond the tool budget, so the model can still answer once it is spent. */
const EXTRA_ROUNDS = 4;
const TITLE_CHARS = 60;
const REMOVED = '[older tool result removed to keep the history short]';

export interface ChatSummary {
  id: string;
  title: string;
  model: string;
  diagnosisId?: string;
  diagnosisIds?: string[];
  updatedAt: string;
  running: boolean;
}

/** Incidents one chat may link to. */
export const MAX_CHAT_INCIDENTS = 20;
/** Characters of incident context in the system prompt, shared by the linked incidents. */
const CONTEXT_CHARS = 48_000;
const SINGLE_CONTEXT_CHARS = 12_000;
const MIN_CONTEXT_CHARS = 2_400;
/** Incidents of a large group that the prompt lists in one short line each, besides the fully linked ones. */
export const MAX_SUMMARY_INCIDENTS = 500;
/** Characters for the short lines of a large group. Lines that do not fit are counted, not shown. */
const SUMMARY_CHARS = 30_000;
const SUMMARY_LINE_CHARS = 260;

export interface ChatDeps {
  store: ChatStore;
  diagnoses: DiagnosisStore;
  tools: ToolHost;
  catalogue: ModelCatalogue;
  /** Tool calls per turn. */
  budget: number;
  /** Turns that may run at once across chats. */
  maxTurns: number;
  /** Called when an answer is done, with the push subscription of the page that asked (if it named one). Must not throw. */
  onAnswer?: (event: { chatId: string; subscription: string; text: string }) => void;
}

/** Replaces the oldest tool results with a short note until the kept results fit `limit` characters. */
export function trimHistory(messages: Message[], limit = HISTORY_RESULT_CHARS): Message[] {
  const out: Message[] = messages.map(m => (m.role === 'tool' ? { role: 'tool', results: m.results.map(r => ({ ...r })) } : m));
  const results = out.flatMap(m => (m.role === 'tool' ? m.results : []));
  let total = results.reduce((n, r) => n + r.content.length, 0);
  for (const r of results) {
    if (total <= limit) break;
    if (r.content === REMOVED) continue;
    total -= r.content.length - REMOVED.length;
    r.content = REMOVED;
  }
  return out;
}

/** One short line about an incident, for the incidents of a large group that get no full context. */
export function summaryLine(d: Diagnosis): string {
  const cause = d.result?.likelyCause ? ` | cause: ${d.result.likelyCause.replace(/\s+/g, ' ')}` : d.error ? ` | error: ${d.error.replace(/\s+/g, ' ')}` : '';
  const fires = d.fires && d.fires > 1 ? ` | fired ${d.fires} times` : '';
  const where = ['namespace', 'pod', 'node', 'instance'].map(k => (d.alert.labels[k] ? `${k}=${d.alert.labels[k]}` : '')).filter(Boolean).join(' ');
  return clip(`- ${d.id} | ${d.alert.severity || 'unrated'} | ${d.status}${d.resolvedAt ? ', resolved' : ''} | ${d.createdAt}${fires}${where ? ` | ${where}` : ''}${cause}`, SUMMARY_LINE_CHARS);
}

/** A group of incidents that an operator chose as a whole. */
export interface GroupContext {
  /** The alert name of the group. */
  name: string;
  /** The other incidents of the group, newest first. Each gets one short line. */
  summaries: Diagnosis[];
  /** Older incidents of the group that the client left out. They are counted, not listed. */
  omitted?: number;
}

export function systemPrompt(budget: number, diagnosis?: Diagnosis | Diagnosis[], group?: GroupContext): string {
  const parts = [
    readSkill().body,
    [
      '## Chat mode',
      'You are chatting with an operator about this cluster and its incidents. Answer in Markdown, in plain words, and keep it short.',
      `You have the read-only tools. Use them when you need facts, and give each call a \`reason\`. You may make at most ${budget} tool calls for each answer.`,
      'There is no submit_diagnosis tool in this chat: ignore any instruction to call it. Answer in text when you have enough facts.',
      'You cannot change anything. Say so when asked, and show the command or the change for the operator to make.',
    ].join('\n'),
  ];
  const list = diagnosis === undefined ? [] : Array.isArray(diagnosis) ? diagnosis : [diagnosis];
  if (list.length === 1) parts.push(diagnosisContext(list[0]!));
  else if (list.length > 1) {
    const each = Math.max(MIN_CONTEXT_CHARS, Math.floor(CONTEXT_CHARS / list.length));
    parts.push(
      `## The ${list.length} incidents this chat is about\nThe operator chose these incidents together. Compare them, and look for a shared cause, when the question asks for it.`,
      ...list.map((d, i) => diagnosisContext(d, `Incident ${i + 1} of ${list.length}`, each)),
    );
  }
  if (group) {
    const total = list.length + group.summaries.length + (group.omitted ?? 0);
    const lines: string[] = [];
    let used = 0;
    for (const d of group.summaries) {
      const line = summaryLine(d);
      if (used + line.length > SUMMARY_CHARS) break;
      lines.push(line);
      used += line.length + 1;
    }
    const more = group.summaries.length - lines.length;
    parts.push(
      [
        `## The group of incidents: ${group.name}`,
        `The operator chose the whole group, with ${total} incidents. ${list.length} of them, the newest, have the full context above. The next ${group.summaries.length} have one short line each. Say so when an answer rests on the short lines only, and read a full diagnosis with the tools when you need its detail.`,
        ...lines,
        ...(more + (group.omitted ?? 0) > 0 ? [`(${more + (group.omitted ?? 0)} more older incidents are not listed.)`] : []),
      ].join('\n'),
    );
  }
  return parts.join('\n\n');
}

function diagnosisContext(d: Diagnosis, heading = 'The incident this chat is about', limit = SINGLE_CONTEXT_CHARS): string {
  const lines = [`## ${heading}\nDiagnosis ${d.id} (${d.status}${d.resolvedAt ? ', resolved' : ''}).`, `Alert: ${JSON.stringify(d.alert)}`];
  if (d.error) lines.push(`Error: ${d.error}`);
  if (d.result) {
    lines.push(`Summary: ${d.result.summary}`, `Likely cause (${d.result.confidence} confidence): ${d.result.likelyCause}`);
    lines.push(`Fixes:\n${d.result.fixes.map((f, i) => `${i + 1}. ${f.title}: ${f.detail}`).join('\n')}`, `How to verify: ${d.result.verify}`);
  }
  if (d.evidence.length) lines.push(`Evidence:\n${d.evidence.map(e => `- ${e.id} ${e.tool} (${e.ok ? 'ok' : 'failed'}): ${e.summary}`).join('\n')}`);
  return clip(lines.join('\n'), limit);
}

function linkFields(chat: Chat): { diagnosisId?: string; diagnosisIds?: string[]; groupName?: string; groupCount?: number } {
  const ids = chatDiagnosisIds(chat);
  const group = chat.groupName ? { groupName: chat.groupName, groupCount: ids.length + (chat.summaryIds?.length ?? 0) + (chat.groupOmitted ?? 0) } : {};
  return ids.length ? { diagnosisId: ids[0], diagnosisIds: ids, ...group } : {};
}

function summary(store: ChatStore, chat: Chat): ChatSummary {
  return { id: chat.id, title: chat.title, model: chat.model, ...linkFields(chat), updatedAt: chat.updatedAt, running: store.running(chat) };
}

export class ChatService {
  private readonly turns = new Map<string, AbortController>();
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly deps: ChatDeps) {}

  private get catalogue(): ModelCatalogue {
    return this.deps.catalogue;
  }

  /** True when the operator picked this chat's model. A chat saved before the default order follows the order (see `ModelCatalogue.isPinned`). */
  private pinned(chat: Chat): boolean {
    return this.deps.catalogue.isPinned(chat.modelPinned, chat.model);
  }

  /** The model a request picks, or undefined for no pick. An empty id and an echo of the default (sent by an old plugin bundle) are no pick. */
  private pick(requested?: string): string | undefined {
    if (requested === undefined || requested === '' || this.deps.catalogue.isDefaultEcho(requested)) return undefined;
    return requested;
  }

  /** The full id of a model, or an empty string when none is configured. Unknown ids throw a 400. No id gives the default that answers first now. */
  private async modelId(requested?: string): Promise<string> {
    const explicit = requested !== undefined && requested !== '';
    const { catalogue } = this;
    // An ordered default never resolves its first entry: that route may have no credentials. The first live entry is the default.
    if (!explicit && catalogue.defaultOrder.length > 1) {
      const id = catalogue.currentDefault();
      return catalogue.hasRoute(id) ? id : '';
    }
    try {
      const r = await catalogue.resolve(explicit ? requested : undefined);
      return `${r.route.id}/${r.model}`;
    } catch (error) {
      if (error instanceof UnknownModelError) throw new ChatError(400, error.message);
      if (explicit) throw new ChatError(400, error instanceof Error ? error.message : String(error));
      return '';
    }
  }

  /** Newest activity first. `diagnosisId` keeps only the chats linked to that incident. */
  list(limit: number, diagnosisId?: string): ChatSummary[] {
    const all = this.deps.store.list();
    const kept = diagnosisId ? all.filter(c => chatDiagnosisIds(c).includes(diagnosisId)) : all;
    return kept.slice(0, limit).map(c => summary(this.deps.store, c));
  }

  async create(body: { model?: string; diagnosisId?: string; diagnosisIds?: string[]; groupName?: string; summaryIds?: string[]; groupOmitted?: number }): Promise<{ id: string }> {
    const ids = [...new Set([...(body.diagnosisIds ?? []), ...(body.diagnosisId !== undefined ? [body.diagnosisId] : [])])];
    if (ids.length > MAX_CHAT_INCIDENTS) throw new ChatError(400, `A chat can link at most ${MAX_CHAT_INCIDENTS} incidents`);
    const summaryIds = [...new Set(body.summaryIds ?? [])];
    if (summaryIds.length > MAX_SUMMARY_INCIDENTS) throw new ChatError(400, `A group chat can list at most ${MAX_SUMMARY_INCIDENTS} more incidents`);
    if (summaryIds.length && !ids.length) throw new ChatError(400, 'summaryIds needs diagnosisIds');
    for (const id of ids) if (!(await this.deps.diagnoses.get(id))) throw new ChatError(404, `No diagnosis ${id}`);
    // An incident that left the store (retention removed it) drops out of the short list. It is not an error.
    const known: string[] = [];
    for (const id of summaryIds) if (await this.deps.diagnoses.get(id)) known.push(id);
    const picked = this.pick(body.model);
    const model = await this.modelId(picked);
    const modelPinned = picked !== undefined;
    return { id: this.deps.store.create({ model, modelPinned, diagnosisIds: ids, ...(body.groupName ? { groupName: body.groupName } : {}), summaryIds: known, ...(body.groupOmitted ? { groupOmitted: body.groupOmitted } : {}) }).id };
  }

  private chat(id: string): Chat {
    const chat = this.deps.store.get(id);
    if (!chat) throw new ChatError(404, 'not found');
    return chat;
  }

  get(id: string): unknown {
    const chat = this.chat(id);
    return {
      id: chat.id,
      title: chat.title,
      model: chat.model,
      ...linkFields(chat),
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      running: this.deps.store.running(chat),
      messages: chat.messages.map(({ trace: _trace, ...m }) => m),
    };
  }

  async patch(id: string, body: { title?: string; model?: string }): Promise<ChatSummary> {
    const chat = this.chat(id);
    if (body.model !== undefined) {
      const picked = this.pick(body.model);
      chat.model = await this.modelId(picked);
      chat.modelPinned = picked !== undefined;
    }
    if (body.title !== undefined) chat.title = body.title.trim() || DEFAULT_TITLE;
    this.deps.store.save(chat);
    return summary(this.deps.store, chat);
  }

  delete(id: string): void {
    this.chat(id);
    this.cancel(id);
    this.deps.store.delete(id);
  }

  /** Starts one assistant turn. Returns the id of the assistant message. */
  async send(id: string, text: string, model?: string, subscription?: string): Promise<{ messageId: string }> {
    const { store } = this.deps;
    const chat = this.chat(id);
    if (store.running(chat) || this.turns.has(id)) throw new ChatError(409, 'A turn is already running in this chat');
    if (this.turns.size >= this.deps.maxTurns) throw new ChatError(429, 'Too many chat turns are running. Try again in a moment.');
    const wanted = this.pick(model);
    // An explicit pick pins the chat to that model. Without one a pinned chat keeps its model, and the others use the default order.
    const pinned = wanted ? true : this.pinned(chat);
    const resolved = wanted || !pinned ? await this.modelId(wanted) : chat.model;
    if (!resolved) throw new ChatError(503, 'No model is configured');
    // The checks above await, so a parallel send may have won. Check again, then claim the chat without awaiting.
    if (store.running(chat) || this.turns.has(id)) throw new ChatError(409, 'A turn is already running in this chat');
    if (this.turns.size >= this.deps.maxTurns) throw new ChatError(429, 'Too many chat turns are running. Try again in a moment.');
    const controller = new AbortController();
    this.turns.set(id, controller);

    chat.model = resolved;
    chat.modelPinned = pinned;
    const now = new Date().toISOString();
    if (chat.messages.length === 0 && chat.title === DEFAULT_TITLE) chat.title = text.replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS) || DEFAULT_TITLE;
    chat.messages.push({ id: randomUUID(), role: 'user', text: maskText(text), createdAt: now, status: 'done', steps: [] });
    const reply: ChatMessage = { id: randomUUID(), role: 'assistant', text: '', createdAt: now, status: 'running', model: resolved, steps: [] };
    chat.messages.push(reply);
    store.save(chat);
    const run = this.run(chat, reply, controller, subscription).catch(() => undefined);
    this.running.add(run);
    void run.then(() => this.running.delete(run));
    return { messageId: reply.id };
  }

  /** Aborts the running turn of a chat. Safe to call when none runs. */
  cancel(id: string): void {
    this.chat(id);
    this.stop(id, 'cancelled');
  }

  /** Wait for turns started by requests that the listener accepted. */
  async drain(): Promise<void> {
    await Promise.all(this.running);
  }

  private stop(id: string, status: 'cancelled' | 'failed', error?: string): void {
    const controller = this.turns.get(id);
    const chat = this.deps.store.get(id);
    this.turns.delete(id);
    if (chat) {
      for (const m of chat.messages) {
        if (m.status !== 'running') continue;
        m.status = status;
        if (error) m.error = error;
        for (const s of m.steps) {
          if (s.status === 'running') {
            s.status = 'done';
            s.ok = false;
            s.summary = status === 'cancelled' ? 'cancelled' : error;
          }
        }
      }
      this.deps.store.save(chat);
    }
    controller?.abort();
  }

  private history(chat: Chat, upTo: ChatMessage): Message[] {
    const out: Message[] = [];
    for (const m of chat.messages) {
      if (m === upTo) break;
      if (m.role === 'user') out.push({ role: 'user', text: m.text });
      else if (m.trace?.length) out.push(...m.trace);
      else out.push({ role: 'assistant', text: m.text || `(no answer: ${m.status}${m.error ? `, ${m.error}` : ''})`, toolCalls: [] });
    }
    return out;
  }

  private async run(chat: Chat, reply: ChatMessage, controller: AbortController, subscription?: string): Promise<void> {
    const { store, tools: host, budget } = this.deps;
    const signal = controller.signal;
    const cancelled = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    cancelled.catch(() => undefined);
    const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, cancelled]);
    const save = () => {
      if (!signal.aborted) store.save(chat);
    };
    try {
      // A pinned chat uses its model as it is. Otherwise the default order applies, with a fallback on a usage failure.
      const client = await guard(this.deps.catalogue.open(this.pinned(chat) ? chat.model : undefined));
      reply.model = client.name;
      const specs = await guard(host.list());
      const names = new Set(specs.map(s => s.name));
      const toolSpecs: ToolSpec[] = specs.map(s => withReason(s));
      const linked = (await Promise.all(chatDiagnosisIds(chat).map(id => this.deps.diagnoses.get(id)))).filter((d): d is Diagnosis => !!d);
      const summaries = chat.summaryIds?.length
        ? (await Promise.all(chat.summaryIds.map(id => this.deps.diagnoses.get(id)))).filter((d): d is Diagnosis => !!d)
        : [];
      const group = chat.groupName && summaries.length ? { name: chat.groupName, summaries, omitted: chat.groupOmitted ?? 0 } : undefined;
      const system = systemPrompt(budget, linked.length === 1 && !group ? linked[0] : linked, group);
      const past = this.history(chat, reply);
      const turn: Message[] = [];
      const texts: string[] = [];
      let calls = 0;
      let n = 0;
      let answered = false;
      for (let round = 0; round < budget + EXTRA_ROUNDS; round++) {
        const completion = await guard(client.complete({ system, messages: trimHistory([...past, ...turn]), tools: toolSpecs, session: chat.id }));
        // The default order can move to the next model, so the record names the one that answered.
        reply.model = client.name;
        if (!this.pinned(chat)) chat.model = client.name;
        const text = completion.text.trim();
        if (text) {
          texts.push(text);
          reply.text = maskText(texts.join('\n\n'));
        }
        turn.push({ role: 'assistant', text: completion.text, toolCalls: completion.toolCalls });
        if (completion.toolCalls.length === 0) {
          answered = true;
          break;
        }
        const results: Array<{ id: string; name: string; content: string; isError: boolean }> = [];
        for (const call of completion.toolCalls) {
          const { reason, ...args } = (call.args ?? {}) as Record<string, unknown>;
          const step: ChatStep = { id: `s${++n}`, tool: call.name, reason: maskText(typeof reason === 'string' && reason ? reason : '(no reason given)'), status: 'running' };
          reply.steps.push(step);
          save();
          const finish = (ok: boolean, text: string, content: string): void => {
            step.ok = ok;
            step.summary = maskText(text);
            step.status = 'done';
            results.push({ id: call.id, name: call.name, content, isError: !ok });
            save();
          };
          if (!names.has(call.name)) {
            finish(false, `There is no tool named ${call.name}.`, `There is no tool named ${call.name}.`);
          } else if (calls >= budget) {
            finish(false, 'Tool budget used up.', 'The tool budget for this answer is used up. Answer with what you have.');
          } else {
            calls++;
            try {
              const out = await guard(host.call(call.name, args));
              finish(out.ok, out.summary, clip(maskText(JSON.stringify(mask(out.data)))));
            } catch (error) {
              if (signal.aborted) throw error;
              const message = maskText(error instanceof Error ? error.message : String(error));
              finish(false, message, JSON.stringify({ error: message }));
            }
          }
        }
        turn.push({ role: 'tool', results });
        save();
      }
      if (signal.aborted) return;
      if (!reply.text) throw new Error(answered ? 'The model gave no answer' : 'The model kept calling tools and did not answer');
      reply.trace = mask(turn);
      reply.status = 'done';
      store.save(chat);
      if (subscription) {
        try {
          this.deps.onAnswer?.({ chatId: chat.id, subscription, text: reply.text });
        } catch {
          // A push problem never changes the answer.
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      reply.status = 'failed';
      reply.error = maskText(error instanceof Error ? error.message : String(error));
      for (const s of reply.steps) {
        if (s.status === 'running') {
          s.status = 'done';
          s.ok = false;
        }
      }
      store.save(chat);
    } finally {
      if (this.turns.get(chat.id) === controller) this.turns.delete(chat.id);
    }
  }
}
