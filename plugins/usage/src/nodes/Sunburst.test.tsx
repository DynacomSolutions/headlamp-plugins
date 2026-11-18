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

// jsdom has no PointerEvent: MouseEvent carries the coordinates the component reads.
if (!window.PointerEvent) {
  (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = MouseEvent;
}

afterEach(cleanup);

describe('Sunburst', () => {
  it('draws one path per arc and a capacity outline', () => {
    const { container } = render(<Sunburst tree={tree} resource="cpu" focus={[]} size={400} />);
    expect(container.querySelectorAll('path[data-key]')).toHaveLength(5);
    expect(container.querySelector('circle[data-outline]')).not.toBeNull();
  });

  it('taps an arc to focus its key path', () => {
    const onFocus = vi.fn();
    const { container } = render(
      <Sunburst tree={tree} resource="cpu" focus={[]} size={400} onFocus={onFocus} />
    );
    const arc = container.querySelector('path[data-key="p:x"]') as Element;
    fireEvent.pointerDown(arc, { clientX: 5, clientY: 5 });
    fireEvent.pointerUp(arc, { clientX: 6, clientY: 5 });
    expect(onFocus).toHaveBeenCalledWith(['t3', 'p:x']);
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

  it('labels the image with the top children and their share of capacity', () => {
    const { getByRole } = render(<Sunburst tree={tree} resource="cpu" focus={[]} size={400} />);
    const label = getByRole('img').getAttribute('aria-label') as string;
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
});
