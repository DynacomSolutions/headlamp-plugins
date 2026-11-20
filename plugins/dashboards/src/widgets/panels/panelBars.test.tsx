import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { CATEGORICAL } from '../promql/palette';
import { limitColour, REUSED_OPACITY } from './limitColours';
import { parsePanel } from './model';
import { DEFAULT_DISPLAY, displayOf, PanelDisplay, PanelView } from './PanelView';
import { groupRows, limitRank, orderLimits, UNNAMED_LIMIT } from './rowGroups';

afterEach(cleanup);

const wrap = (ui: React.ReactNode, mode: 'light' | 'dark' = 'light') => (
  <MemoryRouter>
    <ThemeProvider theme={createTheme({ palette: { mode } })}>{ui}</ThemeProvider>
  </MemoryRouter>
);

const row = (label: string, detail: string, fraction: number | undefined, status = 'ok') => ({
  label,
  detail,
  value: fraction === undefined ? 'n/a' : `${Math.round(fraction * 100)}%`,
  ...(fraction === undefined ? {} : { fraction }),
  status,
});

const LIMITS = parsePanel({
  version: 1,
  id: 'limits',
  title: 'Limits',
  status: 'warn',
  summary: '2 accounts near a limit',
  stats: [{ label: 'Accounts', value: '2', status: 'ok' }],
  rows: [
    row('Anthropic / personal', '5-hour', 0.42),
    row('Anthropic / personal', 'weekly', 0.81, 'warn'),
    row('Anthropic / personal', 'monthly', 0.2),
    { ...row('Anthropic / work', '5-hour', 0.95, 'crit'), link: '/c/main/x' },
    row('Anthropic / work', 'weekly', 0.5),
    row('Other / solo', '', 0.1),
  ],
});

const bars: PanelDisplay = { ...DEFAULT_DISPLAY, rowLayout: 'grouped-bars' };
const view = (display = bars, mode: 'light' | 'dark' = 'light', panel = LIMITS) =>
  render(wrap(<PanelView panel={panel} kiosk={false} editing={false} display={display} />, mode))
    .container;

describe('groupRows', () => {
  it('groups by label in order of first sight and names segments by detail', () => {
    const { groups, limits } = groupRows(LIMITS.rows);
    expect(groups.map(g => g.label)).toEqual([
      'Anthropic / personal',
      'Anthropic / work',
      'Other / solo',
    ]);
    expect(groups.map(g => g.segments.map(s => s.name))).toEqual([
      ['5-hour', 'weekly', 'monthly'],
      ['5-hour', 'weekly'],
      [UNNAMED_LIMIT],
    ]);
    expect(limits).toEqual(['5-hour', 'weekly', 'monthly', UNNAMED_LIMIT]);
    expect(groups[1].link).toBe('/c/main/x');
  });

  it('keeps every group and every limit: no top-N and no Other bucket', () => {
    const rows = Array.from({ length: 40 }, (_v, i) => ({
      label: `acct-${i % 20}`,
      detail: `limit-${i % 12}`,
      value: '1%',
      status: 'ok' as const,
    }));
    const { groups, limits } = groupRows(rows);
    expect(groups).toHaveLength(20);
    expect(limits).toHaveLength(12);
    expect(groups.reduce((n, g) => n + g.segments.length, 0)).toBe(40);
    expect(limits.some(l => /other/i.test(l))).toBe(false);
  });
});

describe('display options', () => {
  it('defaults to the summary, the tiles and the list', () => {
    expect(displayOf({})).toEqual({ showSummary: true, showStats: true, rowLayout: 'list' });
    expect(displayOf({ showSummary: false, showStats: false, rowLayout: 'grouped-bars' })).toEqual({
      showSummary: false,
      showStats: false,
      rowLayout: 'grouped-bars',
    });
    expect(displayOf({ rowLayout: 'weird' }).rowLayout).toBe('list');
  });

  it('draws the list by default and the summary and tiles can be turned off', () => {
    const c = view(DEFAULT_DISPLAY);
    expect(c.querySelector('[data-rows]')).not.toBeNull();
    expect(c.querySelector('[data-bars]')).toBeNull();
    expect(c.querySelector('[data-panel-summary]')).not.toBeNull();
    expect(c.querySelectorAll('[data-stat]')).toHaveLength(1);
    cleanup();
    const off = view({ ...DEFAULT_DISPLAY, showSummary: false, showStats: false });
    expect(off.querySelector('[data-panel-summary]')).toBeNull();
    expect(off.querySelector('[data-stat]')).toBeNull();
    expect(off.querySelector('[data-rows]')).not.toBeNull();
  });
});

