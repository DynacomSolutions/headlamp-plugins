import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeTree, SunNode } from './tree';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn() } }));
vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));

import { Sunburst } from './Sunburst';

function n(
  key: string,
  value: number,
  kind: SunNode['kind'],
  children: SunNode[] = [],
  extra: Partial<SunNode> = {}
): SunNode {
  return { key, label: key, value, kind, children, ...extra };
}

const tree: NodeTree = {
  root: n('root', 8, 'node', [
    n('t3', 6, 'category', [
      n('p:x', 2, 'project', [n('t:a', 1, 'thread')], { icon: { kind: 'lucide', name: 'box' } }),
      n('p:y', 1, 'project'),
    ]),
    n('k8s', 2, 'category'),
  ]),
  capacity: 16,
  used: 8,
  hostMetrics: true,
};

// jsdom has no PointerEvent: a MouseEvent subclass carries pointerId and the coordinates.
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
(window as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;

afterEach(cleanup);

describe('Sunburst', () => {
  it('draws one path per arc, plus the empty space as arcs without fill', () => {
    const { container } = render(<Sunburst tree={tree} resource="cpu" focus={[]} size={400} />);
    expect(container.querySelectorAll('path[data-key]:not([data-gap])')).toHaveLength(5);
    const unused = container.querySelector('path[data-key="root/~unused"]') as SVGElement;
    expect(unused.getAttribute('fill')).toMatch(/^url\(#sb-hatch-/);
    expect(unused.style.pointerEvents).toBe('all');
    expect(unused.getAttribute('stroke-dasharray')).toBeTruthy();
    expect(container.querySelector('path[data-key="t3/~unattributed"]')).not.toBeNull();
  });

  it('taps an arc to select its key path without zooming', () => {
    const onFocus = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <Sunburst
        tree={tree}
        resource="cpu"
        focus={[]}
        size={400}
        onFocus={onFocus}
        onSelect={onSelect}
      />
    );
    const arc = container.querySelector('path[data-key="p:x"]') as Element;
    fireEvent.pointerDown(arc, { clientX: 5, clientY: 5 });
    fireEvent.pointerUp(arc, { clientX: 6, clientY: 5 });
    expect(onSelect).toHaveBeenCalledWith(['t3', 'p:x']);
    expect(onFocus).not.toHaveBeenCalled();
  });

  const tap = (el: Element, x = 5, y = 5) => {
    fireEvent.pointerDown(el, { clientX: x, clientY: y });
    fireEvent.pointerUp(el, { clientX: x, clientY: y });
  };

  it('opens an arc on a double tap with pointer events, and the first tap still selects', () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={400} onSelect={onSelect} onOpen={onOpen} />
    );
    const arc = container.querySelector('path[data-key="p:x"]') as Element;
    tap(arc);
    expect(onSelect).toHaveBeenCalledWith(['t3', 'p:x']);
    expect(onOpen).not.toHaveBeenCalled();
    tap(arc, 8, 6);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(['t3', 'p:x']);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('does not open on two taps that are too slow, on different arcs or far apart', () => {
    vi.useFakeTimers();
    try {
      const onOpen = vi.fn();
      const { container } = render(
        <Sunburst tree={tree} resource="cpu" focus={[]} size={400} onOpen={onOpen} />
      );
      const x = container.querySelector('path[data-key="p:x"]') as Element;
      const y = container.querySelector('path[data-key="p:y"]') as Element;
      tap(x);
      vi.advanceTimersByTime(400);
      tap(x);
      tap(y);
      tap(y, 100, 100);
      expect(onOpen).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens an arc on a double click event, once when pointer events came first', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={400} onOpen={onOpen} />
    );
    const arc = container.querySelector('path[data-key="p:x"]') as Element;
    fireEvent.doubleClick(arc);
    expect(onOpen).toHaveBeenCalledWith(['t3', 'p:x']);
    onOpen.mockClear();
    tap(arc);
    tap(arc);
    fireEvent.doubleClick(arc);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a double click of empty space', () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={400} onOpen={onOpen} onSelect={onSelect} />
    );
    const gap = container.querySelector('path[data-key="root/~unused"]') as Element;
    tap(gap);
    tap(gap);
    fireEvent.doubleClick(gap);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('goes up one level on a double click of the centre, once for a double tap', () => {
    const onFocus = vi.fn();
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={['t3', 'p:x']} size={400} onFocus={onFocus} />
    );
    const centre = container.querySelector('circle[data-centre]') as Element;
    fireEvent.doubleClick(centre);
    expect(onFocus).toHaveBeenCalledWith(['t3']);
    onFocus.mockClear();
    tap(centre);
    tap(centre);
    fireEvent.doubleClick(centre);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('ignores double taps in compact mode', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={400} compact onOpen={onOpen} />
    );
    const arc = container.querySelector('path[data-key="p:x"]') as Element;
    tap(arc);
    tap(arc);
    fireEvent.doubleClick(arc);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('zoomed below the node: centre names the node and capacity, focus is a thin ring', () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const { container } = render(
      <Sunburst
        tree={tree}
        resource="cpu"
        focus={['t3', 'p:x']}
        size={1200}
        subject={{ label: 'p:x' }}
        onSelect={onSelect}
        onOpen={onOpen}
      />
    );
    const line = (k: string) => container.querySelector(`[data-centre-line="${k}"]`)?.textContent;
    expect(line('title')).toBe('root');
    expect(line('value')).toBe('16.00 cores');
    expect(line('node')).toBe('50% used');
    const rings = container.querySelectorAll('path[data-key="t3"], path[data-key="p:x"]');
    expect(rings).toHaveLength(2);
    // Tapping a thin ring selects it; double tap opens it.
    const t3 = container.querySelector('path[data-key="t3"]') as Element;
    tap(t3);
    expect(onSelect).toHaveBeenCalledWith(['t3']);
    tap(t3);
    expect(onOpen).toHaveBeenCalledWith(['t3']);
    // The empty space beside the focus selects the node's unused capacity.
    const gap = container.querySelector('path[data-key="root/~unused"]') as Element;
    tap(gap);
    expect(onSelect).toHaveBeenLastCalledWith(['root/~unused']);
  });

  it('grows and outlines the selected arc, and a second tap clears it', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Sunburst
        tree={tree}
        resource="cpu"
        focus={[]}
        size={400}
        selected={['t3']}
        onSelect={onSelect}
      />
    );
    const arc = container.querySelector('path[data-key="t3"]') as SVGElement;
    const other = container.querySelector('path[data-key="k8s"]') as SVGElement;
    expect(arc.getAttribute('data-selected')).toBe('true');
    expect(arc.getAttribute('stroke-width')).toBe('3');
    expect(other.getAttribute('data-selected')).toBeNull();
    // The selected arc reaches further out than an unselected one of the same ring.
    const outer = (el: SVGElement) =>
      Math.max(
        ...(el.getAttribute('d') ?? '').match(/-?\d+\.?\d*/g)!.map(v => Math.abs(Number(v)))
      );
    expect(outer(arc)).toBeGreaterThan(outer(other));
    fireEvent.pointerDown(arc);
    fireEvent.pointerUp(arc);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('draws a dotted rim at the full outer radius, and no focus box on an arc', () => {
    const { container } = render(<Sunburst tree={tree} resource="cpu" focus={[]} size={420} />);
    const rim = container.querySelector('circle[data-rim]') as Element;
    expect(Number(rim.getAttribute('r'))).toBeCloseTo(210 - 10);
    expect(container.querySelector('style')?.textContent).toContain('.sb-arc{outline:none}');
    expect(container.querySelector('style')?.textContent).toContain(':focus-visible');
    expect(container.querySelector('path[data-key="t3"]')?.getAttribute('class')).toBe('sb-arc');
  });

  it('selects the unused capacity like any other arc', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={400} onSelect={onSelect} />
    );
    const arc = container.querySelector('path[data-key="root/~unused"]') as Element;
    fireEvent.pointerDown(arc);
    fireEvent.pointerUp(arc);
    expect(onSelect).toHaveBeenCalledWith(['root/~unused']);
  });

  it('clears the selection on a tap beside the arcs', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={400} onSelect={onSelect} />
    );
    fireEvent.pointerUp(container.querySelector('svg') as Element);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('ignores a tap that moved', () => {
    const onFocus = vi.fn();
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={400} onFocus={onFocus} />
    );
    const arc = container.querySelector('path[data-key="k8s"]') as Element;
    fireEvent.pointerDown(arc, { clientX: 5, clientY: 5 });
    fireEvent.pointerUp(arc, { clientX: 50, clientY: 5 });
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('taps the centre to go up one level', () => {
    const onFocus = vi.fn();
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={['t3', 'p:x']} size={400} onFocus={onFocus} />
    );
    const centre = container.querySelector('circle[data-centre]') as Element;
    fireEvent.pointerDown(centre, { clientX: 5, clientY: 5 });
    fireEvent.pointerUp(centre, { clientX: 5, clientY: 5 });
    expect(onFocus).toHaveBeenCalledWith(['t3']);
  });

  it('taps an arc under a focus deeper than this tree into a path it can resolve', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Sunburst
        tree={tree}
        resource="cpu"
        focus={['t3', 'only-in-memory']}
        size={400}
        onSelect={onSelect}
      />
    );
    const arc = container.querySelector('path[data-key="p:x"]') as Element;
    fireEvent.pointerDown(arc, { clientX: 5, clientY: 5 });
    fireEvent.pointerUp(arc, { clientX: 5, clientY: 5 });
    expect(onSelect).toHaveBeenCalledWith(['t3', 'p:x']);
  });

  it('labels the chart with the top children and their share of capacity', () => {
    const { getByRole } = render(<Sunburst tree={tree} resource="cpu" focus={[]} size={400} />);
    const label = getByRole('group').getAttribute('aria-label') as string;
    expect(label).toContain('t3');
    expect(label).toContain('38%');
    expect(label).toContain('k8s');
  });

  it('scales a pressed arc', () => {
    const { container } = render(<Sunburst tree={tree} resource="cpu" focus={[]} size={400} />);
    const arc = container.querySelector('path[data-key="k8s"]') as SVGElement;
    fireEvent.pointerDown(arc);
    expect(arc.style.transform).toBe('scale(1.03)');
    fireEvent.pointerUp(arc);
    expect(arc.style.transform).toBe('');
  });

  it('compact hides labels and icons and ignores taps', () => {
    const onFocus = vi.fn();
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={400} onFocus={onFocus} compact />
    );
    expect(container.querySelectorAll('text[data-arc-label]')).toHaveLength(0);
    expect(container.querySelectorAll('foreignObject, image')).toHaveLength(0);
    const arc = container.querySelector('path[data-key="k8s"]') as Element;
    fireEvent.pointerDown(arc);
    fireEvent.pointerUp(arc);
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('shows labels and icons when not compact', () => {
    const { container } = render(<Sunburst tree={tree} resource="cpu" focus={[]} size={600} />);
    expect(container.querySelectorAll('text[data-arc-label]').length).toBeGreaterThan(0);
    expect(container.querySelector('foreignObject [data-icon="lucide:box"]')).not.toBeNull();
  });

  it('ignores a pointerup from another pointer', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={400} onSelect={onSelect} />
    );
    const arc = container.querySelector('path[data-key="k8s"]') as Element;
    fireEvent.pointerDown(arc, { pointerId: 1 });
    fireEvent.pointerUp(arc, { pointerId: 2 });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.pointerUp(arc, { pointerId: 1 });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('pointercancel then pointerup does not focus', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={400} onSelect={onSelect} />
    );
    const arc = container.querySelector('path[data-key="k8s"]') as Element;
    fireEvent.pointerDown(arc, { pointerId: 1 });
    fireEvent.pointerCancel(arc, { pointerId: 1 });
    fireEvent.pointerUp(arc, { pointerId: 1 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('never draws text under 14 px and truncates long centre titles', () => {
    const long: NodeTree = {
      ...tree,
      root: { ...tree.root, label: 'a-very-long-node-title-here' },
    };
    const { container } = render(<Sunburst tree={long} resource="cpu" focus={[]} size={1000} />);
    container.querySelectorAll('text').forEach(t => {
      expect(Number(t.getAttribute('font-size'))).toBeGreaterThanOrEqual(14);
    });
    expect(container.textContent).toContain('\u2026');
  });

  it('names every arc with its value and share and makes it focusable', () => {
    const { container } = render(<Sunburst tree={tree} resource="cpu" focus={[]} size={400} />);
    const arc = container.querySelector('path[data-key="t3"]') as Element;
    expect(arc.getAttribute('aria-label')).toBe('t3: 6.00 cores, 38% of node');
    expect(arc.getAttribute('tabindex')).toBe('0');
    expect(arc.getAttribute('role')).toBe('button');
  });

  it('focuses an arc with Enter or Space', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={400} onSelect={onSelect} />
    );
    const arc = container.querySelector('path[data-key="p:x"]') as Element;
    fireEvent.keyDown(arc, { key: 'Enter' });
    fireEvent.keyDown(arc, { key: ' ' });
    fireEvent.keyDown(arc, { key: 'a' });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith(['t3', 'p:x']);
  });

  it('keeps compact charts out of the tab order', () => {
    const { container, getByRole } = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={140} compact />
    );
    expect(container.querySelectorAll('[tabindex]')).toHaveLength(0);
    expect(getByRole('img')).not.toBeNull();
  });

  it('describes the whole node in the centre when zoomed below it: name, capacity, share used', () => {
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={['t3', 'p:x']} size={1200} />
    );
    const line = (k: string) => container.querySelector(`[data-centre-line="${k}"]`)?.textContent;
    expect(line('title')).toBe('root');
    expect(line('value')).toBe('16.00 cores');
    expect(line('node')).toBe('50% used');
    expect(line('parent')).toBeUndefined();
  });

  it('gives arc percentages of the focus when zoomed', () => {
    const { container } = render(<Sunburst tree={tree} resource="cpu" focus={['t3']} size={600} />);
    const labels = [...container.querySelectorAll('path[aria-label]')].map(p =>
      p.getAttribute('aria-label')
    );
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) {
      // The thin ring of t3 and the unused gap are shares of the node, every other arc of t3.
      expect(l).toMatch(/ of (root|t3)$/);
      if (!/^(t3|Unused):/.test(l as string)) expect(l).toContain('of t3');
      expect(l).not.toContain('of node');
    }
  });

  it('has no share of parent at the root', () => {
    const { container } = render(<Sunburst tree={tree} resource="cpu" focus={[]} size={800} />);
    expect(container.querySelector('[data-centre-line="parent"]')).toBeNull();
    expect(container.querySelector('[data-centre-line="node"]')?.textContent).toBe('50% of node');
  });

  it('says so in the centre when this chart has no data for the focus', () => {
    const onFocus = vi.fn();
    const { container } = render(
      <Sunburst
        tree={tree}
        resource="cpu"
        focus={['t3', 'only-in-memory']}
        size={1200}
        onFocus={onFocus}
        subject={{ label: 'Memory only' }}
      />
    );
    const line = (k: string) => container.querySelector(`[data-centre-line="${k}"]`)?.textContent;
    expect(line('title')).toBe('Memory only');
    expect(line('value')).toBe('no CPU data');
    expect(line('node')).toBeUndefined();
    const centre = container.querySelector('circle[data-centre]') as Element;
    fireEvent.pointerDown(centre);
    fireEvent.pointerUp(centre);
    expect(onFocus).toHaveBeenCalledWith(['t3']);
  });

  it('labels arcs inside them in a colour that contrasts with the fill', () => {
    const { container } = render(<Sunburst tree={tree} resource="cpu" focus={['t3']} size={800} />);
    const labels = container.querySelectorAll('text[data-arc-label]');
    expect(labels.length).toBeGreaterThan(0);
    labels.forEach(t => {
      expect(['#fff', 'rgba(0, 0, 0, 0.87)']).toContain(t.getAttribute('fill'));
      expect(Number(t.getAttribute('font-size'))).toBeGreaterThanOrEqual(14);
    });
  });

  it('fills empty space with a crosshatch pattern that has its own id per chart', () => {
    const { container } = render(
      <>
        <Sunburst tree={tree} resource="cpu" focus={[]} size={400} />
        <Sunburst tree={tree} resource="memory" focus={[]} size={400} />
      </>
    );
    const ids = Array.from(container.querySelectorAll('pattern[data-hatch]')).map(p => p.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const svg = container.querySelector('svg') as Element;
    const own = svg.querySelector('pattern[data-hatch]') as Element;
    expect(own.querySelectorAll('path')).toHaveLength(1);
    const gap = svg.querySelector('path[data-key="root/~unused"]') as Element;
    expect(gap.getAttribute('fill')).toBe(`url(#${own.id})`);
    expect(svg.querySelector('path[data-key="t3"]')?.getAttribute('fill')).not.toContain('url(');
  });

  it('in quiet mode a selected arc changes fill and has no outline or focus ring', () => {
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={400} quiet selected={['t3']} />
    );
    const arc = container.querySelector('path[data-key="t3"]') as Element;
    const plain = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={400} />
    ).container.querySelector('path[data-key="t3"]') as Element;
    expect(arc.getAttribute('fill')).not.toBe(plain.getAttribute('fill'));
    expect(arc.getAttribute('stroke-width')).toBe('1');
    expect(container.querySelector('style')?.textContent).not.toContain('focus-visible');
  });
});
