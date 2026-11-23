import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePanel } from './model';
import { DEFAULT_DISPLAY, displayOf, NARROW_STRIP, PanelView } from './PanelView';
import { COMPACT_ROW_HEIGHT, ROW_HEIGHT } from './RowList';
import { COMPACT_SCALE, TILES_HEIGHT, TILES_HEIGHT_COMPACT } from './StatTiles';

afterEach(cleanup);

const PANEL = parsePanel({
  version: 1,
  id: 'backups',
  title: 'Backups',
  status: 'warn',
  summary: '1 of 2 backups ok',
  stats: [{ label: 'Ok', value: '1', status: 'ok' }],
  rows: [
    { label: 'app', detail: 'postgres, ok', value: '3h', status: 'ok' },
    { label: 'walt', detail: 'postgres, failing', value: '31h', status: 'crit' },
  ],
  series: [{ label: 'lag', points: [0, 1, 0] }],
});

const view = (display: Parameters<typeof PanelView>[0]['display']) =>
  render(
    <MemoryRouter>
      <ThemeProvider theme={createTheme()}>
        <PanelView panel={PANEL} kiosk={false} editing={false} display={display} />
      </ThemeProvider>
    </MemoryRouter>
  ).container;

describe('compact and rows-off display options', () => {
  it('reads the options and keeps the old defaults', () => {
    expect(displayOf({})).toEqual({ showSummary: true, showStats: true, rowLayout: 'list' });
    expect(displayOf({ compact: true })).toMatchObject({ compact: true });
    expect(displayOf({ compact: 'yes' })).not.toHaveProperty('compact');
    expect(displayOf({ showRows: false })).toMatchObject({ showRows: false });
    expect(displayOf({ showRows: 0 })).not.toHaveProperty('showRows');
  });

  it('draws the list with its old row height by default', () => {
    const c = view(DEFAULT_DISPLAY);
    expect(c.querySelector('[data-rows]')?.hasAttribute('data-compact')).toBe(false);
    expect((c.querySelector('[data-row]') as HTMLElement).style.height || '').toBe('');
    expect(ROW_HEIGHT).toBeGreaterThan(COMPACT_ROW_HEIGHT);
  });

  it('draws one line for each row when compact, and keeps every row and its detail', () => {
    const c = view({ ...DEFAULT_DISPLAY, compact: true });
    expect(c.querySelector('[data-rows]')?.hasAttribute('data-compact')).toBe(true);
    const rows = [...c.querySelectorAll('[data-row]')];
    // The worst row is still first.
    expect(rows.map(r => r.getAttribute('data-row-status'))).toEqual(['crit', 'ok']);
    expect(rows.map(r => r.textContent)).toEqual([
      expect.stringContaining('postgres, failing'),
      expect.stringContaining('postgres, ok'),
    ]);
    expect(c.textContent).not.toMatch(/\+\s*\d+\s*more|\d+ more|Other/);
  });

  it('keeps the plot, the tiles and the summary when the rows are off', () => {
    const c = view({ ...DEFAULT_DISPLAY, showRows: false });
    expect(c.querySelector('[data-rows]')).toBeNull();
    expect(c.querySelector('[data-row]')).toBeNull();
    expect(c.querySelector('[data-stats]')).not.toBeNull();
    expect(c.querySelector('[data-panel-summary]')?.textContent).toBe('1 of 2 backups ok');
  });
});

describe('compact tiles', () => {
  const tiles = (display: Parameters<typeof PanelView>[0]['display']) =>
    view(display).querySelector('[data-stats]') as HTMLElement;

  it('draws smaller numerals and a shorter tile row when compact', () => {
    const size = (el: HTMLElement) =>
      Number(
        getComputedStyle(el.querySelector('[data-stat] > div') as HTMLElement).fontSize.replace(
          'px',
          ''
        )
      );
    const normal = size(tiles(DEFAULT_DISPLAY));
    const compact = size(tiles({ ...DEFAULT_DISPLAY, compact: true }));
    expect(compact).toBe(Math.round(normal * COMPACT_SCALE));
    expect(compact).toBeLessThan(normal);
    expect(TILES_HEIGHT_COMPACT).toBeLessThan(TILES_HEIGHT);
  });

  it('keeps one row of tiles when the widget width is not measured', () => {
    // jsdom measures no width, so the strip does not use two columns.
    expect(tiles({ ...DEFAULT_DISPLAY, compact: true }).hasAttribute('data-stat-columns')).toBe(
      false
    );
    expect(NARROW_STRIP).toBe(330);
  });
});
