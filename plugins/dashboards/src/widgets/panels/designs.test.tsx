import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn(), clusterRequest: vi.fn() },
  ConfigStore: class {},
}));

import { parsePanel } from './model';
import { fitLaneRows, fullCount, PanelLanes, worstSegment } from './PanelLanes';
import { DEFAULT_DISPLAY, displayOf, PanelView } from './PanelView';
import { groupRows } from './rowGroups';
import { fitRows, isInformative, MORE_HEIGHT, ROW_HEIGHT } from './RowList';
import { niceMax } from './SeriesPlot';
import { worstStat } from './StatTiles';
import { bySeverity } from './tokens';

afterEach(cleanup);

const view = (node: React.ReactNode, mode: 'dark' | 'light' = 'dark') =>
  render(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <MemoryRouter>{node}</MemoryRouter>
    </ThemeProvider>
  );

const panel = (extra: Record<string, unknown>) =>
  parsePanel({ version: 1, id: 'p', status: 'ok', summary: 'Fine', ...extra });

describe('severity order of rows', () => {
  it('puts the worst rows first and keeps the order of equal rows', () => {
    const rows = [
      { id: 'a', status: 'ok' as const },
      { id: 'b', status: 'warn' as const },
      { id: 'c', status: 'crit' as const },
      { id: 'd', status: 'ok' as const },
      { id: 'e', status: 'unknown' as const },
    ];
    expect(bySeverity(rows).map(r => r.id)).toEqual(['c', 'b', 'e', 'a', 'd']);
  });
});

describe('row fit', () => {
  it('shows every row when they fit or when the height is not measured', () => {
    expect(fitRows(10, 0, ROW_HEIGHT)).toBe(10);
    expect(fitRows(4, 4 * ROW_HEIGHT, ROW_HEIGHT)).toBe(4);
  });
  it('shows the rows that fit and leaves room for the "+N more" line', () => {
    const n = fitRows(40, 300, ROW_HEIGHT);
    expect(n * ROW_HEIGHT + MORE_HEIGHT).toBeLessThanOrEqual(300);
    expect((n + 1) * ROW_HEIGHT + MORE_HEIGHT).toBeGreaterThan(300);
  });
  it('always shows one row', () => {
    expect(fitRows(10, 10, ROW_HEIGHT)).toBe(1);
  });
  it('draws a bar only when it tells something', () => {
    const row = { label: 'a', detail: '', value: '1', status: 'ok' as const };
    expect(isInformative({ ...row, fraction: 1 })).toBe(false);
    expect(isInformative({ ...row, fraction: 0.4 })).toBe(true);
    expect(isInformative({ ...row, fraction: 1, status: 'warn' })).toBe(true);
    expect(isInformative(row)).toBe(false);
  });
});

describe('stat tiles', () => {
  it('marks the worst tile with a real value, never a zero tile', () => {
    const stat = (value: string, status: 'ok' | 'warn' | 'crit') => ({ label: 'x', value, status });
    expect(worstStat([stat('95', 'ok'), stat('1', 'warn'), stat('0', 'crit')])).toBe(1);
    expect(worstStat([stat('95', 'ok'), stat('0', 'warn')])).toBe(-1);
  });
  it('renders one tile for each stat and flags the worst', () => {
    const { container } = view(
      <PanelView
        kiosk
        editing={false}
        panel={panel({
          stats: [
            { label: 'Up', value: '95', status: 'ok' },
            { label: 'Down', value: '3', status: 'crit' },
          ],
        })}
      />
    );
    expect(container.querySelectorAll('[data-stat]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-stat-worst]')).toHaveLength(1);
  });
});

describe('row list', () => {
  it('sorts rows by severity in the panel', () => {
    const { container } = view(
      <PanelView
        kiosk
        editing={false}
        panel={panel({
          rows: [
            { label: 'fine', detail: '', value: '1', status: 'ok' },
            { label: 'broken', detail: '', value: '2', status: 'crit' },
          ],
        })}
      />
    );
    const labels = Array.from(container.querySelectorAll('[data-row]')).map(r => r.textContent);
    expect(labels[0]).toContain('broken');
    expect(labels[1]).toContain('fine');
  });
});

