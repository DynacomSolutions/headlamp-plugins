/*
 * The "grouped bars" layout of the panel widget. One horizontal track for each group of rows (rows
 * with the same label, for example one identity). Every row of the group is drawn on that same
 * track, from 0 to 100 percent, in the colour of its limit name (the row detail). The largest
 * fraction is at the back and the smaller ones are in front, so every colour stays visible. A thin
 * tick in the limit colour marks the end of each fraction, so equal or hidden values still show.
 * One tooltip lists every limit with its value and status. One status mark at the end of the row
 * shows the worst status of the group, so status is never colour alone and the limit colours never
 * carry status. A legend above the rows maps the colours to the limit names.
 */
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { InternalLink } from '../../links';
import { INK, KIOSK_INK } from '../promql/palette';
import { limitColours } from './limitColours';
import type { PanelRow } from './model';
import { groupRows, RowGroup, RowSegment, worstStatus } from './rowGroups';
import { RowIcon } from './RowIcon';
import type { PanelSource } from './sources';
import { STATUS_WORD, StatusMark } from './StatusMark';

/** The widest the label column grows, as a share of the widget width. */
export const LABEL_MAX = '35%';

function GroupLabel(props: { group: RowGroup; editing: boolean }): JSX.Element {
  const { group, editing } = props;
  const link = group.link;
  if (!link || editing) return <>{group.label}</>;
  return (
    <InternalLink to={link} style={{ color: 'inherit' }}>
      {group.label}
    </InternalLink>
  );
}

/** The words of a segment, for its tooltip and its accessible name. */
export function segmentText(group: RowGroup, seg: RowSegment): string {
  const row: PanelRow = seg.row;
  const pct = row.fraction === undefined ? '' : `, ${Math.round(row.fraction * 100)} percent`;
  return `${group.label}, ${seg.name}: ${row.value}${pct}. ${STATUS_WORD[row.status]}`;
}

/** The height of the track and how far a tick reaches above and below it, in pixels. */
const TRACK_HEIGHT = 16;
const TICK_OVERHANG = 3;
const TICK_WIDTH = 2;

/** The segments that have a fraction, the largest first: the DOM order is the stacking order. */
export function drawOrder(segments: ReadonlyArray<RowSegment>): RowSegment[] {
  return segments
    .filter(s => s.row.fraction !== undefined)
    .map((s, at) => ({ s, at }))
    .sort((a, b) => (b.s.row.fraction ?? 0) - (a.s.row.fraction ?? 0) || a.at - b.at)
    .map(x => x.s);
}

const clamp = (f: number): number => Math.min(1, Math.max(0, f));

