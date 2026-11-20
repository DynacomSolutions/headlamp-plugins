/*
 * Charts for summary reports: bar, horizontal bar, donut and stacked bar. Plain SVG. Every group
 * is its own bar or slice: nothing is merged into "Other". A long list scrolls inside the chart.
 */
import Box from '@mui/material/Box';
import React from 'react';
import { arcPath, ChartCategory, ChartData, donutArcs, niceScale, seriesPaint } from './chart';
import type { ChartType } from './config';
import { formatNumber } from './model';
import type { ReportColors } from './theme';

const GAP = 2; // the surface gap between touching fills

function useSize(): [React.RefObject<HTMLDivElement>, { w: number; h: number }] {
  const ref = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState({ w: 480, h: 220 });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setSize({ w: el.clientWidth || 480, h: el.clientHeight || 220 });
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** A bar with a rounded data end (4 px) and a square base on the baseline. */
function barPath(x: number, y: number, w: number, h: number, horizontal: boolean, round: boolean): string {
  if (h <= 0 || w <= 0) return '';
  const r = round ? Math.min(4, (horizontal ? h : w) / 2) : 0;
  if (horizontal) {
    // x, y is the top left. The data end is on the right.
    return `M ${x} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} H ${x} Z`;
  }
  return `M ${x} ${y + h} V ${y + r} Q ${x} ${y} ${x + r} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + h} Z`;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function Legend(props: { items: Array<{ label: string; paint: ReturnType<typeof seriesPaint>; value?: string }>; colors: ReportColors; scroll?: boolean }): JSX.Element {
  const { items, colors } = props;
  return (
    <Box
      component="ul"
      aria-label="Legend"
      sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexWrap: 'wrap', gap: '2px 14px', maxHeight: props.scroll ? '100%' : 56, overflow: 'auto', color: colors.muted, fontSize: '0.75rem' }}
    >
      {items.map(it => (
        <li key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: it.paint.color, opacity: it.paint.opacity, flex: 'none' }} />
          <span style={{ color: colors.text }}>{it.label}</span>
          {it.value !== undefined && <span>{it.value}</span>}
        </li>
      ))}
    </Box>
  );
}

