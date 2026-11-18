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
    expect(x.x1).toBeCloseTo((2 * Math.PI * 2) / 6);
    expect(y.x0).toBeCloseTo(x.x1);
    expect(y.x1 - y.x0).toBeCloseTo((2 * Math.PI) / 6);
    expect(centre.share).toBeCloseTo(6 / 16);
    const child = arcs.find(a => a.key === 't3/p:x/t:a')!;
    expect(child.x1 - child.x0).toBeCloseTo((2 * Math.PI) / 6);
  });

  it('returns only `rings` levels', () => {
    const { arcs } = layoutSunburst(tree(), [], { ...opts, rings: 2 });
    expect(Math.max(...arcs.map(a => a.depth))).toBe(2);
    expect(arcs.some(a => a.key === 't3/p:x/t:a')).toBe(false);
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
    expect(categoryColour('other', 'dark')).toBe(colourAt(3, 'dark'));
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
