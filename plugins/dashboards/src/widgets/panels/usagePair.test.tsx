/*
 * The usage pair: two node-first sunbursts with one shared legend, and the widget that feeds it
 * (with the last-good cache of the panel widgets).
 */
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request, clusterRequest } = vi.hoisted(() => ({
  request: vi.fn(),
  clusterRequest: vi.fn(),
}));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request, clusterRequest },
  K8s: { useClustersConf: () => ({ main: {} }), useCluster: () => null },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
    get() {
      return undefined;
    }
  },
}));

import { lastGoodStore, resetLastGoodStore, widgetCache } from '../../cache/lastGood';
import { getRegistry } from '../../registry';
import { registerBuiltinWidgets } from '../builtin';
import {
  FREE_SEGMENT,
  inOrder,
  pairLayout,
  pairLegend,
  pairOrder,
  shortUsage,
} from '../sunburst/pairModel';
import { UsagePair } from '../sunburst/UsagePair';
import { clearPanelListCache } from './data';
import { usagePairWidget } from './UsagePairWidget';

const wrap = (ui: React.ReactNode, mode: 'light' | 'dark' = 'light') => (
  <MemoryRouter>
    <ThemeProvider theme={createTheme({ palette: { mode } })}>{ui}</ThemeProvider>
  </MemoryRouter>
);

const cat = (key: string, label: string, value: number, kids: number[] = []) => ({
  key,
  label,
  value,
  children: kids.map((v, i) => ({ key: `${key}/${i}`, label: `${label} ${i + 1}`, value: v })),
});
const ringData = (scale: number) => ({
  capacity: 100 * scale,
  categories: [cat('k8s', 'Kubernetes', 40 * scale)],
  nodes: [
    {
      key: 'node:worker-1',
      label: 'worker-1',
      capacity: 60 * scale,
      used: 40 * scale,
      categories: [
        cat('k8s', 'Kubernetes', 30 * scale, [20 * scale, 10 * scale]),
        cat('system', 'System', 10 * scale),
      ],
    },
    {
      key: 'node:worker-2',
      label: 'worker-2',
      capacity: 40 * scale,
      used: 10 * scale,
      categories: [cat('k8s', 'Kubernetes', 10 * scale)],
    },
  ],
});
const cpu = { data: ringData(1), format: (v: number) => `${v} cores`, title: 'CPU' };
// The memory ring has a category that the CPU ring has not.
const memData = ringData(2);
memData.nodes[1].categories.push(cat('cache', 'Cache', 5));
memData.nodes[1].used += 5;
const mem = { data: memData, format: (v: number) => `${v} GiB`, title: 'Memory' };

describe('pairLegend', () => {
  it('has one line per node, with one bar for each ring, split by category, then free', () => {
    const legend = pairLegend(cpu.data, mem.data);
    expect(legend.nodes.map(n => n.key)).toEqual(['node:worker-1', 'node:worker-2']);
    const [c, m] = legend.nodes[0].bars;
    expect(c!.segments.map(s => s.key)).toEqual(['k8s', 'system', FREE_SEGMENT]);
    expect(c!.segments.map(s => s.value)).toEqual([30, 10, 20]);
    expect(m!.segments.map(s => s.value)).toEqual([60, 20, 40]);
    expect(c).toMatchObject({ used: 40, total: 60 });
    expect(m).toMatchObject({ used: 80, total: 120 });
    // A bar splits the whole node: the segments add up to its total.
    for (const bar of [c!, m!])
      expect(bar.segments.reduce((t, s) => t + s.value, 0)).toBe(bar.total);
  });
  it('has the colour key once: every category of either ring, by name, and the free chip', () => {
    const legend = pairLegend(cpu.data, mem.data);
    // The cache category sits only in the memory ring and is still in the key.
    expect(legend.categories.map(c => c.key)).toEqual(['cache', 'k8s', 'system']);
    expect(legend.hasFree).toBe(true);
    const full = {
      ...cpu.data,
      nodes: [
        {
          key: 'n',
          label: 'n',
          capacity: 10,
          used: 10,
          categories: [cat('k8s', 'Kubernetes', 10)],
        },
      ],
    };
    expect(pairLegend(full, full).hasFree).toBe(false);
  });
  it('keeps the same category at the same place on every line', () => {
    const legend = pairLegend(cpu.data, mem.data);
    const keys = (i: number) => legend.nodes[i].bars[1]!.segments.map(s => s.key);
    expect(keys(0)).toEqual(['k8s', 'system', FREE_SEGMENT]);
    expect(keys(1)).toEqual(['cache', 'k8s', FREE_SEGMENT]);
  });
  it('keeps a node that only one ring has, with no bar in the other ring', () => {
    const only = { ...cpu.data, nodes: cpu.data.nodes.slice(0, 1) };
    const legend = pairLegend(only, mem.data);
    expect(legend.nodes).toHaveLength(2);
    expect(legend.nodes[1].bars[0]).toBeUndefined();
    expect(legend.nodes[1].bars[1]).toMatchObject({ used: 25, total: 40 * 2 });
  });
});

