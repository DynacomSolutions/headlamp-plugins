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
import { inOrder, pairNodes, pairOrder } from '../sunburst/pairModel';
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

describe('pairNodes', () => {
  it('has one row per node, category and free space, with a value for each ring', () => {
    const nodes = pairNodes(cpu.data, mem.data);
    expect(nodes.map(n => n.key)).toEqual(['node:worker-1', 'node:worker-2']);
    expect(nodes[0].rows.map(r => r.key)).toEqual([
      'node:worker-1',
      'node:worker-1/k8s',
      'node:worker-1/system',
      'node:worker-1/~free',
    ]);
    expect(nodes[0].rows[0].values).toEqual([40, 80]);
    expect(nodes[0].rows[1].values).toEqual([30, 60]);
    // A category that only one ring has gets no value in the other ring.
    const cache = nodes[1].rows.find(r => r.key === 'node:worker-2/cache')!;
    expect(cache.values).toEqual([undefined, 5]);
    expect(nodes[1].rows.at(-1)!.values).toEqual([30, 60 - 5]);
  });
  it('keeps a node that only one ring has', () => {
    const only = { ...cpu.data, nodes: cpu.data.nodes.slice(0, 1) };
    const nodes = pairNodes(only, mem.data);
    expect(nodes).toHaveLength(2);
    expect(nodes[1].rows[0].values).toEqual([undefined, 25]);
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
      node('n:hq0', 'hq0', 50, 10),
      node('n:eu2', 'eu2', 30, 5),
      node('n:eu10', 'eu10', 2, 1),
    ],
  };
  const b = {
    capacity: 100,
    categories: [],
    nodes: [node('n:eu2', 'eu2', 40, 5), node('n:hq1', 'hq1', 60, 5), node('n:hq0', 'hq0', 8, 4)],
  };
  it('is one order by name for both rings and the legend, whatever the size or the chart', () => {
    const order = pairOrder(a, b);
    expect(order.map(o => o.label)).toEqual(['eu2', 'eu10', 'hq0', 'hq1']);
    expect(inOrder(a, order).nodes!.map(n => n.label)).toEqual(['eu2', 'eu10', 'hq0', 'hq1']);
    expect(inOrder(b, order).nodes!.map(n => n.label)).toEqual(['eu2', 'eu10', 'hq0', 'hq1']);
    expect(pairNodes(a, b).map(n => n.label)).toEqual(['eu2', 'eu10', 'hq0', 'hq1']);
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
    expect(legend).toContain('n:hq1');
  });
});

