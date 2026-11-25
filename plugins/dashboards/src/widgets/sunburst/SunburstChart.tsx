/*
 * A reusable two-level sunburst, drawn as SVG. The inner ring is one arc per category and the
 * outer ring is one arc per child. The full circle is the capacity and the filled part is the
 * used part. Hover (or a tap, on a touch screen) shows the label and the value in the centre.
 * Every group is its own arc at its real size: there is no "Other" arc and no top-N cut.
 * The legend lists every category, so colour is never the only encoding.
 */
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import { useTheme } from '@mui/material/styles';
import React from 'react';
import { useElementSize } from '../promql/useElementSize';
import {
  arcPath,
  ArcShape,
  fitCentreText,
  layoutArcs,
  SunburstData,
  trackPath,
  usedShare,
} from './geometry';
import type { ArcPaint, ArcRef } from './NodeRing';
import { NodeSunburstChart } from './NodeSunburstChart';
import { childShade, colourAt } from './palette';
import { clip, percent, RADIUS, VIEW } from './shared';

export interface SunburstChartProps {
  data: SunburstData;
  /** Formats a value in the unit of the data, for example `5.2 GiB` or `1.20 cores`. */
  format: (value: number) => string;
  /** The title in the centre when nothing is selected, for example `CPU`. */
  title: string;
  /** True in kiosk mode: touch screen, no hover, no focus rings. */
  kiosk?: boolean;
  /** Hide the legend (the chart then fills its box). */
  hideLegend?: boolean;
  /** Name the largest children under each group in the legend. Default on. */
  showChildren?: boolean;
  /**
   * The thing that the values count, for example `agents`. Data of a count has no capacity to
   * fill, so the node-first chart then shows `<unit>` under the total and no "of capacity" text.
   */
  unit?: string;
  /**
   * A small logo for a node or group label, or null. It sits before the label in the legend, and in
   * the ring label where there is room. `at` is set when the logo sits inside an SVG.
   */
  labelIcon?: (
    label: string,
    size: number,
    at?: { x: number; y: number },
    kind?: ArcRef['kind']
  ) => JSX.Element | null;
  /** The fill and the ink of an arc (node-first data only). Arcs it gives nothing for keep the default. */
  paint?: (arc: ArcRef) => ArcPaint | undefined;
  /** Node-first data: the text between the parts of a path in a tooltip, for example ` > `. */
  pathSeparator?: string;
  /** Node-first data: name the category and child arcs on the ring, where the name fits. */
  ringLabels?: boolean;
  /** Node-first data: list the children of each category in the legend. */
  legendChildren?: boolean;
  /** Node-first data: show a tooltip with the path and the count at the pointer, or at the top when tapped. */
  tooltip?: boolean;
}

const arcId = (a: Pick<ArcShape, 'level' | 'categoryKey' | 'key'>): string =>
  `${a.level}\u0000${a.categoryKey}\u0000${a.key}`;

/**
 * The sunburst. Data with `nodes` is drawn node first (see `NodeSunburstChart`). Other data is
 * drawn category first: one arc per category and one arc per child.
 */
export function SunburstChart(props: SunburstChartProps): JSX.Element {
  return props.data.nodes && props.data.nodes.length > 0 ? (
    <NodeSunburstChart {...props} />
  ) : (
    <CategorySunburstChart {...props} />
  );
}