describe('shortUsage', () => {
  const cores = (v: number) => `${v.toFixed(2)} cores`;
  it('writes the unit once', () => {
    expect(shortUsage(61, 64, cores)).toBe('61.00 / 64.00 cores');
  });
  it('keeps both units when they differ', () => {
    const mixed = (v: number) => (v < 1 ? `${v * 1024} MiB` : `${v} GiB`);
    expect(shortUsage(0.5, 4, mixed)).toBe('512 MiB / 4 GiB');
  });
  it('copes with a value that has no unit', () => {
    expect(shortUsage(3, 9, v => `${v}`)).toBe('3 / 9');
  });
});

describe('pairLayout', () => {
  it('does not size a box that has no size yet', () => {
    expect(pairLayout(0, 0, 5)).toEqual({ mode: 'right', ring: 0 });
  });
  it('stacks the rings in a narrow tall box, each nearly as wide as the box', () => {
    // A widget of 3 of 12 columns on a 1080 px screen, 7 nodes.
    const l = pairLayout(415, 940, 7);
    expect(l.mode).toBe('below-stack');
    // The circle fills 96 % of the ring square, so the diameter is about 90 % of the width.
    expect(l.ring * 0.96).toBeGreaterThanOrEqual(415 * 0.88);
    expect(l.ring).toBeLessThanOrEqual(415);
    // Two rings and the least legend fit in the height.
    expect(2 * l.ring + 120).toBeLessThanOrEqual(940);
  });
  it('never puts the rings side by side in a narrow box, whatever the height', () => {
    for (const h of [200, 400, 600, 930, 2000]) {
      expect(pairLayout(415, h, 7).mode).toBe('below-stack');
      expect(pairLayout(300, h, 20).mode).toBe('below-stack');
    }
  });
  it('shrinks the rings only when the box is too short for the least legend', () => {
    expect(pairLayout(415, 500, 7).ring).toBeLessThan(415 * 0.94);
    expect(pairLayout(415, 500, 7).ring).toBe(Math.floor((500 - 120 - 16) / 2));
  });
  it('puts the legend on the right in a wide box that is not tall', () => {
    const l = pairLayout(1000, 400, 7);
    expect(l.mode).toBe('right');
    expect(l.ring).toBe(Math.floor((1000 - 300 - 8) / 2));
  });
  it('takes the layout with the biggest ring in a wide box', () => {
    const l = pairLayout(600, 1000, 5);
    expect(l.mode).not.toBe('right');
    expect(l.ring).toBeGreaterThan(Math.floor((600 - 300 - 8) / 2));
  });
});

describe('node order of a pair', () => {
  const node = (key: string, label: string, capacity: number, used: number) => ({
    key,
    label,
    capacity,
    used,
    categories: used > 0 ? [cat('k8s', 'Kubernetes', used)] : [],
  });
  const a = {
    capacity: 100,
    categories: [],
    nodes: [
      node('n:worker-3', 'worker-3', 50, 10),
      node('n:worker-2', 'worker-2', 30, 5),
      node('n:worker-10', 'worker-10', 2, 1),
    ],
  };
  const b = {
    capacity: 100,
    categories: [],
    nodes: [
      node('n:worker-2', 'worker-2', 40, 5),
      node('n:worker-4', 'worker-4', 60, 5),
      node('n:worker-3', 'worker-3', 8, 4),
    ],
  };
  it('is one order by name for both rings and the legend, whatever the size or the chart', () => {
    const order = pairOrder(a, b);
    expect(order.map(o => o.label)).toEqual(['worker-2', 'worker-3', 'worker-4', 'worker-10']);
    expect(inOrder(a, order).nodes!.map(n => n.label)).toEqual([
      'worker-2',
      'worker-3',
      'worker-4',
      'worker-10',
    ]);
    expect(inOrder(b, order).nodes!.map(n => n.label)).toEqual([
      'worker-2',
      'worker-3',
      'worker-4',
      'worker-10',
    ]);
    expect(pairLegend(a, b).nodes.map(n => n.label)).toEqual([
      'worker-2',
      'worker-3',
      'worker-4',
      'worker-10',
    ]);
  });
  it('draws the same node at the same angle start order in both rings, with an arc for every legend node', () => {
    const { container } = render(
      wrap(
        <UsagePair
          first={{ data: a, format: v => `${v}`, title: 'CPU' }}
          second={{ data: b, format: v => `${v}`, title: 'Memory' }}
        />
      )
    );
    const keys = (ring: string) =>
      Array.from(container.querySelectorAll(`svg[data-ring="${ring}"] [data-arc="node"]`)).map(p =>
        p.getAttribute('data-node')
      );
    const legend = Array.from(container.querySelectorAll('[data-legend-node]')).map(n =>
      n.getAttribute('data-legend-node')
    );
    expect(keys('CPU')).toEqual(legend);
    expect(keys('Memory')).toEqual(legend);
    // The node that only one ring has still has an arc in the other ring.
    expect(legend).toContain('n:worker-4');
  });
});

