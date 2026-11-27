import type { Message } from './model.js';

/** The most time that the last call of a run may take. It has its own short limit, after the run limit has passed. */
export const FINAL_CALL_MAX_MS = 60_000;

/** The time that a run keeps for its last call: two model calls, but never more than half of the run limit. */
export function reserveMs(limit: number, callTimeoutMs?: number): number {
  return Math.min(2 * (callTimeoutMs ?? 120_000), Math.floor(limit / 2));
}

/** The time limit of the last call. */
export function finalCallMs(callTimeoutMs?: number): number {
  return Math.min(callTimeoutMs ?? FINAL_CALL_MAX_MS, FINAL_CALL_MAX_MS);
}

/**
 * A run that stops in the middle of its tool calls leaves an assistant message whose calls have no results. An endpoint refuses such a
 * history. This adds a tool message that answers every call that has no result yet: with the result that exists, or with a note.
 */
export function closeToolCalls(messages: Message[], partial: Array<{ id: string; name: string; content: string; isError: boolean }> = []): void {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || last.toolCalls.length === 0) return;
  const results = last.toolCalls.map(call => partial.find(r => r.id === call.id) ?? { id: call.id, name: call.name, content: 'The run reached its time limit before this tool call ran.', isError: true });
  messages.push({ role: 'tool', results });
}
