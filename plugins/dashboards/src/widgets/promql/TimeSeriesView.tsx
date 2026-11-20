/*
 * The SVG time series chart: line, area, stacked area or bars. Pure view: it gets series, a size
 * and colours, and draws. A pointer (or a finger, or the arrow keys) moves a crosshair to the
 * nearest time, and one tooltip lists every series at that time. The axes are quiet, the lines
 * are 2 px, and stacked fills and bars have a 2 px surface gap.
 */
import Box from '@mui/material/Box';
import React from 'react';
import { mergeTimes, nearestIndex, Series, stackSeries, valueAt } from './mapping';
import type { Ink } from './palette';
import {
  areaPath,
  computeDomain,
  formatTick,
  formatTooltipTime,
  linear,
  linePath,
  niceDomain,
  niceTicks,
  timeTicks,
} from './scale';
import { formatValue, Unit } from './units';

export type ChartKind = 'line' | 'area' | 'stacked' | 'bar';

export interface TimeSeriesViewProps {
  series: Series[];
  kind: ChartKind;
  unit: Unit;
  yMin?: number;
  yMax?: number;
  /** The query window in epoch seconds. */
  start: number;
  end: number;
  width: number;
  height: number;
  colourFor: (key: string) => string;
  ink: Ink;
  kiosk: boolean;
  /** Offset of the local time zone east of UTC, in seconds. */
  tzOffsetSeconds: number;
}

const TOP = 8;
const BOTTOM = 20;
const RIGHT = 10;
const FONT = 11;
const GAP = 2;

/** A bar with a rounded top and a flat base, so it stands on the baseline. */
export function barPath(x: number, base: number, w: number, top: number, r: number): string {
  const h = Math.abs(base - top);
  const rr = Math.min(r, w / 2, h);
  const up = top <= base;
  const x1 = x + w;
  const r1 = (n: number) => Math.round(n * 100) / 100;
  if (rr <= 0) return `M${r1(x)},${r1(base)}V${r1(top)}H${r1(x1)}V${r1(base)}Z`;
  return up
    ? `M${r1(x)},${r1(base)}V${r1(top + rr)}A${rr},${rr} 0 0 1 ${r1(x + rr)},${r1(top)}H${r1(
        x1 - rr
      )}A${rr},${rr} 0 0 1 ${r1(x1)},${r1(top + rr)}V${r1(base)}Z`
    : `M${r1(x)},${r1(base)}V${r1(top - rr)}A${rr},${rr} 0 0 0 ${r1(x + rr)},${r1(top)}H${r1(
        x1 - rr
      )}A${rr},${rr} 0 0 0 ${r1(x1)},${r1(top - rr)}V${r1(base)}Z`;
}

