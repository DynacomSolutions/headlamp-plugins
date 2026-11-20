import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { CATEGORICAL } from '../promql/palette';
import { limitColour, REUSED_OPACITY } from './limitColours';
import { parsePanel } from './model';
import { drawOrder } from './PanelBars';
import { DEFAULT_DISPLAY, displayOf, PanelDisplay, PanelView } from './PanelView';
import { groupRows, limitRank, orderLimits, UNNAMED_LIMIT, worstStatus } from './rowGroups';

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
  it('draws exactly one track per group and every limit of the group on it', () => {
    const c = view();
    expect(c.querySelector('[data-rows]')).toBeNull();
    const groups = c.querySelectorAll('[data-bar-group]');
    expect(Array.from(groups).map(g => g.getAttribute('data-bar-group'))).toEqual([
      'Anthropic / personal',
      'Anthropic / work',
      'Other / solo',
    ]);
    expect(Array.from(groups).map(g => g.querySelectorAll('[data-bar]').length)).toEqual([1, 1, 1]);
    expect(Array.from(groups).map(g => g.querySelectorAll('[data-segment]').length)).toEqual([
      3, 2, 1,
    ]);
    // Every row is a fill on a track, and every fill has an end tick.
    expect(c.querySelectorAll('[data-segment]')).toHaveLength(LIMITS.rows.length);
    expect(c.querySelectorAll('[data-tick]')).toHaveLength(LIMITS.rows.length);
  });

  it('has no fixed slots: a group with one limit has a single fill, not a row of empty slots', () => {
    const c = view(bars, 'light', LIMIT_ROWS);
    const kimi = c.querySelector('[data-bar-group="Kimi / team-a"]') as HTMLElement;
    expect(kimi.querySelectorAll('[data-segment]')).toHaveLength(1);
    expect(c.querySelector('[data-segment-empty]')).toBeNull();
  });

  it('draws the largest fraction at the back and the smaller ones in front', () => {
    const c = view();
    const personal = c.querySelector('[data-bar-group="Anthropic / personal"]') as HTMLElement;
    const fills = Array.from(personal.querySelectorAll('[data-fill]'));
    // DOM order is the stacking order: weekly 0.81, 5-hour 0.42, monthly 0.2.
    expect(fills.map(f => f.getAttribute('data-segment'))).toEqual(['weekly', '5-hour', 'monthly']);
    expect(fills.map(f => Number(f.getAttribute('data-fill')))).toEqual([0.81, 0.42, 0.2]);
    expect(fills.map(f => getComputedStyle(f).width)).toEqual(['81%', '42%', '20%']);
    expect(drawOrder(groupRows(LIMITS.rows).groups[0].segments).map(s => s.name)).toEqual([
      'weekly',
      '5-hour',
      'monthly',
    ]);
  });

  it('keeps equal fractions drawn in row order and gives each a tick of its own', () => {
    const rows = [row('A', '5-hour', 0.5), row('A', 'weekly', 0.5), row('A', 'monthly', 0.9)];
    const c = view(bars, 'light', parsePanel({ version: 1, id: 'x', rows }));
    const fills = Array.from(c.querySelectorAll('[data-fill]')).map(f =>
      f.getAttribute('data-segment')
    );
    expect(fills).toEqual(['monthly', '5-hour', 'weekly']);
    const ticks = Array.from(c.querySelectorAll('[data-tick]')) as HTMLElement[];
    expect(ticks.map(t => t.getAttribute('data-tick'))).toEqual(['monthly', '5-hour', 'weekly']);
    // The two ticks at 50 % share the height, so neither hides the other.
    const [, t5, tw] = ticks.map(t => getComputedStyle(t));
    expect(t5.top).not.toBe(tw.top);
    expect(t5.height).toBe(tw.height);
    expect(t5.left).toBe(tw.left);
  });

  it('puts a tick in the limit colour at the end of each fraction', () => {
    const c = view();
    const tick = c.querySelector(
      '[data-bar-group="Anthropic / personal"] [data-tick="weekly"]'
    ) as HTMLElement;
    const fill = c.querySelector(
      '[data-bar-group="Anthropic / personal"] [data-segment="weekly"]'
    ) as HTMLElement;
    expect(getComputedStyle(tick).backgroundColor).toBe(getComputedStyle(fill).backgroundColor);
    expect(getComputedStyle(tick).left).toBe('calc(81% - 2px)');
  });

  it('lists every limit with its value and status in the tooltip and the accessible name', () => {
    const c = view();
    const bar = c.querySelector(
      '[data-bar-group="Anthropic / personal"] [data-bar]'
    ) as HTMLElement;
    const text = bar.getAttribute('aria-label') ?? '';
    expect(text).toContain('Anthropic / personal, 5-hour: 42%, 42 percent. OK');
    expect(text).toContain('Anthropic / personal, weekly: 81%, 81 percent. Warning');
    expect(text).toContain('Anthropic / personal, monthly: 20%, 20 percent. OK');
  });

  it('shows the tooltip list with a line for every limit on hover', async () => {
    const c = view();
    const bar = c.querySelector('[data-bar-group="Anthropic / work"] [data-bar]') as HTMLElement;
    fireEvent.mouseOver(bar);
    const tip = await screen.findByRole('tooltip');
    const lines = Array.from(tip.querySelectorAll('[data-tooltip-limit]')).map(l => l.textContent);
    expect(lines).toEqual(['5-hour: 95%, 95 percent. Critical', 'weekly: 50%, 50 percent. OK']);
  });

  it('shows one status mark per group: the worst status of its limits', () => {
    const c = view({ ...bars, showSummary: false, showStats: false });
    const marks = (g: string) =>
      Array.from(c.querySelectorAll(`[data-bar-group="${g}"] svg[data-status]`)).map(s =>
        s.getAttribute('data-status')
      );
    expect(marks('Anthropic / personal')).toEqual(['warn']);
    expect(marks('Anthropic / work')).toEqual(['crit']);
    expect(marks('Other / solo')).toEqual(['ok']);
    expect(c.querySelectorAll('[data-bar] svg[data-status]')).toHaveLength(0);
    // No summary and no stat tiles: the three row marks are the only marks.
    expect(c.querySelectorAll('svg[data-status]')).toHaveLength(3);
    expect(c.querySelector('[data-panel-summary]')).toBeNull();
    expect(c.querySelector('[data-stat]')).toBeNull();
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
      return getComputedStyle(seg as Element).backgroundColor;
    };
    expect(colourOf('Anthropic / personal', '5-hour')).toBe(colourOf('Anthropic / work', '5-hour'));
    expect(colourOf('Anthropic / personal', '5-hour')).not.toBe(
      colourOf('Anthropic / personal', 'weekly')
    );
  });

  it('never uses a status colour as a limit colour', () => {
    const c = view();
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
    expect(c.querySelectorAll('[data-bar]')).toHaveLength(1);
    expect(c.querySelectorAll('[data-segment]')).toHaveLength(10);
    expect(c.querySelectorAll('[data-legend-item]')).toHaveLength(10);
    expect(limitColour(8, 'light')).toEqual({
      colour: CATEGORICAL.light[0],
      opacity: REUSED_OPACITY,
    });
    expect(limitColour(7, 'light').opacity).toBe(1);
    expect(c.textContent).not.toMatch(/other/i);
  });

  it('draws a group with no fraction as an empty track and keeps the value in its text', () => {
    const c = view(
      bars,
      'light',
      parsePanel({ version: 1, id: 'x', rows: [row('Account', 'daily', undefined)] })
    );
    expect(c.querySelectorAll('[data-bar]')).toHaveLength(1);
    expect(c.querySelector('[data-fill]')).toBeNull();
    expect(c.querySelector('[data-tick]')).toBeNull();
    expect(c.querySelector('[data-bar]')?.getAttribute('aria-label')).toContain('n/a');
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

  it('uses one list for the legend and the colours of every group', () => {
    const { limits } = groupRows(LIMIT_ROWS.rows);
    expect(limits).toEqual([
      '5-hour',
      'Daily',
      'Weekly',
      'Weekly (Fable)',
      'Monthly',
      'Burst',
      'Tokens',
    ]);
    const c = view(bars, 'light', LIMIT_ROWS);
    const legend = Array.from(c.querySelectorAll('[data-legend-item]')).map(i =>
      i.getAttribute('data-legend-item')
    );
    expect(legend).toEqual(limits);
    // The same name has the same colour in every group, whatever order the group saw it in.
    const colourOf = (g: string, n: string) =>
      getComputedStyle(c.querySelector(`[data-bar-group="${g}"] [data-segment="${n}"]`) as Element)
        .backgroundColor;
    expect(colourOf('Anthropic / personal', 'Weekly (Fable)')).toBe(
      colourOf('Anthropic / myriad', 'Weekly (Fable)')
    );
    expect(colourOf('Anthropic / personal', 'Weekly')).toBe(
      colourOf('Anthropic / myriad', 'Weekly')
    );
  });

  it('keeps every row of a name that repeats inside one group on the same track', () => {
    const rows = [row('A', 'Weekly', 0.1), row('A', 'Weekly', 0.2), row('B', 'Weekly', 0.3)];
    const c = view(bars, 'light', parsePanel({ version: 1, id: 'x', rows }));
    const a = c.querySelector('[data-bar-group="A"]') as HTMLElement;
    expect(a.querySelectorAll('[data-bar]')).toHaveLength(1);
    expect(a.querySelectorAll('[data-fill]')).toHaveLength(2);
  });
});

describe('worst status', () => {
  it('ranks critical over warning over unknown over OK', () => {
    const seg = (status: string) => ({
      name: 'x',
      row: { label: 'a', detail: '', value: '', status } as never,
    });
    expect(worstStatus([seg('ok'), seg('warn'), seg('crit')])).toBe('crit');
    expect(worstStatus([seg('ok'), seg('warn')])).toBe('warn');
    expect(worstStatus([seg('ok'), seg('unknown')])).toBe('unknown');
    expect(worstStatus([seg('ok')])).toBe('ok');
    expect(worstStatus([])).toBe('unknown');
  });
});

describe('group labels', () => {
  it('sizes the label column to the longest label, up to 35 % of the widget, and clips only beyond', () => {
    const c = view(bars, 'light', LIMIT_ROWS);
    const grid = c.querySelector('[data-bar-grid]') as HTMLElement;
    expect(getComputedStyle(grid).gridTemplateColumns).toBe('fit-content(35%) minmax(0, 1fr) auto');
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
