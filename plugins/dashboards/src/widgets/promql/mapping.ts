/* Mapping a Prometheus HTTP API response to series and rows. Pure functions. */

export type Labels = Record<string, string>;

export interface Point {
  /** Epoch seconds. */
  t: number;
  /** The value, or null for a gap (NaN). */
  v: number | null;
}

export interface Series {
  /** A stable identity: the sorted labels as JSON. Colours follow this, never the position. */
  key: string;
  labels: Labels;
  /** The legend text. */
  name: string;
  /** The full default name (`name{a="b"}`) when `name` was shortened. The tooltip shows it. */
  fullName?: string;
  points: Point[];
}

export interface Sample {
  key: string;
  labels: Labels;
  name: string;
  value: number | null;
}

export interface PromEnvelope {
  status?: string;
  error?: string;
  errorType?: string;
  data?: { resultType?: string; result?: unknown };
}

/** A sample value from the API is a string: "1.5", "NaN", "+Inf". Non-finite values become null. */
export function parseValue(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function labelKey(labels: Labels): string {
  return JSON.stringify(
    Object.keys(labels)
      .sort()
      .map(k => [k, labels[k]])
  );
}

/** `{{label}}` placeholders in a legend template. An empty template gives the default name. */
export function legendName(
  template: string | undefined,
  labels: Labels,
  fallback = 'value'
): string {
  if (template && template.trim() !== '') {
    return template.replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, (_, key: string) => labels[key] ?? '');
  }
  return defaultName(labels, fallback);
}

/** The default series name: the metric name and the other labels, as `name{a="b"}`. */
export function defaultName(labels: Labels, fallback = 'value'): string {
  const name = labels.__name__ ?? '';
  const rest = Object.keys(labels)
    .filter(k => k !== '__name__')
    .sort()
    .map(k => `${k}="${labels[k]}"`);
  if (rest.length === 0) return name || fallback;
  return `${name}{${rest.join(', ')}}`;
}

/**
 * Shorter legend names for series that have no label template: only the label values that differ between the
 * series, in label order, joined with " / ". The full default name moves to `fullName`. A series set with nothing
 * that differs, or a short name that two series share, keeps its full name.
 */
export function shortenNames(series: Series[]): Series[] {
  if (series.length < 2) return series;
  const keys = [...new Set(series.flatMap(s => Object.keys(s.labels)))].sort();
  const differing = keys.filter(k => new Set(series.map(s => s.labels[k] ?? '')).size > 1);
  if (differing.length === 0) return series;
  const shorts = series.map(s =>
    differing
      .map(k => s.labels[k] ?? '')
      .filter(v => v !== '')
      .join(' / ')
  );
  const count = new Map<string, number>();
  shorts.forEach(n => count.set(n, (count.get(n) ?? 0) + 1));
  return series.map((s, i) =>
    shorts[i] === '' || (count.get(shorts[i]) ?? 0) > 1
      ? s
      : { ...s, name: shorts[i], fullName: s.name }
  );
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

/** The `data.result` of a query_range response (a matrix) as series. Bad entries are skipped. */
export function parseMatrix(result: unknown, template?: string): Series[] {
  const out: Series[] = [];
  for (const entry of asArray(result)) {
    const labels: Labels =
      entry && typeof entry.metric === 'object' && entry.metric ? entry.metric : {};
    const points: Point[] = [];
    for (const pair of asArray(entry?.values)) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'number') continue;
      points.push({ t: pair[0], v: parseValue(pair[1]) });
    }
    out.push({ key: labelKey(labels), labels, name: legendName(template, labels), points });
  }
  return out;
}

/** The `data.result` of an instant query: a vector, or a scalar or string result. */
export function parseVector(result: unknown, template?: string, resultType = 'vector'): Sample[] {
  if (resultType === 'scalar' || resultType === 'string') {
    const pair = Array.isArray(result) ? result : [];
    return [
      { key: labelKey({}), labels: {}, name: legendName(template, {}), value: parseValue(pair[1]) },
    ];
  }
  const out: Sample[] = [];
  for (const entry of asArray(result)) {
    const labels: Labels =
      entry && typeof entry.metric === 'object' && entry.metric ? entry.metric : {};
    const pair = Array.isArray(entry?.value) ? entry.value : [];
    out.push({
      key: labelKey(labels),
      labels,
      name: legendName(template, labels),
      value: parseValue(pair[1]),
    });
  }
  return out;
}

/** Throws a readable error when the envelope is not a success. */
export function assertSuccess(body: PromEnvelope | undefined | null): asserts body is PromEnvelope {
  if (!body || typeof body !== 'object')
    throw new Error('The metrics service sent an unreadable answer.');
  if (body.status !== 'success') {
    throw new Error(body.error ? `Query failed: ${body.error}` : 'The metrics query failed.');
  }
}