describe('UsagePair', () => {
  const render2 = (mode: 'light' | 'dark' = 'light', kiosk = false) =>
    render(wrap(<UsagePair first={cpu} second={mem} kiosk={kiosk} />, mode));

  it('draws two rings and one legend with one line per node', () => {
    const { container } = render2();
    expect(container.querySelectorAll('svg[data-ring]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-usage-legend]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-legend-node]')).toHaveLength(2);
    // No per-category rows: a node line holds a name, and a value with a bar for each ring.
    expect(container.querySelectorAll('[data-legend-row]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-legend-bar]')).toHaveLength(4);
    expect(container.querySelectorAll('ul')).toHaveLength(1);
  });

  it('shows the colour key once, at the top, with the same colours as the rings', () => {
    const { container } = render2();
    const key = container.querySelector('[data-legend-key]')!;
    expect(
      Array.from(key.querySelectorAll('[data-legend-chip]')).map(c =>
        c.getAttribute('data-legend-chip')
      )
    ).toEqual(['cache', 'k8s', 'system', FREE_SEGMENT]);
    // The key comes before the node lines and outside the scroll list.
    const list = container.querySelector('ul')!;
    expect(list.contains(key)).toBe(false);
    expect(key.textContent).toContain('Kubernetes');
    expect(key.textContent).toContain('Free');
    const chipColour = (k: string) =>
      getComputedStyle(key.querySelector(`[data-legend-chip="${k}"] > span`) as HTMLElement)
        .backgroundColor;
    const segColour = (k: string) =>
      getComputedStyle(container.querySelector(`[data-legend-seg="${k}"]`) as HTMLElement)
        .backgroundColor;
    for (const k of ['k8s', 'system']) {
      expect(chipColour(k)).not.toBe('');
      expect(segColour(k)).toBe(chipColour(k));
    }
    const arc = container
      .querySelector('svg[data-ring="CPU"] [data-arc="category"][data-key="k8s"]')!
      .getAttribute('fill');
    expect(arc).toBeTruthy();
  });

  it('writes the used and total value of each ring in short form on the node line', () => {
    const { container } = render2();
    const line = container.querySelector('[data-legend-node="node:worker-1"]')!;
    expect(line.textContent).toContain('worker-1');
    const values = Array.from(line.querySelectorAll('[data-legend-value]')).map(v => v.textContent);
    expect(values).toEqual(['40 / 60 cores', '80 / 120 GiB']);
    const head = container.querySelector('[data-legend-head]')!;
    expect(head.textContent).toContain('CPU');
    expect(head.textContent).toContain('Memory');
    // The head and every line use the same grid, so the columns line up.
    const grids = new Set(
      Array.from(container.querySelectorAll('[data-legend-node], [data-legend-head]')).map(
        e => getComputedStyle(e).gridTemplateColumns
      )
    );
    expect(grids.size).toBe(1);
  });

  it('splits each bar by category, in order, with the free part last, sized by value', () => {
    const { container } = render2();
    const bar = container.querySelector(
      '[data-legend-node="node:worker-1"] [data-legend-bar="CPU"]'
    )!;
    const segs = Array.from(bar.querySelectorAll('[data-legend-seg]'));
    expect(segs.map(x => x.getAttribute('data-legend-seg'))).toEqual([
      'k8s',
      'system',
      FREE_SEGMENT,
    ]);
    expect(segs.map(x => getComputedStyle(x).flexGrow)).toEqual(['30', '10', '20']);
    expect(bar.getAttribute('aria-label')).toContain('Kubernetes 30 cores');
  });

  it('shows a tooltip with the category and the value when a segment is hovered', async () => {
    const { container, findByRole } = render2();
    const seg = container.querySelector(
      '[data-legend-node="node:worker-1"] [data-legend-bar="Memory"] [data-legend-seg="system"]'
    )!;
    fireEvent.mouseOver(seg);
    const tip = await findByRole('tooltip');
    expect(tip.textContent).toBe('worker-1 / System: 20 GiB');
  });

  it('shows no tooltip in the kiosk, where a tap selects', () => {
    const { container, queryByRole } = render2('dark', true);
    const seg = container.querySelector('[data-legend-seg="system"]')!;
    fireEvent.mouseOver(seg);
    expect(queryByRole('tooltip')).toBeNull();
  });

  it('uses the same colour for a category in both rings', () => {
    const { container } = render2();
    const fills = (ring: string) =>
      Array.from(
        container.querySelectorAll(`svg[data-ring="${ring}"] [data-arc="category"][data-key="k8s"]`)
      ).map(p => p.getAttribute('fill'));
    expect(fills('CPU')).toEqual(fills('Memory'));
    // The cache category sits only in memory, so it must not move the colour of the others.
    const system = (ring: string) =>
      container
        .querySelector(`svg[data-ring="${ring}"] [data-arc="category"][data-key="system"]`)!
        .getAttribute('fill');
    expect(system('CPU')).toBe(system('Memory'));
    // The node arcs have the same tone in both rings.
    const tone = (ring: string, node: string) =>
      container
        .querySelector(`svg[data-ring="${ring}"] [data-arc="node"][data-node="${node}"]`)!
        .getAttribute('fill-opacity');
    expect(tone('CPU', 'node:worker-2')).toBe(tone('Memory', 'node:worker-2'));
    expect(tone('CPU', 'node:worker-1')).not.toBe(tone('CPU', 'node:worker-2'));
  });

  it('highlights the same group in both rings when a bar segment is hovered', () => {
    const { container } = render2();
    const dimmed = (ring: string) =>
      Array.from(container.querySelectorAll(`svg[data-ring="${ring}"] [data-dim="true"]`));
    expect(dimmed('CPU')).toHaveLength(0);
    const seg = container.querySelector(
      '[data-legend-node="node:worker-1"] [data-legend-seg="system"]'
    )!;
    fireEvent.mouseEnter(seg);
    for (const ring of ['CPU', 'Memory']) {
      const lit = container.querySelectorAll(
        `svg[data-ring="${ring}"] [data-arc]:not([data-dim="true"])`
      );
      expect(Array.from(lit).every(a => a.getAttribute('data-node') === 'node:worker-1')).toBe(
        true
      );
      expect(
        container.querySelector(`svg[data-ring="${ring}"] [data-sunburst-centre]`)!.textContent
      ).toContain('System');
    }
    expect(seg.getAttribute('data-lit')).toBe('true');
    fireEvent.mouseLeave(seg);
    expect(dimmed('CPU')).toHaveLength(0);
    expect(dimmed('Memory')).toHaveLength(0);
  });

  it('highlights the node line and the segments when a node name is hovered', () => {
    const { container } = render2();
    const row = container.querySelector('[data-legend-row="node:worker-2"]')!;
    fireEvent.mouseEnter(row);
    expect(row.getAttribute('data-lit')).toBe('true');
    // The segments of the other node dim, those of this node stay lit.
    const dim = (node: string) =>
      getComputedStyle(
        container.querySelector(
          `[data-legend-node="${node}"] [data-legend-seg="k8s"]`
        ) as HTMLElement
      ).opacity;
    expect(dim('node:worker-2')).toBe('1');
    expect(dim('node:worker-1')).toBe('0.4');
  });

  it('highlights the segment and the other ring when an arc is hovered', () => {
    const { container } = render2();
    const arc = container.querySelector(
      'svg[data-ring="CPU"] [data-arc="category"][data-key="system"]'
    )!;
    fireEvent.mouseEnter(arc);
    expect(
      container
        .querySelector('[data-legend-node="node:worker-1"] [data-legend-seg="system"]')!
        .getAttribute('data-lit')
    ).toBe('true');
    expect(
      container.querySelectorAll('svg[data-ring="Memory"] [data-dim="true"]').length
    ).toBeGreaterThan(0);
  });

  it('selects with a tap in the kiosk, where hover is off', () => {
    const { container } = render2('dark', true);
    const row = container.querySelector('[data-legend-row="node:worker-1"]')!;
    fireEvent.mouseEnter(row);
    expect(row.getAttribute('data-lit')).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute('data-lit')).toBe('true');
    fireEvent.click(row);
    expect(row.getAttribute('data-lit')).toBeNull();
  });

  it('keeps every node, has no Other group and no "more" line, and scrolls inside itself', () => {
    const many = (scale: number) => ({
      capacity: 1200 * scale,
      categories: [cat('k8s', 'Kubernetes', 600 * scale)],
      nodes: Array.from({ length: 14 }, (_, i) => ({
        key: `node:n${i}`,
        label: `n${i}`,
        capacity: 100 * scale,
        used: 50 * scale,
        categories: [
          cat('k8s', 'Kubernetes', 30 * scale, [10, 10, 10]),
          cat('system', 'System', 20 * scale),
        ],
      })),
    });
    const { container } = render(
      wrap(<UsagePair first={{ ...cpu, data: many(1) }} second={{ ...mem, data: many(2) }} />)
    );
    expect(container.querySelectorAll('[data-legend-node]')).toHaveLength(14);
    expect(container.querySelectorAll('[data-legend-row]')).toHaveLength(14);
    expect(container.textContent).not.toMatch(/other/i);
    expect(container.textContent).not.toMatch(/\bmore\b/i);
    const list = container.querySelector('ul') as HTMLElement;
    expect(getComputedStyle(list).overflowY).toBe('auto');
    // The key and the head are outside the scroll list, so they stay in place.
    expect(list.contains(container.querySelector('[data-legend-head]'))).toBe(false);
    expect(list.contains(container.querySelector('[data-legend-key]'))).toBe(false);
    for (const ring of container.querySelectorAll('svg[data-ring]'))
      expect(ring.getAttribute('aria-label')).not.toMatch(/\bmore\b/i);
  });

  it('falls back to two category charts when the data has no nodes', () => {
    const plain = (d: ReturnType<typeof ringData>) => ({ ...d, nodes: undefined });
    const { container } = render(
      wrap(
        <UsagePair
          first={{ ...cpu, data: plain(cpu.data) }}
          second={{ ...mem, data: plain(mem.data) }}
        />
      )
    );
    expect(container.querySelectorAll('[data-sunburst]')).toHaveLength(2);
    expect(container.querySelector('[data-usage-legend]')).toBeNull();
  });

  describe('layout from the own size of the widget', () => {
    const original = globalThis.ResizeObserver;
    const sized = (width: number, height: number) => {
      globalThis.ResizeObserver = class {
        constructor(private cb: ResizeObserverCallback) {}
        observe() {
          this.cb(
            [{ contentRect: { width, height } } as unknown as ResizeObserverEntry],
            this as unknown as ResizeObserver
          );
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    };
    afterEach(() => {
      globalThis.ResizeObserver = original;
    });

    it('stacks CPU above memory, large and centred, in a narrow tall widget', () => {
      sized(415, 940);
      const { container } = render2('dark', true);
      const root = container.querySelector('[data-usage-pair]') as HTMLElement;
      expect(root.getAttribute('data-layout')).toBe('below-stack');
      const rings = Array.from(container.querySelectorAll('svg[data-ring]')) as SVGElement[];
      expect(rings.map(r => r.getAttribute('data-ring'))).toEqual(['CPU', 'Memory']);
      for (const r of rings) {
        // Nearly the full width: a circle of about 90 % of the width.
        expect(parseInt(r.style.width, 10)).toBeGreaterThanOrEqual(415 * 0.9);
        expect(r.style.width).toBe(r.style.height);
      }
      // One ring above the other, centred in the widget.
      const holder = rings[0].parentElement as HTMLElement;
      expect(getComputedStyle(holder).flexDirection).toBe('column');
      expect(getComputedStyle(root).alignItems).toBe('center');
      expect(getComputedStyle(root).flexDirection).toBe('column');
    });

    it('puts the rings side by side with the legend on the right in a wide widget', () => {
      sized(1000, 400);
      const { container } = render2();
      const root = container.querySelector('[data-usage-pair]') as HTMLElement;
      expect(root.getAttribute('data-layout')).toBe('right');
      expect(getComputedStyle(root).flexDirection).toBe('row');
      const holder = container.querySelector('svg[data-ring]')!.parentElement as HTMLElement;
      expect(getComputedStyle(holder).flexDirection).toBe('row');
      // The wide layout has the same compact legend.
      expect(container.querySelectorAll('[data-legend-bar]')).toHaveLength(4);
    });
  });
});

describe('agent usage pair widget', () => {
  const RING = (id: string, label: string, unit: string, scale: number) => ({
    id,
    label,
    unit,
    capacity: 100 * scale,
    used: 50 * scale,
    segments: [{ key: 'k8s', label: 'Kubernetes', value: 50 * scale }],
    nodes: [
      {
        key: 'node:a',
        label: 'node-a',
        capacity: 100 * scale,
        used: 50 * scale,
        segments: [{ key: 'k8s', label: 'Kubernetes', value: 50 * scale }],
      },
    ],
  });
  const RAW = (extra = '') => ({
    version: 1,
    id: 'usage-dashboard',
    title: 'Usage',
    summary: extra,
    rings: [RING('cpu', 'CPU', 'cores', 1), RING('memory', 'Memory', 'bytes', 1024 ** 3)],
  });
  const LIST = {
    version: 1,
    panels: [
      {
        id: 'usage-dashboard',
        title: 'Usage',
        description: '',
        plugin: 'usage',
        link: '/usage',
        refreshSeconds: 30,
      },
    ],
  };
  const Component = usagePairWidget.Component;
  const props = (cache?: ReturnType<typeof widgetCache>) => ({
    instanceId: 'w-1',
    config: { ...usagePairWidget.defaultConfig },
    filters: { namespaces: [], nodes: [], labelSelector: '', range: '1h' as const },
    refreshSignal: 0,
    reportRefreshed: vi.fn(),
    editing: false,
    kiosk: true,
    cache,
  });
  let resolvePanel: (v: unknown) => void;

  beforeEach(() => {
    localStorage.clear();
    resetLastGoodStore();
    clearPanelListCache();
    registerBuiltinWidgets(getRegistry());
    request.mockReset();
    request.mockImplementation((url: string) => {
      if (url.includes('/api/widgets/usage-dashboard')) return new Promise(r => (resolvePanel = r));
      if (url.endsWith('/api/widgets')) return Promise.resolve(LIST);
      return Promise.reject(new Error(`unexpected ${url}`));
    });
  });
  afterEach(cleanup);
  const flush = () =>
    act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

  it('is registered under its own type, size and default rings', () => {
    expect(getRegistry().get('agent.usage-pair')).toBeTruthy();
    expect(usagePairWidget.defaultSize).toEqual({ w: 6, h: 8 });
    expect(usagePairWidget.defaultConfig).toMatchObject({ first: 'cpu', second: 'memory' });
  });

  it('draws both rings and one legend from a panel', async () => {
    const { container } = render(wrap(<Component {...props()} />));
    await flush();
    await act(async () => {
      resolvePanel(RAW());
    });
    await flush();
    expect(container.querySelectorAll('svg[data-ring]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-usage-legend]')).toHaveLength(1);
    const line = container.querySelector('[data-legend-node="node:a"]')!;
    expect(line.textContent).toContain('50.00 / 100 cores');
    expect(line.textContent).toContain('50.0 / 100 GiB');
  });

  it('shows the cached panel at once, then the fresh answer, and writes it back', async () => {
    const cache = widgetCache(lastGoodStore(), 'dash-ns/ops', 'w-1');
    const url =
      '/api/v1/namespaces/headlamp-agent/services/headlamp-agent:80/proxy/api/widgets/usage-dashboard';
    cache.write({ url, raw: RAW('cached') }, Date.now() - 60_000);
    const { container } = render(wrap(<Component {...props(cache)} />));
    // No spinner: the rings are there on the first render, before any answer.
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelectorAll('svg[data-ring]')).toHaveLength(2);
    await flush();
    await act(async () => {
      resolvePanel(RAW('fresh'));
    });
    await flush();
    const kept = cache.read<{ raw: { summary: string } }>();
    expect(kept?.value.raw.summary).toBe('fresh');
  });

  it('keeps the rings and a legend when a panel has fewer than two rings', async () => {
    const { container } = render(wrap(<Component {...props()} />));
    await flush();
    await act(async () => {
      resolvePanel({ ...RAW(), rings: [RING('cpu', 'CPU', 'cores', 1)] });
    });
    await flush();
    expect(container.textContent).toContain('needs two rings');
  });
});
