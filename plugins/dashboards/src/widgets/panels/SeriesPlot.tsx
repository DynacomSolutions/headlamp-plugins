/*
 * The series of a panel on one shared plot: every line uses the same scale, so a person compares
 * them at once. Each line has its own hue and a direct label at its end, so no legend is needed.
 * A grid gives the scale. The colours are also drawn beside the rows (see `seriesColour`), so a
 * row and its line are linked by more than the order.
 */
import { useTheme } from '@mui/material/styles';
import React from 'react';
import type { PanelSeries } from './model';
import { useTokens } from './tokens';

const HUES_LIGHT = ['#2a78d6', '#1baf7a', '#6250d6', '#eb6834', '#e87ba4', '#eda100'];
const HUES_DARK = ['#3987e5', '#199e70', '#9085e9', '#d95926', '#d55181', '#c98500'];

/** The hue of the series at an index. Beyond six series the hues repeat. */
export function useSeriesColours(): (i: number) => string {
  const mode = useTheme().palette.mode;
  const hues = mode === 'dark' ? HUES_DARK : HUES_LIGHT;
  return i => hues[i % hues.length];
}

/** A round upper bound for the scale: 1, 2, 5 times a power of ten. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

const fmt = (n: number): string =>
  n >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1);
const short = (label: string): string => label.split('/').pop() ?? label;

export function SeriesPlot(props: {
  series: PanelSeries[];
  width: number;
  height: number;
}): JSX.Element | null {
  const { series, width, height } = props;
  const tk = useTokens();
  const colour = useSeriesColours();
  const maxPoints = Math.max(0, ...series.map(s => s.points.length));
  if (width < 80 || height < 50 || maxPoints < 2) return null;
  const labelW = Math.min(104, Math.max(64, width * 0.28));
  const left = 28;
  const top = 8;
  const plotW = width - left - labelW;
  const plotH = height - top - 16;
  const limit = series.find(s => s.limit !== undefined)?.limit;
  const unit = series.find(s => s.unit !== undefined)?.unit ?? '';
  const ymax = niceMax(Math.max(limit ? limit * 1.2 : 0, ...series.flatMap(s => s.points)));
  const x = (i: number, n: number) => left + (n > 1 ? (i / (n - 1)) * plotW : 0);
  const y = (v: number) => top + plotH - (Math.min(v, ymax) / ymax) * plotH;
  const lines = series.map((s, i) => {
    const pts = s.points.map((v, k) => [x(k, s.points.length), y(v)] as const);
    return { s, i, pts, end: pts[pts.length - 1] };
  });
  // Spread the end labels at least 14 px apart.
  const order = [...lines].sort((a, b) => (a.end?.[1] ?? 0) - (b.end?.[1] ?? 0));
  const labelY = new Map<number, number>();
  let prev = -99;
  for (const l of order) {
    const v = Math.max(l.end?.[1] ?? 0, prev + 14);
    labelY.set(l.i, v);
    prev = v;
  }
  const bottom = top + plotH + 2;
  let upper = bottom;
  for (let k = order.length - 1; k >= 0; k--) {
    const v = Math.min(labelY.get(order[k].i) ?? 0, upper);
    labelY.set(order[k].i, v);
    upper = v - 14;
  }
  const ticks = [0, ymax / 2, ymax];
  return (
    <svg
      data-series-plot
      role="img"
      aria-label={`${series.map(s => short(s.label)).join(', ')} on one scale, up to ${fmt(ymax)}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block', flex: 'none' }}
    >
      {ticks.map(g => (
        <g key={g}>
          <line x1={left} x2={left + plotW} y1={y(g)} y2={y(g)} stroke={tk.line} />
          <text x={left - 6} y={y(g) + 3.5} textAnchor="end" fontSize={10} fill={tk.mut}>
            {fmt(g)}
            {unit}
          </text>
        </g>
      ))}
      {limit !== undefined && (
        <g data-series-limit>
          <line
            x1={left}
            x2={left + plotW}
            y1={y(limit)}
            y2={y(limit)}
            stroke={tk.status.crit}
            strokeWidth={1.2}
            strokeDasharray="5 4"
          />
          <text
            x={left + plotW}
            y={y(limit) - 4}
            textAnchor="end"
            fontSize={10.5}
            fill={tk.status.crit}
          >
            {fmt(limit)}
            {unit} limit
          </text>
        </g>
      )}
      <text x={left + plotW} y={height - 3} textAnchor="end" fontSize={10} fill={tk.mut}>
        now
      </text>
      {lines.map(l => (
        <g key={l.s.label + l.i}>
          <polyline
            data-sparkline
            points={l.pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')}
            fill="none"
            stroke={colour(l.i)}
            strokeWidth={1.8}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {l.end && <circle cx={l.end[0]} cy={l.end[1]} r={3} fill={colour(l.i)} />}
        </g>
      ))}
      {lines.map(l => (
        <text
          key={`t-${l.s.label}-${l.i}`}
          x={left + plotW + 8}
          y={(labelY.get(l.i) ?? 0) + 3.5}
          fontSize={11.5}
          fill={tk.fg}
        >
          <tspan fill={colour(l.i)}>●</tspan> {short(l.s.label)}
        </text>
      ))}
    </svg>
  );
}
