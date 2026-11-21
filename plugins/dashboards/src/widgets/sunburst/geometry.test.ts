import { describe, expect, it } from 'vitest';
import {
  arcPath,
  CENTRE,
  fitCentreText,
  freeKey,
  layoutArcs,
  layoutNodeArcs,
  MIN_NODE_ANGLE,
  nodeAngles,
  nodeSpan,
  SunburstNode,
  TAU,
  trackPath,
  usedShare,
} from './geometry';

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
    expect(CENTRE).toBe(0.5);
    expect(layoutArcs(data, 100)[0].inner).toBeCloseTo(50);
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
    expect(fitCentreText('abcdefghijklmnopqrstuv', 9, 14, R)).toBeLessThan(
      fitCentreText('abcdefghijklmnopqrstuv', 9, 0, R)
    );
    expect(fitCentreText('x'.repeat(200), 9, 0, R)).toBe(3);
  });
});

describe('layoutNodeArcs', () => {
  const cat = (key: string, value: number, kids: number[] = []) => ({
    key,
    label: key.toUpperCase(),
    value,
    children: kids.map((v, i) => ({ key: `${key}/${i}`, label: `${key}${i}`, value: v })),
  });
  // worker-1 holds 40 of 60, worker-2 holds 10 of 40 and worker-3 is idle with 20.
  const nodes: SunburstNode[] = [
    {
      key: 'node:worker-1',
      label: 'worker-1',
      capacity: 60,
      used: 40,
      categories: [cat('k8s', 30, [20, 10]), cat('system', 10, [10])],
    },
    {
      key: 'node:worker-2',
      label: 'worker-2',
      capacity: 40,
      used: 10,
      categories: [cat('k8s', 10, [10])],
    },
    { key: 'node:worker-3', label: 'worker-3', capacity: 20, used: 0, categories: [] },
  ];
  const arcs = layoutNodeArcs(nodes, 96);
  const of = (kind: string, node?: string) =>
    arcs.filter(a => a.kind === kind && (node === undefined || a.nodeKey === node));
  const share = (a: { start: number; end: number }) => (a.end - a.start) / TAU;

  it('puts the node ring first, each node at its share of the total capacity', () => {
    const ring = of('node');
    expect(ring.map(a => a.key)).toEqual(nodes.map(n => n.key));
    expect(ring.map(share)).toEqual(
      ring.map((_, i) => [60, 40, 20][i] / 120).map(v => expect.closeTo(v, 6))
    );
    // The node ring is the innermost ring and the arcs follow each other without a gap.
    const inner = Math.max(...ring.map(a => a.outer));
    for (const a of arcs.filter(x => x.kind !== 'node'))
      expect(a.inner).toBeGreaterThanOrEqual(inner);
    expect(ring[0].start).toBe(0);
    expect(ring[2].end).toBeCloseTo(TAU, 6);
  });

  it('keeps the category and child rings inside each node at their real size', () => {
    const w1 = of('category', 'node:worker-1');
    expect(w1.map(a => a.key)).toEqual(['k8s', 'system']);
    expect(w1.map(share)).toEqual([expect.closeTo(30 / 120, 6), expect.closeTo(10 / 120, 6)]);
    const kids = of('child', 'node:worker-1').filter(a => a.categoryKey === 'k8s');
    expect(kids.map(a => a.value)).toEqual([20, 10]);
    expect(kids.map(share)).toEqual([expect.closeTo(20 / 120, 6), expect.closeTo(10 / 120, 6)]);
    // A child sits inside the angle of its category.
    const [k8s] = w1;
    for (const k of kids) {
      expect(k.start).toBeGreaterThanOrEqual(k8s.start - 1e-9);
      expect(k.end).toBeLessThanOrEqual(k8s.end + 1e-9);
    }
    // The node ring, the category ring and the child ring do not overlap.
    expect(w1[0].outer).toBeLessThan(kids[0].inner);
  });

  it('adds one free slice per node with spare capacity, at the end of the node', () => {
    const free = of('free');
    expect(free.map(a => a.nodeKey)).toEqual(['node:worker-1', 'node:worker-2', 'node:worker-3']);
    expect(free.map(a => a.value)).toEqual([20, 30, 20]);
    expect(free.map(a => a.key)).toEqual(nodes.map(n => freeKey(n.key)));
    for (const f of free) {
      const node = of('node', f.nodeKey)[0];
      expect(f.end).toBeCloseTo(node.end, 9);
      expect(share(f)).toBeCloseTo(f.value / 120, 6);
      // The free slice spans the category and the child ring.
      expect(f.outer).toBe(96);
    }
    // The used arcs and the free arc of a node fill its wedge exactly.
    for (const n of nodes) {
      const node = of('node', n.key)[0];
      const used = of('category', n.key).reduce((s, a) => s + share(a), 0);
      expect(used + share(of('free', n.key)[0])).toBeCloseTo(share(node), 6);
    }
  });

  it('draws no free slice for a full node and widens an overcommitted node', () => {
    const full = layoutNodeArcs(
      [{ key: 'node:a', label: 'a', capacity: 10, used: 10, categories: [cat('k8s', 10)] }],
      96
    );
    expect(full.some(a => a.kind === 'free')).toBe(false);
    const over = layoutNodeArcs(
      [
        { key: 'node:a', label: 'a', capacity: 10, used: 15, categories: [cat('k8s', 15)] },
        { key: 'node:b', label: 'b', capacity: 15, used: 0, categories: [] },
      ],
      96
    );
    expect(nodeSpan(nodes[0])).toBe(60);
    expect(over.find(a => a.kind === 'node' && a.nodeKey === 'node:a')).toMatchObject({
      value: 15,
    });
    expect(share(over.find(a => a.kind === 'node' && a.nodeKey === 'node:a')!)).toBeCloseTo(0.5, 6);
    expect(over.some(a => a.kind === 'free' && a.nodeKey === 'node:a')).toBe(false);
  });

  it('never folds a small group into an Other arc', () => {
    const many = layoutNodeArcs(
      [
        {
          key: 'node:a',
          label: 'a',
          capacity: 1000,
          used: 500,
          categories: [cat('k8s', 499, [498, 0.5, 0.5]), cat('tiny', 1, [1])],
        },
      ],
      96
    );
    expect(many.filter(a => a.kind === 'child').map(a => a.key)).toEqual([
      'k8s/0',
      'k8s/1',
      'k8s/2',
      'tiny/0',
    ]);
    expect(JSON.stringify(many)).not.toMatch(/other/i);
  });

  it('draws nothing for no nodes or for nodes without capacity and use', () => {
    expect(layoutNodeArcs([], 96)).toEqual([]);
    expect(
      layoutNodeArcs([{ key: 'n', label: 'n', capacity: 0, used: 0, categories: [] }], 96)
    ).toEqual([]);
  });

  it('gives a small node, and a node with no capacity, its minimum arc and keeps the circle whole', () => {
    const list: SunburstNode[] = [
      { key: 'node:big', label: 'big', capacity: 380, used: 100, categories: [cat('k8s', 100)] },
      { key: 'node:tiny', label: 'tiny', capacity: 2, used: 1, categories: [cat('k8s', 1, [1])] },
      { key: 'node:none', label: 'none', capacity: 0, used: 0, categories: [] },
    ];
    const arcsOf = layoutNodeArcs(list, 96);
    const ring = arcsOf.filter(a => a.kind === 'node');
    expect(ring.map(a => a.key)).toEqual(['node:big', 'node:tiny', 'node:none']);
    for (const a of ring.slice(1)) expect(a.end - a.start).toBeCloseTo(MIN_NODE_ANGLE, 6);
    expect(ring[0].start).toBe(0);
    expect(ring[2].end).toBeCloseTo(TAU, 6);
    for (let i = 1; i < ring.length; i++) expect(ring[i].start).toBeCloseTo(ring[i - 1].end, 9);
    // The inside of the widened node still fills it exactly: the used arcs and the free arc.
    const tiny = ring[1];
    const inside = arcsOf
      .filter(a => a.nodeKey === 'node:tiny' && (a.kind === 'category' || a.kind === 'free'))
      .reduce((s, a) => s + (a.end - a.start), 0);
    expect(inside).toBeCloseTo(tiny.end - tiny.start, 6);
  });
});

describe('nodeAngles', () => {
  it('keeps the real share of nodes that are large enough', () => {
    expect(nodeAngles([1, 1, 2]).map(a => a / TAU)).toEqual([
      expect.closeTo(0.25, 6),
      expect.closeTo(0.25, 6),
      expect.closeTo(0.5, 6),
    ]);
  });
  it('lowers the minimum when there are very many nodes, and still fills the circle', () => {
    const angles = nodeAngles([1000, ...Array.from({ length: 29 }, () => 0)]);
    expect(angles.reduce((s, a) => s + a, 0)).toBeCloseTo(TAU, 6);
    expect(Math.min(...angles)).toBeGreaterThan(0);
  });
});
