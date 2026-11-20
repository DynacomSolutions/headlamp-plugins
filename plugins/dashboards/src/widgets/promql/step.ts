/* Choosing the query step. A wide chart gets more points, and a long range gets a larger step. */
import type { TimeRange } from '../../contract';

export const RANGE_SECONDS: Record<TimeRange, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
  '7d': 604800,
  '30d': 2592000,
};

export const NICE_STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400];

/** The most points a series gets, whatever the width. */
export const MAX_POINTS = 300;
export const MIN_POINTS = 30;
/** Pixels of chart width for each point: more points than this cannot be seen. */
export const PIXELS_PER_POINT = 3;

export function rangeSeconds(range: string): number {
  return RANGE_SECONDS[range as TimeRange] ?? RANGE_SECONDS['1h'];
}

/**
 * The step (seconds) for a range and a chart width. It is a round number, so a small change in
 * width keeps the same step and does not fetch again. Each series has at most MAX_POINTS points.
 */
export function chooseStep(rangeSec: number, widthPx: number): number {
  const width = Number.isFinite(widthPx) && widthPx > 0 ? widthPx : 600;
  const points = Math.min(MAX_POINTS, Math.max(MIN_POINTS, Math.round(width / PIXELS_PER_POINT)));
  const raw = rangeSec / points;
  return NICE_STEPS.find(s => s >= raw) ?? NICE_STEPS[NICE_STEPS.length - 1];
}
