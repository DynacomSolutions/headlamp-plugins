/* A small line with a faint area under it, no axes. It fills its box. */
import React from 'react';
import { linePath } from './scale';

export function Sparkline(props: {
  values: Array<number | null>;
  colour: string;
  label: string;
  /** Draw from zero instead of from the smallest value. */
  fromZero?: boolean;
}): JSX.Element {
  const { values, colour, label } = props;
  const W = 200;
  const H = 40;
  const PAD = 3;
  const nums = values.filter((v): v is number => v !== null);
  const min = props.fromZero ? Math.min(0, ...nums) : Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const xs = (i: number) => (values.length > 1 ? (i / (values.length - 1)) * W : W / 2);
  const ys = (v: number) => (max === min ? H / 2 : H - PAD - ((v - min) / span) * (H - 2 * PAD));
  const pts: Array<[number, number | null]> = values.map((v, i) => [
    xs(i),
    v === null ? null : ys(v),
  ]);
  const line = nums.length > 1 ? linePath(pts) : '';
  const area = line && pts.every(p => p[1] !== null) ? `${line}L${W},${H}L0,${H}Z` : '';
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: '100%', display: 'block' }}
    >
      {area && <path d={area} fill={colour} fillOpacity={0.14} />}
      {line && (
        <path
          d={line}
          fill="none"
          stroke={colour}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
