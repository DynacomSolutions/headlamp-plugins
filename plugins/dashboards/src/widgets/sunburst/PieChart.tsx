/*
 * A pie chart drawn as SVG, with a fixed legend that scrolls inside itself. Every item is its own
 * slice at its real size: there is no "Other" slice and no top-N cut. An item with value 0 has no
 * angle, so it has no slice, but it stays in the legend with its value. A slice has the hue of its
 * group (for example the provider) and a shade of that hue by its place in the group, the same
 * colour system as the sunburst. Hover (or a tap, on a touch screen) shows the item above the pie.
 * Colour is never the only encoding: the legend names every item with its value and share.
 */
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import { useTheme } from '@mui/material/styles';
import React from 'react';
import { ScrollArea } from '../../components/ScrollArea';
import { useElementSize } from '../promql/useElementSize';
import { arcPath, TAU } from './geometry';
import { childShade, colourAt } from './palette';
import { clip, percent, RADIUS, VIEW } from './shared';

export interface PieSlice {
  key: string;
  label: string;
  /** The group of the item. It sets the hue. */
  group: string;
  value: number;
  /** The value as text, for the legend. */
  valueText: string;
}

export interface PieChartProps {
  slices: PieSlice[];
  /** The colour index of a group. It must not change when the data changes. */
  groupIndex: (group: string) => number;
  /** The title above the pie when nothing is selected, for example `Tokens in 7 days`. */
  title: string;
  /** The total as text. */
  totalText: string;
  kiosk?: boolean;
}

/** The least width of a legend column, the gap between columns and the height of a legend row, in px. */
const LEGEND_COLUMN = 250;
const LEGEND_GAP = 16;
const ROW = 18;

/** The number of legend columns that fit in a width. */
export const legendColumns = (width: number): number =>
  Math.max(1, Math.floor((width + LEGEND_GAP) / (LEGEND_COLUMN + LEGEND_GAP)));

