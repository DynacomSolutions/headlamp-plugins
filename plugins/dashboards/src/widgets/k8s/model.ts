/*
 * The report model: a pure function from objects and settings to a tabular, summary or matrix
 * report. It does no I/O and holds no state, so the widget memoises it on (objects, config, filters).
 */
import { AggFn, AggregateSpec, ReportConfig } from './config';
import { Cell, compareCells, defaultHeader, getCell, toNumber } from './fields';
import { compileFilters } from './filters';

export const NONE_LABEL = '(none)';

export interface ScopeFilters {
  namespaces: string[];
  nodes: string[];
}

export interface RowView {
  /** A stable key: the object uid, or namespace/name. */
  key: string;
  obj: any;
  cells: Cell[];
  /** One number (or null) per aggregate of the config. */
  nums: Array<number | null>;
}

export interface ColumnView {
  field: string;
  header: string;
}

export interface Group {
  /** A unique id for collapse state: the path of the values from the top. */
  id: string;
  field: string;
  label: string;
  depth: number;
  count: number;
  aggs: Array<number | null>;
  children: Group[];
  /** Rows of a leaf group only. */
  rows: RowView[];
}

export interface Totals {
  count: number;
  aggs: Array<number | null>;
}

export interface TabularReport {
  type: 'tabular';
  columns: ColumnView[];
  rows: RowView[];
  logicError: string | null;
}

export interface SummaryReport {
  type: 'summary';
  columns: ColumnView[];
  groupFields: string[];
  aggregates: Array<AggregateSpec & { header: string }>;
  groups: Group[];
  total: Totals;
  logicError: string | null;
}

export interface MatrixReport {
  type: 'matrix';
  rowField: string;
  colField: string;
  /** What each cell shows, for example "Count" or "sum of restarts". */
  measure: string;
  rowLabels: string[];
  colLabels: string[];
  cells: Array<Array<number | null>>;
  rowTotals: Array<number | null>;
  colTotals: Array<number | null>;
  grandTotal: number | null;
  logicError: string | null;
}

export type Report = TabularReport | SummaryReport | MatrixReport;

/* --------------------------------- aggregates --------------------------------- */

export function aggregate(values: Array<number | null>, fn: AggFn): number | null {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (nums.length === 0) return null;
  switch (fn) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
  }
}

/** Round to at most three decimals for display. */
export function formatNumber(n: number | null): string {
  if (n === null) return '';
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}

/* ---------------------------------- scoping ---------------------------------- */

/**
 * Apply the dashboard filters that can be checked on the object itself. The label selector is
 * sent to the API server, so it is not checked here.
 */
export function scopeObjects(objects: any[], scope: ScopeFilters, namespaced: boolean, now: number): any[] {
  const ns = scope.namespaces.length > 0 && namespaced ? new Set(scope.namespaces) : null;
  const nodes = scope.nodes.length > 0 ? new Set(scope.nodes) : null;
  if (!ns && !nodes) return objects;
  return objects.filter(o => {
    if (ns && !ns.has(o?.metadata?.namespace)) return false;
    if (nodes) {
      // Nodes apply to Pods (spec.nodeName) and to Nodes themselves. Other kinds have no node.
      if (o?.kind === 'Pod' || o?.spec?.nodeName !== undefined || o?.kind === 'Node') {
        const node = getCell(o, 'node', now).value;
        if (typeof node !== 'string' || !nodes.has(node)) return false;
      }
    }
    return true;
  });
}

/* ----------------------------------- build ----------------------------------- */

function rowKey(obj: any, index: number): string {
  return obj?.metadata?.uid ?? `${obj?.metadata?.namespace ?? ''}/${obj?.metadata?.name ?? index}`;
}

function numberOf(obj: any, field: string, now: number): number | null {
  return toNumber(getCell(obj, field, now).value);
}

function columnViews(config: ReportConfig): ColumnView[] {
  const cols = config.columns.length > 0 ? config.columns : [{ field: 'name', header: '' }];
  return cols.map(c => ({ field: c.field, header: c.header.trim() !== '' ? c.header : defaultHeader(c.field) }));
}

/** The header of a field, preferring a column header the user edited. */
export function fieldHeader(config: ReportConfig, field: string): string {
  const col = config.columns.find(c => c.field === field && c.header.trim() !== '');
  return col ? col.header : defaultHeader(field);
}

export interface BuildOptions {
  now: number;
  scope: ScopeFilters;
  /** The interactive sort. Empty field uses the saved sort, then no sort. */
  sortField?: string;
  sortDir?: 'asc' | 'desc';
}