describe('grouped bars', () => {
  it('draws one bar per group and one segment per row, replacing the table', () => {
    const c = view();
    expect(c.querySelector('[data-rows]')).toBeNull();
    const groups = c.querySelectorAll('[data-bar-group]');
    expect(Array.from(groups).map(g => g.getAttribute('data-bar-group'))).toEqual([
      'Anthropic / personal',
      'Anthropic / work',
      'Other / solo',
    ]);
    expect(Array.from(groups).map(g => g.querySelectorAll('[data-segment]').length)).toEqual([
      3, 2, 1,
    ]);
    // Every row is a segment.
    expect(c.querySelectorAll('[data-segment]')).toHaveLength(LIMITS.rows.length);
  });

  it('fills each segment to the fraction of its row and names the value in the tooltip text', () => {
    const c = view();
    const personal = c.querySelector('[data-bar-group="Anthropic / personal"]') as HTMLElement;
    const fills = Array.from(personal.querySelectorAll('[data-fill]'));
    expect(fills.map(f => Number(f.getAttribute('data-fill')))).toEqual([0.42, 0.81, 0.2]);
    expect(fills.map(f => getComputedStyle(f).width)).toEqual(['42%', '81%', '20%']);
    const weekly = personal.querySelector('[data-segment="weekly"]') as HTMLElement;
    expect(weekly.getAttribute('aria-label')).toBe(
      'Anthropic / personal, weekly: 81%, 81 percent. Warning'
    );
  });

  it('gives each limit name its own colour, the same in every group, matched by the legend', () => {
    const c = view();
    const legend = Array.from(c.querySelectorAll('[data-legend-item]')).map(i => ({
      name: i.getAttribute('data-legend-item'),
      swatch: i.querySelector('[data-swatch]')?.getAttribute('data-swatch'),
    }));
    expect(legend.map(l => l.name)).toEqual(['5-hour', 'weekly', 'monthly', UNNAMED_LIMIT]);
    expect(legend.map(l => l.swatch)).toEqual(CATEGORICAL.light.slice(0, 4));
    expect(new Set(legend.map(l => l.swatch)).size).toBe(4);
    // The same name has the same swatch in each group.
    const colourOf = (group: string, name: string) => {
      const seg = c.querySelector(`[data-bar-group="${group}"] [data-segment="${name}"]`);
      return getComputedStyle(seg?.querySelector('[data-fill]') as Element).backgroundColor;
    };
    expect(colourOf('Anthropic / personal', '5-hour')).toBe(colourOf('Anthropic / work', '5-hour'));
    expect(colourOf('Anthropic / personal', '5-hour')).not.toBe(
      colourOf('Anthropic / personal', 'weekly')
    );
  });

  it('keeps a status marker with its own shape on every segment', () => {
    const c = view();
    const marks = Array.from(c.querySelectorAll('[data-bar] svg[data-status]')).map(s =>
      s.getAttribute('data-status')
    );
    expect(marks).toHaveLength(LIMITS.rows.length);
    expect(marks).toContain('warn');
    expect(marks).toContain('crit');
    // The limit colours are never a status colour.
    const status = createTheme().palette;
    const reserved = [status.success.main, status.warning.main, status.error.main];
    for (const sw of Array.from(c.querySelectorAll('[data-swatch]'))) {
      expect(reserved).not.toContain(sw.getAttribute('data-swatch'));
    }
  });

  it('uses the dark palette in a dark theme', () => {
    const c = view(bars, 'dark');
    const swatches = Array.from(c.querySelectorAll('[data-swatch]')).map(s =>
      s.getAttribute('data-swatch')
    );
    expect(swatches).toEqual(CATEGORICAL.dark.slice(0, 4));
  });

  it('shows every group and limit past eight limits, reusing hues at lower opacity', () => {
    const rows = Array.from({ length: 10 }, (_v, i) => row('Account', `limit-${i}`, 0.3));
    const c = view(bars, 'light', parsePanel({ version: 1, id: 'x', rows }));
    expect(c.querySelectorAll('[data-segment]')).toHaveLength(10);
    expect(c.querySelectorAll('[data-legend-item]')).toHaveLength(10);
    expect(limitColour(8, 'light')).toEqual({
      colour: CATEGORICAL.light[0],
      opacity: REUSED_OPACITY,
    });
    expect(limitColour(7, 'light').opacity).toBe(1);
    expect(c.textContent).not.toMatch(/other/i);
  });

  it('draws a segment with no fraction as an empty track and keeps the value in its text', () => {
    const c = view(
      bars,
      'light',
      parsePanel({ version: 1, id: 'x', rows: [row('Account', 'daily', undefined)] })
    );
    expect(c.querySelectorAll('[data-segment]')).toHaveLength(1);
    expect(c.querySelector('[data-fill]')).toBeNull();
    expect(c.querySelector('[data-segment]')?.getAttribute('aria-label')).toContain('n/a');
  });

  it('turns the group link off while editing', () => {
    const c = render(
      wrap(<PanelView panel={LIMITS} kiosk={false} editing display={bars} />)
    ).container;
    expect(c.querySelector('a')).toBeNull();
  });
});

