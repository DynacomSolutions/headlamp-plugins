import { describe, expect, it } from 'vitest';
import {
  FILL_TOLERANCE_PX,
  fitRowHeight,
  MAX_FILL_ROW_HEIGHT,
  MIN_FILL_ROW_HEIGHT,
  scalableRows,
} from './fillHeight';
import { ROW_HEIGHT } from './layout';
import { emptySection, Section } from './spec/model';

const section = (mode: Section['mode'], ys: Array<[number, number]>): Section => ({
  ...emptySection('S'),
  mode,
  widgets: ys.map(([y, h], i) => ({
    id: `w${i}`,
    type: 't',
    title: '',
    config: {},
    x: 0,
    y,
    w: 4,
    h,
  })),
});

describe('fitRowHeight', () => {
  it('stretches the rows by the gap shared over the rows, aiming a little short', () => {
    // 20 rows at 30 px use 600 px; 1000 px are free: each row grows by about 20 px.
    expect(fitRowHeight({ current: 30, rows: 20, available: 1000, used: 600 })).toBe(49.9);
  });

  it('shrinks the rows when the content is taller than the space', () => {
    expect(fitRowHeight({ current: 60, rows: 20, available: 1000, used: 1400 })).toBe(39.9);
  });

  it('never goes below the minimum row height, so a small screen scrolls', () => {
    expect(fitRowHeight({ current: 30, rows: 20, available: 400, used: 600 })).toBe(
      MIN_FILL_ROW_HEIGHT
    );
    expect(MIN_FILL_ROW_HEIGHT).toBe(ROW_HEIGHT);
  });

  it('never goes above the maximum', () => {
    expect(fitRowHeight({ current: 30, rows: 2, available: 5000, used: 100 })).toBe(
      MAX_FILL_ROW_HEIGHT
    );
  });

  it('keeps the row height when the content is at most the tolerance shorter than the space', () => {
    for (const gap of [0, 1, FILL_TOLERANCE_PX]) {
      expect(fitRowHeight({ current: 41.3, rows: 20, available: 600 + gap, used: 600 })).toBe(41.3);
    }
  });

  it('shrinks the rows when the content is even 1 px taller than the space', () => {
    expect(fitRowHeight({ current: 41.3, rows: 20, available: 599, used: 600 })).toBeLessThan(41.3);
  });

  it('is stable: the fitted height measured again gives the same height', () => {
    // Content height is rows * row height plus a fixed 150 px of margins.
    const used = (rh: number) => 20 * rh + 150;
    const first = fitRowHeight({ current: 30, rows: 20, available: 900, used: used(30) });
    expect(first).toBe(37.4);
    // The content is now 898 px: inside the window under 900.
    expect(fitRowHeight({ current: first, rows: 20, available: 900, used: used(first) })).toBe(
      first
    );
  });

  it('keeps the current height, within the limits, when it cannot measure', () => {
    expect(fitRowHeight({ current: 45, rows: 0, available: 900, used: 600 })).toBe(45);
    expect(fitRowHeight({ current: 45, rows: 5, available: 0, used: 600 })).toBe(45);
    expect(fitRowHeight({ current: 45, rows: 5, available: NaN, used: 600 })).toBe(45);
    expect(fitRowHeight({ current: 5, rows: 0, available: 900, used: 600 })).toBe(
      MIN_FILL_ROW_HEIGHT
    );
  });
});

describe('scalableRows', () => {
  it('adds the rows of every section of the tab', () => {
    const a = section('flow', [
      [0, 4],
      [4, 6],
    ]);
    const b = section('sticky-top', [[0, 3]]);
    expect(scalableRows([a, b])).toBe(13);
  });

  it('counts a self-scroll section, which gives up its fixed height while the tab fits', () => {
    expect(scalableRows([section('flow', [[0, 5]]), section('self-scroll', [[0, 9]])])).toBe(14);
  });

  it('is zero for an empty tab', () => {
    expect(scalableRows([section('flow', [])])).toBe(0);
  });
});
