/*
 * Retry delays. The delay doubles with each failed try, from `baseMs` up to `capMs`. `attempt` is
 * the number of failures so far (1 for the first retry). `jitter` (0 to 1) spreads a delay by up to
 * that share, so many kiosks do not call the server in the same second after an outage.
 */
export function backoffDelay(
  attempt: number,
  baseMs = 2_000,
  capMs = 60_000,
  jitter = 0,
  random: () => number = Math.random
): number {
  const tries = Math.max(1, Math.floor(attempt));
  const plain = Math.min(capMs, baseMs * 2 ** Math.min(tries - 1, 20));
  return Math.round(plain * (1 - jitter * random()));
}
