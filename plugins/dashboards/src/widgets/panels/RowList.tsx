/*
 * The rows of a panel, one line each: status mark, icon, label, a muted detail, a thin bar only
 * where the fraction tells something, and the value. The worst rows come first. When the rows do
 * not fit the height, the list shows the rows that fit and a quiet "+N more" line, never a
 * half-cut row. Rows with and without an icon stay aligned: one icon slot, one bar slot and one
 * value width for every row.
 */
import Box from '@mui/material/Box';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import type { PanelRow, PanelStatus } from './model';
import { RowIcon } from './RowIcon';
import type { PanelSource } from './sources';
import { StatusMark } from './StatusMark';
import { bySeverity, useTokens } from './tokens';

/** A link in a row keeps the text colour and the row text calm. */
const LINK_STYLE: React.CSSProperties = {
  color: 'inherit',
  textDecoration: 'none',
};

export function Label(props: { row: PanelRow; editing: boolean }): JSX.Element {
  const { row, editing } = props;
  const link = row.link;
  if (!link || editing) return <>{row.label}</>;
  return link.startsWith('/') ? (
    <RouterLink to={link} style={LINK_STYLE}>
      {row.label}
    </RouterLink>
  ) : (
    <a href={link} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>
      {row.label}
    </a>
  );
}

/** A bar tells something when the row is not full or not fine. A full row that is fine is noise. */
export const isInformative = (r: PanelRow): boolean =>
  r.fraction !== undefined && (r.fraction < 0.995 || r.status !== 'ok');

export const ROW_HEIGHT = 26;
export const ROW_HEIGHT_ICON = 28;
export const MORE_HEIGHT = 24;

/** How many rows show in a list of the given height. A height of 0 (not measured) shows all. */
export function fitRows(count: number, height: number, rowHeight: number): number {
  if (height <= 0 || count * rowHeight <= height) return count;
  return Math.max(1, Math.floor((height - MORE_HEIGHT) / rowHeight));
}

function Bar(props: { row: PanelRow }): JSX.Element {
  const tk = useTokens();
  const { row } = props;
  const status: PanelStatus = row.status === 'unknown' ? 'ok' : row.status;
  const fraction = row.fraction ?? 0;
  return (
    <Box
      role="img"
      aria-label={`${Math.round(fraction * 100)} percent`}
      sx={{ width: 48, height: 4, borderRadius: '2px', bgcolor: tk.track, overflow: 'hidden' }}
    >
      <Box
        data-fraction={fraction}
        sx={{
          height: '100%',
          width: `${Math.max(2, fraction * 100)}%`,
          bgcolor: tk.status[status],
        }}
      />
    </Box>
  );
}

export function RowList(props: {
  rows: PanelRow[];
  /** The height in px that the list may use. 0 means every row. */
  height: number;
  editing: boolean;
  source?: PanelSource;
  /** The colour of the plot line that belongs to a row. It shows as a short line before the row. */
  swatch?: (row: PanelRow) => string | undefined;
}): JSX.Element {
  const { rows, height, editing, source, swatch } = props;
  const tk = useTokens();
  const withBar = rows.some(isInformative);
  const withIcon = source !== undefined && rows.some(r => r.icon !== undefined);
  const rowHeight = withIcon ? ROW_HEIGHT_ICON : ROW_HEIGHT;
  const ordered = React.useMemo(() => bySeverity(rows), [rows]);
  const shown = fitRows(ordered.length, height, rowHeight);
  const hidden = ordered.length - shown;
  // One value width for every row, so the bars start at the same place.
  const valueWidth = Math.max(...ordered.map(r => r.value.length), 2);
  return (
    <Box data-rows sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, fontSize: 13 }}>
      {ordered.slice(0, shown).map((r, i) => (
        <Box
          key={`${r.label}-${i}`}
          data-row
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            height: rowHeight,
            flex: 'none',
            minWidth: 0,
            borderTop: i === 0 ? 0 : `1px solid ${tk.line}`,
          }}
        >
          {swatch && (
            <Box
              data-row-swatch
              sx={{ width: 12, height: 3, borderRadius: '2px', flex: 'none', bgcolor: swatch(r) }}
            />
          )}
          <StatusMark status={r.status} size={11} />
          {withIcon && (
            <Box data-row-icon-cell sx={{ display: 'flex' }}>
              <RowIcon source={source} icon={r.icon} />
            </Box>
          )}
          <Box
            title={r.label}
            sx={{
              flex: '0 1 auto',
              maxWidth: '46%',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <Label row={r} editing={editing} />
          </Box>
          <Box
            title={r.detail}
            sx={{
              flex: '1 1 0',
              minWidth: 0,
              color: tk.mut,
              fontSize: 12,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {r.detail}
          </Box>
          {withBar && (
            <Box sx={{ width: 48, flex: 'none' }}>{isInformative(r) && <Bar row={r} />}</Box>
          )}
          <Box
            sx={{
              flex: 'none',
              minWidth: `${valueWidth}ch`,
              textAlign: 'right',
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
              color:
                r.status === 'warn'
                  ? tk.status.warn
                  : r.status === 'crit'
                  ? tk.status.crit
                  : tk.fg2,
            }}
          >
            {r.value}
          </Box>
        </Box>
      ))}
      {hidden > 0 && (
        <Box
          data-rows-more
          sx={{
            height: MORE_HEIGHT,
            pt: '4px',
            color: tk.mut,
            fontSize: 12.5,
            borderTop: `1px solid ${tk.line}`,
            flex: 'none',
          }}
        >
          +{hidden} more
        </Box>
      )}
    </Box>
  );
}
