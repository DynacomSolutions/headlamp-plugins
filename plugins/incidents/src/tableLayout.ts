/*
 * The same approach as plugins/node-hardware/src/tableLayout.ts: a short column takes the width of
 * its content and does not wrap, and a long text column wraps in the width that is left. Headlamp
 * plugins are separate bundles and cannot import each other, so this file is a copy that fits the
 * diagnoses table. Keep the two in step.
 *
 * One difference: that table is a Headlamp grid (`gridTemplateColumns` sets its tracks). This one is
 * a Material UI table, so the browser sizes the columns itself. A `nowrap` cell then takes the width
 * of its content, and a `wrap` cell takes the rest, with a minimum width.
 *
 * Columns are counted from 1.
 */
export interface TableLayout {
  /** Number of columns, the checkbox column included. */
  columns: number;
  /** Columns that wrap their text. Every other body cell stays on one line. */
  wrap: readonly number[];
}

/** Which columns the table has. */
export interface DiagnosesColumns {
  /** The checkbox column of the multi-select. */
  checkbox: boolean;
  /** The confidence, source and resolved columns. */
  detail: boolean;
  /** The Actions column (the "Run again" button). */
  actions: boolean;
}

/** Column order: checkbox, time, alert, severity, status, likely cause, confidence, source, resolved, actions. */
export function diagnosesLayout(c: DiagnosesColumns): TableLayout {
  const first = c.checkbox ? 1 : 0;
  const time = first + 1;
  const cause = first + 5;
  const after = (c.detail ? 3 : 0) + (c.actions ? 1 : 0);
  // The time wraps at the comma (date, then clock), the likely cause wraps at any space.
  return { columns: cause + after, wrap: [time, cause] };
}

/** Body cells of the wrapping columns, as one CSS selector list scoped to a table. */
export function wrapSelector(layout: TableLayout): string {
  return layout.wrap.map(n => `& td:nth-of-type(${n})`).join(', ');
}

/** The narrowest the likely cause gets, in characters. A longer single word breaks at that width. */
export const CAUSE_MIN_CH = 18;

/**
 * The most lines the likely cause shows before it ends with an ellipsis (the full text is on hover).
 * A cause of about 140 characters needs four lines at 1280 px with the sidebar open, so three lines
 * would hide the end of most causes. Six lines only cut a very long text.
 */
export const CAUSE_LINES = 6;

/** `sx` rules for the table. */
export function tableSx(layout: TableLayout): Record<string, unknown> {
  const cause = layout.wrap[layout.wrap.length - 1];
  return {
    width: '100%',
    // Tight cells: the default 16 px side padding costs about 150 px over nine columns.
    // The doubled `&` beats the cell padding of the Headlamp theme.
    '&& th, && td': { padding: '6px 6px' },
    '&& th.MuiTableCell-paddingCheckbox, && td.MuiTableCell-paddingCheckbox': { padding: '0 4px' },
    '& th': { whiteSpace: 'nowrap' },
    '& td': { whiteSpace: 'nowrap' },
    // The time breaks at the space only (date, then clock). The cause also breaks inside a long word
    // (`anywhere`), but only when the column has no room.
    [wrapSelector(layout)]: { whiteSpace: 'normal' },
    [`& td:nth-of-type(${cause})`]: { overflowWrap: 'anywhere', minWidth: `${CAUSE_MIN_CH}ch` },
  };
}
