/*
 * Grouping for the "grouped bars" row layout of the panel widget. Rows that share a `label` (for
 * example one account) form one group. Inside a group each row is a segment, named by the row
 * `detail` (for example the 5-hour, weekly or monthly limit). Every group and every segment
 * stays: there is no top-N cut and no "Other" bucket. Order is the order of first sight.
 */
import type { PanelRow } from './model';

/** The name of a segment whose row has no `detail`. */
export const UNNAMED_LIMIT = 'Value';

export interface RowSegment {
  /** The limit name: the row `detail`, or `UNNAMED_LIMIT`. */
  name: string;
  row: PanelRow;
}

export interface RowGroup {
  label: string;
  segments: RowSegment[];
  /** The first link of the rows in the group, if any. */
  link?: string;
}

export interface GroupedRows {
  groups: RowGroup[];
  /** Every limit name in order of first sight, one entry per name: the legend and the colours follow it. */
  limits: string[];
}

export function groupRows(rows: ReadonlyArray<PanelRow>): GroupedRows {
  const byLabel = new Map<string, RowGroup>();
  const limits: string[] = [];
  for (const row of rows) {
    let group = byLabel.get(row.label);
    if (!group) {
      group = { label: row.label, segments: [] };
      byLabel.set(row.label, group);
    }
    if (!group.link && row.link) group.link = row.link;
    const name = row.detail === '' ? UNNAMED_LIMIT : row.detail;
    group.segments.push({ name, row });
    if (!limits.includes(name)) limits.push(name);
  }
  return { groups: Array.from(byLabel.values()), limits };
}
