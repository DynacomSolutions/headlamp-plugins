/*
 * A two-level sunburst, drawn as SVG. This is a copy of the one in the Dashboards plugin
 * (separate bundles cannot share code), using the Usage palette. The inner ring is one arc per category and the
 * outer ring is one arc per child. The full circle is the capacity and the filled part is the
 * used part. Hover (or a tap, on a touch screen) shows the label and the value in the centre.
 * Every group is its own arc at its real size: there is no "Other" arc and no top-N cut.
 * The legend lists every category, so colour is never the only encoding.
 */
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import { useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import React from 'react';
import { colourAt } from '../palette';
import {
  arcPath,
  ArcShape,
  fitCentreText,
  layoutArcs,
  SunburstData,
  trackPath,
  usedShare,
} from './geometry';
import { childShade } from './shade';

/** The drawing is laid out in these units and scaled to the card by the viewBox. */
const RADIUS = 96;
const VIEW = RADIUS * 2 + 8;

const percent = (share: number): string => {
  const p = share * 100;
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p.toFixed(p >= 10 ? 0 : 1)}%`;
};

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

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
}

const arcId = (a: Pick<ArcShape, 'level' | 'categoryKey' | 'key'>): string =>
  `${a.level}\u0000${a.categoryKey}\u0000${a.key}`;

export function SunburstChart({
  data,
  format,
  title,
  kiosk = false,
  hideLegend = false,
}: SunburstChartProps): JSX.Element {
  const theme = useTheme();
  const mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const [active, setActive] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<string | null>(null);

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

  return (
    <Box
      data-sunburst
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        height: '100%',
        minHeight: 0,
        width: '100%',
        containerType: 'size',
      }}
    >
      <Box
        sx={{
          flex: '1 1 0',
          minHeight: 0,
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <svg
          role="img"
          aria-label={summary}
          viewBox={`${-VIEW / 2} ${-VIEW / 2} ${VIEW} ${VIEW}`}
          style={{
            height: '100%',
            maxWidth: '100%',
            aspectRatio: '1 / 1',
            display: 'block',
            touchAction: 'manipulation',
          }}
        >
          <path d={trackPath(RADIUS)} fill={track} fillRule="evenodd" data-sunburst-track />
          {arcs.map(a => {
            const id = arcId(a);
            const dim =
              shown !== null &&
              shown !== id &&
              !(shownArc && a.categoryKey === shownArc.categoryKey);
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
              y={-8}
              fontSize={fitCentreText(centreLabel, 8.5, -11, RADIUS)}
              fill={theme.palette.text.secondary}
            >
              {centreLabel}
            </text>
            <text
              y={6}
              fontSize={fitCentreText(centreValue, 13, 1, RADIUS, true)}
              fontWeight={600}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {centreValue}
            </text>
            <text
              y={17}
              fontSize={fitCentreText(centreSub, 7.5, 14, RADIUS)}
              fill={theme.palette.text.secondary}
            >
              {centreSub}
            </text>
          </g>
        </svg>
      </Box>
      {!hideLegend && data.categories.length > 0 && (
        <Box
          component="ul"
          aria-label={`${title} groups`}
          sx={{
            listStyle: 'none',
            m: 0,
            p: 0,
            width: '100%',
            flex: '0 1 auto',
            maxHeight: '38%',
            // Every group is listed. A long legend scrolls (also in the kiosk), with a thin scrollbar.
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            touchAction: 'pan-y',
            scrollbarWidth: 'thin',
            '&::-webkit-scrollbar': { width: 6 },
            '&::-webkit-scrollbar-thumb': { borderRadius: 3, background: 'rgba(128,128,128,0.6)' },
            display: 'flex',
            flexWrap: 'wrap',
            gap: '2px 12px',
            justifyContent: 'center',
          }}
        >
          {[...data.categories]
            .filter(c => c.value > 0)
            .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
            .map(c => {
              const id = arcId({ level: 1, categoryKey: c.key, key: c.key });
              return (
                <li key={c.key}>
                  <ButtonBase
                    onClick={() => select(id)}
                    {...hoverProps(id)} // dashboard-links: allow hover handlers only
                    title={`${c.label}: ${format(c.value)}`}
                    focusRipple={false}
                    disableRipple={kiosk}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.75,
                      py: 0.25,
                      px: 0.5,
                      borderRadius: 0.5,
                      outline: 'none',
                      '&.Mui-focusVisible': { outline: kiosk ? 'none' : undefined },
                    }}
                  >
                    <Box
                      component="span"
                      sx={{
                        width: 10,
                        height: 10,
                        borderRadius: '2px',
                        flex: 'none',
                        bgcolor: baseColour(c.key),
                      }}
                    />
                    <Typography variant="caption" noWrap sx={{ maxWidth: 140 }}>
                      {c.label}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ whiteSpace: 'nowrap' }}
                    >
                      {percent(scale > 0 ? c.value / scale : 0)}
                    </Typography>
                  </ButtonBase>
                </li>
              );
            })}
        </Box>
      )}
    </Box>
  );
}
