import { describe, expect, it } from 'vitest';
import { colourAt } from '../palette';
import { categoryColour, CENTRE, layoutSunburst, shade } from './layout';
import type { NodeTree, SunNode } from './tree';

function n(key: string, value: number, kind: SunNode['kind'], children: SunNode[] = []): SunNode {
  return { key, label: key, value, kind, children };
}

const tree = (used: number | null = 8): NodeTree => ({
  root: n('root', 8, 'node', [
    n('t3', 6, 'category', [
      n('t3/p:x', 2, 'project', [n('t3/p:x/t:a', 1, 'thread')]),
      n('t3/p:y', 1, 'project'),
    ]),
    n('k8s', 2, 'category'),
  ]),
  capacity: 16,
  used,
  hostMetrics: used !== null,
});

const opts = { radius: 1000, rings: 3, mode: 'light' as const };

describe('layoutSunburst', () => {
  it('draws 2π·used/capacity at the root', () => {
    const { arcs, centre } = layoutSunburst(tree(), [], opts);
    const d1 = arcs.filter(a => a.depth === 1 && !a.gap);
    expect(d1[0].x0).toBe(0);
    expect(d1[d1.length - 1].x1).toBeCloseTo(Math.PI);
    expect(centre).toEqual({ title: 'root', value: 8, share: 0.5, parentShare: null });
  });

  it('fills the circle when focused and leaves gaps empty', () => {
    const { arcs, focusNode, centre } = layoutSunburst(tree(), ['t3'], opts);
    expect(focusNode.key).toBe('t3');
    const x = arcs.find(a => a.key === 't3/p:x')!;
    const y = arcs.find(a => a.key === 't3/p:y')!;
    expect(x.x0).toBe(0);
    // Zoomed below the node: angles are shares of node capacity (16), not of the focus.
    expect(x.x1).toBeCloseTo((2 * Math.PI * 2) / 16);
    expect(y.x0).toBeCloseTo(x.x1);
    expect(y.x1 - y.x0).toBeCloseTo((2 * Math.PI) / 16);
    expect(centre.share).toBeCloseTo(6 / 16);
    const child = arcs.find(a => a.key === 't3/p:x/t:a')!;
    expect(child.x1 - child.x0).toBeCloseTo((2 * Math.PI) / 16);
  });

  it('returns only `rings` levels', () => {
    const { arcs } = layoutSunburst(tree(), [], { ...opts, rings: 2 });
    expect(Math.max(...arcs.map(a => a.depth))).toBe(2);
    expect(arcs.some(a => a.key === 't3/p:x/t:a')).toBe(false);
  });

  it('draws arcs up to the ring count and none beyond, with 4 and 6 rings', () => {
    const deep = (d: number, key = 'k'): SunNode[] =>
      d === 0 ? [] : [n(key, 1, 'thread', deep(d - 1, `${key}/x`))];
    const t = tree();
    t.root.children = [n('t3', 8, 'category', deep(7, 't3/a'))];
    for (const rings of [4, 6]) {
      const { arcs } = layoutSunburst(t, [], { ...opts, rings });
      const real = arcs.filter(a => !a.gap);
      expect(Math.max(...real.map(a => a.depth))).toBe(rings);
      expect(Math.max(...arcs.map(a => a.depth))).toBeLessThanOrEqual(rings);
      const outer = real.find(a => a.depth === rings)!;
      expect(outer.y1).toBeCloseTo(1000);
      const thick = (760 / rings);
      expect(outer.y1 - outer.y0).toBeCloseTo(thick);
    }
  });

  it('uses the ring formula', () => {
    const { arcs } = layoutSunburst(tree(), [], opts);
    const a1 = arcs.find(a => a.depth === 1)!;
    const a2 = arcs.find(a => a.depth === 2)!;
    expect(a1.y0).toBeCloseTo(1000 * CENTRE);
    expect(CENTRE).toBe(0.24);
    expect(a1.y1).toBeCloseTo(240 + 760 / 3);
    expect(a2.y0).toBeCloseTo(a1.y1);
  });

  it('gives the share of the parent below the root', () => {
    expect(layoutSunburst(tree(), [], opts).centre.parentShare).toBeNull();
    expect(layoutSunburst(tree(), ['t3', 't3/p:x'], opts).centre.parentShare).toBeCloseTo(2 / 6);
  });

  it('falls back to the deepest existing ancestor', () => {
    const { focusNode } = layoutSunburst(tree(), ['t3', 'nope'], opts);
    expect(focusNode.key).toBe('t3');
  });

  it('keeps one hue per category, also when zoomed', () => {
    const root = layoutSunburst(tree(), [], opts).arcs;
    const zoom = layoutSunburst(tree(), ['t3'], opts).arcs;
    const hue = (s: string) => s.split(',')[0];
    const a = root.find(x => x.key === 't3/p:x')!;
    const b = zoom.find(x => x.key === 't3/p:x')!;
    expect(a.fill).toBe(b.fill);
    expect(hue(root.find(x => x.key === 't3/p:y')!.fill)).toBe(hue(a.fill));
    expect(root.find(x => x.key === 't3')!.fill).not.toBe(root.find(x => x.key === 'k8s')!.fill);
  });

  it('gives a category the same colour whatever other categories are present', () => {
    const other: NodeTree = {
      root: n('root', 8, 'node', [
        n('system', 1, 'system'),
        n('herdr', 2, 'category'),
        n('t3', 3, 'category', [n('t3/p:x', 2, 'project')]),
      ]),
      capacity: 16,
      used: 8,
      hostMetrics: true,
    };
    const a = layoutSunburst(tree(), [], opts).arcs;
    const b = layoutSunburst(other, [], opts).arcs;
    const fill = (arcs: typeof a, key: string) => arcs.find(x => x.key === key)!.fill;
    expect(fill(a, 't3')).toBe(fill(b, 't3'));
    expect(fill(a, 't3/p:x')).toBe(fill(b, 't3/p:x'));
    expect(fill(a, 't3')).toBe(colourAt(1, 'light'));
    expect(fill(a, 'k8s')).toBe(colourAt(0, 'light'));
    expect(fill(b, 'herdr')).toBe(colourAt(2, 'light'));
    expect(fill(b, 'system')).toBe(colourAt(5, 'light'));
    expect(categoryColour('custom', 'light')).toBe(categoryColour('custom', 'light'));
    expect([0, 1, 2, 3, 5].map(i => colourAt(i, 'light'))).not.toContain(
      categoryColour('custom', 'light')
    );
  });

  it('returns the resolved focus path', () => {
    expect(layoutSunburst(tree(), ['t3', 'nope', 't3/p:x'], opts).path).toEqual(['t3']);
    expect(layoutSunburst(tree(), ['t3', 't3/p:x'], opts).path).toEqual(['t3', 't3/p:x']);
  });

  it('uses root value when used is null', () => {
    const { arcs } = layoutSunburst(tree(null), [], opts);
    const d1 = arcs.filter(a => a.depth === 1 && !a.gap);
    expect(d1[d1.length - 1].x1).toBeCloseTo(Math.PI);
  });
});

