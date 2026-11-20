/*
 * The panel model (version 1) that a panel source serves on `GET /api/widgets/<id>`. The agent
 * layer is one source, and external apps may serve the same API. The parsers are strict about the
 * shape (a wrong shape or version is an error) and forgiving about extra fields: unknown fields
 * are ignored, a bad value is dropped or replaced by a default, and the widget never throws on
 * bad data. The types match `agent/src/widgets.ts`, plus the optional `tables` field.
 */
import type { SunburstCategory, SunburstData } from '../sunburst/geometry';

export type PanelStatus = 'ok' | 'warn' | 'crit' | 'unknown';

export interface Stat {
  label: string;
  value: string;
  status: PanelStatus;
}

export interface PanelRow {
  label: string;
  detail: string;
  value: string;
  /** Between 0 and 1. */
  fraction?: number;
  status: PanelStatus;
  link?: string;
}

export interface PanelSeries {
  label: string;
  points: number[];
}

export interface RingSegment {
  key: string;
  label: string;
  value: number;
  children?: RingSegment[];
}

export interface PanelRing {
  id: string;
  label: string;
  unit: 'cores' | 'bytes' | string;
  capacity: number;
  used: number;
  segments: RingSegment[];
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
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const status = (v: unknown): PanelStatus => (STATUSES.includes(v as PanelStatus) ? (v as PanelStatus) : 'unknown');
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Only web and path links open from a panel. Anything else (javascript:, data:) is dropped. */
export function safeLink(href: unknown): string | undefined {
  if (typeof href !== 'string') return undefined;
  const v = href.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('/') && !v.startsWith('//')) return v;
  return undefined;
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

function parseRing(raw: unknown): PanelRing | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  if (id === '') return null;
  return {
    id,
    label: str(raw.label, id),
    unit: str(raw.unit, 'bytes'),
    capacity: Math.max(0, num(raw.capacity)),
    used: Math.max(0, num(raw.used)),
    segments: array(raw.segments)
      .map(s => parseSegment(s, 0))
      .filter((s): s is RingSegment => s !== null),
  };
}

function parseTable(raw: unknown): PanelTable | null {
  if (!isObject(raw)) return null;
  const columns = array(raw.columns)
    .filter(isObject)
    .map(c => ({ key: str(c.key), label: str(c.label, str(c.key)), align: c.align === 'right' ? ('right' as const) : ('left' as const) }))
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
  if (json.version === undefined) throw new Error(`The source sent ${what} with no version. Expected version 1.`);
  if (json.version !== 1) throw new Error(`The source sent ${what} with version ${str(json.version, '?')}. Only version 1 is supported.`);
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
        const fraction = typeof r.fraction === 'number' && Number.isFinite(r.fraction) ? Math.min(1, Math.max(0, r.fraction)) : undefined;
        return {
          label: str(r.label),
          detail: str(r.detail),
          value: str(r.value),
          fraction,
          status: status(r.status),
          link: safeLink(r.link),
        };
      }),
    series: array(json.series)
      .filter(isObject)
      .map(s => ({
        label: str(s.label),
        points: array(s.points).filter((p): p is number => typeof p === 'number' && Number.isFinite(p)),
      })),
    rings: array(json.rings)
      .map(parseRing)
      .filter((r): r is PanelRing => r !== null),
    tables: array(json.tables)
      .map(parseTable)
      .filter((t): t is PanelTable => t !== null),
  };
}

/** The panel list from `GET /api/widgets`: `{ version: 1, panels: [...] }`. Throws a short message for any other shape. */
export function parsePanelList(json: unknown): PanelInfo[] {
  if (!isObject(json)) throw new Error('The source sent an answer that is not a panel list.');
  checkVersion(json, 'a panel list');
  if (!Array.isArray(json.panels)) throw new Error('The source sent a panel list with no panels field.');
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
  p.stats.length === 0 && p.rows.length === 0 && p.series.every(s => s.points.length === 0) && p.rings.every(r => r.segments.length === 0) && p.tables.every(t => t.rows.length === 0) && p.summary === '';

/** A ring as sunburst data. Every segment stays its own arc: nothing is merged or cut. */
export function ringToSunburst(ring: PanelRing): SunburstData {
  const categories: SunburstCategory[] = ring.segments.map(s => ({
    key: s.key,
    label: s.label,
    value: s.value,
    children: (s.children ?? []).map(c => ({ key: c.key, label: c.label, value: c.value })),
  }));
  return { capacity: ring.capacity, categories };
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
export function sortTableRows(rows: PanelTable['rows'], key: string, dir: SortDir): PanelTable['rows'] {
  const sign = dir === 'asc' ? 1 : -1;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const x = a.row[key];
      const y = b.row[key];
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x ?? ''), String(y ?? ''));
      // The original order breaks ties, so the sort is stable in both directions.
      return c === 0 ? a.index - b.index : sign * c;
    })
    .map(e => e.row);
}
