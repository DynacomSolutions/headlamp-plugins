import { describe, expect, it } from 'vitest';
import { arcPath, chartData, donutArcs, niceScale, seriesPaint } from './chart';
import { DEFAULT_REPORT, ReportConfig } from './config';
import { buildReport, SummaryReport } from './model';

const mk = (ns: string, phase: string, restarts = 0) => ({
  kind: 'Pod',
  metadata: { name: `${ns}-${phase}-${Math.random()}`, namespace: ns },
  status: { phase, containerStatuses: [{ ready: true, restartCount: restarts }] },
});
const objs = [
  mk('a', 'Running', 1),
  mk('a', 'Running', 2),
  mk('a', 'Pending', 4),
  mk('b', 'Running', 8),
];
const cfg = (patch: Partial<ReportConfig>): ReportConfig => ({
  ...DEFAULT_REPORT,
  reportType: 'summary',
  ...patch,
});
const run = (patch: Partial<ReportConfig>) =>
  buildReport(objs, cfg(patch), { now: 0, scope: { namespaces: [], nodes: [] } }) as SummaryReport;

describe('chart data', () => {
  it('has one category per group with the row count', () => {
    const d = chartData(run({ groupBy: ['namespace'] }), 'bar', -1);
    expect(d.categories.map(c => [c.label, c.total])).toEqual([
      ['a', 3],
      ['b', 1],
    ]);
    expect(d.measureLabel).toBe('Rows');
  });
  it('charts an aggregate', () => {
    const d = chartData(
      run({ groupBy: ['namespace'], aggregates: [{ field: 'restarts', fn: 'sum' }] }),
      'hbar',
      0
    );
    expect(d.categories.map(c => c.total)).toEqual([7, 8]);
    expect(d.measureLabel).toBe('sum of Restarts');
  });
  it('stacks the second group level as series', () => {
    const d = chartData(run({ groupBy: ['namespace', 'status'] }), 'stacked', -1);
    expect(d.series).toEqual(['Pending', 'Running']);
    expect(d.categories[0].segments.map(s => [s.label, s.value])).toEqual([
      ['Pending', 1],
      ['Running', 2],
    ]);
  });
  it('never merges groups into an Other bucket, however many there are', () => {
    const many = Array.from({ length: 60 }, (_, i) => mk(`ns-${i}`, 'Running'));
    const r = buildReport(many, cfg({ groupBy: ['namespace'] }), {
      now: 0,
      scope: { namespaces: [], nodes: [] },
    }) as SummaryReport;
    const d = chartData(r, 'donut', -1);
    expect(d.categories).toHaveLength(60);
    expect(d.categories.some(c => /other/i.test(c.label))).toBe(false);
    expect(donutArcs(d.categories)).toHaveLength(60);
  });
});

describe('chart geometry', () => {
  it('rounds the axis to tidy ticks', () => {
    expect(niceScale(0)).toEqual({ end: 1, ticks: [0, 1] });
    expect(niceScale(7)).toEqual({ end: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceScale(96).end).toBeGreaterThanOrEqual(96);
  });
  it('gives donut slices that sum to a full turn', () => {
    const arcs = donutArcs([
      { id: '1', label: 'a', total: 1, segments: [] },
      { id: '2', label: 'b', total: 3, segments: [] },
      { id: '3', label: 'c', total: 0, segments: [] },
    ]);
    expect(arcs[0].fraction).toBeCloseTo(0.25);
    expect(arcs[1].end).toBeCloseTo(Math.PI * 2);
    expect(arcs[2].end).toBe(arcs[2].start);
  });
  it('draws a single full slice as a closed shape', () => {
    expect(arcPath(50, 50, 40, 20, 0, Math.PI * 2)).toContain('Z');
    expect(arcPath(50, 50, 40, 20, 0, Math.PI)).toMatch(/^M .* A 40 40 0 0 1/);
  });
  it('keeps the first eight series in fixed order and reuses hues after that', () => {
    expect(seriesPaint(0, false)).toEqual({ color: '#2a78d6', opacity: 1 });
    expect(seriesPaint(0, true).color).toBe('#3987e5');
    expect(seriesPaint(8, false).color).toBe('#2a78d6');
    expect(seriesPaint(8, false).opacity).toBeLessThan(1);
  });
});
