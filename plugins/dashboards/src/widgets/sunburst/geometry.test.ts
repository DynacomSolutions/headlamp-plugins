import { describe, expect, it } from 'vitest';
import { arcPath, CENTRE, fitCentreText, layoutArcs, TAU, trackPath, usedShare } from './geometry';

const data = {
  capacity: 100,
  categories: [
    {
      key: 'a',
      label: 'A',
      value: 40,
      children: [
        { key: 'a1', label: 'A1', value: 30 },
        { key: 'a2', label: 'A2', value: 5 },
      ],
    },
    { key: 'b', label: 'B', value: 10, children: [{ key: 'b1', label: 'B1', value: 10 }] },
  ],
};

describe('layoutArcs', () => {
  it('sizes each arc by its share of the capacity and leaves the unused part empty', () => {
    const arcs = layoutArcs(data, 100);
    const a = arcs.find(x => x.key === 'a')!;
    const b = arcs.find(x => x.key === 'b')!;
    expect(a.start).toBe(0);
    expect(a.end - a.start).toBeCloseTo(0.4 * TAU);
    expect(b.start).toBeCloseTo(a.end);
    expect(b.end).toBeLessThan(0.51 * TAU);
  });
  it('places children inside their category and keeps the gap empty', () => {
    const arcs = layoutArcs(data, 100);
    const a = arcs.find(x => x.key === 'a')!;
    const a1 = arcs.find(x => x.key === 'a1')!;
    const a2 = arcs.find(x => x.key === 'a2')!;
    expect(a1.start).toBeCloseTo(a.start);
    expect(a2.start).toBeCloseTo(a1.end);
    expect(a2.end).toBeLessThan(a.end);
    expect(a1.level).toBe(2);
    expect(a1.inner).toBeGreaterThan(a.outer);
  });
  it('keeps every group: no other bucket and no top-n cut', () => {
    const many = {
      capacity: 1000,
      categories: Array.from({ length: 60 }, (_, i) => ({
        key: `c${i}`,
        label: `C${i}`,
        value: 1 + i,
        children: Array.from({ length: 30 }, (_, j) => ({
          key: `c${i}-${j}`,
          label: `x${j}`,
          value: (1 + i) / 40,
        })),
      })),
    };
    const arcs = layoutArcs(many, 100);
    expect(arcs.filter(a => a.level === 1)).toHaveLength(60);
    expect(arcs.filter(a => a.level === 2)).toHaveLength(60 * 30);
    expect(arcs.some(a => /other/i.test(a.label))).toBe(false);
  });
  it('uses the sum of the categories when they exceed the capacity', () => {
    const arcs = layoutArcs(
      {
        capacity: 10,
        categories: [
          { key: 'a', label: 'A', value: 30 },
          { key: 'b', label: 'B', value: 10 },
        ],
      },
      100
    );
    expect(arcs[arcs.length - 1].end).toBeCloseTo(TAU);
  });
  it('scales children down when they exceed their category', () => {
    const arcs = layoutArcs(
      {
        capacity: 100,
        categories: [
          {
            key: 'a',
            label: 'A',
            value: 10,
            children: [
              { key: 'x', label: 'X', value: 8 },
              { key: 'y', label: 'Y', value: 8 },
            ],
          },
        ],
      },
      100
    );
    const a = arcs.find(x => x.key === 'a')!;
    expect(Math.max(...arcs.filter(x => x.level === 2).map(x => x.end))).toBeCloseTo(a.end);
  });
  it('drops zero, negative and not-a-number values and handles no data', () => {
    expect(layoutArcs({ capacity: 0, categories: [] }, 100)).toEqual([]);
    const arcs = layoutArcs(
      {
        capacity: 10,
        categories: [
          { key: 'a', label: 'A', value: NaN },
          { key: 'b', label: 'B', value: -3 },
          { key: 'c', label: 'C', value: 5, children: [{ key: 'z', label: 'Z', value: 0 }] },
        ],
      },
      100
    );
    expect(arcs.map(a => a.key)).toEqual(['c']);
  });
  it('has a centre hole large enough for the centre text', () => {
    expect(CENTRE).toBe(0.36);
    expect(layoutArcs(data, 100)[0].inner).toBeCloseTo(36);
    expect(Math.max(...layoutArcs(data, 100).map(a => a.outer))).toBe(100);
  });
});

describe('arcPath', () => {
  it('draws a sector with two arcs and two lines', () => {
    const d = arcPath(24, 100, 0, Math.PI / 2);
    expect(d.startsWith('M 0 -100 A 100 100 0 0 1 100 0')).toBe(true);
    expect(d.match(/A /g)).toHaveLength(2);
  });
  it('sets the large-arc flag past half a turn', () => {
    expect(arcPath(24, 100, 0, 1.5 * Math.PI)).toContain('A 100 100 0 1 1');
  });
  it('draws a full circle as a ring and an empty arc as nothing', () => {
    expect(arcPath(24, 100, 0, TAU).match(/A /g)).toHaveLength(4);
    expect(arcPath(24, 100, 1, 1)).toBe('');
    expect(arcPath(100, 24, 0, 1)).toBe('');
    expect(trackPath(100)).toContain('Z');
  });
});

describe('usedShare', () => {
  it('is the used part of the capacity, capped at one', () => {
    expect(usedShare(data)).toBeCloseTo(0.5);
    expect(usedShare({ capacity: 10, categories: [{ key: 'a', label: 'A', value: 30 }] })).toBe(1);
    expect(usedShare({ capacity: 0, categories: [] })).toBe(0);
  });
});

describe('fitCentreText', () => {
  const R = 96;
  const hole = R * CENTRE;
  it('keeps the base size for short text', () => {
    expect(fitCentreText('5', 13, 1, R, true)).toBe(13);
  });
  it('shrinks long text so its width stays inside the hole', () => {
    for (const text of ['123 cores', '57.96 cores', '1.23 TiB', 'of 384 cores (32%)']) {
      const size = fitCentreText(text, 13, 1, R, text !== 'of 384 cores (32%)');
      expect(size).toBeLessThanOrEqual(13);
      expect(size * text.length * 0.56).toBeLessThanOrEqual(hole * 2);
    }
    expect(fitCentreText('123456789012', 13, 1, R, true)).toBeLessThan(
      fitCentreText('123', 13, 1, R, true)
    );
  });
  it('gives less room on a line far from the middle, and never goes below a floor', () => {
    expect(fitCentreText('abcdefghijklmnop', 9, 14, R)).toBeLessThan(
      fitCentreText('abcdefghijklmnop', 9, 0, R)
    );
    expect(fitCentreText('x'.repeat(200), 9, 0, R)).toBe(3);
  });
});