function VerticalBars(props: { data: ChartData; stacked: boolean; colors: ReportColors }): JSX.Element {
  const { data, stacked, colors } = props;
  const [ref, size] = useSize();
  const cats = data.categories;
  const n = Math.max(1, cats.length);
  const left = 44;
  const bottom = 56;
  const top = 12;
  const minSlot = 22;
  const innerW = Math.max(size.w - left - 8, n * minSlot);
  const slot = innerW / n;
  const barW = Math.max(3, Math.min(48, slot - 6));
  const innerH = Math.max(40, size.h - top - bottom);
  const max = Math.max(...cats.map(c => Math.max(0, c.total)), 0);
  const scale = niceScale(max);
  const y = (v: number) => top + innerH - (Math.max(0, v) / scale.end) * innerH;
  const showValues = slot >= 30 && n <= 16;
  const showLabels = slot >= 18;
  return (
    <Box ref={ref} sx={{ flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'hidden' }}>
      <svg width={left + innerW + 8} height={size.h} role="img" aria-label={`Bar chart of ${data.measureLabel} by group`} style={{ display: 'block' }}>
        {scale.ticks.map(t => (
          <g key={t}>
            <line x1={left} x2={left + innerW} y1={y(t)} y2={y(t)} stroke={colors.line} strokeWidth={1} />
            <text x={left - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill={colors.muted}>
              {formatNumber(t)}
            </text>
          </g>
        ))}
        {cats.map((c, i) => {
          const cx = left + slot * i + slot / 2;
          const x = cx - barW / 2;
          return (
            <g key={c.id}>
              <title>{`${c.label}: ${formatNumber(c.total)} (${data.measureLabel})`}</title>
              {stacked && c.segments.length > 0 ? (
                <StackedColumn category={c} x={x} w={barW} y={y} series={data.series} dark={colors.dark} surface={colors.surface} />
              ) : (
                <path d={barPath(x, y(c.total), barW, top + innerH - y(c.total), false, true)} fill={seriesPaint(0, colors.dark).color} />
              )}
              {showValues && c.total > 0 && (
                <text x={cx} y={y(c.total) - 4} textAnchor="middle" fontSize={11} fill={colors.text}>
                  {formatNumber(c.total)}
                </text>
              )}
              {showLabels && (
                <text transform={`translate(${cx} ${top + innerH + 10}) rotate(${slot >= 80 ? 0 : -40})`} textAnchor={slot >= 80 ? 'middle' : 'end'} fontSize={11} fill={colors.muted}>
                  {clip(c.label, slot >= 80 ? 12 : 14)}
                </text>
              )}
            </g>
          );
        })}
        <line x1={left} x2={left + innerW} y1={top + innerH} y2={top + innerH} stroke={colors.muted} strokeWidth={1} />
      </svg>
    </Box>
  );
}

function StackedColumn(props: {
  category: ChartCategory;
  x: number;
  w: number;
  y: (v: number) => number;
  series: string[];
  dark: boolean;
  surface: string;
}): JSX.Element {
  const { category, x, w, y, series, dark, surface } = props;
  const parts = [...category.segments]
    .filter(s => s.value > 0)
    .sort((a, b) => series.indexOf(a.label) - series.indexOf(b.label));
  let acc = 0;
  return (
    <>
      {parts.map((s, i) => {
        const y0 = y(acc);
        acc += s.value;
        const y1 = y(acc);
        const paint = seriesPaint(series.indexOf(s.label), dark);
        // The surface coloured stroke makes the 2 px gap between touching segments.
        return (
          <path
            key={s.id}
            d={barPath(x, y1, w, Math.max(1, y0 - y1), false, i === parts.length - 1)}
            fill={paint.color}
            fillOpacity={paint.opacity}
            stroke={surface}
            strokeWidth={GAP}
          >
            <title>{`${category.label} / ${s.label}: ${formatNumber(s.value)}`}</title>
          </path>
        );
      })}
    </>
  );
}

function HorizontalBars(props: { data: ChartData; colors: ReportColors }): JSX.Element {
  const { data, colors } = props;
  const [ref, size] = useSize();
  const rowH = 26;
  const labelW = Math.min(180, Math.max(90, size.w * 0.3));
  const right = 56;
  const cats = data.categories;
  const max = Math.max(...cats.map(c => Math.max(0, c.total)), 0);
  const scale = niceScale(max);
  const barMax = Math.max(20, size.w - labelW - right - 8);
  return (
    <Box ref={ref} sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
      <svg width={size.w} height={cats.length * rowH + 4} role="img" aria-label={`Horizontal bar chart of ${data.measureLabel} by group`} style={{ display: 'block' }}>
        {cats.map((c, i) => {
          const w = (Math.max(0, c.total) / scale.end) * barMax;
          const yy = i * rowH + 2;
          return (
            <g key={c.id}>
              <title>{`${c.label}: ${formatNumber(c.total)} (${data.measureLabel})`}</title>
              <text x={labelW - 8} y={yy + rowH / 2 + 4} textAnchor="end" fontSize={12} fill={colors.text}>
                {clip(c.label, Math.floor(labelW / 7))}
              </text>
              <path d={barPath(labelW, yy + 4, Math.max(w, 1), rowH - 8, true, true)} fill={seriesPaint(0, colors.dark).color} />
              <text x={labelW + Math.max(w, 1) + 6} y={yy + rowH / 2 + 4} fontSize={11} fill={colors.muted}>
                {formatNumber(c.total)}
              </text>
            </g>
          );
        })}
      </svg>
    </Box>
  );
}

function Donut(props: { data: ChartData; colors: ReportColors }): JSX.Element {
  const { data, colors } = props;
  const [ref, size] = useSize();
  const arcs = donutArcs(data.categories);
  const total = arcs.reduce((n, a) => n + Math.max(0, a.value), 0);
  const d = Math.max(80, Math.min(size.h - 8, size.w * 0.5));
  const cx = d / 2;
  const outer = d / 2 - 2;
  const inner = outer * 0.62;
  return (
    <Box ref={ref} sx={{ flex: 1, minHeight: 0, display: 'flex', gap: 2, alignItems: 'center' }}>
      <svg width={d} height={d} role="img" aria-label={`Donut chart of ${data.measureLabel} by group`} style={{ flex: 'none' }}>
        {arcs.map((a, i) =>
          a.fraction > 0 ? (
            <path
              key={a.id}
              d={arcPath(cx, cx, outer, inner, a.start, a.end)}
              fill={seriesPaint(i, colors.dark).color}
              fillOpacity={seriesPaint(i, colors.dark).opacity}
              fillRule="evenodd"
              stroke={colors.surface}
              strokeWidth={GAP}
            >
              <title>{`${a.label}: ${formatNumber(a.value)} (${(a.fraction * 100).toFixed(1)}%)`}</title>
            </path>
          ) : null
        )}
        <text x={cx} y={cx - 2} textAnchor="middle" fontSize={Math.max(14, d / 7)} fontWeight={600} fill={colors.text}>
          {formatNumber(total)}
        </text>
        <text x={cx} y={cx + 16} textAnchor="middle" fontSize={11} fill={colors.muted}>
          {clip(data.measureLabel, 18)}
        </text>
      </svg>
      <Box sx={{ flex: 1, minWidth: 0, maxHeight: '100%', overflow: 'auto' }}>
        <Legend
          scroll
          colors={colors}
          items={arcs.map((a, i) => ({ label: a.label, paint: seriesPaint(i, colors.dark), value: `${formatNumber(a.value)} (${(a.fraction * 100).toFixed(1)}%)` }))}
        />
      </Box>
    </Box>
  );
}

export function ReportChart(props: { type: ChartType; data: ChartData; colors: ReportColors }): JSX.Element | null {
  const { type, data, colors } = props;
  if (type === 'none' || data.categories.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 0.5 }}>
      {type === 'bar' && <VerticalBars data={data} stacked={false} colors={colors} />}
      {type === 'stacked' && (
        <>
          {data.series.length > 0 && <Legend colors={colors} items={data.series.map((s, i) => ({ label: s, paint: seriesPaint(i, colors.dark) }))} />}
          <VerticalBars data={data} stacked colors={colors} />
        </>
      )}
      {type === 'hbar' && <HorizontalBars data={data} colors={colors} />}
      {type === 'donut' && <Donut data={data} colors={colors} />}
    </Box>
  );
}