describe('layoutSunburst gaps', () => {
  it('draws the unused capacity and the unattributed space as arcs without fill', () => {
    const { arcs } = layoutSunburst(tree(), [], opts);
    const unused = arcs.find(a => a.key === 'root/~unused')!;
    expect(unused).toMatchObject({ gap: true, fill: 'none', depth: 1 });
    expect(unused.x0).toBeCloseTo(Math.PI);
    expect(unused.x1).toBeCloseTo(2 * Math.PI);
    const un = arcs.find(a => a.key === 't3/~unattributed')!;
    expect(un.gap).toBe(true);
    expect(un.depth).toBe(2);
    // t3 holds 6, its children 3: the gap is the other half of the t3 arc.
    const t3 = arcs.find(a => a.key === 't3')!;
    expect(un.x0).toBeCloseTo(t3.x0 + (t3.x1 - t3.x0) / 2);
    expect(un.x1).toBeCloseTo(t3.x1);
  });

  it('has an unattributed arc only where children sum to less than the parent', () => {
    const { arcs } = layoutSunburst(tree(), ['t3'], opts);
    expect(arcs.some(a => a.key === 't3/~unused')).toBe(false);
    expect(arcs.some(a => a.key === 't3/~unattributed')).toBe(true);
  });
});

describe('layoutSunburst empty space reaches the rim', () => {
  it('runs a gap arc from its ring to the outer radius, and nothing under a leaf', () => {
    const { arcs } = layoutSunburst(tree(), [], opts);
    for (const key of ['root/~unused', 't3/~unattributed']) {
      expect(arcs.find(a => a.key === key)!.y1).toBeCloseTo(1000);
    }
    // Leaves (k8s here, and the thread under t3/p:x) hold no unattributed space.
    expect(arcs.some(a => a.key === 'k8s/~unattributed')).toBe(false);
    expect(arcs.some(a => a.key === 't3/p:x/t:a/~unattributed')).toBe(false);
  });
});