describe('shared series plot', () => {
  it('rounds the scale up to 1, 2 or 5 times a power of ten', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(0.3)).toBe(0.5);
    expect(niceMax(3.6)).toBe(5);
    expect(niceMax(34.3)).toBe(50);
    expect(niceMax(180)).toBe(200);
  });
  it('keeps the optional limit and unit of a series and drops bad ones', () => {
    const p = panel({
      series: [
        { label: 'a', points: [1, 2], limit: 5, unit: 's' },
        { label: 'b', points: [1, 2], limit: -3, unit: 5 },
      ],
    });
    expect(p.series[0]).toMatchObject({ limit: 5, unit: 's' });
    expect(p.series[1].limit).toBeUndefined();
  });
});

const LIMITS = [
  { label: 'A / one', detail: '5-hour', value: '10%', fraction: 0.1, status: 'ok' },
  { label: 'A / one', detail: 'Weekly', value: '100%', fraction: 1, status: 'crit' },
  { label: 'A / one', detail: 'Weekly (Fable)', value: '100%', fraction: 1, status: 'crit' },
  { label: 'B / two', detail: 'Monthly', value: '40%', fraction: 0.4, status: 'ok' },
  { label: 'C / three', detail: 'Weekly', value: '50%', fraction: 0.5, status: 'ok' },
];

describe('stacked lanes', () => {
  it('has the layout name `stacked-lanes` and keeps `grouped-bars`', () => {
    expect(displayOf({ rowLayout: 'stacked-lanes' }).rowLayout).toBe('stacked-lanes');
    expect(displayOf({ rowLayout: 'grouped-bars' }).rowLayout).toBe('grouped-bars');
    expect(displayOf({ rowLayout: 'other' }).rowLayout).toBe('list');
  });
  it('fits the rows to the height and keeps the lane height rules', () => {
    expect(fitLaneRows(16, 0, true).shown).toBe(16);
    const small = fitLaneRows(16, 200, false);
    expect(small.shown).toBeLessThan(16);
    expect(small.shown * small.rowHeight + 22).toBeLessThanOrEqual(200);
    expect(fitLaneRows(4, 600, true).rowHeight).toBeLessThanOrEqual(46);
  });
  it('finds the worst limit and counts the full limits', () => {
    const { groups } = groupRows(panel({ rows: LIMITS }).rows);
    expect(worstSegment(groups[0]).row.status).toBe('crit');
    expect(fullCount(groups[0])).toBe(2);
    expect(fullCount(groups[1])).toBe(0);
  });
  it('draws one bar for each identity with one lane for each limit it has', () => {
    const { container } = view(
      <PanelLanes rows={panel({ rows: LIMITS }).rows} kiosk editing={false} />
    );
    const bars = Array.from(container.querySelectorAll('[data-bar-group]'));
    expect(bars.map(b => b.getAttribute('data-bar-group'))).toEqual([
      'A / one',
      'B / two',
      'C / three',
    ]);
    expect(bars.map(b => b.querySelectorAll('[data-lane]').length)).toEqual([3, 1, 1]);
    const first = Array.from(bars[0].querySelectorAll('[data-lane]')).map(l =>
      l.getAttribute('data-lane')
    );
    expect(first).toEqual(['5-hour', 'Weekly', 'Weekly (Fable)']);
    expect(container.querySelectorAll('[data-legend-item]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-bar-status] svg[data-status]')).toHaveLength(3);
  });
  it('is chosen by the row layout of the panel', () => {
    const { container } = view(
      <PanelView
        kiosk
        editing={false}
        display={{ ...DEFAULT_DISPLAY, rowLayout: 'stacked-lanes' }}
        panel={panel({ rows: LIMITS })}
      />
    );
    expect(container.querySelector('[data-lanes]')).not.toBeNull();
    expect(container.querySelector('[data-rows]')).toBeNull();
  });
});
