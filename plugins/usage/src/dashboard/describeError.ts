/** A short, safe message for a failed metrics request. */
export function describeError(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return m.trim() === '' ? 'Failed to query the metrics service' : m.slice(0, 200);
}