describe('layoutSunburst node ring', () => {
  const ring: NodeTree = {
    root: n('root', 8, 'node', [
      n('node:a', 5, 'node', [n('k8s', 3, 'category'), n('system', 2, 'system')]),
      n('node:b', 3, 'node', [n('k8s', 3, 'category')]),
    ]),
    capacity: 16,
    used: 8,
    hostMetrics: true,
    nodeRing: true,
  };

  it('colours categories on the second ring and keeps node arcs neutral', () => {
    const { arcs } = layoutSunburst(ring, [], opts);
    const k8s = arcs.filter(a => a.node.kind === 'category');
    expect(k8s).toHaveLength(2);
    k8s.forEach(a => expect(a.fill).toBe(colourAt(0, 'light')));
    expect(arcs.find(a => a.key === 'node:a')!.fill).not.toBe(colourAt(0, 'light'));
  });
});

describe('layoutSunburst node ring by capacity', () => {
  const TAU = 2 * Math.PI;
  const ring = (): NodeTree => ({
    root: n('root', 12, 'node', [
      {
        ...n('node:a', 4, 'node', [n('k8s', 3, 'category'), n('system', 1, 'system')]),
        span: 12,
        capacity: 12,
      },
      { ...n('node:b', 2, 'node', [n('k8s', 2, 'category')]), span: 4, capacity: 4 },
      { ...n('node:c', 6, 'node', [n('k8s', 6, 'category')]), span: 6, capacity: 4 },
    ]),
    capacity: 20,
    used: 12,
    hostMetrics: true,
    nodeRing: true,
  });
  const arcOf = (key: string, o = opts, focus: string[] = []) =>
    layoutSunburst(ring(), focus, o).arcs.find(a => a.key === key)!;

  it('splits the whole circle by capacity, using the sum of spans', () => {
    const a = arcOf('node:a');
    const b = arcOf('node:b');
    const c = arcOf('node:c');
    expect(a.x0).toBe(0);
    expect(a.x1).toBeCloseTo((TAU * 12) / 22);
    expect(b.x1 - b.x0).toBeCloseTo((TAU * 4) / 22);
    expect(c.x1).toBeCloseTo(TAU);
    expect(a.gap).toBeUndefined();
  });

  it('keeps the node arc over its whole span and the children in the used share', () => {
    const a = arcOf('node:a');
    const k8s = arcOf('k8s');
    expect(k8s.x0).toBe(0);
    // Used 4 of span 12: the children fill the first third of the wedge.
    expect(k8s.x1).toBeCloseTo(a.x1 * (4 / 12) * (3 / 4));
    const sys = arcOf('system');
    expect(sys.x1).toBeCloseTo(a.x1 / 3);
  });

  it('draws the unused gap from the used share to the wedge end, out to the rim', () => {
    const a = arcOf('node:a');
    const gap = arcOf('node:a/~unused');
    expect(gap).toMatchObject({ gap: true, fill: 'none', depth: 2 });
    expect(gap.x0).toBeCloseTo(a.x1 / 3);
    expect(gap.x1).toBeCloseTo(a.x1);
    expect(gap.y0).toBeCloseTo(1000 * (CENTRE + (1 - CENTRE) / 3));
    expect(gap.y1).toBeCloseTo(1000);
    expect(gap.node).toMatchObject({ label: 'Unused on node:a', kind: 'unused', value: 8 });
  });

  it('has no root unused arc and no gap for an overcommitted node', () => {
    const { arcs } = layoutSunburst(ring(), [], opts);
    expect(arcs.some(x => x.key === 'root/~unused')).toBe(false);
    expect(arcs.some(x => x.key === 'node:c/~unused')).toBe(false);
    const c = arcOf('node:c');
    const k8s = arcs.filter(x => x.key === 'k8s').pop()!;
    expect(k8s.x1).toBeCloseTo(c.x1);
    expect(arcs.every(x => x.x1 >= x.x0)).toBe(true);
  });

  it('zooms into a node like a single-node root: use, then its unused gap to the circle end', () => {
    const { arcs, centre } = layoutSunburst(ring(), ['node:a'], opts);
    const k8s = arcs.find(x => x.key === 'k8s')!;
    expect(k8s.x1).toBeCloseTo(TAU * (3 / 12));
    const gap = arcs.find(x => x.key === 'node:a/~unused')!;
    expect(gap).toMatchObject({ gap: true, depth: 1 });
    expect(gap.x0).toBeCloseTo(TAU * (4 / 12));
    expect(gap.x1).toBeCloseTo(TAU);
    expect(gap.y0).toBeCloseTo(1000 * CENTRE);
    expect(gap.y1).toBeCloseTo(1000);
    expect(centre.share).toBeCloseTo(4 / 12);
  });

  it('zoomed below a node draws against the node capacity, with the unused gap as the rest', () => {
    const { arcs } = layoutSunburst(ring(), ['node:a', 'k8s'], opts);
    const thin = arcs.find(x => x.key === 'k8s' && x.context)!;
    expect(thin.x1).toBeCloseTo(TAU * (3 / 12));
    expect(arcs.find(x => x.key === 'node:a/~unused')!.gap).toBe(true);
  });
});

