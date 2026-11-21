import { describe, expect, it } from 'vitest';
import {
  breakpointFor,
  isEditableBreakpoint,
  layoutForColumns,
  layoutPositions,
  otherSectionAt,
  pointerOf,
  rowsUsed,
  sameLayout,
  toLayout,
} from './layout';
import type { WidgetInstance } from './spec/model';

const w = (
  id: string,
  x: number,
  y: number,
  ww: number,
  h: number,
  type = 't'
): WidgetInstance => ({ id, type, title: '', config: {}, x, y, w: ww, h });

describe('layout helpers', () => {
  it('turns widgets into grid items with limits', () => {
    const l = toLayout([w('a', 0, 0, 3, 2, 'big'), w('b', 3, 0, 2, 2)], t =>
      t === 'big' ? { minSize: { w: 2, h: 3 }, maxSize: { w: 8, h: 9 } } : undefined
    );
    expect(l[0]).toMatchObject({ i: 'a', minW: 2, minH: 3, maxW: 8, maxH: 9 });
    expect(l[1]).toMatchObject({ i: 'b', minW: 1, minH: 1 });
    expect(l[1].maxW).toBeUndefined();
  });

  it('compares a grid layout with the saved positions', () => {
    const ws = [w('a', 0, 0, 3, 2)];
    expect(sameLayout([{ i: 'a', x: 0, y: 0, w: 3, h: 2 }], ws)).toBe(true);
    expect(sameLayout([{ i: 'a', x: 1, y: 0, w: 3, h: 2 }], ws)).toBe(false);
    expect(sameLayout([], ws)).toBe(false);
    expect(layoutPositions([{ i: 'a', x: 1, y: 2, w: 3, h: 4, minW: 2 }])).toEqual([
      { i: 'a', x: 1, y: 2, w: 3, h: 4 },
    ]);
  });

  it('allows editing only with the full 12 columns', () => {
    expect(breakpointFor(1400)).toBe('lg');
    expect(breakpointFor(950)).toBe('md');
    expect(breakpointFor(700)).toBe('sm');
    expect(breakpointFor(100)).toBe('xxs');
    expect(['lg', 'md'].every(b => isEditableBreakpoint(b as any))).toBe(true);
    expect(['sm', 'xs', 'xxs'].some(b => isEditableBreakpoint(b as any))).toBe(false);
  });

  it('measures the rows used', () => {
    expect(rowsUsed([])).toBe(0);
    expect(rowsUsed([w('a', 0, 0, 1, 2), w('b', 0, 2, 1, 3)])).toBe(5);
  });

  it('reads a pointer from a mouse or touch event', () => {
    expect(pointerOf({ clientX: 3, clientY: 4 })).toEqual({ x: 3, y: 4 });
    expect(pointerOf({ changedTouches: [{ clientX: 5, clientY: 6 }] })).toEqual({ x: 5, y: 6 });
    expect(pointerOf(null)).toBeNull();
    expect(pointerOf({})).toBeNull();
  });

  it('finds the other section under the pointer', () => {
    document.body.innerHTML =
      '<section data-section-id="s1"><div id="in1"></div></section><section data-section-id="s2"><div id="in2"></div></section>';
    const stack = (id: string) => [document.getElementById(id)!, document.body];
    const doc = { elementsFromPoint: () => stack('in2') } as unknown as Document;
    expect(otherSectionAt({ x: 0, y: 0 }, 's1', doc)).toBe('s2');
    expect(otherSectionAt({ x: 0, y: 0 }, 's2', doc)).toBeNull();
    expect(otherSectionAt({ x: 0, y: 0 }, 's1', {} as Document)).toBeNull();
  });
});

describe('layout for fewer columns', () => {
  // The AIS Console tab of the live dashboard: 3 widgets on the first row and 3 on the second.
  const ais = toLayout(
    [
      w('limits', 0, 0, 6, 14),
      w('agents', 6, 0, 3, 14),
      w('gateway', 9, 0, 3, 14),
      w('identities', 0, 14, 4, 9),
      w('swap', 4, 14, 4, 9),
      w('spend', 8, 14, 4, 9),
    ],
    () => undefined
  );

  const gaps = (layout: ReadonlyArray<{ x: number; y: number; w: number }>) => {
    // A row has a gap at the left when no widget starts at column 0 on it.
    const rows = new Map<number, number[]>();
    for (const l of layout) rows.set(l.y, [...(rows.get(l.y) ?? []), l.x]);
    return [...rows.values()].filter(xs => !xs.includes(0)).length;
  };

  it('keeps the 12 column layout as it is', () => {
    expect(layoutForColumns(ais, 12)).toEqual(ais);
  });

  it('flows the widgets in reading order on 6 columns, with no blank column at the left', () => {
    const l = layoutForColumns(ais, 6);
    expect(l.map(i => i.i)).toEqual(ais.map(i => i.i));
    for (const i of l) {
      expect(i.x).toBeGreaterThanOrEqual(0);
      expect(i.x + i.w).toBeLessThanOrEqual(6);
      expect(i.w).toBeGreaterThanOrEqual(3);
    }
    expect(gaps(l)).toBe(0);
    // Two widgets across, three rows.
    expect(l.map(i => [i.x, i.y])).toEqual([
      [0, 0],
      [3, 0],
      [0, 14],
      [3, 14],
      [0, 28],
      [3, 28],
    ]);
    // Nothing overlaps.
    for (const a of l)
      for (const b of l)
        if (a !== b)
          expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(
            false
          );
  });

  it('gives every widget the full width on 2 columns, in one stack', () => {
    const l = layoutForColumns(ais, 2);
    expect(l.every(i => i.x === 0 && i.w === 2)).toBe(true);
    expect(l.map(i => i.y)).toEqual([0, 14, 28, 42, 51, 60]);
  });

  it('respects a minimum width and does not change the saved layout', () => {
    const saved = toLayout([w('a', 0, 0, 2, 4, 'wide'), w('b', 2, 0, 2, 4)], t =>
      t === 'wide' ? { minSize: { w: 5, h: 1 } } : undefined
    );
    const copy = JSON.stringify(saved);
    const l = layoutForColumns(saved, 6);
    expect(l[0].w).toBe(5);
    expect(l[1]).toMatchObject({ x: 0, y: 4 });
    expect(JSON.stringify(saved)).toBe(copy);
  });
});