export function buildRows(objects: any[], config: ReportConfig, options: BuildOptions): {
  rows: RowView[];
  columns: ColumnView[];
  logicError: string | null;
} {
  const { now } = options;
  const columns = columnViews(config);
  const scoped = scopeObjects(objects, options.scope, config.source.namespaced, now);
  const { test, logicError } = compileFilters(config.filters, config.logic, now);
  const aggs = config.reportType === 'summary' ? config.aggregates : [];
  const rows: RowView[] = [];
  scoped.forEach((obj, i) => {
    if (!test(obj)) return;
    rows.push({
      key: rowKey(obj, i),
      obj,
      cells: columns.map(c => getCell(obj, c.field, now)),
      nums: aggs.map(a => numberOf(obj, a.field, now)),
    });
  });
  const sortField = options.sortField ?? config.sortField;
  const sortDir = options.sortDir ?? config.sortDir;
  if (sortField !== '') {
    const idx = columns.findIndex(c => c.field === sortField);
    if (idx >= 0) sortRows(rows, idx, sortDir);
  }
  return { rows, columns, logicError };
}

/** Sort in place by a column index. The sort is stable, and empty cells always go last. */
export function sortRows(rows: RowView[], column: number, dir: 'asc' | 'desc'): RowView[] {
  const sign = dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const ca = a.cells[column];
    const cb = b.cells[column];
    const aEmpty = ca.value === null;
    const bEmpty = cb.value === null;
    if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
    return sign * compareCells(ca, cb);
  });
}

function aggregateHeader(config: ReportConfig, a: AggregateSpec): string {
  return `${a.fn} of ${fieldHeader(config, a.field)}`;
}

function groupLabel(cell: Cell): string {
  return cell.text === '' ? NONE_LABEL : cell.text;
}

function buildGroups(rows: RowView[], fields: string[], depth: number, parentId: string, config: ReportConfig, now: number): Group[] {
  const field = fields[depth];
  const buckets = new Map<string, { cell: Cell; rows: RowView[] }>();
  for (const row of rows) {
    const cell = getCell(row.obj, field, now);
    const label = groupLabel(cell);
    const bucket = buckets.get(label);
    if (bucket) bucket.rows.push(row);
    else buckets.set(label, { cell, rows: [row] });
  }
  const groups: Group[] = [...buckets.entries()].map(([label, b]) => {
    const id = `${parentId}/${label}`;
    const leaf = depth === fields.length - 1;
    return {
      id,
      field,
      label,
      depth,
      count: b.rows.length,
      aggs: totalsOf(b.rows, config.aggregates).aggs,
      children: leaf ? [] : buildGroups(b.rows, fields, depth + 1, id, config, now),
      rows: leaf ? b.rows : [],
    };
  });
  const cellOf = (g: Group): Cell => buckets.get(g.label)!.cell;
  groups.sort((a, b) => {
    if (a.label === NONE_LABEL || b.label === NONE_LABEL) {
      return a.label === b.label ? 0 : a.label === NONE_LABEL ? 1 : -1;
    }
    if (config.groupSort === 'count' && a.count !== b.count) return b.count - a.count;
    return compareCells(cellOf(a), cellOf(b));
  });
  return groups;
}

function totalsOf(rows: RowView[], aggregates: AggregateSpec[]): Totals {
  return {
    count: rows.length,
    aggs: aggregates.map((a, i) => aggregate(rows.map(r => r.nums[i] ?? null), a.fn)),
  };
}

function buildMatrix(objects: any[], config: ReportConfig, options: BuildOptions): MatrixReport {
  const { now } = options;
  const scoped = scopeObjects(objects, options.scope, config.source.namespaced, now);
  const { test, logicError } = compileFilters(config.filters, config.logic, now);
  const fn = config.matrixFn;
  const measureField = config.matrixField;
  const cellValues = new Map<string, Array<number | null>>();
  const rowValues = new Map<string, Array<number | null>>();
  const colValues = new Map<string, Array<number | null>>();
  const all: Array<number | null> = [];
  const rowCells = new Map<string, Cell>();
  const colCells = new Map<string, Cell>();
  for (const obj of scoped) {
    if (!test(obj)) continue;
    const rc = getCell(obj, config.matrixRow, now);
    const cc = getCell(obj, config.matrixCol, now);
    const r = groupLabel(rc);
    const c = groupLabel(cc);
    rowCells.set(r, rc);
    colCells.set(c, cc);
    // A count counts rows, so each row adds 1. An aggregate adds the row's number (or null).
    const v = fn === 'count' || measureField === '' ? 1 : numberOf(obj, measureField, now);
    const key = `${r}\u0000${c}`;
    for (const [map, k] of [
      [cellValues, key],
      [rowValues, r],
      [colValues, c],
    ] as const) {
      const list = map.get(k);
      if (list) list.push(v);
      else map.set(k, [v]);
    }
    all.push(v);
  }
  const reduce = (values: Array<number | null> | undefined): number | null => {
    if (!values) return null;
    if (fn === 'count' || measureField === '') return values.length;
    return aggregate(values, fn);
  };
  const order = (cells: Map<string, Cell>): string[] =>
    [...cells.keys()].sort((a, b) => {
      if (a === NONE_LABEL || b === NONE_LABEL) return a === b ? 0 : a === NONE_LABEL ? 1 : -1;
      return compareCells(cells.get(a)!, cells.get(b)!);
    });
  const rowLabels = order(rowCells);
  const colLabels = order(colCells);
  return {
    type: 'matrix',
    rowField: config.matrixRow,
    colField: config.matrixCol,
    measure:
      fn === 'count' || measureField === '' ? 'Count' : `${fn} of ${fieldHeader(config, measureField)}`,
    rowLabels,
    colLabels,
    cells: rowLabels.map(r => colLabels.map(c => reduce(cellValues.get(`${r}\u0000${c}`)))),
    rowTotals: rowLabels.map(r => reduce(rowValues.get(r))),
    colTotals: colLabels.map(c => reduce(colValues.get(c))),
    grandTotal: all.length === 0 ? null : reduce(all),
    logicError,
  };
}

