import { describe, expect, it } from 'vitest';
import { childRows, detailFor, selectionFor } from './detail';
import type { NodeTree, SunNode } from './tree';

function n(
  key: string,
  value: number,
  children: SunNode[] = [],
  extra: Partial<SunNode> = {}
): SunNode {
  return { key, label: key.toUpperCase(), value, kind: 'category', children, ...extra };
}
const tree = (root: SunNode, capacity: number): NodeTree => ({
  root,
  capacity,
  used: root.value,
  hostMetrics: true,
});

// CPU has a thread "t3/p:x/t:b" that memory lacks; memory has project "t3/p:y" that CPU lacks.
const cpu = tree(
  n('root', 4, [
    n('t3', 3, [
      n('t3/p:x', 2, [
        n('t3/p:x/t:a', 1),
        n('t3/p:x/t:b', 1, [], { href: 'https://example.com/t/b' }),
      ]),
    ]),
    n('k8s', 1),
  ]),
  8
);
const mem = tree(
  n('root', 600, [
    n('k8s', 400),
    n('t3', 200, [
      n('t3/p:x', 50, [n('t3/p:x/t:a', 50)], { icon: { kind: 'lucide', name: 'box' } }),
      n('t3/p:y', 100),
    ]),
  ]),
  1000
);

describe('detailFor', () => {
  it('describes the root', () => {
    const d = detailFor(cpu, mem, []);
    expect(d.focus).toMatchObject({ key: 'root', label: 'ROOT' });
    expect(d.path).toEqual([]);
  });

  it('takes the icon from whichever tree has it', () => {
    expect(detailFor(cpu, mem, ['t3', 't3/p:x']).focus.icon).toEqual({
      kind: 'lucide',
      name: 'box',
    });
  });

  it('resolves a node only memory has', () => {
    const d = detailFor(cpu, mem, ['t3', 't3/p:y']);
    expect(d.path).toEqual(['t3', 't3/p:y']);
    expect(d.focus.key).toBe('t3/p:y');
  });

  it('falls back to the CPU tree when memory lacks the focused node', () => {
    const d = detailFor(cpu, mem, ['t3', 't3/p:x', 't3/p:x/t:b']);
    expect(d.path).toEqual(['t3', 't3/p:x', 't3/p:x/t:b']);
    expect(d.focus).toMatchObject({ key: 't3/p:x/t:b', href: 'https://example.com/t/b' });
  });

  it('stops at the deepest node either tree has', () => {
    const d = detailFor(cpu, mem, ['t3', 'gone', 'deeper']);
    expect(d.path).toEqual(['t3']);
    expect(d.focus.key).toBe('t3');
  });

  it('gives a breadcrumb trail from the root', () => {
    const d = detailFor(cpu, mem, ['t3', 't3/p:x']);
    expect(d.trail).toEqual([
      { key: 'root', label: 'ROOT', path: [] },
      { key: 't3', label: 'T3', path: ['t3'] },
      { key: 't3/p:x', label: 'T3/P:X', path: ['t3', 't3/p:x'] },
    ]);
  });
});

