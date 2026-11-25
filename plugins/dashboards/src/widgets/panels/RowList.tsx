/*
 * The rows of a panel as status bands. A row that needs attention (warning, critical or unknown)
 * is a tinted band with a label, a detail line and a value. Every row is drawn, the worst first:
 * the healthy rows never fold into a line such as "95 more up", and no "+N more" line ends the
 * list. The panel view puts this list in a scroll area, so a long list scrolls under the fixed
 * summary. A bar shows only where the fraction tells something. Rows with and without an icon
 * stay aligned: one icon slot, one bar slot.
 */
import Box from '@mui/material/Box';
import React from 'react';
import { InternalLink } from '../../links';
import { GroupIcon } from '../runners/GroupIcon';
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
/** The compact row: one line, no gap. A row with an icon needs the height of the icon tile. */
export const COMPACT_ROW_HEIGHT = 30;
export const COMPACT_ROW_HEIGHT_ICON = 34;
export const COMPACT_VALUE_FONT_SIZE = 15;

/** Every row, the worst first. Nothing folds and nothing is left out. */
export function orderRows(rows: PanelRow[]): PanelRow[] {
  return bySeverity(rows);
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
  /** The width in px of the list. 0 (not measured) draws the bars. A narrow list has no bars. */
  width?: number;
  editing: boolean;
  source?: PanelSource;
  /** The colour of the plot line that belongs to a row. It shows as a short line before the row. */
  swatch?: (row: PanelRow) => string | undefined;
  /** One line for each row, with the detail after the label, and no gap between rows. */
  compact?: boolean;
  /** An icon address for a row (for example the org avatar of an `org/repo` label), or undefined. */
  nameIcon?: (row: PanelRow) => string | undefined;
  /** The logo of the AI provider that a row names, or null. Rows of the AIS source only. */
  providerIcon?: (row: PanelRow) => JSX.Element | null;
}): JSX.Element {
  const {
    rows,
    width = 0,
    editing,
    source,
    swatch,
    compact = false,
    nameIcon,
    providerIcon,
  } = props;
  const tk = useTokens();
  const items = React.useMemo(() => orderRows(rows), [rows]);
  // Under 360 px a bar would leave the label no room.
  const withBar = (width === 0 || width >= 360) && items.some(isInformative);
  const withIcon = source !== undefined && rows.some(r => r.icon !== undefined);
  // One slot for every row as soon as one row has an icon, so the labels stay aligned.
  const withNameIcon = nameIcon !== undefined && rows.some(r => nameIcon(r) !== undefined);
  const withProviderIcon = providerIcon !== undefined && rows.some(r => providerIcon(r) !== null);
  const rowHeight = !compact ? ROW_HEIGHT : withIcon ? COMPACT_ROW_HEIGHT_ICON : COMPACT_ROW_HEIGHT;
  return (
    <Box
      data-rows
      data-compact={compact ? '' : undefined}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 0 : `${ROW_GAP}px`,
        minWidth: 0,
        fontSize: 13,
      }}
    >
      {items.map((r, i) => {
        const band = r.status !== 'ok';
        return (
          <Box
            key={`${r.label}-${i}`}
            data-row
            data-row-status={r.status}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: compact ? 1 : 1.5,
              height: rowHeight,
              px: compact ? 1 : 1.5,
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
            {withProviderIcon && (
              <Box
                data-row-provider-icon
                sx={{ flex: 'none', width: 14, height: 14, display: 'inline-flex', color: tk.fg }}
              >
                {providerIcon?.(r)}
              </Box>
            )}
            {withNameIcon && <GroupIcon src={nameIcon?.(r)} name={r.label} />}
            {withIcon && (
              <Box data-row-icon-cell sx={{ display: 'flex' }}>
                <RowIcon source={source} icon={r.icon} />
              </Box>
            )}
            <Box
              sx={{
                flex: '1 1 0',
                minWidth: 0,
                ...(compact ? { display: 'flex', alignItems: 'baseline', gap: 1 } : {}),
              }}
            >
              <Box
                title={r.label}
                sx={{
                  fontSize: compact ? 14 : 16,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  ...(compact ? { flex: 'none', maxWidth: '55%' } : {}),
                }}
              >
                <Label row={r} editing={editing} />
              </Box>
              {r.detail && (
                <Box
                  title={r.detail}
                  sx={{
                    color: tk.fg2,
                    fontSize: compact ? 12 : 12.5,
                    lineHeight: 1.2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    ...(compact ? { flex: '1 1 0', minWidth: 0 } : {}),
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
                fontSize: compact ? COMPACT_VALUE_FONT_SIZE : VALUE_FONT_SIZE,
                fontWeight: VALUE_FONT_WEIGHT,
                lineHeight: 1,
              }}
            >
              {r.value}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