// ---- time series helpers ----

/** The sorted union of the timestamps of all series. */
export function mergeTimes(series: Series[]): number[] {
  const set = new Set<number>();
  for (const s of series) for (const p of s.points) set.add(p.t);
  return [...set].sort((a, b) => a - b);
}

/** The index of the time nearest to `t`. The list is sorted and not empty. */
export function nearestIndex(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  if (times.length === 0) return -1;
  return Math.abs(times[lo] - t) <= Math.abs(times[hi] - t) ? lo : hi;
}

/** The value of a series at an exact time, or null. */
export function valueAt(s: Series, t: number): number | null {
  let lo = 0;
  let hi = s.points.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const pt = s.points[mid].t;
    if (pt === t) return s.points[mid].v;
    if (pt < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

export interface SeriesStats {
  last: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
}

export function seriesStats(s: Series): SeriesStats {
  let last: number | null = null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (const p of s.points) {
    if (p.v === null) continue;
    last = p.v;
    min = Math.min(min, p.v);
    max = Math.max(max, p.v);
    sum += p.v;
    n += 1;
  }
  return n === 0
    ? { last: null, min: null, max: null, avg: null }
    : { last, min, max, avg: sum / n };
}

/** The running totals for a stacked chart: `tops[i][j]` is the top of series i at time j. Gaps count as 0. */
export function stackSeries(
  series: Series[],
  times: number[]
): { bases: number[][]; tops: number[][] } {
  const bases: number[][] = [];
  const tops: number[][] = [];
  const running = times.map(() => 0);
  for (const s of series) {
    const byTime = new Map<number, number | null>();
    for (const p of s.points) byTime.set(p.t, p.v);
    const base = [...running];
    times.forEach((t, j) => {
      const v = byTime.get(t);
      running[j] += typeof v === 'number' ? Math.max(0, v) : 0;
    });
    bases.push(base);
    tops.push([...running]);
  }
  return { bases, tops };
}

// ---- instant helpers ----

export type Reduce = 'first' | 'sum' | 'avg' | 'max' | 'min';

export const REDUCE_OPTIONS: ReadonlyArray<{ value: Reduce; label: string }> = [
  { value: 'first', label: 'First series' },
  { value: 'sum', label: 'Sum of all series' },
  { value: 'avg', label: 'Average of all series' },
  { value: 'max', label: 'Largest series' },
  { value: 'min', label: 'Smallest series' },
];

/** One number from several samples. Returns null when none has a value. */
export function reduceSamples(values: Array<number | null>, how: Reduce): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number');
  if (nums.length === 0) return null;
  switch (how) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'max':
      return Math.max(...nums);
    case 'min':
      return Math.min(...nums);
    default:
      return nums[0];
  }
}

/** The labels shown as table columns: the chosen ones, or every label except the metric name. */
export function pickLabelColumns(samples: Array<{ labels: Labels }>, chosen: string): string[] {
  const wanted = chosen
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (wanted.length > 0) return wanted;
  const all = new Set<string>();
  for (const s of samples) for (const k of Object.keys(s.labels)) if (k !== '__name__') all.add(k);
  return [...all].sort();
}

export interface TableRow {
  key: string;
  cells: string[];
  values: Array<number | null>;
}

/**
 * Join the result of several queries into rows. A row is one combination of the chosen label
 * values. A query adds one value column. A query with no sample for a row leaves its cell empty.
 */
export function buildTableRows(results: Sample[][], columns: string[]): TableRow[] {
  const rows = new Map<string, TableRow>();
  results.forEach((samples, qi) => {
    for (const s of samples) {
      const cells = columns.map(c => s.labels[c] ?? '');
      const key = JSON.stringify(cells);
      let row = rows.get(key);
      if (!row) {
        row = { key, cells, values: results.map(() => null) };
        rows.set(key, row);
      }
      // Several series with the same chosen labels add up, so no sample is lost.
      const prev = row.values[qi];
      row.values[qi] = s.value === null ? prev : (prev ?? 0) + s.value;
    }
  });
  return [...rows.values()];
}

export interface Group {
  key: string;
  name: string;
  value: number;
}

/**
 * Group an instant vector by a label. Every group is kept at its real size: there is no top-N and
 * no "Other" group. Series with the same label value add up. Series with no value are left out.
 */
export function groupSamples(samples: Sample[], label: string): Group[] {
  const groups = new Map<string, Group>();
  for (const s of samples) {
    if (s.value === null) continue;
    const name = label.trim() === '' ? s.name : s.labels[label.trim()] ?? '(none)';
    const g = groups.get(name);
    if (g) g.value += s.value;
    else groups.set(name, { key: name, name, value: s.value });
  }
  return [...groups.values()].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}
