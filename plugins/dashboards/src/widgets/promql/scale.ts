/* Scales, ticks and path strings for the SVG charts. Pure functions. */
import { Unit } from './units';

export interface Domain {
  min: number;
  max: number;
}

/** A "nice" step (1, 2, 5 times a power of ten) for a span and a target tick count. */
export function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * pow;
}

/** Ticks between min and max, rounded to nice values. For bytes the steps follow powers of 1024. */
export function niceTicks(min: number, max: number, count: number, unit?: Unit | string): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max === min) return [min];
  let scale = 1;
  if (unit === 'bytes') {
    const top = Math.max(Math.abs(min), Math.abs(max));
    while (top / scale >= 1024 * 1.0001) scale *= 1024;
  }
  const step = niceStep((max - min) / scale, count) * scale;
  const start = Math.ceil(min / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = start, i = 0; v <= max + step * 1e-9 && i < 100; v += step, i += 1) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

export interface DomainInput {
  min: number;
  max: number;
  /** Areas and bars must start at zero, because their size is the value. */
  includeZero: boolean;
  yMin?: number;
  yMax?: number;
}

/** The y domain: the data extent, widened to zero for filled marks, then the user's limits. */
export function computeDomain(input: DomainInput): Domain {
  let { min, max } = input;
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (input.includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (input.yMin !== undefined) min = input.yMin;
  if (input.yMax !== undefined) max = input.yMax;
  if (max <= min) {
    // A flat series (or limits that cross): give it some height.
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    if (input.yMin !== undefined && input.yMax !== undefined) {
      max = min + 1;
    } else if (input.yMin !== undefined) {
      max = min + pad * 2;
    } else if (input.yMax !== undefined) {
      min = max - pad * 2;
    } else if (input.includeZero) {
      max = min + pad;
    } else {
      min -= pad;
      max += pad;
    }
  }
  return { min, max };
}

/** Round the domain out to the ticks, except for limits the user set. */
export function niceDomain(
  d: Domain,
  count: number,
  unit: Unit | string | undefined,
  fixedMin: boolean,
  fixedMax: boolean
): Domain {
  const ticks = niceTicks(d.min, d.max, count, unit);
  if (ticks.length < 2) return d;
  const step = ticks[1] - ticks[0];
  const min = fixedMin ? d.min : Math.floor(d.min / step + 1e-9) * step;
  const max = fixedMax ? d.max : Math.ceil(d.max / step - 1e-9) * step;
  return { min, max: max > min ? max : d.max };
}

export function linear(domain: Domain, r0: number, r1: number): (v: number) => number {
  const span = domain.max - domain.min || 1;
  return v => r0 + ((v - domain.min) / span) * (r1 - r0);
}

// ---- time ticks ----

const TIME_STEPS = [
  60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800,
];

/**
 * Ticks for a time axis (epoch seconds), at round local times. `tzOffsetSeconds` is the local
 * offset east of UTC (the negative of `getTimezoneOffset() * 60`).
 */
export function timeTicks(
  start: number,
  end: number,
  count: number,
  tzOffsetSeconds: number
): number[] {
  const span = end - start;
  if (!(span > 0) || count < 1) return [];
  const raw = span / count;
  const step = TIME_STEPS.find(s => s >= raw) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const first = Math.ceil((start + tzOffsetSeconds) / step) * step - tzOffsetSeconds;
  const out: number[] = [];
  for (let t = first; t <= end; t += step) out.push(t);
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A tick label: `HH:mm` for a day or less, `d MMM` at midnight and `d MMM HH:mm` otherwise. */
export function formatTick(t: number, rangeSpanSeconds: number, tzOffsetSeconds: number): string {
  const d = new Date((t + tzOffsetSeconds) * 1000);
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (rangeSpanSeconds <= 86400 * 1.5) return time;
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? day : `${day} ${time}`;
}

export function formatTooltipTime(t: number, tzOffsetSeconds: number): string {
  const d = new Date((t + tzOffsetSeconds) * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCHours())}:${pad2(
    d.getUTCMinutes()
  )}:${pad2(d.getUTCSeconds())}`;
}

// ---- paths ----

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/** A line path through points. A null value breaks the line (a gap), it is never drawn as zero. */
export function linePath(points: Array<[number, number | null]>): string {
  let d = '';
  let pen = false;
  for (const [x, y] of points) {
    if (y === null) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${f(x)},${f(y)}`;
    pen = true;
  }
  return d;
}

/** A closed area between a top line and a base line. Gaps split it into separate shapes. */
export function areaPath(xs: number[], tops: Array<number | null>, bases: number[]): string {
  let d = '';
  let i = 0;
  while (i < xs.length) {
    if (tops[i] === null) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < xs.length && tops[j + 1] !== null) j += 1;
    let seg = `M${f(xs[i])},${f(tops[i] as number)}`;
    for (let k = i + 1; k <= j; k += 1) seg += `L${f(xs[k])},${f(tops[k] as number)}`;
    for (let k = j; k >= i; k -= 1) seg += `L${f(xs[k])},${f(bases[k])}`;
    d += `${seg}Z`;
    i = j + 1;
  }
  return d;
}

/** A pie or donut slice as a path. A full circle is two half arcs, because one arc cannot close. */
export function slicePath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  a0: number,
  a1: number
): string {
  const sweep = a1 - a0;
  const pt = (r: number, a: number) => `${f(cx + r * Math.sin(a))},${f(cy - r * Math.cos(a))}`;
  if (sweep >= Math.PI * 2 - 1e-6) {
    const ring = (r: number, dir: 0 | 1) =>
      `M${pt(r, 0)}A${r},${r} 0 1 ${dir} ${pt(r, Math.PI)}A${r},${r} 0 1 ${dir} ${pt(r, 0)}`;
    return rInner > 0 ? `${ring(rOuter, 1)}${ring(rInner, 0)}Z` : `${ring(rOuter, 1)}Z`;
  }
  const large = sweep > Math.PI ? 1 : 0;
  const outer = `M${pt(rOuter, a0)}A${rOuter},${rOuter} 0 ${large} 1 ${pt(rOuter, a1)}`;
  if (rInner <= 0) return `${outer}L${f(cx)},${f(cy)}Z`;
  return `${outer}L${pt(rInner, a1)}A${rInner},${rInner} 0 ${large} 0 ${pt(rInner, a0)}Z`;
}
