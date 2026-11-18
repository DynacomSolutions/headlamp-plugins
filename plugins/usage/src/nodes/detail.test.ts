import { describe, expect, it } from 'vitest';
import { detailFor } from './detail';
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