function LimitTrack(props: {
  group: RowGroup;
  colours: Map<string, { colour: string; opacity: number }>;
  track: string;
  surface: string;
}): JSX.Element {
  const { group, colours, track, surface } = props;
  const [hovered, setHovered] = React.useState<RowSegment | null>(null);
  const drawn = drawOrder(group.segments);
  // Ticks at the same fraction share the height, so none of them is hidden.
  const tickSlot = new Map<RowSegment, { at: number; of: number }>();
  for (const seg of drawn) {
    const same = drawn.filter(o => clamp(o.row.fraction ?? 0) === clamp(seg.row.fraction ?? 0));
    tickSlot.set(seg, { at: same.indexOf(seg), of: same.length });
  }
  const list = (
    <Box data-bar-tooltip sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      {group.segments.map((seg, i) => {
        const c = colours.get(seg.name);
        const pct =
          seg.row.fraction === undefined ? '' : `, ${Math.round(seg.row.fraction * 100)} percent`;
        return (
          <Box
            key={`${seg.name}-${i}`}
            data-tooltip-limit={seg.name}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              fontWeight: seg === hovered ? 700 : 400,
            }}
          >
            <Box
              sx={{
                width: 10,
                height: 10,
                borderRadius: '2px',
                flex: 'none',
                bgcolor: c?.colour,
                opacity: c?.opacity,
              }}
            />
            <span>
              {seg.name}: {seg.row.value}
              {pct}. {STATUS_WORD[seg.row.status]}
            </span>
          </Box>
        );
      })}
    </Box>
  );
  const summary = group.segments.map(s => segmentText(group, s)).join(' ');
  return (
    <Tooltip title={list} arrow placement="top">
      <Box
        data-bar
        role="img"
        aria-label={summary}
        onMouseLeave={() => setHovered(null)}
        sx={{
          position: 'relative',
          height: TRACK_HEIGHT,
          minWidth: 0,
          alignSelf: 'center',
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            bgcolor: track,
            borderRadius: '3px',
            overflow: 'hidden',
          }}
        >
          {drawn.map((seg, i) => {
            const c = colours.get(seg.name);
            const fraction = clamp(seg.row.fraction ?? 0);
            return (
              <Box
                key={`${seg.name}-${i}`}
                data-segment={seg.name}
                data-fill={seg.row.fraction}
                onMouseEnter={() => setHovered(seg)}
                sx={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: `${fraction * 100}%`,
                  bgcolor: c?.colour,
                  opacity: c?.opacity,
                }}
              />
            );
          })}
        </Box>
        {drawn.map((seg, i) => {
          const c = colours.get(seg.name);
          const fraction = clamp(seg.row.fraction ?? 0);
          const slot = tickSlot.get(seg) ?? { at: 0, of: 1 };
          const full = TRACK_HEIGHT + 2 * TICK_OVERHANG;
          const part = full / slot.of;
          return (
            <Box
              key={`${seg.name}-${i}`}
              data-tick={seg.name}
              aria-hidden
              sx={{
                position: 'absolute',
                pointerEvents: 'none',
                top: -TICK_OVERHANG + slot.at * part,
                height: part,
                width: TICK_WIDTH,
                left: fraction === 0 ? 0 : `calc(${fraction * 100}% - ${TICK_WIDTH}px)`,
                bgcolor: c?.colour,
                opacity: c?.opacity,
                boxShadow: `0 0 0 1px ${surface}`,
              }}
            />
          );
        })}
      </Box>
    </Tooltip>
  );
}

export function PanelBars(props: {
  rows: ReadonlyArray<PanelRow>;
  kiosk: boolean;
  editing: boolean;
  /** The source of the panel, for the row icons. Without it no icon shows. */
  source?: PanelSource;
}): JSX.Element {
  const { rows, kiosk, editing, source } = props;
  const theme = useTheme();
  const mode = theme.palette.mode;
  const ink = kiosk && mode === 'dark' ? KIOSK_INK : INK[mode];
  const { groups, limits } = React.useMemo(() => groupRows(rows), [rows]);
  const colours = React.useMemo(() => limitColours(limits, mode), [limits, mode]);
  // An icon column for every group when any group has an icon, so the labels stay aligned.
  const withIcon = source !== undefined && groups.some(g => g.icon !== undefined);
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
          // The label column fits the longest label, up to 35 % of the widget. The track takes the
          // rest. The last column holds the one status mark of the row. An optional first column
          // holds the row icon.
          gridTemplateColumns: `${
            withIcon ? 'auto ' : ''
          }fit-content(${LABEL_MAX}) minmax(0, 1fr) auto`,
          columnGap: 1.5,
          rowGap: 1.25,
          alignItems: 'center',
          minWidth: 0,
        }}
      >
        {groups.map(group => (
          <Box key={group.label} data-bar-group={group.label} sx={{ display: 'contents' }}>
            {withIcon && <RowIcon source={source} icon={group.icon} />}
            <Tooltip title={group.label} placement="top-start">
              <Typography
                variant="body2"
                data-bar-label
                sx={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <GroupLabel group={group} editing={editing} />
              </Typography>
            </Tooltip>
            <LimitTrack group={group} colours={colours} track={ink.track} surface={ink.surface} />
            <Box data-bar-status sx={{ display: 'flex', alignItems: 'center' }}>
              <StatusMark status={worstStatus(group.segments)} size={14} />
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
