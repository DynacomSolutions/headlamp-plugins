/*
 * The model of the matrix widget: rows by columns, one cell for each pair. Pure functions.
 * A pair that has no sample is a "no data" cell, never zero. The status of a cell follows two
 * limits: above `warnAbove` is a warning, above `critAbove` is critical. A value equal to a limit
 * is not above it.
 */
import type { PanelStatus } from '../panels/model';
import { Sample } from './mapping';
import { formatValue, Unit } from './units';

export interface MatrixOptions {
  rowLabel: string;
  columnLabel: string;
  /** Rows and columns are one set of members (a node pair): the diagonal is blank. */
  sameSet: boolean;
  warnAbove: number;
  critAbove: number;
  unit: Unit;
}

export interface MatrixCell {
  row: string;
  col: string;
  value: number | null;
  status: PanelStatus;
  /** False when the path is relayed, true when it is direct, null when it is not known. */
  direct: boolean | null;
  rtt: number | null;
}

export interface MatrixSummary {
  /** The pairs that the matrix draws (the diagonal is not a pair). */
  pairs: number;
  above: number;
  warn: number;
  noData: number;
  relayed: number;
  worst?: { row: string; col: string; value: number };
}

export interface MatrixModel {
  rows: string[];
  cols: string[];
  /** The cell of a pair, or undefined on the diagonal. */
  cell: (row: string, col: string) => MatrixCell | undefined;
  cells: MatrixCell[];
  summary: MatrixSummary;
  status: PanelStatus;
}

const naturalOrder = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Values are compared at 6 decimals, so 0.020000000001 is not "above" 0.02. */
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function cellStatus(
  value: number | null,
  warnAbove: number,
  critAbove: number
): PanelStatus {
  if (value === null) return 'unknown';
  const v = round6(value);
  if (v > round6(critAbove)) return 'crit';
  if (v > round6(warnAbove)) return 'warn';
  return 'ok';
}

const pairKey = (row: string, col: string) => `${row}\u0000${col}`;

function byPair(samples: Sample[], rowLabel: string, columnLabel: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of samples) {
    const row = s.labels[rowLabel];
    const col = s.labels[columnLabel];
    if (row === undefined || col === undefined || s.value === null) continue;
    // Two series for one pair (two probes): the larger value wins, so a loss is never hidden.
    const old = out.get(pairKey(row, col));
    out.set(pairKey(row, col), old === undefined ? s.value : Math.max(old, s.value));
  }
  return out;
}

/**
 * Build the matrix from the value samples and the optional path (1 direct, 0 relayed) and round trip
 * time samples. The members are every label value that any query returned, so a pair that has no
 * data still has its cell.
 */
export function buildMatrix(
  value: Sample[],
  direct: Sample[],
  rtt: Sample[],
  o: MatrixOptions
): MatrixModel {
  const values = byPair(value, o.rowLabel, o.columnLabel);
  const paths = byPair(direct, o.rowLabel, o.columnLabel);
  const times = byPair(rtt, o.rowLabel, o.columnLabel);
  const rowSet = new Set<string>();
  const colSet = new Set<string>();
  for (const samples of [value, direct, rtt]) {
    for (const s of samples) {
      const r = s.labels[o.rowLabel];
      const c = s.labels[o.columnLabel];
      if (r === undefined || c === undefined) continue;
      rowSet.add(r);
      colSet.add(c);
    }
  }
  if (o.sameSet) {
    for (const m of [...rowSet, ...colSet]) {
      rowSet.add(m);
      colSet.add(m);
    }
  }
  const rows = [...rowSet].sort(naturalOrder);
  const cols = [...colSet].sort(naturalOrder);
  const cells: MatrixCell[] = [];
  const index = new Map<string, MatrixCell>();
  const summary: MatrixSummary = { pairs: 0, above: 0, warn: 0, noData: 0, relayed: 0 };
  for (const row of rows) {
    for (const col of cols) {
      if (o.sameSet && row === col) continue;
      const k = pairKey(row, col);
      const v = values.get(k) ?? null;
      const p = paths.get(k);
      const cell: MatrixCell = {
        row,
        col,
        value: v,
        status: cellStatus(v, o.warnAbove, o.critAbove),
        direct: p === undefined ? null : p > 0,
        rtt: times.get(k) ?? null,
      };
      cells.push(cell);
      index.set(k, cell);
      summary.pairs += 1;
      if (cell.status === 'crit') summary.above += 1;
      if (cell.status === 'warn') summary.warn += 1;
      if (cell.status === 'unknown') summary.noData += 1;
      if (cell.direct === false) summary.relayed += 1;
      if (v !== null && v > 0 && (!summary.worst || v > summary.worst.value))
        summary.worst = { row, col, value: v };
    }
  }
  const status: PanelStatus =
    summary.above > 0 ? 'crit' : summary.warn > 0 ? 'warn' : summary.noData > 0 ? 'unknown' : 'ok';
  return { rows, cols, cell: (r, c) => index.get(pairKey(r, c)), cells, summary, status };
}

/** The fixed summary line: "30 pairs, 2 above 2%, 4 no data, worst a to b 3.5%". With no loss it has no "worst". */
export function summaryText(
  s: MatrixSummary,
  o: Pick<MatrixOptions, 'critAbove' | 'unit'>
): string {
  const parts = [
    `${s.pairs} ${s.pairs === 1 ? 'pair' : 'pairs'}`,
    `${s.above} above ${formatValue(o.critAbove, o.unit)}`,
    `${s.noData} no data`,
  ];
  if (s.worst)
    parts.push(`worst ${s.worst.row} to ${s.worst.col} ${formatValue(s.worst.value, o.unit)}`);
  return parts.join(', ');
}
