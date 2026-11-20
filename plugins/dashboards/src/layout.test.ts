import { describe, expect, it } from 'vitest';
import { breakpointFor, isEditableBreakpoint, layoutPositions, otherSectionAt, pointerOf, rowsUsed, sameLayout, toLayout } from './layout';
import type { WidgetInstance } from './spec/model';

const w = (id: string, x: number, y: number, ww: number, h: number, type = 't'): WidgetInstance => ({ id, type, title: '', config: {}, x, y, w: ww, h });

describe('layout helpers', () => {
  it('turns widgets into grid items with limits', () => {
    const l = toLayout([w('a', 0, 0, 3, 2, 'big'), w('b', 3, 0, 2, 2)], t => (t === 'big' ? { minSize: { w: 2, h: 3 }, maxSize: { w: 8, h: 9 } } : undefined));
    expect(l[0]).toMatchObject({ i: 'a', minW: 2, minH: 3, maxW: 8, maxH: 9 });
    expect(l[1]).toMatchObject({ i: 'b', minW: 1, minH: 1 });
    expect(l[1].maxW).toBeUndefined();
  });

  it('compares a grid layout with the saved positions', () => {
    const ws = [w('a', 0, 0, 3, 2)];
    expect(sameLayout([{ i: 'a', x: 0, y: 0, w: 3, h: 2 }], ws)).toBe(true);
    expect(sameLayout([{ i: 'a', x: 1, y: 0, w: 3, h: 2 }], ws)).toBe(false);
    expect(sameLayout([], ws)).toBe(false);
    expect(layoutPositions([{ i: 'a', x: 1, y: 2, w: 3, h: 4, minW: 2 }])).toEqual([{ i: 'a', x: 1, y: 2, w: 3, h: 4 }]);
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
    document.body.innerHTML = '<section data-section-id="s1"><div id="in1"></div></section><section data-section-id="s2"><div id="in2"></div></section>';
    const stack = (id: string) => [document.getElementById(id)!, document.body];
    const doc = { elementsFromPoint: () => stack('in2') } as unknown as Document;
    expect(otherSectionAt({ x: 0, y: 0 }, 's1', doc)).toBe('s2');
    expect(otherSectionAt({ x: 0, y: 0 }, 's2', doc)).toBeNull();
    expect(otherSectionAt({ x: 0, y: 0 }, 's1', {} as Document)).toBeNull();
  });
});