describe('selectionFor', () => {
  it('gives name, kind, both resources and the three shares', () => {
    const sel = selectionFor(cpu, mem, [], ['t3', 't3/p:x'])!;
    expect(sel.label).toBe('T3/P:X');
    expect(sel.icon).toEqual({ kind: 'lucide', name: 'box' });
    expect(sel.canOpen).toBe(true);
    expect(sel.cpu).toEqual({ value: 2, ofCapacity: 0.25, ofParent: 2 / 3, ofRoot: 0.5 });
    expect(sel.mem!.value).toBe(50);
    expect(sel.mem!.ofCapacity).toBeCloseTo(0.05);
    expect(sel.mem!.ofParent).toBeCloseTo(0.25);
  });

  it('measures the share of the zoom root', () => {
    const sel = selectionFor(cpu, mem, ['t3'], ['t3', 't3/p:x'])!;
    expect(sel.cpu!.ofRoot).toBeCloseTo(2 / 3);
  });

  it('cannot open a segment with no children, and has no data in a chart that lacks it', () => {
    const sel = selectionFor(cpu, mem, [], ['t3', 't3/p:y'])!;
    expect(sel.canOpen).toBe(false);
    expect(sel.cpu).toBeNull();
    expect(sel.mem!.value).toBe(100);
  });

  it('describes the unused capacity and the unattributed space, which cannot be opened', () => {
    const unused = selectionFor(cpu, mem, [], ['root/~unused'])!;
    expect(unused).toMatchObject({ label: 'Unused', kind: 'unused', canOpen: false });
    expect(unused.cpu).toEqual({ value: 4, ofCapacity: 0.5, ofParent: null, ofRoot: null });
    const un = selectionFor(cpu, mem, [], ['t3', 't3/~unattributed'])!;
    expect(un.label).toBe('Unattributed in T3');
    expect(un.cpu!.value).toBe(1);
    expect(un.cpu!.ofParent).toBeCloseTo(1 / 3);
  });

  it('measures an unattributed gap against its parent, which has children of its own', () => {
    const un = selectionFor(cpu, mem, [], ['t3', 't3/~unattributed'])!;
    // t3 holds 3 cores and its children 2: the gap is 1 core, a third of the parent, not all.
    expect(un.cpu!.value).toBe(1);
    expect(un.cpu!.ofParent).toBeCloseTo(1 / 3);
    expect(un.cpu!.ofRoot).toBeCloseTo(1 / 4);
    expect(un.icon).toEqual({ kind: 'mdi', name: 'selection-ellipse' });
    // A leaf has no unattributed space.
    expect(selectionFor(cpu, mem, [], ['k8s', 'k8s/~unattributed'])).toBeNull();
  });

  it('is null for a path neither tree has', () => {
    expect(selectionFor(cpu, mem, [], ['nope'])).toBeNull();
  });
});

describe('childRows', () => {
  it('lists the children of either chart, biggest share of capacity first', () => {
    const rows = childRows(cpu, mem, ['t3', 't3/p:x']);
    expect(rows.map(r => r.key)).toEqual(['t3/p:x/t:a', 't3/p:x/t:b']);
    expect(rows[0]).toMatchObject({ cpu: 1, mem: 50 });
    expect(rows[1]).toMatchObject({ cpu: 1, mem: null });
    expect(childRows(cpu, mem, ['t3']).map(r => r.key)).toEqual(['t3/p:x', 't3/p:y']);
  });

  it('gives each child its share of capacity at the root', () => {
    const rows = childRows(cpu, mem, ['t3']);
    expect(rows[0]).toMatchObject({ key: 't3/p:x', cpuShare: 2 / 8, memShare: 50 / 1000 });
  });

  it('gives shares of the focus node in each tree when zoomed', () => {
    const rows = childRows(cpu, mem, ['t3'], ['t3']);
    expect(rows[0]).toMatchObject({ key: 't3/p:x', cpuShare: 2 / 3, memShare: 50 / 200 });
    const y = rows.find(r => r.key === 't3/p:y');
    expect(y).toMatchObject({ cpu: null, cpuShare: null, memShare: 100 / 200 });
  });

  it('sorts by share of the focus when zoomed', () => {
    // Of capacity y is 0.1 and x is 0.3; of t3 (cpu 3, mem 200) x is 2/3 + 1/4, y is 1/2.
    expect(childRows(cpu, mem, ['t3'], ['t3']).map(r => r.key)).toEqual(['t3/p:x', 't3/p:y']);
  });

  it('shows friendly names and orders equal values by name', () => {
    const mk = (label: string, key: string, displayName?: string) =>
      n(key, 5, [], { label, displayName });
    const t = tree(
      n('root', 10, [mk('b.mount', 'k:b', 'Beta'), mk('a.mount', 'k:a', 'Alpha')]),
      100
    );
    expect(childRows(t, t, []).map(r => r.label)).toEqual(['Alpha', 'Beta']);
  });
});
