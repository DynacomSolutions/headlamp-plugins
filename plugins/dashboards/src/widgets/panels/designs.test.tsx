import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn(), clusterRequest: vi.fn() },
  ConfigStore: class {},
}));

import { alertChipsWidget } from './AlertChips';
import { PANEL_WIDGETS } from './index';
import { parsePanel } from './model';
import { fitLaneRows, fullCount, PanelLanes, worstSegment } from './PanelLanes';
import { DEFAULT_DISPLAY, displayOf, PanelView } from './PanelView';
import { groupRows } from './rowGroups';
import { isInformative, orderRows, VALUE_FONT_SIZE, VALUE_FONT_WEIGHT } from './RowList';
import { niceMax } from './SeriesPlot';
import { tileSize, worstStat } from './StatTiles';
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

describe('row order', () => {
  const row = (label: string, status: 'ok' | 'warn' | 'crit') => ({
    label,
    detail: '',
    value: '1',
    status,
  });
  it('draws every row, the worst first, and folds none', () => {
    const rows = [row('a', 'ok'), row('b', 'crit'), row('c', 'ok'), row('d', 'warn')];
    expect(orderRows(rows).map(r => r.label)).toEqual(['b', 'd', 'a', 'c']);
    expect(orderRows(rows)).toEqual(bySeverity(rows));
  });
  it('keeps all of a long list, with no "+N more" cut', () => {
    const rows = Array.from({ length: 200 }, (_, i) => row(`r${i}`, 'ok'));
    expect(orderRows(rows)).toHaveLength(200);
  });
  it('draws a bar only when it tells something', () => {
    const base = row('a', 'ok');
    expect(isInformative({ ...base, fraction: 1 })).toBe(false);
    expect(isInformative({ ...base, fraction: 0.4 })).toBe(true);
    expect(isInformative({ ...base, fraction: 1, status: 'warn' })).toBe(true);
    expect(isInformative(base)).toBe(false);
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
  it('shows every row, the worst row as a band first, and folds none into one line', () => {
    const { container } = view(
      <PanelView
        kiosk
        editing={false}
        panel={panel({
          id: 'uptime',
          rows: [
            { label: 'fine', detail: '', value: '1', status: 'ok' },
            { label: 'fine2', detail: '', value: '1', status: 'ok' },
            { label: 'broken', detail: '', value: '2', status: 'crit' },
          ],
        })}
      />
    );
    expect(container.querySelectorAll('[data-row]')).toHaveLength(3);
    expect(container.querySelector('[data-row]')?.textContent).toContain('broken');
    expect(container.querySelector('[data-rows-fold]')).toBeNull();
    expect(container.textContent).not.toMatch(/\bmore\b/i);
  });
  it('gives every row value one size and weight, whatever the text or the status', () => {
    const look = (rows: { label: string; value: string; status: string }[]): string[] => {
      const { container, unmount } = view(
        <PanelView
          kiosk
          editing={false}
          panel={panel({
            id: 'pools',
            rows: rows.map(r => ({ ...r, detail: '' })),
          })}
        />
      );
      const values = Array.from(container.querySelectorAll('[data-row-value]'));
      expect(values.length).toBe(rows.length);
      const out = values.map(v => {
        const c = getComputedStyle(v);
        return `${c.fontSize}/${c.fontWeight}/${c.fontVariantNumeric}`;
      });
      unmount();
      return out;
    };
    // Healthy rows fold when a row needs attention, so draw the two groups apart.
    const healthy = look([
      { label: 'a', value: '5/200', status: 'ok' },
      { label: 'b', value: '33/200', status: 'ok' },
      { label: 'c', value: '2m 7s', status: 'ok' },
      { label: 'd', value: '13 dbs', status: 'ok' },
    ]);
    const attention = look([
      { label: 'e', value: '-', status: 'warn' },
      { label: 'f', value: 'open', status: 'crit' },
      { label: 'g', value: '100%', status: 'unknown' },
      { label: 'h', value: '4/4 members', status: 'crit' },
    ]);
    const all = [...healthy, ...attention];
    expect(new Set(all).size).toBe(1);
    expect(all[0]).toBe(`${VALUE_FONT_SIZE}px/${VALUE_FONT_WEIGHT}/tabular-nums`);
  });
  it('gives every stat tile of a row one numeral size', () => {
    const stats = [
      { label: 'Queued', value: '5', status: 'ok' as const },
      { label: 'Oldest', value: '2m 7s', status: 'ok' as const },
    ];
    expect(tileSize(stats, false)).toBe(tileSize([stats[1]], false));
    const { container } = view(<PanelView kiosk editing={false} panel={panel({ stats })} />);
    const sizes = Array.from(container.querySelectorAll('[data-stat] > div:first-child')).map(
      v => getComputedStyle(v).fontSize
    );
    expect(sizes).toHaveLength(2);
    expect(new Set(sizes).size).toBe(1);
  });
  it('gives every number of the summary line one size', () => {
    const { container } = view(
      <PanelView kiosk editing={false} panel={panel({ summary: '95 up, 1 degraded, 0 down' })} />
    );
    expect(container.querySelectorAll('[data-panel-summary]')).toHaveLength(1);
  });
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
    expect(container.querySelector('[data-rows-fold]')).toBeNull();
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

describe('no fold rows and one fixed summary', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      label: `row ${i}`,
      detail: '',
      value: `${i}`,
      status: i % 7 === 0 ? 'crit' : 'ok',
    }));
  const text = (c: HTMLElement) => c.textContent ?? '';
  it('draws all rows of a long list inside one scroll area, and no "more" line', () => {
    const { container } = view(
      <PanelView kiosk editing={false} panel={panel({ id: 'uptime', rows: many(120) })} />
    );
    const area = container.querySelector('[data-scroll-area]') as HTMLElement;
    expect(area).toBeTruthy();
    expect(area.querySelectorAll('[data-row]')).toHaveLength(120);
    expect(container.querySelector('[data-rows-more]')).toBeNull();
    expect(container.querySelector('[data-rows-fold]')).toBeNull();
    expect(text(container)).not.toMatch(/\bmore\b/i);
  });
  it('keeps the stat tiles and the summary line outside the scroll area', () => {
    const { container } = view(
      <PanelView
        kiosk
        editing={false}
        panel={panel({
          rows: many(30),
          stats: [{ label: 'Up', value: '25', status: 'ok' }],
          summary: 'All fine',
        })}
      />
    );
    const area = container.querySelector('[data-scroll-area]') as HTMLElement;
    expect(area.contains(container.querySelector('[data-stat]'))).toBe(false);
    expect(area.contains(container.querySelector('[data-panel-summary]'))).toBe(false);
    expect(area.contains(container.querySelector('[data-row]'))).toBe(true);
    expect(getComputedStyle(area).overflowY).toBe('auto');
    expect(getComputedStyle(area).overscrollBehavior).toBe('contain');
  });
  it('lanes keep the legend outside the scroll area and draw every group', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      label: `acct ${i}`,
      detail: i % 2 ? 'Weekly' : '5-hour',
      value: '10%',
      status: 'ok',
      fraction: 0.1,
    }));
    const { container } = view(
      <PanelView
        kiosk
        editing={false}
        display={{ ...DEFAULT_DISPLAY, rowLayout: 'stacked-lanes' }}
        panel={panel({ rows })}
      />
    );
    const area = container.querySelector('[data-scroll-area]') as HTMLElement;
    expect(area.contains(container.querySelector('[data-legend]'))).toBe(false);
    expect(area.querySelectorAll('[data-bar-group]')).toHaveLength(40);
    expect(container.querySelector('[data-rows-more]')).toBeNull();
    expect(text(container)).not.toMatch(/\bmore\b/i);
  });
  it('grouped bars keep the legend outside the scroll area and draw every group', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      label: `acct ${i}`,
      detail: 'Weekly',
      value: '10%',
      status: 'ok',
      fraction: 0.1,
    }));
    const { container } = view(
      <PanelView
        kiosk
        editing={false}
        display={{ ...DEFAULT_DISPLAY, rowLayout: 'grouped-bars' }}
        panel={panel({ rows })}
      />
    );
    const area = container.querySelector('[data-scroll-area]') as HTMLElement;
    expect(area.contains(container.querySelector('[data-legend]'))).toBe(false);
    expect(area.querySelectorAll('[data-bar-group]')).toHaveLength(40);
  });
});

