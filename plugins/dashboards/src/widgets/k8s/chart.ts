/*
 * Chart data and geometry for summary reports. Every group is its own bar or slice at its real
 * size: there is no "Other" bucket and no top-N cut. Pure functions, no React.
 */
import type { ChartType } from './config';
import type { Group, SummaryReport } from './model';

export interface ChartSegment {
  id: string;
  label: string;
  value: number;
}

export interface ChartCategory {
  id: string;
  label: string;
  /** The value of the whole group. */
  total: number;
  /** Stacked charts only: one segment per second-level group. */
  segments: ChartSegment[];
}

export interface ChartData {
  categories: ChartCategory[];
  /** Stacked charts only: the second-level labels, in order. A series keeps one colour. */
  series: string[];
  measureLabel: string;
}

function measureOf(g: Group, measure: number): number {
  const v = measure < 0 ? g.count : g.aggs[measure];
  return v !== null && v !== undefined && Number.isFinite(v) ? v : 0;
}

export function chartData(report: SummaryReport, type: ChartType, measure: number): ChartData {
  const agg = measure >= 0 ? report.aggregates[measure] : undefined;
  const measureLabel = agg ? agg.header : 'Rows';
  const stacked = type === 'stacked' && report.groupFields.length > 1;
  const series: string[] = [];
  if (stacked) {
    const seen = new Set<string>();
    for (const g of report.groups) {
      for (const c of g.children) {
        if (!seen.has(c.label)) {
          seen.add(c.label);
          series.push(c.label);
        }
      }
    }
    series.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  const categories: ChartCategory[] = report.groups.map(g => ({
    id: g.id,
    label: g.label,
    total: measureOf(g, measure),
    segments: stacked
      ? g.children.map(c => ({ id: c.id, label: c.label, value: measureOf(c, measure) }))
      : [],
  }));
  return { categories, series, measureLabel };
}

/** Round a maximum up to a tidy axis end and give the tick values (4 steps). */
export function niceScale(max: number): { end: number; ticks: number[] } {
  if (!(max > 0)) return { end: 1, ticks: [0, 1] };
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => s >= rough) ?? 10 * pow;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= end + step / 1000; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return { end, ticks };
}

/** The reference categorical palette (dataviz skill), light and dark steps. Slot 1 is blue. */
export const SERIES_LIGHT = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#6250d6',
  '#e34948',
];
export const SERIES_DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
];

export interface SeriesPaint {
  color: string;
  /** Below 1 for the second and later passes through the eight hues. */
  opacity: number;
}

/**
 * The paint of the nth series. The eight hues come first, in fixed order. A report may have more
 * groups than that, and every group stays its own slice, so later groups reuse the hues at lower
 * opacity. The tooltip and the legend name every slice, so colour is never the only identity.
 */
export function seriesPaint(index: number, dark: boolean): SeriesPaint {
  const colors = dark ? SERIES_DARK : SERIES_LIGHT;
  const pass = Math.floor(index / colors.length);
  return {
    color: colors[index % colors.length],
    opacity: pass === 0 ? 1 : Math.max(0.35, 1 - pass * 0.25),
  };
}

export interface Arc {
  id: string;
  label: string;
  value: number;
  /** Radians, clockwise from twelve o'clock. */
  start: number;
  end: number;
  fraction: number;
}

/** Slice angles for a donut. A zero or negative value gets no angle but stays in the list. */
export function donutArcs(categories: ChartCategory[]): Arc[] {
  const total = categories.reduce((n, c) => n + Math.max(0, c.total), 0);
  let angle = 0;
  return categories.map(c => {
    const v = Math.max(0, c.total);
    const fraction = total > 0 ? v / total : 0;
    const start = angle;
    angle += fraction * Math.PI * 2;
    return { id: c.id, label: c.label, value: c.total, start, end: angle, fraction };
  });
}

/** An SVG path for a donut slice. A full circle is drawn as two halves, as one arc cannot close itself. */
export function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  start: number,
  end: number
): string {
  const full = end - start >= Math.PI * 2 - 1e-6;
  const pt = (r: number, a: number) =>
    `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
  if (full) {
    return `M ${pt(outer, 0)} A ${outer} ${outer} 0 1 1 ${pt(
      outer,
      Math.PI
    )} A ${outer} ${outer} 0 1 1 ${pt(outer, 0)} Z M ${pt(inner, 0)} A ${inner} ${inner} 0 1 0 ${pt(
      inner,
      Math.PI
    )} A ${inner} ${inner} 0 1 0 ${pt(inner, 0)} Z`;
  }
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${pt(outer, start)} A ${outer} ${outer} 0 ${large} 1 ${pt(outer, end)} L ${pt(
    inner,
    end
  )} A ${inner} ${inner} 0 ${large} 0 ${pt(inner, start)} Z`;
}