export function buildReport(objects: any[], config: ReportConfig, options: BuildOptions): Report {
  if (config.reportType === 'matrix') return buildMatrix(objects, config, options);
  const { rows, columns, logicError } = buildRows(objects, config, options);
  if (config.reportType === 'summary' && config.groupBy.length > 0) {
    const fields = config.groupBy.slice(0, 2);
    return {
      type: 'summary',
      columns,
      groupFields: fields,
      aggregates: config.aggregates.map(a => ({ ...a, header: aggregateHeader(config, a) })),
      groups: buildGroups(rows, fields, 0, '', config, options.now),
      total: totalsOf(rows, config.aggregates),
      logicError,
    };
  }
  return { type: 'tabular', columns, rows, logicError };
}

/* ------------------------------ summary flattening ------------------------------ */

export type DisplayItem =
  | { kind: 'group'; group: Group; open: boolean; hasBody: boolean }
  | { kind: 'row'; row: RowView; depth: number }
  | { kind: 'total'; total: Totals };

/**
 * Flatten a summary into the visible lines, in order: a group line, its sub-groups or rows when
 * open, then the grand total. `toggled` holds ids whose state is the opposite of `defaultOpen`.
 */
export function flattenSummary(
  report: SummaryReport,
  toggled: ReadonlySet<string>,
  defaultOpen: boolean,
  showRows: boolean
): DisplayItem[] {
  const out: DisplayItem[] = [];
  const visit = (g: Group) => {
    const open = defaultOpen !== toggled.has(g.id);
    const hasBody = g.children.length > 0 || (showRows && g.rows.length > 0);
    out.push({ kind: 'group', group: g, open, hasBody });
    if (!open) return;
    g.children.forEach(visit);
    if (showRows) g.rows.forEach(row => out.push({ kind: 'row', row, depth: g.depth + 1 }));
  };
  report.groups.forEach(visit);
  out.push({ kind: 'total', total: report.total });
  return out;
}

/* ------------------------------------ CSV ------------------------------------ */

/** Quote a CSV field. A text field that starts with = + - or @ gets a leading quote mark (spreadsheet formulas). */
export function csvField(value: string | number | null, isNumber = false): string {
  let s = value === null ? '' : String(value);
  if (!isNumber && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(table: Array<Array<string | number | null>>): string {
  return table.map(line => line.map(v => csvField(v, typeof v === 'number')).join(',')).join('\r\n');
}

export function reportToTable(report: Report, config: ReportConfig): Array<Array<string | number | null>> {
  if (report.type === 'tabular') {
    return [report.columns.map(c => c.header), ...report.rows.map(r => r.cells.map(c => c.text))];
  }
  if (report.type === 'summary') {
    const levels = report.groupFields.map(f => fieldHeader(config, f));
    const header = [...levels, 'Rows', ...report.aggregates.map(a => a.header)];
    const lines: Array<Array<string | number | null>> = [header];
    const visit = (g: Group) => {
      const lead: Array<string | null> = levels.map((_, i) => (i === g.depth ? g.label : null));
      lines.push([...lead, g.count, ...g.aggs]);
      g.children.forEach(visit);
    };
    report.groups.forEach(visit);
    lines.push([...levels.map((_, i) => (i === 0 ? 'Grand total' : null)), report.total.count, ...report.total.aggs]);
    return lines;
  }
  const head: Array<string | number | null> = [`${fieldHeader(config, report.rowField)} / ${fieldHeader(config, report.colField)}`, ...report.colLabels, 'Total'];
  const lines: Array<Array<string | number | null>> = [head];
  report.rowLabels.forEach((r, i) => lines.push([r, ...report.cells[i], report.rowTotals[i]]));
  lines.push(['Total', ...report.colTotals, report.grandTotal]);
  return lines;
}

export function reportToCsv(report: Report, config: ReportConfig): string {
  return toCsv(reportToTable(report, config));
}
