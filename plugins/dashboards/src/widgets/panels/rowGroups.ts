/*
 * Grouping for the "grouped bars" row layout of the panel widget. Rows that share a `label` (for
 * example one account) form one group. Inside a group each row is a segment, named by the row
 * `detail` (for example the 5-hour, weekly or monthly limit). Every group and every segment
 * stays: there is no top-N cut and no "Other" bucket. Groups keep the order of first sight. The
 * limit names have one display order for every group (see `orderLimits`). Each group is one track,
 * so there are no fixed slots.
 */
import type { PanelRow, PanelStatus } from './model';

/** The name of a segment whose row has no `detail`. */
export const UNNAMED_LIMIT = 'Value';

export interface RowSegment {
  /** The limit name: the row `detail`, or `UNNAMED_LIMIT`. */
  name: string;
  row: PanelRow;
}

export interface RowGroup {
  label: string;
  /** The rows of the group in the order they came. */
  segments: RowSegment[];
  /** The first link of the rows in the group, if any. */
  link?: string;
}

export interface GroupedRows {
  groups: RowGroup[];
  /** Every limit name once, in display order: the legend and the colours follow it. */
  limits: string[];
}

/**
 * The display rank of a limit name by its window length, or null for a name that is not known:
 * 5-hour, daily, weekly, weekly for a model ("Weekly (Fable)"), monthly.
 */
export function limitRank(name: string): number | null {
  const n = name
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
  if (/^(5 ?h(ours?)?|5 ?hr|five hours?)$/.test(n)) return 0;
  if (/^(daily|day|24 ?h(ours?)?)$/.test(n)) return 1;
  if (/^(weekly|week|7 ?d(ays?)?)$/.test(n)) return 2;
  if (/^(weekly|week) ?\(.+\)$/.test(n)) return 3;
  if (/^(monthly|month|30 ?d(ays?)?)$/.test(n)) return 4;
  return null;
}

/** Known names by window length, then the other names in order of first sight. */
export function orderLimits(firstSeen: ReadonlyArray<string>): string[] {
  const known: Array<{ name: string; rank: number; at: number }> = [];
  const other: string[] = [];
  firstSeen.forEach((name, at) => {
    const rank = limitRank(name);
    if (rank === null) other.push(name);
    else known.push({ name, rank, at });
  });
  known.sort((a, b) => a.rank - b.rank || a.at - b.at);
  return [...known.map(k => k.name), ...other];
}

export function groupRows(rows: ReadonlyArray<PanelRow>): GroupedRows {
  const byLabel = new Map<string, RowGroup>();
  const firstSeen: string[] = [];
  for (const row of rows) {
    let group = byLabel.get(row.label);
    if (!group) {
      group = { label: row.label, segments: [] };
      byLabel.set(row.label, group);
    }
    if (!group.link && row.link) group.link = row.link;
    const name = row.detail === '' ? UNNAMED_LIMIT : row.detail;
    group.segments.push({ name, row });
    if (!firstSeen.includes(name)) firstSeen.push(name);
  }
  const groups = Array.from(byLabel.values());
  const limits = orderLimits(firstSeen);
  return { groups, limits };
}

const SEVERITY: Record<PanelStatus, number> = { ok: 0, unknown: 1, warn: 2, crit: 3 };

/** The worst status of the rows of a group: critical, then warning, then unknown, then OK. */
export function worstStatus(segments: ReadonlyArray<RowSegment>): PanelStatus {
  let worst: PanelStatus = 'ok';
  for (const seg of segments) {
    if (SEVERITY[seg.row.status] > SEVERITY[worst]) worst = seg.row.status;
  }
  return segments.length === 0 ? 'unknown' : worst;
}