export function TimeSeriesView(props: TimeSeriesViewProps): JSX.Element {
  const { series, kind, unit, start, end, width, height, colourFor, ink, kiosk, tzOffsetSeconds } =
    props;
  const [hover, setHover] = React.useState<number | null>(null);

  const model = React.useMemo(() => {
    const times = mergeTimes(series);
    const stacked =
      kind === 'stacked' || (kind === 'bar' && series.length > 1)
        ? stackSeries(series, times)
        : undefined;
    let min = Infinity;
    let max = -Infinity;
    if (stacked) {
      for (const top of stacked.tops) for (const v of top) max = Math.max(max, v);
      min = 0;
    } else {
      for (const s of series) {
        for (const p of s.points) {
          if (p.v === null) continue;
          min = Math.min(min, p.v);
          max = Math.max(max, p.v);
        }
      }
    }
    const filled = kind !== 'line';
    // A line chart may start above zero, unless the data is close to zero anyway.
    const includeZero = filled || (min >= 0 && min <= max * 0.5);
    const raw = computeDomain({ min, max, includeZero, yMin: props.yMin, yMax: props.yMax });
    return { times, stacked, raw };
  }, [series, kind, props.yMin, props.yMax]);

  const plotH = Math.max(10, height - TOP - BOTTOM);
  const count = Math.max(2, Math.floor(plotH / 38));
  const domain = niceDomain(
    model.raw,
    count,
    unit,
    props.yMin !== undefined,
    props.yMax !== undefined
  );
  const ticks = niceTicks(domain.min, domain.max, count, unit).filter(
    t => t >= domain.min - 1e-9 && t <= domain.max + 1e-9
  );
  const tickLabels = ticks.map(t => formatValue(t, unit, { compact: true }));
  const left = Math.min(
    110,
    Math.max(34, Math.max(0, ...tickLabels.map(l => l.length)) * 6.4 + 12)
  );
  const plotW = Math.max(10, width - left - RIGHT);
  const x = linear({ min: start, max: end }, left, left + plotW);
  const y = linear(domain, TOP + plotH, TOP);
  const clampY = (v: number) => Math.min(TOP + plotH, Math.max(TOP, y(v)));
  const xTicks = timeTicks(start, end, Math.max(2, Math.floor(plotW / 90)), tzOffsetSeconds);
  const span = end - start;

  const { times, stacked } = model;

  const shapes = React.useMemo(() => {
    const xs = times.map(x);
    return series.map((s, i) => {
      const colour = colourFor(s.key);
      if (kind === 'bar') {
        return { key: s.key, colour, d: '' };
      }
      if (stacked) {
        const tops = stacked.tops[i].map(clampY);
        const bases = stacked.bases[i].map(clampY);
        return { key: s.key, colour, d: areaPath(xs, tops, bases), line: '' };
      }
      const byTime = new Map<number, number | null>();
      for (const p of s.points) byTime.set(p.t, p.v);
      const pts: Array<[number, number | null]> = [];
      for (const p of s.points) pts.push([x(p.t), p.v === null ? null : clampY(p.v)]);
      const line = linePath(pts);
      let d = '';
      if (kind === 'area') {
        d = areaPath(
          pts.map(p => p[0]),
          pts.map(p => p[1]),
          pts.map(() => clampY(Math.max(0, domain.min)))
        );
      }
      return { key: s.key, colour, d, line };
    });
    // The scales are derived from these inputs, so listing them is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    series,
    kind,
    stacked,
    times,
    width,
    height,
    domain.min,
    domain.max,
    start,
    end,
    colourFor,
    left,
  ]);

  const bars = React.useMemo(() => {
    if (kind !== 'bar') return [];
    const slot = times.length > 1 ? Math.abs(x(times[1]) - x(times[0])) : plotW;
    const w = Math.max(1, Math.min(48, slot - GAP));
    const out: Array<{ key: string; d: string; colour: string; gap: boolean }> = [];
    if (series.length === 1) {
      // One series: each bar stands on the baseline with a rounded top.
      const base = clampY(Math.max(0, domain.min));
      const s = series[0];
      for (const p of s.points) {
        if (p.v === null) continue;
        out.push({
          key: `${s.key}@${p.t}`,
          d: barPath(x(p.t) - w / 2, base, w, clampY(p.v), Math.min(4, w / 2)),
          colour: colourFor(s.key),
          gap: false,
        });
      }
      return out;
    }
    // Several series stack, so one time is one column. A 2 px surface gap separates the segments.
    const st = stackSeries(series, times);
    series.forEach((s, i) => {
      times.forEach((t, j) => {
        if (st.tops[i][j] <= st.bases[i][j]) return;
        const x0 = x(t) - w / 2;
        const top = clampY(st.tops[i][j]);
        const bottom = clampY(st.bases[i][j]);
        out.push({
          key: `${s.key}@${t}`,
          d: `M${x0},${bottom}V${top}H${x0 + w}V${bottom}Z`,
          colour: colourFor(s.key),
          gap: true,
        });
      });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, series, times, width, height, domain.min, domain.max, start, end, colourFor, left]);

  const pick = (clientX: number, el: SVGSVGElement) => {
    if (times.length === 0) return;
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    const t = start + ((px - left) / plotW) * (end - start);
    setHover(nearestIndex(times, t));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (times.length === 0) return;
    if (e.key === 'ArrowLeft') setHover(h => Math.max(0, (h ?? times.length) - 1));
    else if (e.key === 'ArrowRight') setHover(h => Math.min(times.length - 1, (h ?? -1) + 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const hoverT = hover !== null && hover < times.length ? times[hover] : undefined;
  const hoverX = hoverT !== undefined ? x(hoverT) : 0;
  const rows =
    hoverT === undefined
      ? []
      : series
          .map((s, i) => ({
            key: s.key,
            name: s.fullName ?? s.name,
            colour: colourFor(s.key),
            value: valueAt(s, hoverT),
            top: stacked ? stacked.tops[i][hover as number] : undefined,
          }))
          .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  const columns = Math.min(4, Math.max(1, Math.ceil(rows.length / 10)));
  const tipRight = hoverX > left + plotW * 0.55;

  return (
    <Box sx={{ position: 'relative', width, height }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${kind} chart with ${series.length} series. Use the arrow keys to read values.`}
        tabIndex={0}
        onKeyDown={onKey}
        onPointerMove={e => pick(e.clientX, e.currentTarget)}
        onPointerDown={e => pick(e.clientX, e.currentTarget)}
        onPointerLeave={() => !kiosk && setHover(null)}
        style={{ display: 'block', touchAction: 'pan-y', outline: kiosk ? 'none' : undefined }}
      >
        {ticks.map((t, i) => (
          <g key={t}>
            <line
              x1={left}
              x2={left + plotW}
              y1={y(t)}
              y2={y(t)}
              stroke={ink.grid}
              strokeWidth={1}
            />
            <text
              x={left - 6}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
              fontSize={FONT}
              fill={ink.muted}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {tickLabels[i]}
            </text>
          </g>
        ))}
        <line
          x1={left}
          x2={left + plotW}
          y1={TOP + plotH}
          y2={TOP + plotH}
          stroke={ink.axis}
          strokeWidth={1}
        />
        {xTicks.map(t => (
          <text
            key={t}
            x={x(t)}
            y={height - 5}
            textAnchor="middle"
            fontSize={FONT}
            fill={ink.muted}
          >
            {formatTick(t, span, tzOffsetSeconds)}
          </text>
        ))}
        {kind === 'bar'
          ? bars.map(b => (
              <path
                key={b.key}
                d={b.d}
                fill={b.colour}
                stroke={b.gap ? ink.surface : 'none'}
                strokeWidth={b.gap ? GAP : 0}
              />
            ))
          : shapes.map(s => (
              <g key={s.key}>
                {s.d && (
                  <path
                    d={s.d}
                    fill={s.colour}
                    fillOpacity={kind === 'stacked' ? 0.9 : 0.16}
                    stroke={kind === 'stacked' ? ink.surface : 'none'}
                    strokeWidth={kind === 'stacked' ? GAP : 0}
                    strokeLinejoin="round"
                  />
                )}
                {kind !== 'stacked' && (s as { line?: string }).line && (
                  <path
                    d={(s as { line: string }).line}
                    fill="none"
                    stroke={s.colour}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}
              </g>
            ))}
        {hoverT !== undefined && (
          <g pointerEvents="none">
            <line
              x1={hoverX}
              x2={hoverX}
              y1={TOP}
              y2={TOP + plotH}
              stroke={ink.muted}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {rows.map((r, i) => {
              const v = stacked ? r.top : r.value;
              if (kind === 'bar' || typeof v !== 'number' || (r.value === null && !stacked))
                return null;
              return (
                <circle
                  key={r.key}
                  cx={hoverX}
                  cy={clampY(v)}
                  r={4}
                  fill={r.colour}
                  stroke={ink.ring}
                  strokeWidth={2}
                  data-hover-dot={i}
                />
              );
            })}
          </g>
        )}
      </svg>
      {hoverT !== undefined && (
        <Box
          data-chart-tooltip
          role="status"
          sx={{
            position: 'absolute',
            top: TOP,
            ...(tipRight ? { right: width - hoverX + 12 } : { left: hoverX + 12 }),
            pointerEvents: 'none',
            bgcolor: ink.surface,
            color: ink.primary,
            border: `1px solid ${ink.axis}`,
            borderRadius: 1,
            px: 1,
            py: 0.5,
            fontSize: FONT + 1,
            maxHeight: Math.max(60, height - TOP * 2),
            maxWidth: Math.max(160, width * 0.7),
            overflow: 'hidden',
            zIndex: 2,
          }}
        >
          <Box sx={{ color: ink.secondary, mb: 0.25 }}>
            {formatTooltipTime(hoverT, tzOffsetSeconds)}
          </Box>
          <Box sx={{ columnCount: columns, columnGap: 1.5 }}>
            {rows.map(r => (
              <Box
                key={r.key}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.75,
                  breakInside: 'avoid',
                  whiteSpace: 'nowrap',
                }}
              >
                <Box
                  component="span"
                  sx={{ width: 10, height: 2, flex: 'none', bgcolor: r.colour }}
                />
                <Box component="span" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {r.value === null ? '-' : formatValue(r.value, unit)}
                </Box>
                <Box
                  component="span"
                  sx={{ color: ink.secondary, overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {r.name}
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}
