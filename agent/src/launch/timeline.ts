import { mask, maskText } from '../mask.js';
import { ACTIVE_RUN, FINAL_RUN, type ThreadProjection } from '../t3/protocol.js';
import type { LaunchStatus, TimelineEntry, TimelineKind, TimelineStatus } from './store.js';

const MAX_ENTRIES = 300;
const DETAIL_CHARS = 4000;
const REPLY_CHARS = 20_000;

export interface Tracked {
  status: LaunchStatus;
  /** True when the launch will not change unless the operator sends a follow-up. */
  final: boolean;
  timeline: TimelineEntry[];
  lastReply?: string;
  error?: string;
  finishedAt?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clip = (text: string, limit = DETAIL_CHARS): string => (text.length <= limit ? text : `${text.slice(0, limit)}\n[cut: ${text.length - limit} more characters]`);

function runStatus(status: string): TimelineStatus {
  if (status === 'waiting') return 'waiting';
  if (status === 'completed') return 'done';
  if (FINAL_RUN.has(status)) return 'failed';
  return 'running';
}

function itemStatus(item: Record<string, unknown>, run: { status: string } | undefined): TimelineStatus {
  const s = str(item.status);
  const failed = /^(failed|error|errored|declined|cancelled|canceled|interrupted|rejected)$/.test(s) || (typeof item.exitCode === 'number' && item.exitCode !== 0);
  if (failed) return 'failed';
  if (s === 'completed' || s === 'done') return 'done';
  // A step that still says running in a finished run was cut short by the end of the run.
  if (run && FINAL_RUN.has(run.status)) return run.status === 'completed' ? 'done' : 'failed';
  if (s === 'waiting' || s === 'pending') return 'waiting';
  return 'running';
}

const TOOL_TYPES = new Set(['command_execution', 'dynamic_tool', 'file_search', 'web_search', 'subagent']);
/** Item types that repeat a message or that carry no information for an operator. */
const HIDDEN_TYPES = new Set(['user_message', 'assistant_message', 'checkpoint', 'thread_created', 'compaction', 'handoff', 'fork', 'notification']);

function describe(item: Record<string, unknown>): { kind: TimelineKind; title: string; detail?: string } | undefined {
  const type = str(item.type);
  if (HIDDEN_TYPES.has(type)) return undefined;
  const title = str(item.title);
  if (type === 'command_execution') {
    // The server adds one "Workspace ready" step to every thread. It is not an agent action.
    if (title === 'Workspace ready' && str(item.input) === 'Preparing workspace') return undefined;
    const lines = [`$ ${str(item.input)}`];
    if (str(item.output)) lines.push(str(item.output));
    if (typeof item.exitCode === 'number') lines.push(`exit code ${item.exitCode}`);
    return { kind: 'tool', title: title || str(item.input).split('\n')[0].slice(0, 120) || 'Command', detail: lines.join('\n') };
  }
  if (type === 'dynamic_tool') {
    const parts: string[] = [];
    if (item.input !== undefined) parts.push(`input: ${typeof item.input === 'string' ? item.input : JSON.stringify(item.input)}`);
    if (item.output !== undefined) parts.push(`output: ${typeof item.output === 'string' ? item.output : JSON.stringify(item.output)}`);
    return { kind: 'tool', title: str(item.toolName) || title || 'Tool call', detail: parts.join('\n') || undefined };
  }
  if (type === 'file_change') {
    const stat = `+${Number(item.additions) || 0} -${Number(item.deletions) || 0}`;
    return { kind: 'file_change', title: str(item.fileName) || title || 'File change', detail: [stat, str(item.diffStr)].filter(Boolean).join('\n') };
  }
  if (TOOL_TYPES.has(type)) return { kind: 'tool', title: title || type.replace(/_/g, ' '), detail: str(item.query) || str(item.input) || undefined };
  if (type === 'error') {
    const failure = item.failure;
    return { kind: 'other', title: title || 'Error', detail: typeof failure === 'string' ? failure : failure ? JSON.stringify(failure) : str(item.message) || undefined };
  }
  if (type === 'reasoning') return { kind: 'other', title: title || 'Thinking', detail: str(item.text) || str(item.summary) || undefined };
  return { kind: 'other', title: title || type.replace(/_/g, ' ') || 'Step', detail: str(item.text) || str(item.input) || undefined };
}

/**
 * Turns a thread projection into the launch state: the status, a flat timeline
 * (each run followed by its messages and steps) and the latest agent reply.
 *
 * The status follows the last run. `waiting` is a short step inside a turn (the
 * server captures a checkpoint), so it is not final. A launch is completed when
 * the last run is completed, no run is active and no reply is still streaming.
 */
export function mapProjection(p: ThreadProjection): Tracked {
  const runs = p.runs;
  const runById = new Map(runs.map(r => [r.id, r]));
  const lastRun = runs.at(-1);
  const entries: Array<{ at: string; order: number; entry: TimelineEntry }> = [];
  let order = 0;
  const groups = new Map<string, typeof entries>();
  const loose: typeof entries = [];
  const add = (runId: string | null | undefined, at: string, entry: TimelineEntry) => {
    const row = { at, order: order++, entry };
    if (runId && runById.has(runId)) {
      const g = groups.get(runId) ?? [];
      g.push(row);
      groups.set(runId, g);
    } else loose.push(row);
  };
  for (const m of p.messages) {
    if (m.role === 'system') continue;
    add(m.runId, str(m.createdAt), {
      id: m.id,
      kind: 'message',
      title: m.role === 'user' ? 'Operator message' : 'Agent reply',
      detail: clip(m.text),
      status: m.streaming ? 'running' : 'done',
      startedAt: m.createdAt,
    });
  }
  const items = [...p.turnItems].sort((a, b) => (Number(a.ordinal) || 0) - (Number(b.ordinal) || 0));
  for (const item of items) {
    const d = describe(item);
    if (!d) continue;
    const run = runById.get(str(item.runId));
    add(str(item.runId), str(item.startedAt) || str(item.updatedAt), {
      id: str(item.id) || `item-${order}`,
      kind: d.kind,
      title: d.title,
      ...(d.detail ? { detail: clip(d.detail) } : {}),
      status: itemStatus(item, run),
      ...(str(item.startedAt) ? { startedAt: str(item.startedAt) } : {}),
      ...(str(item.completedAt) ? { finishedAt: str(item.completedAt) } : {}),
    });
  }
  const sorted = (rows: typeof entries) => [...rows].sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order).map(r => r.entry);
  const timeline: TimelineEntry[] = [...sorted(loose)];
  runs.forEach((r, i) => {
    timeline.push({
      id: r.id,
      kind: 'run',
      title: `Run ${r.ordinal ?? i + 1}`,
      detail: r.status,
      status: runStatus(r.status),
      ...(r.startedAt || r.requestedAt ? { startedAt: r.startedAt || r.requestedAt } : {}),
      ...(r.completedAt ? { finishedAt: r.completedAt } : {}),
    });
    timeline.push(...sorted(groups.get(r.id) ?? []));
  });

