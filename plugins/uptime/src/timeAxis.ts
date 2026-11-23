/*
 * Pure model of the time axis above the history strips. A strip has one cell per bucket. Bucket `i` is the
 * range point at `startSec + i * stepSec`, and its value is the average of the step that ENDS at that point
 * (`avg_over_time(probe_success[step])`), so cell `i` covers `(point - step, point]`.
 *
 * The axis draws the same cells as the strip, so a tick sits on the left edge of a cell and lines up with
 * the strip exactly. A tick is placed at the first cell edge at or after its aligned local time. For a
 * grid whose cells do not hold the local boundary exactly (a 2 hour cell and a midnight in UTC+07:00), the
 * tick is a part of a cell late at most. The tooltip of a cell gives its exact times.
 *
 * Times use the browser time zone, or the `timeZone` argument (tests). Labels use the fixed `en-GB`
 * format, so the 24 hour clock and the day order do not change from one browser to the next.
 */

export interface AxisGrid {
  /** Epoch seconds of bucket 0 (the end of its step). */
  startSec: number;
  stepSec: number;
  buckets: number;
}

export interface AxisTick {
  /** The cell whose left edge carries the tick. */
  index: number;
  label: string;
  /** True when the tick is at a day boundary (local midnight). */
  day: boolean;
}

export interface AxisOptions {
  /** The most ticks to draw. Default 12. */
  maxTicks?: number;
  /** An IANA zone, for tests. Default: the browser zone. */
  timeZone?: string;
}

const DAY = 86400;

/** The tick steps, in seconds. Below a day they divide the day, so midnight is always a tick. */
export const TICK_STEPS: readonly number[] = [
  60,
  300,
  600,
  900,
  1800,
  3600,
  7200,
  10800,
  21600,
  43200,
  DAY,
  2 * DAY,
  3 * DAY,
  5 * DAY,
  7 * DAY,
];

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(key, f);
  }
  return f;
}

/** The wall clock parts of an instant in the zone. */
export function partsOf(sec: number, timeZone?: string): Parts {
  const out: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(sec * 1000))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    weekday: out.weekday ?? '',
  };
}

/** Seconds since the epoch on the local wall clock (the instant shifted by the zone offset). */
function localSec(sec: number, timeZone?: string): number {
  const p = partsOf(sec, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 1000 + (sec % 60);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');

/** `14:30` in the zone. */
export function clockLabel(sec: number, timeZone?: string): string {
  const p = partsOf(sec, timeZone);
  return `${two(p.hour)}:${two(p.minute)}`;
}

/** `Mon 23`, and `1 Dec` for the first day of a month. */
export function dayLabel(sec: number, timeZone?: string): string {
  const p = partsOf(sec, timeZone);
  return p.day === 1 ? `1 ${MONTHS[p.month - 1]}` : `${p.weekday} ${p.day}`;
}

/** The smallest tick step that gives no more than `maxTicks` ticks for the span, and is not under a cell. */
export function tickStepFor(spanSec: number, stepSec: number, maxTicks: number): number {
  const limit = Math.max(1, Math.floor(maxTicks));
  for (const s of TICK_STEPS) {
    if (s >= stepSec && Math.ceil(spanSec / s) <= limit) return s;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

/**
 * The ticks of the axis. Below a day, a tick is every `tickStepFor` of local time (`HH:mm`), and the
 * midnight tick shows the day (`Mon 23`) and is marked `day`. From a day up, every tick is a local
 * midnight with the day. A cell that ends a tick slot starts the next one, so the tick is its left edge.
 */
export function axisTicks(grid: AxisGrid, options: AxisOptions = {}): AxisTick[] {
  const { startSec, stepSec, buckets } = grid;
  if (buckets <= 0 || stepSec <= 0) return [];
  const { timeZone } = options;
  const first = startSec - stepSec;
  const interval = tickStepFor(buckets * stepSec, stepSec, options.maxTicks ?? 12);
  const dayMode = interval >= DAY;
  const dayCount = interval / DAY;
  // The slot of a cell edge: the aligned local time (or whole local days) that it falls in.
  const slot = (edgeSec: number): number => {
    const local = localSec(edgeSec, timeZone);
    return dayMode ? Math.floor(Math.floor(local / DAY) / dayCount) : Math.floor(local / interval);
  };
  const dayOf = (edgeSec: number): number => Math.floor(localSec(edgeSec, timeZone) / DAY);
  const ticks: AxisTick[] = [];
  let prevSlot = slot(first - stepSec);
  let prevDay = dayOf(first - stepSec);
  for (let i = 0; i < buckets; i++) {
    const edge = first + i * stepSec;
    const s = slot(edge);
    const d = dayOf(edge);
    if (s !== prevSlot) {
      const day = dayMode || d !== prevDay;
      ticks.push({
        index: i,
        label: day ? dayLabel(edge, timeZone) : clockLabel(edge, timeZone),
        day,
      });
    }
    prevSlot = s;
    prevDay = d;
  }
  return ticks;
}

/** The time zone name for the axis caption, such as `GMT+7`. Empty when the browser gives none. */
export function zoneName(sec: number, timeZone?: string): string {
  try {
    return (
      new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' })
        .formatToParts(new Date(sec * 1000))
        .find(p => p.type === 'timeZoneName')?.value ?? ''
    );
  } catch {
    return '';
  }
}

/** The exact span of cell `i`: it starts one step before its point and ends at the point. */
export function bucketSpan(
  grid: Pick<AxisGrid, 'startSec' | 'stepSec'>,
  i: number
): { fromSec: number; toSec: number } {
  const toSec = grid.startSec + i * grid.stepSec;
  return { fromSec: toSec - grid.stepSec, toSec };
}

/**
 * The span as text: `Mon 23 Nov 14:00 to 14:15`, with the day again on the end when the span crosses
 * midnight.
 */
export function formatSpan(fromSec: number, toSec: number, timeZone?: string): string {
  const a = partsOf(fromSec, timeZone);
  const b = partsOf(toSec, timeZone);
  const date = (p: Parts): string => `${p.weekday} ${p.day} ${MONTHS[p.month - 1]}`;
  const clock = (p: Parts): string => `${two(p.hour)}:${two(p.minute)}`;
  const sameDay = a.year === b.year && a.month === b.month && a.day === b.day;
  return sameDay
    ? `${date(a)} ${clock(a)} to ${clock(b)}`
    : `${date(a)} ${clock(a)} to ${date(b)} ${clock(b)}`;
}
