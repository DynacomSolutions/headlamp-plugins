/*
 * The "grouped bars" layout of the panel widget. One horizontal bar per group of rows (rows with
 * the same label). The bar has one segment per row. Each segment is filled to the fraction of its
 * row, in the colour of its limit name (the row detail). The value is in the segment tooltip, and
 * a legend above the bars maps the colours to the limit names. A small status marker sits under each segment, so
 * status is never colour alone and the limit colours never carry status.
 */
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { INK, KIOSK_INK } from '../promql/palette';
import { limitColours } from './limitColours';
import type { PanelRow } from './model';
import { groupRows, RowGroup, RowSegment } from './rowGroups';
import { STATUS_WORD, StatusMark } from './StatusMark';

/** The widest the label column grows, as a share of the widget width. */
export const LABEL_MAX = '35%';

function GroupLabel(props: { group: RowGroup; editing: boolean }): JSX.Element {
  const { group, editing } = props;
  const link = group.link;
  if (!link || editing) return <>{group.label}</>;
  return link.startsWith('/') ? (
    <RouterLink to={link} style={{ color: 'inherit' }}>
      {group.label}
    </RouterLink>
  ) : (
    <a href={link} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
      {group.label}
    </a>
  );
}

/** The words of a segment, for its tooltip and its accessible name. */
export function segmentText(group: RowGroup, seg: RowSegment): string {
  const row: PanelRow = seg.row;
  const pct = row.fraction === undefined ? '' : `, ${Math.round(row.fraction * 100)} percent`;
  return `${group.label}, ${seg.name}: ${row.value}${pct}. ${STATUS_WORD[row.status]}`;
}

export function PanelBars(props: {
  rows: ReadonlyArray<PanelRow>;
  kiosk: boolean;
  editing: boolean;
}): JSX.Element {
  const { rows, kiosk, editing } = props;
  const theme = useTheme();
  const mode = theme.palette.mode;
  const ink = kiosk && mode === 'dark' ? KIOSK_INK : INK[mode];
  const { groups, limits, slots } = React.useMemo(() => groupRows(rows), [rows]);
  const colours = React.useMemo(() => limitColours(limits, mode), [limits, mode]);
  return (
    <Box data-bars sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minWidth: 0 }}>
      <Box
        data-legend
        role="list"
        aria-label="Limits"
        sx={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', pb: 0.5 }}
      >
        {limits.map(name => {
          const c = colours.get(name);
          return (
            <Box
              key={name}
              role="listitem"
              data-legend-item={name}
              sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}
            >
              <Box
                data-swatch={c?.colour}
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: '2px',
                  flex: 'none',
                  bgcolor: c?.colour,
                  opacity: c?.opacity,
                }}
              />
              <Typography variant="caption" color="text.secondary" noWrap>
                {name}
              </Typography>
            </Box>
          );
        })}
      </Box>
      <Box
        data-bar-grid
        sx={{
          display: 'grid',
          // The label column fits the longest label, up to 35 % of the widget. The bars take the rest.
          gridTemplateColumns: `fit-content(${LABEL_MAX}) minmax(0, 1fr)`,
          columnGap: 1.5,
          rowGap: 1.25,
          alignItems: 'start',
          minWidth: 0,
        }}
      >
        {groups.map(group => (
          <Box key={group.label} data-bar-group={group.label} sx={{ display: 'contents' }}>
            <Tooltip title={group.label} placement="top-start">
              <Typography
                variant="body2"
                data-bar-label
                sx={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  pt: '1px',
                }}
              >
                <GroupLabel group={group} editing={editing} />
              </Typography>
            </Tooltip>
            <Box
              data-bar
              sx={{ minWidth: 0, display: 'flex', gap: '2px' }}
              role="group"
              aria-label={group.label}
            >
              {group.cells.map((seg, i) => {
                const slot = slots[i];
                if (!seg) {
                  return (
                    <Box
                      key={`${slot.name}-${slot.repeat}`}
                      data-segment-empty={slot.name}
                      aria-hidden
                      sx={{ flex: '1 1 0', minWidth: 0 }}
                    >
                      <Box
                        sx={{ height: 14, bgcolor: ink.track, borderRadius: '3px', opacity: 0.5 }}
                      />
                      <Box sx={{ height: 9, pt: '3px' }} />
                    </Box>
                  );
                }
                const c = colours.get(seg.name);
                const fraction = seg.row.fraction;
                const text = segmentText(group, seg);
                return (
                  <Tooltip key={`${slot.name}-${slot.repeat}`} title={text} arrow placement="top">
                    <Box
                      data-segment={seg.name}
                      role="img"
                      aria-label={text}
                      sx={{ flex: '1 1 0', minWidth: 0 }}
                    >
                      <Box
                        sx={{
                          height: 14,
                          bgcolor: ink.track,
                          borderRadius: '3px',
                          overflow: 'hidden',
                        }}
                      >
                        {fraction !== undefined && (
                          <Box
                            data-fill={fraction}
                            sx={{
                              height: '100%',
                              width: `${Math.min(1, Math.max(0, fraction)) * 100}%`,
                              bgcolor: c?.colour,
                              opacity: c?.opacity,
                            }}
                          />
                        )}
                      </Box>
                      <Box sx={{ display: 'flex', justifyContent: 'center', pt: '3px' }}>
                        <StatusMark status={seg.row.status} size={9} />
                      </Box>
                    </Box>
                  </Tooltip>
                );
              })}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
