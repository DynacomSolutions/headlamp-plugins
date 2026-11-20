/* A small line chart of one series: no axes, one line, the last point marked. */
import { useTheme } from '@mui/material/styles';
import React from 'react';

const W = 120;
const H = 28;
const PAD = 3;

/** The SVG path points of a series, scaled to the box. A flat series draws a middle line. */
export function sparklinePoints(
  points: number[],
  w = W,
  h = H,
  pad = PAD
): Array<[number, number]> {
  if (points.length === 0) return [];
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min;
  const step = points.length > 1 ? (w - 2 * pad) / (points.length - 1) : 0;
  return points.map((p, i) => [
    points.length > 1 ? pad + i * step : w / 2,
    span === 0 ? h / 2 : h - pad - ((p - min) / span) * (h - 2 * pad),
  ]);
}

export function Sparkline(props: {
  label: string;
  points: number[];
  colour?: string;
}): JSX.Element {
  const theme = useTheme();
  const { label, points } = props;
  const colour = props.colour ?? (theme.palette.mode === 'dark' ? '#56B4E9' : '#0072B2');
  const xy = sparklinePoints(points);
  const last = xy[xy.length - 1];
  const first = points[0];
  const end = points[points.length - 1];
  const text =
    points.length === 0
      ? `${label}: no data`
      : `${label}: from ${first} to ${end} over ${points.length} points`;
  return (
    <svg
      role="img"
      aria-label={text}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: H, display: 'block' }}
    >
      <title>{text}</title>
      {xy.length > 1 && (
        <polyline
          data-sparkline
          points={xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
          fill="none"
          stroke={colour}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {last && (
        <circle
          cx={last[0]}
          cy={last[1]}
          r={2.5}
          fill={colour}
          stroke={theme.palette.background.paper}
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
}
