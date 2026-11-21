/*
 * The panel model (version 1) that a panel source serves on `GET /api/widgets/<id>`. The agent
 * layer is one source, and external apps may serve the same API. The parsers are strict about the
 * shape (a wrong shape or version is an error) and forgiving about extra fields: unknown fields
 * are ignored, a bad value is dropped or replaced by a default, and the widget never throws on
 * bad data. The types match `agent/src/widgets.ts`, plus the optional `tables` field.
 */
import type { SunburstCategory, SunburstData, SunburstGroupBy } from '../sunburst/geometry';

export type PanelStatus = 'ok' | 'warn' | 'crit' | 'unknown';

export interface Stat {
  label: string;
  value: string;
  status: PanelStatus;
}

/** The icon of a row. `src` is a safe relative path (see `safeIconPath`); `alt` is the engine kind. */
export interface PanelRowIcon {
  src: string;
  alt: string;
}

export interface PanelRow {
  label: string;
  detail: string;
  value: string;
  /** Between 0 and 1. */
  fraction?: number;
  status: PanelStatus;
  link?: string;
  /**
   * An optional v1 extension (also in `agent/src/widgets.ts`). `src` is relative to the source's
   * `/api/widgets/` base, for example `icons/postgresql.svg`. A bad value drops the icon, never the row.
   */
  icon?: PanelRowIcon;
  /**
   * An optional v1 extension: named text fields for a widget that joins several panels (the alerts
   * and incidents widget). Only string values are kept, a bad entry is dropped, never the row.
   */
  meta?: Record<string, string>;
}

export interface PanelSeries {
  label: string;
  points: number[];
  /**
   * An optional v1 extension: the value that the series must stay under (for example 5 for a lag
   * of 5 seconds). The plot draws it as a dashed line. A bad value drops the line, never the series.
   */
  limit?: number;
  /** An optional v1 extension: the unit of the values, for the axis (for example `s`). */
  unit?: string;
}

export interface RingSegment {
  key: string;
  label: string;
  value: number;
  children?: RingSegment[];
}

/** One node of a ring: its own capacity and use, and its categories with their children. */
export interface RingNode {
  key: string;
  label: string;
  capacity: number;
  used: number;
  segments: RingSegment[];
}

export interface PanelRing {
  id: string;
  label: string;
  unit: 'cores' | 'bytes' | string;
  capacity: number;
  used: number;
  segments: RingSegment[];
  /** The same data split by node first. Absent from an older agent. */
  nodes?: RingNode[];
}

export interface PanelTableColumn {
  key: string;
  label: string;
  align: 'left' | 'right';
}

/** An optional v1 extension: a titled table with its own columns. */
export interface PanelTable {
  title: string;
  columns: PanelTableColumn[];
  rows: Array<Record<string, string | number>>;
}

export type RunState = 'running' | 'queued';
export type StepState = 'done' | 'running' | 'failed' | 'skipped' | 'pending';
const RUN_STATES: RunState[] = ['running', 'queued'];
const STEP_STATES: StepState[] = ['done', 'running', 'failed', 'skipped', 'pending'];

export interface PanelStep {
  name: string;
  state: StepState;
}

/** One job of a workflow run, with its steps in order. */
export interface PanelJob {
  id: string;
  name: string;
  state: RunState;
  pool: string;
  /** Seconds the job has run (running) or waited (queued). */
  seconds: number;
  steps: PanelStep[];
}

/**
 * An optional v1 extension: one workflow run that is running or queued, with its jobs and their
 * steps. A source serves it in a panel with the id `runs`.
 */
export interface PanelRun {
  id: string;
  repo: string;
  workflow: string;
  /** The branch or pull request of the run. */
  ref: string;
  pool: string;
  state: RunState;
  /** Seconds the run has run (running) or waited (queued). */
  seconds: number;
  link?: string;
  jobs: PanelJob[];
}

export interface PanelModel {
  id: string;
  title: string;
  generatedAt: string;
  link: string;
  status: PanelStatus;
  summary: string;
  stats: Stat[];
  rows: PanelRow[];
  series: PanelSeries[];
  rings: PanelRing[];
  tables: PanelTable[];
  runs: PanelRun[];
}

