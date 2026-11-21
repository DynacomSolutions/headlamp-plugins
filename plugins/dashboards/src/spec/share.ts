/*
 * Structural sharing for a spec that was read again. `reuseEqual(prev, next)` returns `next`, but
 * every part that is equal to the same part of `prev` is the object of `prev`. A widget whose
 * settings did not change keeps its object, so React skips it and it keeps its data. When nothing
 * changed, the result is `prev` itself.
 */
export function reuseEqual<T>(prev: unknown, next: T): T {
  if (prev === next) return next;
  if (Array.isArray(next) && Array.isArray(prev)) {
    const items = next.map((n, i) => reuseEqual(prev[i], n));
    const same = items.length === prev.length && items.every((x, i) => x === prev[i]);
    return (same ? prev : items) as unknown as T;
  }
  if (isPlain(next) && isPlain(prev)) {
    const keys = Object.keys(next);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = reuseEqual(prev[k], next[k]);
    const same = keys.length === Object.keys(prev).length && keys.every(k => out[k] === prev[k]);
    return (same ? prev : out) as unknown as T;
  }
  return next;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