describe('layoutSunburst zoom context against the node', () => {
  const TAU = 2 * Math.PI;
  const o = { radius: 1000, rings: 3, mode: 'light' as const };

  it('draws the focus as a thin ring of its share of node capacity, children at that scale', () => {
    const { arcs, nodeCentre, focusNode } = layoutSunburst(tree(), ['t3'], o);
    expect(focusNode.key).toBe('t3');
    const thin = arcs.find(a => a.key === 't3' && a.context)!;
    expect(thin.x0).toBe(0);
    expect(thin.x1).toBeCloseTo((TAU * 6) / 16);
    expect(thin.path).toEqual(['t3']);
    expect(thin.y0).toBeCloseTo(1000 * CENTRE);
    const x = arcs.find(a => a.key === 't3/p:x')!;
    expect(x.x1 - x.x0).toBeCloseTo((TAU * 2) / 16);
    expect(x.y0).toBeCloseTo(thin.y1);
    const y = arcs.find(a => a.key === 't3/p:y')!;
    expect(y.x1 - y.x0).toBeCloseTo((TAU * 1) / 16);
    expect(nodeCentre).toMatchObject({ capacity: 16, used: 8, share: 0.5 });
    expect(nodeCentre!.node.key).toBe('root');
  });

  it('leaves the rest of the circle as a selectable unused gap to the rim', () => {
    const { arcs } = layoutSunburst(tree(), ['t3'], o);
    const gap = arcs.find(a => a.key === 'root/~unused')!;
    expect(gap.gap).toBe(true);
    expect(gap.x0).toBeCloseTo((TAU * 6) / 16);
    expect(gap.x1).toBeCloseTo(TAU);
    expect(gap.y1).toBeCloseTo(1000);
    expect(gap.path).toEqual(['root/~unused']);
  });

  it('gives each ancestor and the focus its own thin ring, all at node capacity scale', () => {
    const { arcs } = layoutSunburst(tree(), ['t3', 't3/p:x'], o);
    const rings = arcs.filter(a => a.context);
    expect(rings.map(a => a.key)).toEqual(['t3', 't3/p:x']);
    expect(rings[0].x1).toBeCloseTo((TAU * 6) / 16);
    expect(rings[1].x1).toBeCloseTo((TAU * 2) / 16);
    expect(rings[1].y0).toBeCloseTo(rings[0].y1);
    expect(rings[1].path).toEqual(['t3', 't3/p:x']);
    expect(rings[0].fill).toBe(colourAt(1, 'light'));
    const child = arcs.find(a => a.key === 't3/p:x/t:a')!;
    expect(child.x1 - child.x0).toBeCloseTo((TAU * 1) / 16);
    expect(child.y0).toBeCloseTo(rings[1].y1);
  });

  it('makes thin rings 0.3 of a normal ring, at least 6 px, and keeps the ring count', () => {
    const { arcs } = layoutSunburst(tree(), ['t3', 't3/p:x'], o);
    const [a, b] = arcs.filter(x => x.context);
    const normal = arcs.find(x => x.key === 't3/p:x/t:a')!;
    expect(b.y1 - b.y0).toBeCloseTo(0.3 * (normal.y1 - normal.y0));
    expect(a.y1 - a.y0).toBeCloseTo(b.y1 - b.y0);
    expect(normal.y1).toBeLessThanOrEqual(1000);
    const small = layoutSunburst(tree(), ['t3'], { ...o, radius: 60 }).arcs.find(x => x.context)!;
    expect(small.y1 - small.y0).toBeCloseTo(6);
    const deeper = layoutSunburst(tree(), ['t3', 't3/p:x'], { ...o, rings: 1 });
    expect(Math.max(...deeper.arcs.map(x => x.depth))).toBe(1);
  });

  it('uses the node capacity in a node ring, and keeps the node zoom as it is', () => {
    const ring: NodeTree = {
      root: n('root', 6, 'node', [
        {
          ...n('node:a', 4, 'node', [n('k8s', 3, 'category', [n('ns', 1, 'namespace')])]),
          span: 12,
          capacity: 12,
        },
        { ...n('node:b', 2, 'node'), span: 4, capacity: 4 },
      ]),
      capacity: 16,
      used: 6,
      hostMetrics: true,
      nodeRing: true,
    };
    const { arcs, nodeCentre } = layoutSunburst(ring, ['node:a', 'k8s'], o);
    const thin = arcs.find(a => a.key === 'k8s' && a.context)!;
    expect(thin.x1).toBeCloseTo((TAU * 3) / 12);
    expect(thin.path).toEqual(['node:a', 'k8s']);
    const ns = arcs.find(a => a.key === 'ns')!;
    expect(ns.x1 - ns.x0).toBeCloseTo((TAU * 1) / 12);
    const gap = arcs.find(a => a.key === 'node:a/~unused')!;
    expect(gap.path).toEqual(['node:a', 'node:a/~unused']);
    expect(gap.x0).toBeCloseTo((TAU * 3) / 12);
    expect(nodeCentre).toMatchObject({ capacity: 12, used: 4 });
    expect(nodeCentre!.node.key).toBe('node:a');
    // The node itself and the root draw no thin rings.
    expect(layoutSunburst(ring, ['node:a'], o).nodeCentre).toBeUndefined();
    expect(layoutSunburst(ring, [], o).nodeCentre).toBeUndefined();
    expect(layoutSunburst(tree(), [], o).nodeCentre).toBeUndefined();
  });
});

describe('shade', () => {
  it('is deterministic, keeps hue, varies lightness', () => {
    expect(shade('#0072B2', 2, 1)).toBe(shade('#0072B2', 2, 1));
    const hue = (s: string) => s.match(/hsl\(([\d.]+),/)![1];
    const l = (s: string) => Number(s.match(/,\s*([\d.]+)%\)/)![1]);
    const a = shade('#0072B2', 1, 0);
    const b = shade('#0072B2', 3, 0);
    expect(hue(a)).toBe(hue(b));
    expect(l(a)).not.toBe(l(b));
    expect(shade('hsl(200.00, 62%, 40%)', 2, 0)).toMatch(/^hsl\(200/);
  });
});
