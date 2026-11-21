/*
 * A windowed table: only the visible lines are in the DOM, so a list of thousands stays quick.
 * The header sticks to the top of the widget. The lines are made on demand by `getLine`.
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import React from 'react';
import type { ReportColors } from './theme';

export interface GridColumn {
  id: string;
  header: string;
  /** Right align numbers. */
  numeric?: boolean;
  /** A relative width. Default 1. */
  grow?: number;
  /** The smallest width in pixels. Default 110. */
  min?: number;
  sortable?: boolean;
}

export interface GridLine {
  key: string;
  kind: 'row' | 'group' | 'total' | 'matrix-total';
  /** One node per column. A `band` replaces the cells and spans the whole line. */
  cells?: React.ReactNode[];
  band?: React.ReactNode;
  onClick?: () => void;
  /** For a group line: whether it is open. Sets `aria-expanded`. */
  expanded?: boolean;
}

export interface GridSort {
  id: string;
  dir: 'asc' | 'desc';
}

const OVERSCAN = 6;

export function GridTable(props: {
  columns: GridColumn[];
  count: number;
  getLine: (index: number) => GridLine;
  sort?: GridSort | null;
  onSort?: (id: string) => void;
  rowHeight: number;
  colors: ReportColors;
  kiosk: boolean;
  label: string;
  empty?: string;
  /** Keep the first column in view while the table scrolls sideways. */
  stickyFirst?: boolean;
}): JSX.Element {
  const { columns, count, getLine, sort, onSort, rowHeight, colors, kiosk, label, stickyFirst } =
    props;
  const scroller = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [height, setHeight] = React.useState(400);
  // Whether more columns wait on the right, for the edge fade that tells the user to scroll sideways.
  const [moreRight, setMoreRight] = React.useState(false);

  const measure = React.useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setHeight(el.clientHeight || 400);
    setMoreRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 2);
  }, []);

  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // The first cell of a line stays at the left edge. A band over it keeps the line colour.
  const stickyCell = (strong: boolean, header: boolean) =>
    stickyFirst
      ? {
          position: 'sticky',
          left: 0,
          zIndex: 1,
          bgcolor: colors.surface,
          backgroundImage:
            strong && !header ? `linear-gradient(${colors.band}, ${colors.band})` : undefined,
          borderRight: `1px solid ${colors.line}`,
        }
      : {};

  const template = columns.map(c => `minmax(${c.min ?? 110}px, ${c.grow ?? 1}fr)`).join(' ');
  const minWidth = columns.reduce((n, c) => n + (c.min ?? 110), 0);
  // The columns can change after the first paint (the data arrives later), and that is no resize of the box.
  React.useEffect(measure, [measure, minWidth, count]);
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN);
  const lines: React.ReactNode[] = [];
  for (let i = first; i < last; i += 1) {
    const line = getLine(i);
    const strong = line.kind !== 'row';
    lines.push(
      <Box
        key={line.key}
        role="row"
        aria-rowindex={i + 2}
        aria-expanded={line.expanded}
        onClick={line.onClick}
        onKeyDown={
          line.onClick
            ? e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  line.onClick?.();
                }
              }
            : undefined
        }
        tabIndex={line.onClick && !kiosk ? 0 : undefined}
        sx={{
          position: 'absolute',
          top: i * rowHeight,
          left: 0,
          right: 0,
          height: rowHeight,
          display: 'grid',
          gridTemplateColumns: line.band ? '1fr' : template,
          alignItems: 'center',
          borderBottom: `1px solid ${colors.line}`,
          bgcolor: strong ? colors.band : 'transparent',
          fontWeight: strong ? 600 : 400,
          cursor: line.onClick ? 'pointer' : 'default',
          outline: 'none',
          '&:focus-visible': { boxShadow: `inset 0 0 0 2px ${colors.link}` },
        }}
      >
        {line.band ??
          columns.map((c, ci) => (
            <Box
              key={c.id}
              role="cell"
              sx={{
                px: 1.25,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textAlign: c.numeric ? 'right' : 'left',
                fontVariantNumeric: c.numeric ? 'tabular-nums' : undefined,
                ...(ci === 0 ? stickyCell(strong, false) : {}),
                // A sticky cell fills the row height, so the line colour reaches the edges.
                ...(ci === 0 && stickyFirst
                  ? { alignSelf: 'stretch', display: 'flex', alignItems: 'center' }
                  : {}),
              }}
            >
              {line.cells?.[ci]}
            </Box>
          ))}
      </Box>
    );
  }

  const table = (
    <Box
      ref={scroller}
      role="table"
      aria-label={label}
      aria-rowcount={count + 1}
      onScroll={e => {
        setScrollTop((e.currentTarget as HTMLDivElement).scrollTop);
        measure();
      }}
      sx={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflow: 'auto',
        color: colors.text,
        fontSize: kiosk ? '1rem' : '0.8125rem',
        // A thin scrollbar always shows that there are more rows. The wheel never scrolls the page.
        overscrollBehavior: 'contain',
        touchAction: 'pan-x pan-y',
        scrollbarWidth: 'thin',
        '&::-webkit-scrollbar': { width: 6, height: 6 },
        '&::-webkit-scrollbar-thumb': { borderRadius: 3, background: 'rgba(128,128,128,0.55)' },
      }}
    >
      <Box sx={{ minWidth }}>
        <Box
          role="row"
          sx={{
            position: 'sticky',
            top: 0,
            zIndex: 2,
            display: 'grid',
            gridTemplateColumns: template,
            height: rowHeight,
            alignItems: 'center',
            bgcolor: colors.surface,
            borderBottom: `2px solid ${colors.line}`,
            color: colors.muted,
            fontWeight: 600,
          }}
        >
          {columns.map((c, ci) => {
            const active = sort?.id === c.id;
            const content = (
              <>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.header}</span>
                {active && (
                  <Icon
                    icon={sort?.dir === 'asc' ? 'mdi:arrow-up' : 'mdi:arrow-down'}
                    width={14}
                    aria-hidden
                  />
                )}
              </>
            );
            return (
              <Box
                key={c.id}
                role="columnheader"
                aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                // A click on the cell itself sorts too (the button inside gets its own click).
                onClick={
                  c.sortable && onSort
                    ? e => {
                        if (e.target === e.currentTarget) onSort(c.id);
                      }
                    : undefined
                }
                sx={{
                  // The cell fills its slot, so a click anywhere in the heading cell sorts.
                  alignSelf: 'stretch',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: c.numeric ? 'flex-end' : 'flex-start',
                  px: c.sortable && onSort ? 0 : 1.25,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textAlign: c.numeric ? 'right' : 'left',
                  ...(ci === 0 ? stickyCell(false, true) : {}),
                }}
              >
                {c.sortable && onSort ? (
                  <Box
                    component="button"
                    type="button"
                    data-sort-cell={c.id}
                    onClick={() => onSort(c.id)}
                    sx={{
                      all: 'unset',
                      boxSizing: 'border-box',
                      cursor: 'pointer',
                      display: 'flex',
                      flex: 1,
                      minWidth: 0,
                      alignSelf: 'stretch',
                      gap: 0.5,
                      alignItems: 'center',
                      justifyContent: c.numeric ? 'flex-end' : 'flex-start',
                      px: 1.25,
                      color: active ? colors.text : 'inherit',
                      '&:focus-visible': { outline: `2px solid ${colors.link}`, outlineOffset: -2 },
                    }}
                  >
                    {content}
                  </Box>
                ) : (
                  <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    {content}
                  </span>
                )}
              </Box>
            );
          })}
        </Box>
        <Box role="rowgroup" sx={{ position: 'relative', height: count * rowHeight }}>
          {lines}
        </Box>
        {count === 0 && (
          <Box sx={{ p: 2, color: colors.muted, textAlign: 'center' }}>
            {props.empty ?? 'No rows match this report.'}
          </Box>
        )}
      </Box>
    </Box>
  );

  return (
    <Box
      sx={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {table}
      {moreRight && (
        <Box
          aria-hidden
          data-more-columns
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            right: 0,
            width: 36,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            pr: 0.25,
            color: colors.muted,
            background: `linear-gradient(to right, transparent, ${colors.surface} 80%)`,
          }}
        >
          <Icon icon="mdi:chevron-right" width={22} />
        </Box>
      )}
    </Box>
  );
}
