/**
 * Layout rules for the hardware tables. A column listed in `wrap` may break its text over several
 * lines (long device names, link text). Every other body cell stays on one line (slot names, lanes,
 * generation, status, addresses), so the browser gives those columns the width of their content and
 * gives the rest to the wrapping columns. Columns are counted from 1.
 */
export interface TableLayout {
  /** Number of columns. */
  columns: number;
  wrap: readonly number[];
}

export const CPU_LAYOUT: TableLayout = { columns: 6, wrap: [2] };
export const MEMORY_LAYOUT: TableLayout = { columns: 7, wrap: [6, 7] };
export const SLOTS_LAYOUT: TableLayout = { columns: 8, wrap: [3, 7, 8] };
export const PCI_LAYOUT: TableLayout = { columns: 6, wrap: [2, 3, 4, 6] };
export const GPU_LAYOUT: TableLayout = { columns: 7, wrap: [2, 3, 7] };
export const NVME_LAYOUT: TableLayout = { columns: 6, wrap: [2, 6] };

/** Body cells of the wrapping columns, as one CSS selector list scoped to a table. */
export function wrapSelector(layout: TableLayout): string {
  return layout.wrap.map(n => `& td:nth-of-type(${n})`).join(', ');
}

/**
 * Grid tracks for the table. Headlamp draws a table as a CSS grid with equal `1fr` tracks, so a short
 * column (lanes, status) would get as much room as a device name. A short column takes the width of
 * its content. A wrapping column shares the rest, and never gets narrower than 6 characters. A longer single word breaks at that width instead of pushing a column out of view.
 */
export function gridColumns(layout: TableLayout): string {
  return Array.from({ length: layout.columns }, (_, i) =>
    layout.wrap.includes(i + 1) ? 'minmax(6ch, 1fr)' : 'max-content',
  ).join(' ');
}

/** `sx` rules for the box around a hardware table. */
export function tableSx(layout: TableLayout): Record<string, unknown> {
  return {
    maxWidth: '100%',
    // A phone is too narrow for every column: the table scrolls inside its box, never the page.
    overflowX: 'auto',
    '& table': { width: '100%', gridTemplateColumns: gridColumns(layout) },
    // Tight cells: the default 16 px side padding costs about 160 px over eight columns.
    // The doubled `&` beats the cell padding of the Headlamp theme.
    '&& th, && td': { padding: '6px 6px', fontSize: '0.8125rem', overflow: 'visible', textOverflow: 'clip' },
    '& th': { whiteSpace: 'nowrap' },
    '& td': { whiteSpace: 'nowrap' },
    // `anywhere` lets a long single word (a driver name) break, but only when the column has no room.
    [wrapSelector(layout)]: { whiteSpace: 'normal', overflowWrap: 'anywhere' },
  };
}
