/* The saved settings of the Kubernetes report widget, with defaults and a defensive normaliser. */
import { FILTER_OPS, ReportFilter } from './filters';

export interface SourceRef {
  /** API group. Empty for the core group. */
  group: string;
  version: string;
  /** The plural resource name, for example `pods`. */
  plural: string;
  kind: string;
  namespaced: boolean;
}

export interface ColumnSpec {
  /** A common field id or a field path. */
  field: string;
  /** An edited header. Empty uses the default. */
  header: string;
}

export const AGG_FNS = ['sum', 'avg', 'min', 'max'] as const;
export type AggFn = (typeof AGG_FNS)[number];

export interface AggregateSpec {
  field: string;
  fn: AggFn;
}

export type ReportType = 'tabular' | 'summary' | 'matrix';
export type ChartType = 'none' | 'bar' | 'hbar' | 'donut' | 'stacked';
export type SortDir = 'asc' | 'desc';

export interface ReportConfig {
  source: SourceRef;
  columns: ColumnSpec[];
  filters: ReportFilter[];
  /** A custom logic string such as `1 AND (2 OR 3)`. Empty means AND. */
  logic: string;
  reportType: ReportType;
  /** Up to two fields. */
  groupBy: string[];
  aggregates: AggregateSpec[];
  groupSort: 'key' | 'count';
  /** Summary: show the rows inside the leaf groups. */
  showRows: boolean;
  /** Summary: groups start open. */
  expandGroups: boolean;
  matrixRow: string;
  matrixCol: string;
  /** `count` or an aggregate function over `matrixField`. */
  matrixFn: 'count' | AggFn;
  matrixField: string;
  chart: ChartType;
  /** -1 charts the row count. Otherwise the index of an aggregate. */
  chartMeasure: number;
  sortField: string;
  sortDir: SortDir;
}

export const DEFAULT_SOURCE: SourceRef = {
  group: '',
  version: 'v1',
  plural: 'pods',
  kind: 'Pod',
  namespaced: true,
};

export const DEFAULT_REPORT: ReportConfig = {
  source: DEFAULT_SOURCE,
  columns: [
    { field: 'name', header: '' },
    { field: 'namespace', header: '' },
    { field: 'status', header: '' },
    { field: 'ready', header: '' },
    { field: 'restarts', header: '' },
    { field: 'node', header: '' },
    { field: 'age', header: '' },
  ],
  filters: [],
  logic: '',
  reportType: 'tabular',
  groupBy: ['status'],
  aggregates: [],
  groupSort: 'key',
  showRows: false,
  expandGroups: true,
  matrixRow: 'namespace',
  matrixCol: 'status',
  matrixFn: 'count',
  matrixField: '',
  chart: 'none',
  chartMeasure: -1,
  sortField: '',
  sortDir: 'asc',
};

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Make any saved value safe to use: wrong types fall back to defaults and never throw. */
export function normaliseConfig(raw: unknown): ReportConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const d = DEFAULT_REPORT;
  const s = c.source && typeof c.source === 'object' ? c.source : {};
  const source: SourceRef =
    typeof s.plural === 'string' &&
    s.plural !== '' &&
    typeof s.version === 'string' &&
    s.version !== ''
      ? {
          group: str(s.group),
          version: s.version,
          plural: s.plural,
          kind: str(s.kind, s.plural),
          namespaced: s.namespaced !== false,
        }
      : d.source;
  const columns: ColumnSpec[] = Array.isArray(c.columns)
    ? c.columns
        .filter((x: any) => x && typeof x.field === 'string' && x.field.trim() !== '')
        .map((x: any) => ({ field: x.field.trim(), header: str(x.header) }))
    : d.columns;
  const filters: ReportFilter[] = Array.isArray(c.filters)
    ? c.filters
        .filter((x: any) => x && typeof x === 'object')
        .map((x: any) => ({
          field: str(x.field),
          op: oneOf(x.op, FILTER_OPS, 'eq'),
          value: str(x.value),
        }))
    : d.filters;
  const aggregates: AggregateSpec[] = Array.isArray(c.aggregates)
    ? c.aggregates
        .filter((x: any) => x && typeof x.field === 'string' && x.field.trim() !== '')
        .map((x: any) => ({ field: x.field.trim(), fn: oneOf(x.fn, AGG_FNS, 'sum') }))
    : d.aggregates;
  return {
    source,
    columns,
    filters,
    logic: str(c.logic),
    reportType: oneOf(c.reportType, ['tabular', 'summary', 'matrix'] as const, d.reportType),
    groupBy: Array.isArray(c.groupBy)
      ? c.groupBy.filter((x: unknown) => typeof x === 'string' && x.trim() !== '').slice(0, 2)
      : d.groupBy,
    aggregates,
    groupSort: oneOf(c.groupSort, ['key', 'count'] as const, d.groupSort),
    showRows: c.showRows === true,
    expandGroups: c.expandGroups !== false,
    matrixRow: str(c.matrixRow, d.matrixRow),
    matrixCol: str(c.matrixCol, d.matrixCol),
    matrixFn: oneOf(c.matrixFn, ['count', ...AGG_FNS] as const, 'count'),
    matrixField: str(c.matrixField),
    chart: oneOf(c.chart, ['none', 'bar', 'hbar', 'donut', 'stacked'] as const, 'none'),
    chartMeasure: Number.isInteger(c.chartMeasure) ? c.chartMeasure : -1,
    sortField: str(c.sortField),
    sortDir: oneOf(c.sortDir, ['asc', 'desc'] as const, 'asc'),
  };
}
