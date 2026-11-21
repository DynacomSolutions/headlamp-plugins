/*
 * The "stacked lanes" layout of the panel widget (row layout `stacked-lanes`). One bar for each
 * group of rows (rows with the same label, for example one identity). The bar has a fixed height of
 * up to 26 px and splits into one lane for each limit that the group has, from top to bottom in
 * legend order. A lane fills from zero to its own fraction in the colour of its limit. A group with
 * one limit has one thick lane, so a small limit never hides behind a large one. At the end of the
 * row the worst limit shows its value and name, with a note when more than one limit is full, and
 * the status mark of the row. A legend above the rows maps the colours to the limit names. The
 * rows that do not fit the height give way to a "+N more" line. Status is never colour alone.
 */
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { InternalLink } from '../../links';
import { useElementSize } from '../promql/useElementSize';
import { limitColours } from './limitColours';
import type { PanelRow } from './model';
import { groupRows, RowGroup, RowSegment, worstStatus } from './rowGroups';
import { RowIcon } from './RowIcon';
import type { PanelSource } from './sources';
import { STATUS_WORD, StatusMark } from './StatusMark';
import { useTokens } from './tokens';

/** A panel at least this wide uses the wide layout: a 2 px lane gap, the full note and the status key. */
export const WIDE_WIDTH = 640;
const MIN_ROW = { wide: 25, narrow: 21 };
const MAX_ROW = 46;
const MORE_HEIGHT = 22;
const BAR_MAX = 26;
const BAR_MIN = 14;
const clamp = (f: number): number => Math.min(1, Math.max(0, f));

/** How many rows show and how high each is. A height of 0 (not measured) shows every row at 28 px. */
export function fitLaneRows(
  count: number,
  height: number,
  wide: boolean
): { shown: number; rowHeight: number } {
  if (count === 0) return { shown: 0, rowHeight: MAX_ROW };
  if (height <= 0) return { shown: count, rowHeight: 28 };
  const min = wide ? MIN_ROW.wide : MIN_ROW.narrow;
  if (height / count >= min)
    return { shown: count, rowHeight: Math.min(MAX_ROW, Math.floor(height / count)) };
  return { shown: Math.max(1, Math.floor((height - MORE_HEIGHT) / min)), rowHeight: min };
}

/** The segment that sets the status: the worst status, and among equals the largest fraction. */
export function worstSegment(group: RowGroup): RowSegment {
  const rank = { ok: 0, unknown: 1, warn: 2, crit: 3 } as const;
  let worst = group.segments[0];
  for (const s of group.segments) {
    const a = rank[s.row.status];
    const b = rank[worst.row.status];
    if (a > b || (a === b && (s.row.fraction ?? 0) > (worst.row.fraction ?? 0))) worst = s;
  }
  return worst;
}

/** How many limits of the group are full. */
export const fullCount = (group: RowGroup): number =>
  group.segments.filter(s => (s.row.fraction ?? 0) >= 0.995).length;

const LINK_STYLE: React.CSSProperties = {
  color: 'inherit',
  textDecoration: 'none',
};

function splitLabel(label: string): { provider: string; account: string } {
  const at = label.indexOf(' / ');
  return at < 0
    ? { provider: '', account: label }
    : { provider: label.slice(0, at), account: label.slice(at + 3) };
}

function Account(props: { group: RowGroup; account: string; editing: boolean }): JSX.Element {
  const { group, account, editing } = props;
  const link = group.link;
  if (!link || editing) return <>{account}</>;
  return (
    <InternalLink to={link} style={LINK_STYLE}>
      {account}
    </InternalLink>
  );
}