export function PieChart({
  slices,
  groupIndex,
  title,
  totalText,
  kiosk = false,
}: PieChartProps): JSX.Element {
  const theme = useTheme();
  const mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const [active, setActive] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<string | null>(null);
  const box = useElementSize<HTMLDivElement>();

  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  const colours = React.useMemo(() => {
    const seen = new Map<string, number>();
    const out = new Map<string, string>();
    for (const s of slices) {
      const n = seen.get(s.group) ?? 0;
      seen.set(s.group, n + 1);
      out.set(s.key, childShade(colourAt(groupIndex(s.group), mode), n, mode));
    }
    return out;
  }, [slices, groupIndex, mode]);
  const arcs = React.useMemo(() => {
    let at = 0;
    return slices
      .filter(s => s.value > 0 && total > 0)
      .map(s => {
        const start = at;
        at += (s.value / total) * TAU;
        return { slice: s, d: arcPath(0, RADIUS, start, at) };
      });
  }, [slices, total]);

  const shownKey = active ?? picked;
  const shown = shownKey ? slices.find(s => s.key === shownKey) : undefined;
  const share = (v: number): string => percent(total > 0 ? v / total : 0);
  const select = (key: string) => setPicked(p => (p === key ? null : key));
  const hover = (key: string) =>
    kiosk ? {} : { onMouseEnter: () => setActive(key), onMouseLeave: () => setActive(null) };

  const bw = box.size.width;
  const bh = box.size.height;
  const side = bw > 0 && bh > 0 && bw / bh > 1.15;
  const head = 44;
  // The legend is a grid of columns that are at least LEGEND_COLUMN px wide. Under the pie it is as
  // tall as its rows need, and the pie takes all the rest. If the rows need more, the legend scrolls.
  const underColumns = legendColumns(bw);
  const underHeight = Math.ceil(slices.length / underColumns) * ROW;
  const pieSize = side
    ? Math.min(bh - head, bw * 0.5)
    : Math.min(bw, Math.max((bh - head) * 0.55, bh - head - underHeight - 10));
  const legendWidth = side ? bw - pieSize - 10 : bw;
  const columns = legendColumns(legendWidth);
  // A narrow column drops the group text, so the name keeps its room. The tooltip names the group.
  const showGroup = (legendWidth + LEGEND_GAP) / columns - LEGEND_GAP >= 300;

  return (
    <Box
      ref={box.ref}
      data-pie
      sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, width: '100%' }}
    >
      <Box
        data-pie-head
        sx={{ flex: 'none', height: head, display: 'flex', flexDirection: 'column', minWidth: 0 }}
      >
        <Box sx={{ fontSize: 12.5, color: 'text.secondary' }}>
          {shown ? `${shown.group}, ${share(shown.value)} of the total` : title}
        </Box>
        <Box
          sx={{
            fontSize: 17,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {shown ? `${clip(shown.label, 40)}: ${shown.valueText}` : totalText}
        </Box>
      </Box>
      <Box
        sx={{
          flex: '1 1 0',
          minHeight: 0,
          display: 'flex',
          flexDirection: side ? 'row' : 'column',
          alignItems: 'center',
          gap: 1.25,
        }}
      >
        <svg
          role="img"
          aria-label={`${title}: ${totalText}. ${slices.length} items`}
          viewBox={`${-VIEW / 2} ${-VIEW / 2} ${VIEW} ${VIEW}`}
          style={{
            width: pieSize > 0 ? Math.round(pieSize) : '100%',
            height: pieSize > 0 ? Math.round(pieSize) : '100%',
            flex: 'none',
            display: 'block',
            touchAction: 'manipulation',
          }}
        >
          {arcs.length === 0 && (
            <circle
              r={RADIUS}
              fill={theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)'}
            />
          )}
          {arcs.map(({ slice, d }) => (
            <path
              key={slice.key}
              d={d}
              data-slice={slice.key}
              fill={colours.get(slice.key)}
              fillOpacity={shownKey !== null && shownKey !== slice.key ? 0.4 : 1}
              stroke={theme.palette.background.paper}
              strokeWidth={0.5}
              role="img"
              aria-label={`${slice.label}, ${slice.valueText}`}
              style={{ cursor: 'pointer', outline: 'none' }}
              onClick={() => select(slice.key)}
              {...hover(slice.key)}
            >
              <title>{`${slice.label}: ${slice.valueText} (${share(slice.value)})`}</title>
            </path>
          ))}
        </svg>
        <ScrollArea label={`${title} legend`} sx={{ alignSelf: 'stretch', flex: '1 1 0' }}>
          <Box
            component="ul"
            data-pie-legend
            data-columns={columns}
            sx={{
              listStyle: 'none',
              m: 0,
              p: 0,
              display: 'grid',
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              columnGap: `${LEGEND_GAP}px`,
              alignContent: 'start',
            }}
          >
            {slices.map(s => (
              <li key={s.key} data-legend-row={s.key}>
                <ButtonBase
                  onClick={() => select(s.key)}
                  {...hover(s.key)}
                  title={`${s.label}, ${s.group}: ${s.valueText} (${share(s.value)})`}
                  focusRipple={false}
                  disableRipple={kiosk}
                  sx={{
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    gap: '6px',
                    height: ROW,
                    fontSize: 12,
                    textAlign: 'left',
                    outline: 'none',
                    '&.Mui-focusVisible': { outline: kiosk ? 'none' : undefined },
                  }}
                >
                  <Box
                    component="span"
                    aria-hidden
                    sx={{
                      width: 7,
                      height: 7,
                      borderRadius: '1px',
                      flex: 'none',
                      bgcolor: colours.get(s.key),
                      opacity: s.value > 0 ? 1 : 0.35,
                    }}
                  />
                  <Box
                    component="span"
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s.label}
                  </Box>
                  {showGroup && (
                    <Box
                      component="span"
                      sx={{ color: 'text.secondary', fontSize: 11, whiteSpace: 'nowrap' }}
                    >
                      {s.group}
                    </Box>
                  )}
                  <Box
                    component="span"
                    sx={{
                      fontWeight: 700,
                      minWidth: 44,
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {s.valueText}
                  </Box>
                  <Box
                    component="span"
                    sx={{
                      color: 'text.secondary',
                      minWidth: 36,
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {share(s.value)}
                  </Box>
                </ButtonBase>
              </li>
            ))}
          </Box>
        </ScrollArea>
      </Box>
    </Box>
  );
}