const LIMIT_ROWS = parsePanel({
  version: 1,
  id: 'limits',
  title: 'Limits',
  rows: [
    // Weekly (Fable) is seen before Weekly in the second group, and 5-hour comes last.
    row('Anthropic / personal', 'Weekly', 0.9),
    row('Anthropic / personal', 'Weekly (Fable)', 0.8),
    row('Anthropic / myriad', 'Weekly (Fable)', 0.7),
    row('Anthropic / myriad', 'Weekly', 0.6),
    row('OpenAI / team-a', 'Monthly', 1),
    row('Anthropic / phoenix-court-group', 'Weekly', 0.3),
    row('Anthropic / phoenix-court-group', '5-hour', 0.1),
    row('Z.ai / team-a', 'Burst', 0.2),
    row('Z.ai / team-a', 'Daily', 0.4),
    row('Kimi / team-a', 'Tokens', 0.5),
  ],
});

describe('limit order', () => {
  it('ranks known names by window length', () => {
    expect(['5-hour', 'Daily', 'Weekly', 'Weekly (Fable)', 'Monthly'].map(limitRank)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(limitRank('5 hour')).toBe(0);
    expect(limitRank('weekly (Opus)')).toBe(3);
    expect(limitRank('Burst')).toBeNull();
    expect(limitRank(UNNAMED_LIMIT)).toBeNull();
  });

  it('puts known names first by window length, then the others in first-seen order', () => {
    expect(
      orderLimits(['Tokens', 'Monthly', 'Weekly (Fable)', 'Burst', 'Weekly', 'Daily', '5-hour'])
    ).toEqual(['5-hour', 'Daily', 'Weekly', 'Weekly (Fable)', 'Monthly', 'Tokens', 'Burst']);
  });

  it('uses one list for the legend and one slot per limit in every group', () => {
    const { groups, limits, slots } = groupRows(LIMIT_ROWS.rows);
    expect(limits).toEqual([
      '5-hour',
      'Daily',
      'Weekly',
      'Weekly (Fable)',
      'Monthly',
      'Burst',
      'Tokens',
    ]);
    expect(slots.map(s => s.name)).toEqual(limits);
    for (const g of groups) {
      expect(g.cells).toHaveLength(slots.length);
      g.cells.forEach((cell, i) => {
        if (cell) expect(cell.name).toBe(slots[i].name);
      });
    }
    // The group that saw Weekly (Fable) first still has Weekly in the Weekly slot.
    const myriad = groups.find(g => g.label === 'Anthropic / myriad')!;
    expect(myriad.cells.map(c => c?.name ?? null)).toEqual([
      null,
      null,
      'Weekly',
      'Weekly (Fable)',
      null,
      null,
      null,
    ]);
  });

  it('gives a name that repeats inside one group its own extra slot, so no row is lost', () => {
    const rows = [
      row('A', 'Weekly', 0.1),
      row('A', 'Weekly', 0.2),
      row('B', 'Weekly', 0.3),
      row('B', '5-hour', 0.4),
    ];
    const { groups, slots } = groupRows(rows.map(r => ({ ...r, status: 'ok' as const })));
    expect(slots.map(s => `${s.name}#${s.repeat}`)).toEqual(['5-hour#0', 'Weekly#0', 'Weekly#1']);
    expect(groups[0].cells.filter(Boolean)).toHaveLength(2);
    expect(groups[1].cells.map(c => c?.row.value ?? null)).toEqual(['40%', '30%', null]);
  });

  it('draws the same column for a limit in every bar, with a faint empty slot where a group has none', () => {
    const c = view(bars, 'light', LIMIT_ROWS);
    const legend = Array.from(c.querySelectorAll('[data-legend-item]')).map(i =>
      i.getAttribute('data-legend-item')
    );
    const bar = (g: string) => c.querySelector(`[data-bar-group="${g}"] [data-bar]`) as HTMLElement;
    for (const label of Array.from(c.querySelectorAll('[data-bar-group]')).map(g =>
      g.getAttribute('data-bar-group')
    )) {
      const cols = Array.from(bar(label!).children);
      expect(cols).toHaveLength(legend.length);
      cols.forEach((col, i) => {
        const name = col.getAttribute('data-segment') ?? col.getAttribute('data-segment-empty');
        expect(name).toBe(legend[i]);
      });
    }
    // Weekly is the third column in every bar that has it, and an empty slot has no fill.
    const weeklyAt = (g: string) =>
      Array.from(bar(g).children).findIndex(col => col.getAttribute('data-segment') === 'Weekly');
    expect(weeklyAt('Anthropic / personal')).toBe(2);
    expect(weeklyAt('Anthropic / myriad')).toBe(2);
    expect(weeklyAt('Anthropic / phoenix-court-group')).toBe(2);
    const kimi = bar('Kimi / team-a');
    expect(kimi.querySelectorAll('[data-segment-empty]')).toHaveLength(legend.length - 1);
    expect(kimi.querySelectorAll('[data-fill]')).toHaveLength(1);
  });
});

describe('group labels', () => {
  it('sizes the label column to the longest label, up to 35 % of the widget, and clips only beyond', () => {
    const c = view(bars, 'light', LIMIT_ROWS);
    const grid = c.querySelector('[data-bar-grid]') as HTMLElement;
    expect(getComputedStyle(grid).gridTemplateColumns).toBe('fit-content(35%) minmax(0, 1fr)');
    const label = c.querySelector('[data-bar-label]') as HTMLElement;
    const style = getComputedStyle(label);
    expect(style.whiteSpace).toBe('nowrap');
    expect(style.overflow).toBe('hidden');
    expect(style.textOverflow).toBe('ellipsis');
    // No fixed width cuts a short label.
    expect(style.width).not.toMatch(/^\d+px$/);
  });

  it('keeps the full label in the text and in a tooltip', () => {
    const c = view(bars, 'light', LIMIT_ROWS);
    for (const l of Array.from(c.querySelectorAll('[data-bar-label]'))) {
      const group = l.parentElement!.getAttribute('data-bar-group');
      expect(l.textContent).toBe(group);
      expect(l.getAttribute('aria-label')).toBe(group);
    }
    expect(c.textContent).toContain('Anthropic / phoenix-court-group');
  });
});