describe('UsagePair', () => {
  const render2 = (mode: 'light' | 'dark' = 'light', kiosk = false) =>
    render(wrap(<UsagePair first={cpu} second={mem} kiosk={kiosk} />, mode));

  it('draws two rings and one legend', () => {
    const { container } = render2();
    expect(container.querySelectorAll('svg[data-ring]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-usage-legend]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-legend-node]')).toHaveLength(2);
    expect(container.querySelectorAll('ul')).toHaveLength(1);
  });

  it('writes both values in equal columns on every row, with a head for each ring', () => {
    const { container } = render2();
    const head = container.querySelector('[data-legend-head]')!;
    expect(head.textContent).toContain('CPU');
    expect(head.textContent).toContain('Memory');
    const row = container.querySelector('[data-legend-row="node:worker-1/k8s"]')!;
    const values = Array.from(row.querySelectorAll('[data-legend-value]'));
    expect(values.map(v => v.textContent)).toEqual(['30 cores', '60 GiB']);
    // Every row has the same two value columns and the same grid as the head.
    const grids = new Set(
      Array.from(container.querySelectorAll('[data-legend-row], [data-legend-head]')).map(
        e => getComputedStyle(e).gridTemplateColumns
      )
    );
    expect(grids.size).toBe(1);
    const free = container.querySelector('[data-legend-row="node:worker-1/~free"]')!;
    expect(free.textContent).toContain('Free');
    expect(free.textContent).toContain('20 cores');
    expect(free.textContent).toContain('40 GiB');
  });

  it('uses the same colour for a category in both rings and in the legend', () => {
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
    const swatch = container.querySelector(
      '[data-legend-row="node:worker-1/system"] > span:first-child'
    ) as HTMLElement;
    expect(system('CPU')).toBeTruthy();
    expect(getComputedStyle(swatch).backgroundColor).not.toBe('');
    // The node arcs have the same tone in both rings.
    const tone = (ring: string, node: string) =>
      container
        .querySelector(`svg[data-ring="${ring}"] [data-arc="node"][data-node="${node}"]`)!
        .getAttribute('fill-opacity');
    expect(tone('CPU', 'node:worker-2')).toBe(tone('Memory', 'node:worker-2'));
    expect(tone('CPU', 'node:worker-1')).not.toBe(tone('CPU', 'node:worker-2'));
  });

  it('highlights the same group in both rings when a legend row is hovered', () => {
    const { container } = render2();
    const dimmed = (ring: string) =>
      Array.from(container.querySelectorAll(`svg[data-ring="${ring}"] [data-dim="true"]`));
    expect(dimmed('CPU')).toHaveLength(0);
    const row = container.querySelector('[data-legend-row="node:worker-1/system"]')!;
    fireEvent.mouseEnter(row);
    for (const ring of ['CPU', 'Memory']) {
      const lit = container.querySelectorAll(
        `svg[data-ring="${ring}"] [data-arc]:not([data-dim="true"])`
      );
      // The node arc and every arc of the System category on worker-1.
      expect(Array.from(lit).every(a => a.getAttribute('data-node') === 'node:worker-1')).toBe(
        true
      );
      expect(
        container.querySelector(`svg[data-ring="${ring}"] [data-sunburst-centre]`)!.textContent
      ).toContain('System');
    }
    expect(row.getAttribute('data-lit')).toBe('true');
    fireEvent.mouseLeave(row);
    expect(dimmed('CPU')).toHaveLength(0);
    expect(dimmed('Memory')).toHaveLength(0);
  });

  it('highlights the legend row and the other ring when an arc is hovered', () => {
    const { container } = render2();
    const arc = container.querySelector(
      'svg[data-ring="CPU"] [data-arc="category"][data-key="system"]'
    )!;
    fireEvent.mouseEnter(arc);
    expect(
      container.querySelector('[data-legend-row="node:worker-1/system"]')!.getAttribute('data-lit')
    ).toBe('true');
    expect(
      container.querySelectorAll('svg[data-ring="Memory"] [data-dim="true"]').length
    ).toBeGreaterThan(0);
  });

  it('keeps a row lit in the other ring when only one ring has the group', () => {
    const { container } = render2();
    fireEvent.mouseEnter(container.querySelector('[data-legend-row="node:worker-2/cache"]')!);
    // The CPU ring has no such group: it dims, and it shows no wrong value.
    expect(
      container.querySelectorAll('svg[data-ring="CPU"] [data-arc]:not([data-dim="true"])')
    ).toHaveLength(0);
  });

  it('selects with a tap in the kiosk, where hover is off', () => {
    const { container } = render2('dark', true);
    const row = container.querySelector('[data-legend-row="node:worker-1/system"]')!;
    fireEvent.mouseEnter(row);
    expect(row.getAttribute('data-lit')).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute('data-lit')).toBe('true');
    fireEvent.click(row);
    expect(row.getAttribute('data-lit')).toBeNull();
  });

  it('has no Other group and no "more" line, and scrolls a long legend inside itself', () => {
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
    expect(container.querySelectorAll('[data-legend-row]')).toHaveLength(14 * 4);
    expect(container.textContent).not.toMatch(/other/i);
    expect(container.textContent).not.toMatch(/\bmore\b/i);
    const list = container.querySelector('ul') as HTMLElement;
    expect(getComputedStyle(list).overflowY).toBe('auto');
    // The head is outside the scroll list, so it stays in place.
    expect(list.contains(container.querySelector('[data-legend-head]'))).toBe(false);
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
    const row = container.querySelector('[data-legend-row="node:a"]')!;
    expect(row.textContent).toContain('50.0 cores'.replace('.0', '.00'));
    expect(row.textContent).toContain('50.0 GiB');
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
