import { randomUUID } from 'node:crypto';
import { mask, maskText } from '../mask.js';
import { DEFAULT_TITLE, type Chat, type ChatMessage, type ChatStep, type ChatStore } from '../chats.js';
import type { DiagnosisStore } from '../store.js';
import { ModelCatalogue, UnknownModelError } from './catalogue.js';
import type { ToolHost } from './engine.js';
import { ModelClient, type Message, type ToolSpec } from './model.js';
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
  updatedAt: string;
  running: boolean;
}

export interface ChatDeps {
  store: ChatStore;
  diagnoses: DiagnosisStore;
  tools: ToolHost;
  catalogue: ModelCatalogue;
  /** Tool calls per turn. */
  budget: number;
  /** Turns that may run at once across chats. */
  maxTurns: number;
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

export function systemPrompt(budget: number, diagnosis?: Diagnosis): string {
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
  if (diagnosis) parts.push(diagnosisContext(diagnosis));
  return parts.join('\n\n');
}

function diagnosisContext(d: Diagnosis): string {
  const lines = [`## The incident this chat is about\nDiagnosis ${d.id} (${d.status}${d.resolvedAt ? ', resolved' : ''}).`, `Alert: ${JSON.stringify(d.alert)}`];
  if (d.error) lines.push(`Error: ${d.error}`);
  if (d.result) {
    lines.push(`Summary: ${d.result.summary}`, `Likely cause (${d.result.confidence} confidence): ${d.result.likelyCause}`);
    lines.push(`Fixes:\n${d.result.fixes.map((f, i) => `${i + 1}. ${f.title}: ${f.detail}`).join('\n')}`, `How to verify: ${d.result.verify}`);
  }
  if (d.evidence.length) lines.push(`Evidence:\n${d.evidence.map(e => `- ${e.id} ${e.tool} (${e.ok ? 'ok' : 'failed'}): ${e.summary}`).join('\n')}`);
  return clip(lines.join('\n'), 12_000);
}

function summary(store: ChatStore, chat: Chat): ChatSummary {
  return { id: chat.id, title: chat.title, model: chat.model, ...(chat.diagnosisId ? { diagnosisId: chat.diagnosisId } : {}), updatedAt: chat.updatedAt, running: store.running(chat) };
}

export class ChatService {
  private readonly turns = new Map<string, AbortController>();

  constructor(private readonly deps: ChatDeps) {}

  /** The full id of a model, or an empty string when none is configured. Unknown ids throw a 400. */
  private async modelId(requested?: string): Promise<string> {
    const explicit = requested !== undefined && requested !== '';
    try {
      const r = await this.deps.catalogue.resolve(explicit ? requested : undefined);
      return `${r.route.id}/${r.model}`;
    } catch (error) {
      if (error instanceof UnknownModelError) throw new ChatError(400, error.message);
      if (explicit) throw new ChatError(400, error instanceof Error ? error.message : String(error));
      return '';
    }
  }

  list(limit: number): ChatSummary[] {
    return this.deps.store.list().slice(0, limit).map(c => summary(this.deps.store, c));
  }

  async create(body: { model?: string; diagnosisId?: string }): Promise<{ id: string }> {
    if (body.diagnosisId !== undefined && !this.deps.diagnoses.get(body.diagnosisId)) throw new ChatError(404, `No diagnosis ${body.diagnosisId}`);
    const model = await this.modelId(body.model);
    return { id: this.deps.store.create({ model, diagnosisId: body.diagnosisId }).id };
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
      ...(chat.diagnosisId ? { diagnosisId: chat.diagnosisId } : {}),
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      running: this.deps.store.running(chat),
      messages: chat.messages.map(({ trace: _trace, ...m }) => m),
    };
  }

  async patch(id: string, body: { title?: string; model?: string }): Promise<ChatSummary> {
    const chat = this.chat(id);
    if (body.model !== undefined) chat.model = await this.modelId(body.model);
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
  async send(id: string, text: string, model?: string): Promise<{ messageId: string }> {
    const { store } = this.deps;
    const chat = this.chat(id);
    if (store.running(chat) || this.turns.has(id)) throw new ChatError(409, 'A turn is already running in this chat');
    if (this.turns.size >= this.deps.maxTurns) throw new ChatError(429, 'Too many chat turns are running. Try again in a moment.');
    const wanted = model !== undefined && model !== '' ? model : undefined;
    const resolved = wanted || !chat.model ? await this.modelId(wanted) : chat.model;
    if (!resolved) throw new ChatError(503, 'No model is configured');
    // The checks above await, so a parallel send may have won. Check again, then claim the chat without awaiting.
    if (store.running(chat) || this.turns.has(id)) throw new ChatError(409, 'A turn is already running in this chat');
    if (this.turns.size >= this.deps.maxTurns) throw new ChatError(429, 'Too many chat turns are running. Try again in a moment.');
    const controller = new AbortController();
    this.turns.set(id, controller);

    chat.model = resolved;
    const now = new Date().toISOString();
    if (chat.messages.length === 0 && chat.title === DEFAULT_TITLE) chat.title = text.replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS) || DEFAULT_TITLE;
    chat.messages.push({ id: randomUUID(), role: 'user', text: maskText(text), createdAt: now, status: 'done', steps: [] });
    const reply: ChatMessage = { id: randomUUID(), role: 'assistant', text: '', createdAt: now, status: 'running', model: resolved, steps: [] };
    chat.messages.push(reply);
    store.save(chat);
    this.run(chat, reply, controller).catch(() => undefined);
    return { messageId: reply.id };
  }

  /** Aborts the running turn of a chat. Safe to call when none runs. */
  cancel(id: string): void {
    this.chat(id);
    this.stop(id, 'cancelled');
  }

  /** Stops every running turn, for shutdown. They are marked failed, as a restart would leave them. */
  shutdown(): void {
    for (const id of [...this.turns.keys()]) this.stop(id, 'failed', 'interrupted by restart');
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

  private async run(chat: Chat, reply: ChatMessage, controller: AbortController): Promise<void> {
    const { store, tools: host, budget } = this.deps;
    const signal = controller.signal;
    const cancelled = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    cancelled.catch(() => undefined);
    const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, cancelled]);
    const save = () => {
      if (!signal.aborted) store.save(chat);
    };
    try {
      const resolved = await guard(this.deps.catalogue.resolve(chat.model));
      const client = new ModelClient(resolved.route, resolved.model);
      reply.model = client.name;
      const specs = await guard(host.list());
      const names = new Set(specs.map(s => s.name));
      const toolSpecs: ToolSpec[] = specs.map(s => withReason(s));
      const diagnosis = chat.diagnosisId ? this.deps.diagnoses.get(chat.diagnosisId) : undefined;
      const system = systemPrompt(budget, diagnosis);
      const past = this.history(chat, reply);
      const turn: Message[] = [];
      const texts: string[] = [];
      let calls = 0;
      let n = 0;
      let answered = false;
      for (let round = 0; round < budget + EXTRA_ROUNDS; round++) {
        const completion = await guard(client.complete({ system, messages: trimHistory([...past, ...turn]), tools: toolSpecs, session: chat.id }));
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