export interface PanelInfo {
  id: string;
  title: string;
  description: string;
  plugin: string;
  link: string;
  refreshSeconds: number;
}

const STATUSES: PanelStatus[] = ['ok', 'warn', 'crit', 'unknown'];
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const status = (v: unknown): PanelStatus =>
  STATUSES.includes(v as PanelStatus) ? (v as PanelStatus) : 'unknown';
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Only web and path links open from a panel. Anything else (javascript:, data:) is dropped. */
export function safeLink(href: unknown): string | undefined {
  if (typeof href !== 'string') return undefined;
  const v = href.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('/') && !v.startsWith('//')) return v;
  return undefined;
}

const ICON_PATH_MAX = 200;
const ICON_ALT_MAX = 80;
const ICON_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * An icon path is safe when it is relative to the source's `/api/widgets/` base: no scheme, no
 * leading slash, no backslash, no empty, `.` or `..` segment, no query or fragment, only URL-safe
 * characters, a `.svg` or `.png` ending and a limited length. Anything else gives undefined.
 */
export function safeIconPath(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const path = v.trim();
  if (path === '' || path.length > ICON_PATH_MAX) return undefined;
  if (!/\.(svg|png)$/i.test(path)) return undefined;
  const segments = path.split('/');
  const ok = segments.every(seg => seg !== '.' && seg !== '..' && ICON_SEGMENT.test(seg));
  return ok ? path : undefined;
}

/** The icon of a row, or undefined for a missing or unsafe one. `alt` defaults to the row label. */
export function parseRowIcon(raw: unknown, label: string): PanelRowIcon | undefined {
  if (!isObject(raw)) return undefined;
  const src = safeIconPath(raw.src);
  if (src === undefined) return undefined;
  const alt = str(raw.alt).trim().slice(0, ICON_ALT_MAX);
  return { src, alt: alt === '' ? label : alt };
}

const META_KEY = /^[a-z][A-Za-z0-9_]{0,23}$/;
const META_MAX_KEYS = 16;
const META_MAX_VALUE = 240;

