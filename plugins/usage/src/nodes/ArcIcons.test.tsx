import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeTree, SunNode } from './tree';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn() } }));
vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));
const iconUrl = vi.hoisted(() => ({ value: 'blob:x' as string | null }));
vi.mock('./useIconUrl', () => ({ useIconUrl: () => iconUrl.value }));

import { Sunburst } from './Sunburst';

const n = (
  key: string,
  value: number,
  kind: SunNode['kind'],
  icon?: SunNode['icon'],
  children: SunNode[] = []
): SunNode => ({ key, label: key, value, kind, children, icon });

const tree: NodeTree = {
  root: n('root', 10, 'node', undefined, [
    n('big', 6, 'process', { kind: 'simple-icons', name: 'git' }),
    n('proj', 3, 'project', { kind: 'file', src: '/icon/1' }),
    // About 1% of the circle: far too small for an icon.
    n('tiny', 0.1, 'process', { kind: 'mdi', name: 'cog-outline' }),
  ]),
  capacity: 10,
  used: 10,
  hostMetrics: true,
};

afterEach(cleanup);

describe('arc icons', () => {
  it('draws an icon in every arc it fits, on a light badge for brand icons', () => {
    iconUrl.value = 'blob:x';
    const { container } = render(<Sunburst tree={tree} resource="cpu" focus={[]} size={900} />);
    expect(container.querySelector('[data-icon="simple-icons:git"]')).not.toBeNull();
    expect(container.querySelector('circle[data-icon-badge]')).not.toBeNull();
    expect(container.querySelector('[data-icon="mdi:cog-outline"]')).toBeNull();
  });

  it('sizes the icon between 16 and 40 px', () => {
    const { container } = render(<Sunburst tree={tree} resource="cpu" focus={[]} size={900} />);
    container.querySelectorAll('foreignObject').forEach(f => {
      const w = Number(f.getAttribute('width'));
      expect(w).toBeGreaterThanOrEqual(16 * 0.68 - 1);
      expect(w).toBeLessThanOrEqual(40);
    });
  });

  it('renders a loaded project icon as an SVG image', () => {
    iconUrl.value = 'blob:x';
    const { container } = render(<Sunburst tree={tree} resource="cpu" focus={[]} size={900} />);
    const img = container.querySelector('image') as SVGElement;
    expect(img.getAttribute('href')).toBe('blob:x');
    expect(img.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
  });

  it('shows the folder while a project icon loads and after it failed', () => {
    for (const state of [null, 'failed']) {
      iconUrl.value = state;
      const { container, unmount } = render(
        <Sunburst tree={tree} resource="cpu" focus={[]} size={900} />
      );
      expect(container.querySelector('image')).toBeNull();
      expect(container.querySelector('[data-icon="mdi:folder"]')).not.toBeNull();
      unmount();
    }
  });

  it('keeps the icon and drops the name when there is not room for both', () => {
    iconUrl.value = 'blob:x';
    // A small chart: the arcs are big enough for an icon but not for icon plus text.
    const { container } = render(<Sunburst tree={tree} resource="cpu" focus={[]} size={260} rings={3} />);
    const lone = container.querySelectorAll('[data-arc-icon]');
    expect(lone.length).toBeGreaterThan(0);
    lone.forEach(g => expect(g.parentElement?.querySelector('text[data-arc-label]')).toBeNull());
  });

  it('never clips the name of an arc that has an icon', () => {
    iconUrl.value = 'blob:x';
    const long: NodeTree = {
      ...tree,
      root: n('root', 10, 'node', undefined, [
        n('a', 3, 'category', { kind: 'mdi', name: 'kubernetes' }),
        n('b', 3, 'category', { kind: 'mdi', name: 'cog' }),
        n('c', 2, 'category', { kind: 'mdi', name: 'robot' }),
      ].map((x, i) => ({ ...x, label: ['Kubernetes control plane', 'System services', 'Scopes with no role'][i] }))),
    };
    for (const size of [260, 420, 600]) {
      const { container, unmount } = render(<Sunburst tree={long} resource="cpu" focus={[]} size={size} />);
      container.querySelectorAll('text[data-arc-label]').forEach(t => {
        expect(t.textContent).not.toContain('\u2026');
      });
      unmount();
    }
  });
});
