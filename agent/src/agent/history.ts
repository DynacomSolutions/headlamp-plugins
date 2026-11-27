import type { Message } from './model.js';

/** The text of all tool results kept in the history sent to the model. Older results go first. */
export const HISTORY_RESULT_CHARS = 120_000;
export const REMOVED = '[older tool result removed to keep the history short]';

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
