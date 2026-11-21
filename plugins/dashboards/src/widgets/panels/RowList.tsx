/*
 * The rows of a panel as status bands. A row that needs attention (warning, critical or unknown)
 * is a tinted band with a label, a detail line and a value. When bands exist, the healthy
 * rows fold into one line such as "95 more up", so the few rows that matter come first. A panel
 * with only healthy rows lists them. A bar shows only where the fraction tells something. The bands
 * and the folded line have square corners, so the bottom of the list is a straight edge. When the
 * rows do not fit the height, the list shows the rows that fit and a quiet "+N more" line, never a
 * half-cut row. Rows with and without an icon stay aligned: one icon slot, one bar slot.
 */
import Box from '@mui/material/Box';
import React from 'react';
import { InternalLink } from '../../links';
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
  return (
    <InternalLink to={link} style={LINK_STYLE}>
      {row.label}
    </InternalLink>
  );
}

/** A bar tells something when the row is not full or not fine. A full row that is fine is noise. */
export const isInformative = (r: PanelRow): boolean =>
  r.fraction !== undefined && (r.fraction < 0.995 || r.status !== 'ok');

/** The size and weight of the value at the end of every row. */
export const VALUE_FONT_SIZE = 18;
export const VALUE_FONT_WEIGHT = 400;

export const ROW_HEIGHT = 52;
export const ROW_GAP = 6;
export const FOLD_HEIGHT = 36;
export const MORE_HEIGHT = 24;

/** The word after the folded count, by panel id: "95 more up", "6 more engines OK". */
const OK_WORD: Record<string, string> = {
  uptime: 'up',
  backups: 'backups OK',
  engines: 'engines OK',
  clusters: 'clusters OK',
  agents: 'agents running',
  pools: 'pools OK',
  'claude-swap': 'members OK',
};
export const okWordOf = (panelId: string): string => OK_WORD[panelId] ?? 'OK';

export interface RowPlan {
  /** The rows to draw, in order. */
  items: PanelRow[];
  /** Healthy rows folded into one line. */
  folded: number;
  /** Rows left out for lack of height, shown as "+N more". */
  more: number;
}

/**
 * Which rows to draw. The worst come first. When some rows need attention and some are healthy,
 * the healthy rows fold. A height of 0 (not measured) draws every row.
 */
export function planRows(rows: PanelRow[], height: number): RowPlan {
  const ordered = bySeverity(rows);
  const bad = ordered.filter(r => r.status !== 'ok');
  const fold = bad.length > 0 && bad.length < ordered.length;
  const items = fold ? bad : ordered;
  const folded = fold ? ordered.length - bad.length : 0;
  if (height <= 0) return { items, folded, more: 0 };
  const unit = ROW_HEIGHT + ROW_GAP;
  const total = items.length * unit + (folded > 0 ? FOLD_HEIGHT : 0);
  if (total <= height) return { items, folded, more: 0 };
  const n = Math.max(1, Math.floor((height - MORE_HEIGHT) / unit));
  const shown = Math.min(n, items.length);
  return { items: items.slice(0, shown), folded: 0, more: items.length - shown + folded };
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
      sx={{ width: 80, height: 8, borderRadius: '4px', bgcolor: tk.track, overflow: 'hidden' }}
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
  /** The width in px of the list. 0 (not measured) draws the bars. A narrow list has no bars. */
  width?: number;
  editing: boolean;
  source?: PanelSource;
  /** The word after the folded count. */
  okWord?: string;
  /** The colour of the plot line that belongs to a row. It shows as a short line before the row. */
  swatch?: (row: PanelRow) => string | undefined;
}): JSX.Element {
  const { rows, height, width = 0, editing, source, swatch, okWord = 'OK' } = props;
  const tk = useTokens();
  const plan = React.useMemo(() => planRows(rows, height), [rows, height]);
  // Under 360 px a bar would leave the label no room.
  const withBar = (width === 0 || width >= 360) && plan.items.some(isInformative);
  const withIcon = source !== undefined && rows.some(r => r.icon !== undefined);
  return (
    <Box
      data-rows
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: `${ROW_GAP}px`,
        minWidth: 0,
        fontSize: 13,
      }}
    >
      {plan.items.map((r, i) => {
        const band = r.status !== 'ok';
        return (
          <Box
            key={`${r.label}-${i}`}
            data-row
            data-row-status={r.status}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              height: ROW_HEIGHT,
              px: 1.5,
              flex: 'none',
              minWidth: 0,
              // Square corners: a band and the list end in a straight edge.
              borderRadius: 0,
              bgcolor: band ? tk.fill[r.status] : 'transparent',
              boxShadow: band ? 'none' : `inset 0 -1px 0 ${tk.line}`,
            }}
          >
            {swatch && (
              <Box
                data-row-swatch
                sx={{ width: 12, height: 3, borderRadius: '2px', flex: 'none', bgcolor: swatch(r) }}
              />
            )}
            <StatusMark status={r.status} size={16} />
            {withIcon && (
              <Box data-row-icon-cell sx={{ display: 'flex' }}>
                <RowIcon source={source} icon={r.icon} />
              </Box>
            )}
            <Box sx={{ flex: '1 1 0', minWidth: 0 }}>
              <Box
                title={r.label}
                sx={{
                  fontSize: 16,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <Label row={r} editing={editing} />
              </Box>
              {r.detail && (
                <Box
                  title={r.detail}
                  sx={{
                    color: tk.fg2,
                    fontSize: 12.5,
                    lineHeight: 1.2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {r.detail}
                </Box>
              )}
            </Box>
            {withBar && (
              <Box sx={{ width: 80, flex: 'none' }}>{isInformative(r) && <Bar row={r} />}</Box>
            )}
            <Box
              data-row-value
              sx={{
                flex: 'none',
                textAlign: 'right',
                whiteSpace: 'nowrap',
                fontVariantNumeric: 'tabular-nums',
                // One size and weight for every value in every list. It never follows the
                // status, the rank or the length of the text.
                fontSize: VALUE_FONT_SIZE,
                fontWeight: VALUE_FONT_WEIGHT,
                lineHeight: 1,
              }}
            >
              {r.value}
            </Box>
          </Box>
        );
      })}
      {plan.folded > 0 && (
        <Box
          data-rows-fold
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            height: FOLD_HEIGHT,
            px: 1.5,
            flex: 'none',
            borderRadius: 0,
            bgcolor: tk.fill.ok,
            fontSize: 16,
          }}
        >
          <StatusMark status="ok" size={13} />
          <span>
            {plan.folded} more {okWord}
          </span>
        </Box>
      )}
      {plan.more > 0 && (
        <Box
          data-rows-more
          sx={{ height: MORE_HEIGHT, px: 1.5, color: tk.mut, fontSize: 14, flex: 'none' }}
        >
          +{plan.more} more
        </Box>
      )}
    </Box>
  );
}