function CategorySunburstChart({
  data,
  format,
  title,
  kiosk = false,
  hideLegend = false,
  showChildren = true,
}: SunburstChartProps): JSX.Element {
  const theme = useTheme();
  const mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const [active, setActive] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<string | null>(null);

  const box = useElementSize<HTMLDivElement>();
  const arcs = React.useMemo(() => layoutArcs(data, RADIUS), [data]);
  // Colours follow the category key, not its size, so a refresh never repaints a category.
  const colourIndex = React.useMemo(() => {
    const keys = [...new Set(data.categories.map(c => c.key))].sort();
    return new Map(keys.map((k, i) => [k, i]));
  }, [data.categories]);
  const baseColour = (key: string): string => colourAt(colourIndex.get(key) ?? 0, mode);

  const scale = Math.max(
    data.capacity,
    data.categories.reduce((s, c) => s + Math.max(0, c.value), 0)
  );
  const used = data.categories.reduce((s, c) => s + Math.max(0, c.value), 0);
  const shown = active ?? picked;
  const shownArc = shown ? arcs.find(a => arcId(a) === shown) : undefined;
  const siblingIndex = new Map<string, number>();
  const shade = (a: ArcShape): string => {
    if (a.level === 1) return baseColour(a.categoryKey);
    const i = siblingIndex.get(arcId(a)) ?? 0;
    return childShade(baseColour(a.categoryKey), i, mode);
  };
  // Number the children inside their category, for the alternating shade.
  const perCategory = new Map<string, number>();
  for (const a of arcs) {
    if (a.level !== 2) continue;
    const n = perCategory.get(a.categoryKey) ?? 0;
    siblingIndex.set(arcId(a), n);
    perCategory.set(a.categoryKey, n + 1);
  }

  const summary =
    data.categories.length === 0
      ? `${title}: no usage`
      : `${title}: ${format(used)} of ${format(data.capacity)} used. ${data.categories
          .map(c => `${c.label} ${percent(scale > 0 ? c.value / scale : 0)}`)
          .join(', ')}`;

  const track = theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
  const surface = theme.palette.background.paper;
  const select = (id: string) => setPicked(p => (p === id ? null : id));
  // Hover is a help for a mouse. The kiosk is a touch screen, so a tap selects instead.
  const hoverProps = (id: string) =>
    kiosk ? {} : { onMouseEnter: () => setActive(id), onMouseLeave: () => setActive(null) };

  const centreLabel = shownArc ? clip(shownArc.label, 22) : title;
  const centreValue = shownArc ? format(shownArc.value) : `${format(used)}`;
  const centreSub = shownArc
    ? shownArc.level === 2
      ? clip(data.categories.find(c => c.key === shownArc.categoryKey)?.label ?? '', 22)
      : percent(scale > 0 ? shownArc.value / scale : 0)
    : `of ${format(data.capacity)} (${percent(usedShare(data))})`;

  // The legend sits beside the ring in a wide box and under it in a narrow one. The ring never
  // takes more than 60 % of the short side, so the legend keeps room for its numbers.
  const bw = box.size.width;
  const bh = box.size.height;
  const side = bw > 0 && bh > 0 && bw / bh > 1.15;
  const sorted = [...data.categories]
    .filter(c => c.value > 0)
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const legend = !hideLegend && sorted.length > 0;
  const ringSize = !legend
    ? Math.min(bw, bh)
    : side
    ? Math.min(bh, bw * 0.55)
    : Math.min(bw, bh * 0.6);
  const number = (v: number): string => format(v).split(' ')[0];

  return (
    <Box
      ref={box.ref}
      data-sunburst
      sx={{
        display: 'flex',
        flexDirection: side ? 'row' : 'column',
        alignItems: 'center',
        gap: 1.25,
        height: '100%',
        minHeight: 0,
        width: '100%',
      }}
    >
      <svg
        role="img"
        aria-label={summary}
        viewBox={`${-VIEW / 2} ${-VIEW / 2} ${VIEW} ${VIEW}`}
        style={{
          width: ringSize > 0 ? Math.round(ringSize) : '100%',
          height: ringSize > 0 ? Math.round(ringSize) : '100%',
          flex: 'none',
          display: 'block',
          touchAction: 'manipulation',
        }}
      >
        <path d={trackPath(RADIUS)} fill={track} fillRule="evenodd" data-sunburst-track />
        {arcs.map(a => {
          const id = arcId(a);
          const dim =
            shown !== null && shown !== id && !(shownArc && a.categoryKey === shownArc.categoryKey);
          const d = arcPath(a.inner, a.outer, a.start, a.end);
          if (!d) return null;
          const common = {
            d,
            fill: shade(a),
            fillOpacity: dim ? 0.35 : 1,
            fillRule: 'evenodd' as const,
            stroke: surface,
            strokeWidth: 0.75,
            'data-arc': a.level === 1 ? 'category' : 'child',
            'data-key': a.key,
            onClick: () => select(id),
            style: { cursor: 'pointer', outline: 'none' },
            ...hoverProps(id),
          };
          return a.level === 1 ? (
            <path
              key={id}
              {...common}
              role="button"
              tabIndex={0}
              aria-label={`${a.label}, ${format(a.value)}`}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  select(id);
                }
              }}
              onFocus={kiosk ? undefined : () => setActive(id)}
              onBlur={kiosk ? undefined : () => setActive(null)}
            >
              <title>{`${a.label}: ${format(a.value)}`}</title>
            </path>
          ) : (
            <path key={id} {...common} role="img" aria-label={`${a.label}, ${format(a.value)}`}>
              <title>{`${a.label}: ${format(a.value)}`}</title>
            </path>
          );
        })}
        <g
          data-sunburst-centre
          style={{ pointerEvents: 'none' }}
          textAnchor="middle"
          fill={theme.palette.text.primary}
        >
          <text
            y={-14}
            fontSize={fitCentreText(centreLabel, 9.5, -17, RADIUS)}
            fill={theme.palette.text.secondary}
          >
            {centreLabel}
          </text>
          <text
            y={8}
            fontSize={fitCentreText(centreValue, 22, 3, RADIUS, true)}
            fontWeight={600}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {centreValue}
          </text>
          <text
            y={22}
            fontSize={fitCentreText(centreSub, 8, 20, RADIUS)}
            fill={theme.palette.text.secondary}
          >
            {centreSub}
          </text>
        </g>
      </svg>
      {legend && (
        <Box
          component="ul"
          aria-label={`${title} groups`}
          sx={{
            listStyle: 'none',
            m: 0,
            p: 0,
            flex: '1 1 0',
            minWidth: 0,
            minHeight: 0,
            width: '100%',
            // A row box centres its children, so stretch the list to the box height, then it scrolls.
            alignSelf: 'stretch',
            overflowY: 'auto',
            overflowX: 'hidden',
            // A thin scrollbar always shows that there are more groups. The wheel never scrolls the page.
            overscrollBehavior: 'contain',
            touchAction: 'pan-y',
            scrollbarWidth: 'thin',
            '&::-webkit-scrollbar': { width: 6 },
            '&::-webkit-scrollbar-thumb': { borderRadius: 3, background: 'rgba(128,128,128,0.6)' },
            display: side ? 'flex' : 'grid',
            flexDirection: 'column',
            justifyContent: 'flex-start',
            // Auto margins centre a short list and, unlike justify-content: center, never clip the top of a long one.
            '& > li:first-of-type': { mt: 'auto' },
            '& > li:last-of-type': { mb: 'auto' },
            gridTemplateColumns: bw >= 360 ? '1fr 1fr' : '1fr',
            alignContent: 'start',
            gap: side ? '5px' : '6px 16px',
          }}
        >
          {sorted.map(c => {
            const id = arcId({ level: 1, categoryKey: c.key, key: c.key });
            const kids = [...(c.children ?? [])]
              .filter(k => k.value > 0)
              .sort((a, b) => b.value - a.value);
            return (
              <li key={c.key} data-legend-group={c.key} style={{ minWidth: 0 }}>
                <ButtonBase
                  onClick={() => select(id)}
                  {...hoverProps(id)}
                  title={`${c.label}: ${format(c.value)}`}
                  focusRipple={false}
                  disableRipple={kiosk}
                  sx={{
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: 12.5,
                    textAlign: 'left',
                    borderBottom: 1,
                    borderColor: 'divider',
                    pb: '2px',
                    outline: 'none',
                    '&.Mui-focusVisible': { outline: kiosk ? 'none' : undefined },
                  }}
                >
                  <Box
                    component="span"
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: '1px',
                      flex: 'none',
                      bgcolor: baseColour(c.key),
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
                    {c.label}
                  </Box>
                  <Box
                    component="span"
                    sx={{
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {format(c.value)}
                  </Box>
                  <Box
                    component="span"
                    sx={{
                      color: 'text.secondary',
                      minWidth: 34,
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {percent(scale > 0 ? c.value / scale : 0)}
                  </Box>
                </ButtonBase>
                {showChildren && kids.length > 0 && (
                  <Box component="ul" sx={{ listStyle: 'none', m: '2px 0 0 14px', p: 0 }}>
                    {kids.map(k => (
                      <Box
                        component="li"
                        key={k.key}
                        data-legend-child={k.key}
                        sx={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 1,
                          fontSize: 11,
                          lineHeight: '14px',
                          color: 'text.secondary',
                        }}
                      >
                        <Box
                          component="span"
                          sx={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            minWidth: 0,
                          }}
                        >
                          {k.label}
                        </Box>
                        <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                          {number(k.value)}
                        </Box>
                      </Box>
                    ))}
                  </Box>
                )}
              </li>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
