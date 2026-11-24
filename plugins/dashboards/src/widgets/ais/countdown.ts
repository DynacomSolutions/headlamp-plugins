/*
 * The countdown to the reset of a limit window, for people. At most two units: "3d 4h", "5h 12m",
 * "12m" and "<1m". A missing, invalid or past reset gives an empty text, never a negative one.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How often the widget redraws the countdowns, in ms. */
export const COUNTDOWN_TICK_MS = 30_000;

/** The time from `now` (epoch ms) to the reset `raw`, as "3d 4h", "5h 12m", "12m" or "<1m". */
export function formatCountdown(raw: string | undefined, now: number): string {
  if (!raw) return '';
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return '';
  const left = at - now;
  if (left <= 0) return '';
  if (left < MINUTE) return '<1m';
  const days = Math.floor(left / DAY);
  const hours = Math.floor((left % DAY) / HOUR);
  const minutes = Math.floor((left % HOUR) / MINUTE);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}