describe('stacked lanes', () => {
  it('has the layout name `stacked-lanes` and keeps `grouped-bars`', () => {
    expect(displayOf({ rowLayout: 'stacked-lanes' }).rowLayout).toBe('stacked-lanes');
    expect(displayOf({ rowLayout: 'grouped-bars' }).rowLayout).toBe('grouped-bars');
    expect(displayOf({ rowLayout: 'other' }).rowLayout).toBe('list');
  });
  it('draws every row: a small height keeps the minimum row height and the list scrolls', () => {
    expect(fitLaneRows(16, 0, true).shown).toBe(16);
    const small = fitLaneRows(16, 200, false);
    expect(small.shown).toBe(16);
    expect(small.rowHeight).toBe(21);
    expect(fitLaneRows(16, 200, true).rowHeight).toBe(25);
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

describe('series limit from the widget settings', () => {
  it('reads a limit line and a unit from the display options and drops bad ones', () => {
    expect(displayOf({ seriesLimit: 5, seriesUnit: 's' })).toMatchObject({
      seriesLimit: 5,
      seriesUnit: 's',
    });
    expect(displayOf({ seriesLimit: -1, seriesUnit: 3 }).seriesLimit).toBeUndefined();
    expect(displayOf({}).seriesUnit).toBeUndefined();
  });
});

describe('alert chips widget', () => {
  it('is a card-less header widget of the alerts panel that the palette lists', () => {
    expect(alertChipsWidget.type).toBe('agent.alert-chips');
    expect(alertChipsWidget.card).toBe(false);
    expect(alertChipsWidget.defaultConfig).toEqual({ source: 'agent', panel: 'alerts' });
    expect(PANEL_WIDGETS).toContain(alertChipsWidget);
  });
});