/** The meta fields of a row: string values under safe keys, in a limited number and length. */
export function parseMeta(raw: unknown): Record<string, string> | undefined {
  if (!isObject(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= META_MAX_KEYS) break;
    if (META_KEY.test(k) && typeof v === 'string') out[k] = v.slice(0, META_MAX_VALUE);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseSegment(raw: unknown, depth: number): RingSegment | null {
  if (!isObject(raw)) return null;
  const key = str(raw.key);
  const value = num(raw.value);
  if (key === '' || value <= 0) return null;
  const seg: RingSegment = { key, label: str(raw.label, key), value };
  if (depth === 0) {
    const kids = array(raw.children)
      .map(c => parseSegment(c, 1))
      .filter((c): c is RingSegment => c !== null);
    if (kids.length > 0) seg.children = kids;
  }
  return seg;
}

function parseSegments(raw: unknown): RingSegment[] {
  return array(raw)
    .map(s => parseSegment(s, 0))
    .filter((s): s is RingSegment => s !== null);
}

function parseNode(raw: unknown): RingNode | null {
  if (!isObject(raw)) return null;
  const key = str(raw.key);
  if (key === '') return null;
  return {
    key,
    label: str(raw.label, key),
    capacity: Math.max(0, num(raw.capacity)),
    used: Math.max(0, num(raw.used)),
    segments: parseSegments(raw.segments),
  };
}

function parseRing(raw: unknown): PanelRing | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  if (id === '') return null;
  const nodes = array(raw.nodes)
    .map(parseNode)
    .filter((n): n is RingNode => n !== null);
  return {
    id,
    label: str(raw.label, id),
    unit: str(raw.unit, 'bytes'),
    capacity: Math.max(0, num(raw.capacity)),
    used: Math.max(0, num(raw.used)),
    segments: parseSegments(raw.segments),
    ...(nodes.length > 0 ? { nodes } : {}),
  };
}

const oneOf = <T extends string>(v: unknown, list: ReadonlyArray<T>, fallback: T): T =>
  list.includes(v as T) ? (v as T) : fallback;
const seconds = (v: unknown): number => Math.max(0, num(v));

function parseJob(raw: unknown): PanelJob | null {
  if (!isObject(raw)) return null;
  const name = str(raw.name);
  if (name === '') return null;
  return {
    id: str(raw.id, name),
    name,
    state: oneOf(raw.state, RUN_STATES, 'running'),
    pool: str(raw.pool),
    seconds: seconds(raw.seconds),
    steps: array(raw.steps)
      .filter(isObject)
      .map(s => ({ name: str(s.name), state: oneOf(s.state, STEP_STATES, 'pending') })),
  };
}

function parseRun(raw: unknown): PanelRun | null {
  if (!isObject(raw)) return null;
  const repo = str(raw.repo);
  if (repo === '') return null;
  const workflow = str(raw.workflow);
  const ref = str(raw.ref);
  return {
    id: str(raw.id, `${repo} ${workflow} ${ref}`),
    repo,
    workflow,
    ref,
    pool: str(raw.pool),
    state: oneOf(raw.state, RUN_STATES, 'queued'),
    seconds: seconds(raw.seconds),
    link: safeLink(raw.link),
    jobs: array(raw.jobs)
      .map(parseJob)
      .filter((j): j is PanelJob => j !== null),
  };
}

function parseTable(raw: unknown): PanelTable | null {
  if (!isObject(raw)) return null;
  const columns = array(raw.columns)
    .filter(isObject)
    .map(c => ({
      key: str(c.key),
      label: str(c.label, str(c.key)),
      align: c.align === 'right' ? ('right' as const) : ('left' as const),
    }))
    .filter(c => c.key !== '');
  if (columns.length === 0) return null;
  const rows = array(raw.rows)
    .filter(isObject)
    .map(r => {
      const row: Record<string, string | number> = {};
      for (const c of columns) {
        const v = r[c.key];
        row[c.key] = typeof v === 'number' && Number.isFinite(v) ? v : str(v);
      }
      return row;
    });
  return { title: str(raw.title), columns, rows };
}

/**
 * The version check of a response. Only version 1 is known. Throws a short message for anything else,
 * so the widget shows a clear error card for an app that does not serve the panel API.
 */
function checkVersion(json: Record<string, unknown>, what: string): void {
  if (json.version === undefined)
    throw new Error(`The source sent ${what} with no version. Expected version 1.`);
  if (json.version !== 1)
    throw new Error(
      `The source sent ${what} with version ${str(json.version, '?')}. Only version 1 is supported.`
    );
}

/** A panel from the JSON a source served. Throws an error with a short message when it is not a panel. */
export function parsePanel(json: unknown): PanelModel {
  if (!isObject(json)) throw new Error('The source sent an answer that is not a panel.');
  checkVersion(json, 'a panel');
  const id = str(json.id);
  if (id === '') throw new Error('The source sent a panel with no id.');
  return {
    id,
    title: str(json.title, id),
    generatedAt: str(json.generatedAt),
    link: str(json.link),
    status: status(json.status),
    summary: str(json.summary),
    stats: array(json.stats)
      .filter(isObject)
      .map(s => ({ label: str(s.label), value: str(s.value), status: status(s.status) })),
    rows: array(json.rows)
      .filter(isObject)
      .map(r => {
        const fraction =
          typeof r.fraction === 'number' && Number.isFinite(r.fraction)
            ? Math.min(1, Math.max(0, r.fraction))
            : undefined;
        const label = str(r.label);
        return {
          label,
          detail: str(r.detail),
          value: str(r.value),
          fraction,
          status: status(r.status),
          link: safeLink(r.link),
          icon: parseRowIcon(r.icon, label),
          meta: parseMeta(r.meta),
        };
      }),
    series: array(json.series)
      .filter(isObject)
      .map(s => {
        const series: PanelSeries = {
          label: str(s.label),
          points: array(s.points).filter(
            (p): p is number => typeof p === 'number' && Number.isFinite(p)
          ),
        };
        if (typeof s.limit === 'number' && Number.isFinite(s.limit) && s.limit > 0)
          series.limit = s.limit;
        const unit = str(s.unit).trim().slice(0, 8);
        if (unit !== '') series.unit = unit;
        return series;
      }),
    rings: array(json.rings)
      .map(parseRing)
      .filter((r): r is PanelRing => r !== null),
    tables: array(json.tables)
      .map(parseTable)
      .filter((t): t is PanelTable => t !== null),
    runs: array(json.runs)
      .map(parseRun)
      .filter((r): r is PanelRun => r !== null),
  };
}

/** The panel list from `GET /api/widgets`: `{ version: 1, panels: [...] }`. Throws a short message for any other shape. */
export function parsePanelList(json: unknown): PanelInfo[] {
  if (!isObject(json)) throw new Error('The source sent an answer that is not a panel list.');
  checkVersion(json, 'a panel list');
  if (!Array.isArray(json.panels))
    throw new Error('The source sent a panel list with no panels field.');
  return json.panels
    .filter(isObject)
    .map(p => ({
      id: str(p.id),
      title: str(p.title, str(p.id)),
      description: str(p.description),
      plugin: str(p.plugin),
      link: str(p.link),
      refreshSeconds: Math.max(0, num(p.refreshSeconds)),
    }))
    .filter(p => p.id !== '');
}

/** A panel is empty when it shows nothing at all. */
export const isEmptyPanel = (p: PanelModel): boolean =>
  p.stats.length === 0 &&
  p.rows.length === 0 &&
  p.series.every(s => s.points.length === 0) &&
  p.rings.every(r => r.segments.length === 0) &&
  p.tables.every(t => t.rows.length === 0) &&
  p.runs.length === 0 &&
  p.summary === '';

/** A ring as sunburst data. Every segment stays its own arc: nothing is merged or cut. */
export function ringToSunburst(
  ring: PanelRing,
  options: { groupBy?: SunburstGroupBy } = {}
): SunburstData {
  const nodes =
    options.groupBy === 'node' && ring.nodes && ring.nodes.length > 0
      ? ring.nodes.map(n => ({
          key: n.key,
          label: n.label,
          capacity: n.capacity,
          used: n.used,
          categories: n.segments.map(s => ({
            key: s.key,
            label: s.label,
            value: s.value,
            children: (s.children ?? []).map(c => ({ key: c.key, label: c.label, value: c.value })),
          })),
        }))
      : undefined;
  const categories: SunburstCategory[] = ring.segments.map(s => ({
    key: s.key,
    label: s.label,
    value: s.value,
    children: (s.children ?? []).map(c => ({ key: c.key, label: c.label, value: c.value })),
  }));
  return { capacity: ring.capacity, categories, ...(nodes ? { nodes } : {}) };
}

/**
 * Whether a refresh signal may fetch now. The panel's own `refreshSeconds` is the smallest
 * time between two fetches, so a short dashboard interval never polls a panel faster than
 * the panel allows. The first fetch always runs.
 */
export function mayFetch(lastFetchAt: number | null, now: number, minSeconds: number): boolean {
  if (lastFetchAt === null) return true;
  return now - lastFetchAt >= Math.max(0, minSeconds) * 1000;
}

export type SortDir = 'asc' | 'desc';

/** The rows of a table sorted by one column. Numbers sort as numbers and text sorts naturally. The input is not changed. */
export function sortTableRows(
  rows: PanelTable['rows'],
  key: string,
  dir: SortDir
): PanelTable['rows'] {
  const sign = dir === 'asc' ? 1 : -1;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const x = a.row[key];
      const y = b.row[key];
      const c =
        typeof x === 'number' && typeof y === 'number'
          ? x - y
          : collator.compare(String(x ?? ''), String(y ?? ''));
      // The original order breaks ties, so the sort is stable in both directions.
      return c === 0 ? a.index - b.index : sign * c;
    })
    .map(e => e.row);
}