export function PanelLanes(props: {
  rows: ReadonlyArray<PanelRow>;
  kiosk: boolean;
  editing: boolean;
  source?: PanelSource;
}): JSX.Element {
  const { rows, editing, source } = props;
  const tk = useTokens();
  const { groups, limits } = React.useMemo(() => groupRows(rows), [rows]);
  const colours = React.useMemo(() => limitColours(limits, tk.mode), [limits, tk.mode]);
  const root = useElementSize<HTMLDivElement>();
  const body = useElementSize<HTMLDivElement>();
  const wide = root.size.width >= WIDE_WIDTH;
  const { shown, rowHeight } = fitLaneRows(groups.length, body.size.height, wide);
  const hidden = groups.length - shown;
  const one = rowHeight < 36;
  const barHeight = Math.max(BAR_MIN, Math.min(BAR_MAX, rowHeight - 6));
  const gap = wide ? 2 : 1;
  const withIcon = source !== undefined && groups.some(g => g.icon !== undefined);
  const labelWidth = wide ? 230 : 140;
  const noteWidth = wide ? 176 : 92;
  const laneTrack = tk.mode === 'dark' ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)';
  return (
    <Box
      ref={root.ref}
      data-bars
      data-lanes
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        minWidth: 0,
        height: '100%',
        minHeight: 0,
      }}
    >
      <Box
        data-legend
        role="list"
        aria-label="Limits"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '2px 20px',
          alignItems: 'center',
          fontSize: 12.5,
          color: tk.fg2,
          flex: 'none',
        }}
      >
        {limits.map(name => {
          const c = colours.get(name);
          return (
            <Box
              key={name}
              role="listitem"
              data-legend-item={name}
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                whiteSpace: 'nowrap',
              }}
            >
              <Box
                data-swatch={c?.colour}
                sx={{
                  width: 18,
                  height: 6,
                  borderRadius: '3px',
                  flex: 'none',
                  bgcolor: c?.colour,
                  opacity: c?.opacity,
                }}
              />
              {name}
            </Box>
          );
        })}
        {wide && (
          <Box sx={{ display: 'inline-flex', gap: 1.5, ml: 'auto' }}>
            {(['crit', 'warn', 'ok'] as const).map(s => (
              <Box key={s} sx={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                <StatusMark status={s} size={11} />
                {STATUS_WORD[s]}
              </Box>
            ))}
          </Box>
        )}
      </Box>
      <Box ref={body.ref} sx={{ flex: '1 1 0', minHeight: 0, overflow: 'hidden' }}>
        <Box data-bar-grid sx={{ display: 'flex', flexDirection: 'column' }}>
          {groups.slice(0, shown).map(group => {
            const worst = worstSegment(group);
            const { provider, account } = splitLabel(group.label);
            const lanes = limits
              .map(name => ({ name, seg: group.segments.find(s => s.name === name) }))
              .filter(x => x.seg && x.seg.row.fraction !== undefined);
            const n = fullCount(group);
            const status = worstStatus(group.segments);
            const summary = group.segments
              .map(s => `${group.label}, ${s.name}: ${s.row.value}. ${STATUS_WORD[s.row.status]}`)
              .join(' ');
            const note = (
              <Box
                data-bar-worst
                sx={{
                  display: 'flex',
                  flexDirection: one ? 'row' : 'column',
                  alignItems: one ? 'baseline' : 'flex-end',
                  justifyContent: 'flex-end',
                  gap: one ? 1 : 0,
                  lineHeight: 1.15,
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
              >
                <Box
                  component="span"
                  sx={{
                    fontSize: one ? 15 : 17,
                    fontVariantNumeric: 'tabular-nums',
                    order: one ? 1 : 0,
                  }}
                >
                  {worst.row.value}
                </Box>
                <Box
                  component="span"
                  sx={{
                    fontSize: 11.5,
                    color: tk.mut,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {worst.name}
                  {wide && n > 1 && (
                    <>
                      {' · '}
                      <Box
                        component="em"
                        data-full-note
                        sx={{ fontStyle: 'normal', color: tk.fg2 }}
                      >
                        {n} limits full
                      </Box>
                    </>
                  )}
                </Box>
              </Box>
            );
            return (
              <Box
                key={group.label}
                data-bar-group={group.label}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: `${
                    withIcon ? 'auto ' : ''
                  }${labelWidth}px minmax(40px, 1fr) ${noteWidth}px 14px`,
                  columnGap: wide ? '16px' : '12px',
                  alignItems: 'center',
                  height: rowHeight,
                  minWidth: 0,
                  flex: 'none',
                }}
              >
                {withIcon && <RowIcon source={source} icon={group.icon} />}
                <Tooltip title={group.label} placement="top-start">
                  <Box
                    data-bar-label
                    sx={{
                      display: 'flex',
                      flexDirection: one ? 'row' : 'column',
                      alignItems: one ? 'baseline' : 'flex-start',
                      gap: one ? 1 : 0,
                      lineHeight: 1.15,
                      minWidth: 0,
                    }}
                  >
                    {provider && (
                      <Box
                        component="span"
                        sx={{
                          fontSize: 11.5,
                          color: tk.mut,
                          order: one ? 2 : -1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {provider}
                      </Box>
                    )}
                    <Box
                      component="span"
                      sx={{
                        fontSize: 15,
                        flex: 'none',
                        maxWidth: '100%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <Account group={group} account={account} editing={editing} />
                    </Box>
                  </Box>
                </Tooltip>
                <Box
                  data-bar
                  role="img"
                  aria-label={summary}
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    height: barHeight,
                    gap: `${gap}px`,
                    minWidth: 0,
                  }}
                >
                  {lanes.map(({ name, seg }) => {
                    const c = colours.get(name);
                    const f = clamp(seg?.row.fraction ?? 0);
                    return (
                      <Box
                        key={name}
                        data-lane={name}
                        title={`${name}: ${seg?.row.value}`}
                        sx={{
                          flex: '1 1 0',
                          minHeight: '1px',
                          position: 'relative',
                          borderRadius: '3px',
                          overflow: 'hidden',
                          bgcolor: laneTrack,
                        }}
                      >
                        <Box
                          data-segment={name}
                          data-fill={seg?.row.fraction}
                          sx={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            bottom: 0,
                            width: f > 0 ? `max(2px, ${f * 100}%)` : 0,
                            borderRadius: '3px',
                            bgcolor: c?.colour,
                            opacity: c?.opacity,
                          }}
                        />
                      </Box>
                    );
                  })}
                </Box>
                {note}
                <Box data-bar-status sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <StatusMark status={status} size={13} />
                </Box>
              </Box>
            );
          })}
          {hidden > 0 && (
            <Box
              data-rows-more
              sx={{ height: MORE_HEIGHT, pt: '4px', color: tk.mut, fontSize: 12.5 }}
            >
              +{hidden} more
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