  const assistant = [...p.messages].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '');
  const streaming = p.messages.some(m => m.role === 'assistant' && m.streaming);
  const lastReply = assistant ? maskText(clip(assistant.text, REPLY_CHARS)) : undefined;
  const pending = p.runtimeRequests.some(r => r.status === 'pending');
  const errorItem = [...p.turnItems].reverse().find(i => str(i.type) === 'error');
  const failure = errorItem?.failure;
  const errorText = failure ? (typeof failure === 'string' ? failure : JSON.stringify(mask(failure))) : str(errorItem?.message);

  const trimmed = timeline.length > MAX_ENTRIES ? timeline.slice(-MAX_ENTRIES) : timeline;
  const base = { timeline: trimmed, ...(lastReply ? { lastReply } : {}) };
  if (!lastRun) return { ...base, status: 'running', final: false };
  const s = lastRun.status;
  const active = runs.some(r => ACTIVE_RUN.has(r.status));
  const finishedAt = lastRun.completedAt ?? undefined;
  if (s === 'completed' && !active && !streaming) return { ...base, status: 'completed', final: true, ...(finishedAt ? { finishedAt } : {}) };
  if (s === 'cancelled') return { ...base, status: 'cancelled', final: true, ...(finishedAt ? { finishedAt } : {}) };
  if (s === 'failed' || s === 'interrupted' || s === 'rolled_back') {
    const reason = errorText ? clip(maskText(errorText), 1000) : `The run ended as ${s}`;
    return { ...base, status: 'failed', final: true, error: reason, ...(finishedAt ? { finishedAt } : {}) };
  }
  if (s === 'waiting' || pending) return { ...base, status: 'waiting', final: false };
  return { ...base, status: 'running', final: false };
}
