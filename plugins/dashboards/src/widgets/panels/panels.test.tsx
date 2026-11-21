import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request, clusterRequest, settings, route } = vi.hoisted(() => ({
  request: vi.fn(),
  clusterRequest: vi.fn(),
  settings: { value: undefined as Record<string, unknown> | undefined },
  route: { cluster: null as string | null },
}));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request, clusterRequest },
  K8s: { useClustersConf: () => ({ main: {}, other: {} }), useCluster: () => route.cluster },
  ConfigStore: class {
    useConfig() {
      return () => settings.value;
    }
    get() {
      return settings.value;
    }
  },
}));

import { SunburstChart } from '../sunburst/SunburstChart';
import { clearPanelListCache } from './data';
import { parsePanel } from './model';
import { PanelTables } from './PanelTables';
import { PanelView } from './PanelView';
import { panelWidget } from './PanelWidget';
import { sparklinePoints } from './Sparkline';

const wrap = (ui: React.ReactNode, mode: 'light' | 'dark' = 'light') => (
  <MemoryRouter>
    <ThemeProvider theme={createTheme({ palette: { mode } })}>{ui}</ThemeProvider>
  </MemoryRouter>
);

const PANEL = {
  version: 1,
  id: 'usage-dashboard',
  title: 'Usage',
  status: 'warn',
  summary: 'Busy',
  stats: [{ label: 'Nodes', value: '3', status: 'ok' }],
  rows: [
    {
      label: 'node-a',
      detail: 'hot',
      value: '90%',
      fraction: 0.9,
      status: 'crit',
      link: '/c/main/nodes/node-a',
    },
    { label: 'node-b', detail: '', value: '10%', fraction: 0.1, status: 'ok' },
  ],
  series: [{ label: 'CPU', points: [1, 3, 2] }],
  rings: [
    {
      id: 'cpu',
      label: 'CPU',
      unit: 'cores',
      capacity: 8,
      used: 4,
      segments: [
        {
          key: 'k8s',
          label: 'Kubernetes',
          value: 3,
          children: [{ key: 'k8s/ns:shop', label: 'shop', value: 2 }],
        },
        { key: 'sys', label: 'System', value: 1 },
      ],
    },
  ],
};

beforeEach(() => {
  settings.value = undefined;
  request.mockReset();
  clearPanelListCache();
});
afterEach(cleanup);

describe('PanelView', () => {
  it('draws status, tiles, rows with bars and links, sparklines and a sunburst', () => {
    const { container } = render(
      wrap(<PanelView panel={parsePanel(PANEL)} kiosk={false} editing={false} />)
    );
    expect(container.querySelector('[data-panel-summary]')?.textContent).toBe('Busy');
    expect(container.querySelectorAll('[data-stat]')).toHaveLength(1);
    // The critical row is a band and comes first. The healthy row is listed too, with no fold line.
    expect(container.querySelectorAll('[data-row]')).toHaveLength(2);
    expect(container.querySelector('[data-rows-fold]')).toBeNull();
    expect(container.querySelectorAll('[data-fraction]')).toHaveLength(2);
    expect(container.querySelector('a[href="/c/main/nodes/node-a"]')?.textContent).toBe('node-a');
    expect(container.querySelectorAll('[data-sparkline]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-arc="category"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-arc="child"]')).toHaveLength(1);
  });
  it('turns links off while editing', () => {
    const { container } = render(
      wrap(<PanelView panel={parsePanel(PANEL)} kiosk={false} editing />)
    );
    expect(container.querySelector('a')).toBeNull();
  });
  it('shows the status as a shape with a word, not colour alone', () => {
    const { container } = render(
      wrap(<PanelView panel={parsePanel(PANEL)} kiosk={false} editing={false} />)
    );
    const labels = Array.from(container.querySelectorAll('svg[data-status]')).map(s =>
      s.getAttribute('aria-label')
    );
    expect(labels).toContain('Warning');
    expect(labels).toContain('Critical');
    expect(labels).toContain('OK');
  });
  it('shows an empty state', () => {
    const { container } = render(
      wrap(<PanelView panel={parsePanel({ version: 1, id: 'x' })} kiosk={false} editing={false} />)
    );
    expect(container.querySelector('[data-panel-empty]')).not.toBeNull();
  });
});

describe('SunburstChart', () => {
  const data = {
    capacity: 10,
    categories: [
      { key: 'a', label: 'Alpha', value: 6, children: [{ key: 'a1', label: 'Child', value: 4 }] },
      { key: 'b', label: 'Beta', value: 2 },
    ],
  };
  const fmt = (v: number) => `${v} u`;
  it('shows the label and value of an arc on hover and clears them again', () => {
    const { container } = render(wrap(<SunburstChart data={data} title="CPU" format={fmt} />));
    const centre = () => container.querySelector('[data-sunburst-centre]')!.textContent;
    expect(centre()).toContain('CPU');
    fireEvent.mouseEnter(container.querySelector('[data-arc="child"]')!);
    expect(centre()).toContain('Child');
    expect(centre()).toContain('4 u');
    fireEvent.mouseLeave(container.querySelector('[data-arc="child"]')!);
    expect(centre()).toContain('CPU');
  });
  it('selects an arc with a tap and in kiosk mode does not react to hover', () => {
    const { container } = render(
      wrap(<SunburstChart data={data} title="CPU" format={fmt} kiosk />, 'dark')
    );
    const arc = container.querySelector('[data-arc="category"]')!;
    fireEvent.mouseEnter(arc);
    expect(container.querySelector('[data-sunburst-centre]')!.textContent).not.toContain('Alpha');
    fireEvent.click(arc);
    expect(container.querySelector('[data-sunburst-centre]')!.textContent).toContain('Alpha');
    fireEvent.click(arc);
    expect(container.querySelector('[data-sunburst-centre]')!.textContent).not.toContain('Alpha');
  });
  it('lists every category in the legend and has a text summary', () => {
    const { container } = render(wrap(<SunburstChart data={data} title="CPU" format={fmt} />));
    expect(container.querySelectorAll('[data-legend-group]')).toHaveLength(2);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toMatch(/Alpha 60%/);
    // The legend and the text summary list every group: no "+N more" line.
    expect(container.textContent).not.toMatch(/\bmore\b/i);
  });
  it('lists all groups and children of a long legend in a scroll area, with no "more" line', () => {
    const big = {
      capacity: 100,
      categories: Array.from({ length: 12 }, (_, i) => ({
        key: `g${i}`,
        label: `Group ${i}`,
        value: 5,
        children: Array.from({ length: 9 }, (_, j) => ({
          key: `g${i}/c${j}`,
          label: `Child ${i}.${j}`,
          value: 0.5,
        })),
      })),
    };
    const { container } = render(wrap(<SunburstChart data={big} title="CPU" format={fmt} />));
    const area = container.querySelector('ul[aria-label="CPU groups"]') as HTMLElement;
    expect(getComputedStyle(area).overflowY).toBe('auto');
    expect(getComputedStyle(area).overscrollBehavior).toBe('contain');
    expect(area.querySelectorAll('[data-legend-group]')).toHaveLength(12);
    expect(area.querySelectorAll('[data-legend-child]')).toHaveLength(108);
    expect(container.textContent).not.toMatch(/\bmore\b|\bOther\b/);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).not.toMatch(/more/);
  });
  it('renders without data', () => {
    const { container } = render(
      wrap(<SunburstChart data={{ capacity: 0, categories: [] }} title="CPU" format={fmt} />)
    );
    expect(container.querySelectorAll('[data-arc]')).toHaveLength(0);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('CPU: no usage');
  });
});

describe('SunburstChart by node', () => {
  const cat = (key: string, label: string, value: number, kids: number[] = []) => ({
    key,
    label,
    value,
    children: kids.map((v, i) => ({ key: `${key}/${i}`, label: `${label} ${i + 1}`, value: v })),
  });
  const data = {
    capacity: 100,
    categories: [cat('k8s', 'Kubernetes', 40)],
    nodes: [
      {
        key: 'node:worker-1',
        label: 'worker-1',
        capacity: 60,
        used: 40,
        categories: [cat('k8s', 'Kubernetes', 30, [20, 10]), cat('system', 'System', 10, [10])],
      },
      {
        key: 'node:worker-2',
        label: 'worker-2',
        capacity: 40,
        used: 10,
        categories: [cat('k8s', 'Kubernetes', 10, [10])],
      },
    ],
  };
  const fmt = (v: number) => `${v} u`;

  it('draws the node ring first and a free arc for each node', () => {
    const { container } = render(wrap(<SunburstChart data={data} title="CPU" format={fmt} />));
    const kinds = Array.from(container.querySelectorAll('[data-arc]')).map(a =>
      a.getAttribute('data-arc')
    );
    expect(kinds.indexOf('node')).toBe(0);
    expect(kinds.filter(k => k === 'node')).toHaveLength(2);
    expect(kinds.filter(k => k === 'category')).toHaveLength(3);
    expect(kinds.filter(k => k === 'free')).toHaveLength(2);
    expect(container.querySelector('[data-arc="free"][data-node="node:worker-1"]')).not.toBeNull();
  });

  it('fills a free arc with a crosshatch pattern on a transparent background, in both themes', () => {
    for (const mode of ['dark', 'light'] as const) {
      const { container, unmount } = render(
        wrap(<SunburstChart data={data} title="CPU" format={fmt} />, mode)
      );
      const free = container.querySelector('[data-arc="free"]')!;
      const id = /^url\(#(.+)\)$/.exec(free.getAttribute('fill') ?? '')?.[1];
      expect(id).toBeTruthy();
      const pattern = container.querySelector(`pattern[id="${id}"]`)!;
      expect(pattern).not.toBeNull();
      // Thin lines at low opacity, and no background rectangle under them.
      expect(pattern.querySelector('rect')).toBeNull();
      expect(Number(pattern.querySelector('path')!.getAttribute('stroke-opacity'))).toBeLessThan(
        0.6
      );
      expect(
        Number(pattern.querySelector('path')!.getAttribute('stroke-width'))
      ).toBeLessThanOrEqual(0.5);
      // A used arc has a solid fill, so the free arc cannot be mistaken for it.
      expect(container.querySelector('[data-arc="category"]')!.getAttribute('fill')).not.toMatch(
        /^url/
      );
      unmount();
    }
  });

  it('gives each chart its own pattern id', () => {
    const { container } = render(
      wrap(
        <>
          <SunburstChart data={data} title="CPU" format={fmt} />
          <SunburstChart data={data} title="Memory" format={fmt} />
        </>
      )
    );
    const ids = Array.from(container.querySelectorAll('pattern')).map(p => p.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps the centre total, and shows node and category on hover', () => {
    const { container } = render(wrap(<SunburstChart data={data} title="CPU" format={fmt} />));
    const centre = () => container.querySelector('[data-sunburst-centre]')!.textContent;
    expect(centre()).toContain('50 u');
    expect(centre()).toContain('of 100 u (50%)');
    const sys = container.querySelector('[data-arc="category"][data-key="system"]')!;
    fireEvent.mouseEnter(sys);
    expect(centre()).toContain('System');
    expect(centre()).toContain('10 u');
    expect(sys.querySelector('title')!.textContent).toBe('worker-1 / System: 10 u (10%)');
    fireEvent.mouseLeave(sys);
    const free = container.querySelector('[data-arc="free"][data-node="node:worker-2"]')!;
    expect(free.querySelector('title')!.textContent).toBe('worker-2 free: 30 u (30%)');
    fireEvent.mouseEnter(free);
    expect(centre()).toContain('Free');
    expect(centre()).toContain('30 u');
  });

  it('lists the node and then its categories and free space in the legend, with value and percent', () => {
    const { container } = render(wrap(<SunburstChart data={data} title="CPU" format={fmt} />));
    const nodes = Array.from(container.querySelectorAll('[data-legend-node]'));
    expect(nodes.map(n => n.getAttribute('data-legend-node'))).toEqual([
      'node:worker-1',
      'node:worker-2',
    ]);
    const rows = Array.from(nodes[0].querySelectorAll('[data-legend-row]'));
    expect(rows.map(r => r.getAttribute('data-legend-row'))).toEqual([
      'node:worker-1',
      'node:worker-1/k8s',
      'node:worker-1/system',
      'node:worker-1/~free',
    ]);
    expect(rows[0].textContent).toContain('worker-1');
    expect(rows[0].textContent).toContain('40 u');
    expect(rows[1].textContent).toContain('Kubernetes');
    expect(rows[1].textContent).toContain('30 u');
    expect(rows[1].textContent).toContain('30%');
    expect(rows[3].textContent).toContain('Free');
    expect(rows[3].textContent).toContain('20 u');
  });

  it('has no Other group, in the arcs or in the legend', () => {
    const { container } = render(wrap(<SunburstChart data={data} title="CPU" format={fmt} />));
    expect(container.textContent).not.toMatch(/other/i);
  });

  it('lists every node and category of a long legend, scrolls it, and never writes "more"', () => {
    const many = {
      capacity: 1200,
      categories: [cat('k8s', 'Kubernetes', 600)],
      nodes: Array.from({ length: 12 }, (_, i) => ({
        key: `node:n${i}`,
        label: `n${i}`,
        capacity: 100,
        used: 50,
        categories: [cat('k8s', 'Kubernetes', 30, [10, 10, 10]), cat('system', 'System', 20)],
      })),
    };
    const { container } = render(wrap(<SunburstChart data={many} title="CPU" format={fmt} />));
    expect(container.querySelectorAll('[data-legend-node]')).toHaveLength(12);
    // Per node: the node row, two categories and the free row.
    expect(container.querySelectorAll('[data-legend-row]')).toHaveLength(12 * 4);
    expect(container.querySelectorAll('[data-arc="node"]')).toHaveLength(12);
    expect(container.textContent).not.toMatch(/\bmore\b/i);
    expect(container.querySelector('svg')!.getAttribute('aria-label')).not.toMatch(/\bmore\b/i);
    const list = container.querySelector('ul[aria-label="CPU nodes"]') as HTMLElement;
    expect(list.style.overflowY || getComputedStyle(list).overflowY).toBe('auto');
  });

  it('lists every category of the category-first legend and never writes "more"', () => {
    const wide = {
      capacity: 100,
      categories: Array.from({ length: 9 }, (_, i) => cat(`c${i}`, `Cat ${i}`, 5, [2, 2, 1])),
    };
    const { container } = render(wrap(<SunburstChart data={wide} title="CPU" format={fmt} />));
    expect(container.querySelectorAll('[data-legend-group]')).toHaveLength(9);
    expect(container.textContent).not.toMatch(/\bmore\b/i);
    expect(container.querySelector('svg')!.getAttribute('aria-label')).not.toMatch(/\bmore\b/i);
  });

  it('draws the category-first chart for data without nodes', () => {
    const { container } = render(
      wrap(<SunburstChart data={{ ...data, nodes: undefined }} title="CPU" format={fmt} />)
    );
    expect(container.querySelector('[data-arc="node"]')).toBeNull();
    expect(container.querySelector('[data-arc="free"]')).toBeNull();
  });
});

describe('sparklinePoints', () => {
  it('scales a series into the box and draws a flat series in the middle', () => {
    const p = sparklinePoints([0, 10], 100, 20, 0);
    expect(p).toEqual([
      [0, 20],
      [100, 0],
    ]);
    expect(sparklinePoints([5, 5], 100, 20, 0).map(x => x[1])).toEqual([10, 10]);
    expect(sparklinePoints([], 100, 20)).toEqual([]);
  });
});

describe('agent panel widget', () => {
  const Component = panelWidget.Component;
  const props = (over: Partial<React.ComponentProps<typeof Component>> = {}) => ({
    instanceId: 'w1',
    config: { source: 'agent', panel: 'usage-dashboard' },
    filters: { namespaces: [], nodes: [], labelSelector: '', range: '1h' as const },
    refreshSignal: 0,
    reportRefreshed: vi.fn(),
    editing: false,
    kiosk: false,
    ...over,
  });
  const answer = (url: string) => {
    if (url.endsWith('/api/widgets'))
      return Promise.resolve({
        version: 1,
        panels: [
          {
            id: 'usage-dashboard',
            title: 'Usage',
            description: '',
            plugin: 'usage',
            link: '/usage',
            refreshSeconds: 60,
          },
        ],
      });
    if (url.includes('/api/widgets/usage-dashboard')) return Promise.resolve(PANEL);
    return Promise.reject(new Error('unexpected'));
  };

  it('asks for a panel when none is chosen', async () => {
    request.mockImplementation(answer);
    render(wrap(<Component {...props({ config: { source: 'agent', panel: '' } })} />));
    expect(screen.getByText(/Choose a panel/)).toBeTruthy();
  });

  it('loads the panel, reports the refresh and honours the minimum interval', async () => {
    request.mockImplementation(answer);
    const p = props();
    const view = render(wrap(<Component {...p} />));
    expect(screen.getByLabelText('Loading the panel')).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-panel="usage-dashboard"]')).not.toBeNull();
    expect(p.reportRefreshed).toHaveBeenCalledTimes(1);
    const panelCalls = () =>
      request.mock.calls.filter(c => String(c[0]).includes('/api/widgets/usage')).length;
    expect(panelCalls()).toBe(1);
    // A refresh signal 0 s later is inside the 60 s minimum, so it does not fetch again.
    view.rerender(wrap(<Component {...p} refreshSignal={1} />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(panelCalls()).toBe(1);
  });

  it('keeps the last panel and shows a warning when a refresh fails', async () => {
    let fail = false;
    request.mockImplementation((url: string) =>
      fail && url.includes('/api/widgets/usage')
        ? Promise.reject(new Error('HTTP 502'))
        : answer(url)
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const p = props();
      const view = render(wrap(<Component {...p} />));
      await act(async () => {
        await Promise.resolve();
      });
      fail = true;
      vi.setSystemTime(Date.now() + 120_000);
      view.rerender(wrap(<Component {...p} refreshSignal={1} />));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText(/Refresh failed, showing the last data: HTTP 502/)).toBeTruthy();
      expect(view.container.querySelector('[data-panel]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an error when the first load fails', async () => {
    request.mockImplementation((url: string) =>
      url.includes('/api/widgets/usage') ? Promise.reject(new Error('HTTP 404')) : answer(url)
    );
    render(wrap(<Component {...props()} />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Could not load the panel: HTTP 404/)).toBeTruthy();
  });

  it('keeps a saved widget with no source setting working: it reads the agent', async () => {
    request.mockImplementation(answer);
    const view = render(
      wrap(<Component {...props({ config: { panel: 'usage-dashboard' } as never })} />)
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-panel="usage-dashboard"]')).not.toBeNull();
    expect(String(request.mock.calls[0][0])).toContain(
      '/services/headlamp-agent:80/proxy/api/widgets'
    );
  });

  it('reads a configured source and shows an error for a source that is not configured', async () => {
    settings.value = {
      panelSources: [
        {
          id: 'my-app',
          title: 'My app',
          kind: 'service',
          namespace: 'apps',
          service: 'my-app',
          port: '8080',
          pathPrefix: '/x',
        },
      ],
    };
    request.mockImplementation(answer);
    const view = render(
      wrap(<Component {...props({ config: { source: 'my-app', panel: 'usage-dashboard' } })} />)
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      request.mock.calls.every(c =>
        String(c[0]).startsWith('/api/v1/namespaces/apps/services/my-app:8080/proxy/x/api/widgets')
      )
    ).toBe(true);
    view.unmount();
    const gone = render(
      wrap(<Component {...props({ config: { source: 'removed', panel: 'usage-dashboard' } })} />)
    );
    expect(gone.container.textContent).toMatch(/The source "removed" is not configured/);
  });

  it('shows a clear error card for a wrong response shape', async () => {
    request.mockImplementation((url: string) =>
      url.endsWith('/api/widgets')
        ? Promise.resolve({ version: 1, panels: [] })
        : Promise.resolve({ id: 'usage-dashboard' })
    );
    render(wrap(<Component {...props()} />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Could not load the panel: .*no version/)).toBeTruthy();
  });

  it('is registered with a settings component and no raw id in its defaults', () => {
    expect(panelWidget.type).toBe('agent.panel');
    expect(panelWidget.defaultConfig).toEqual({
      source: 'agent',
      panel: '',
      showSummary: true,
      showStats: true,
      rowLayout: 'list',
    });
    expect(panelWidget.SettingsComponent).toBeDefined();
  });
});

describe('PanelTables', () => {
  const tables = parsePanel({
    version: 1,
    id: 't',
    tables: [
      {
        title: 'Hosts',
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'load', label: 'Load', align: 'right' },
        ],
        rows: [
          { name: 'b', load: 10 },
          { name: 'a', load: 2 },
          { name: 'c', load: 33 },
        ],
      },
    ],
  }).tables;
  const names = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('[data-table-row] td:first-child')).map(td => td.textContent);

  it('draws the title, the headings and every row in the given order', () => {
    const { container } = render(wrap(<PanelTables tables={tables} />));
    expect(container.querySelector('[data-table]')?.textContent).toContain('Hosts');
    expect(Array.from(container.querySelectorAll('th')).map(th => th.textContent)).toEqual([
      'Name',
      'Load',
    ]);
    expect(names(container)).toEqual(['b', 'a', 'c']);
  });
  it('sorts by a heading, flips the direction on a second click and marks the sort for screen readers', () => {
    const { container } = render(wrap(<PanelTables tables={tables} />));
    const load = container.querySelector('[data-sort="load"]')!;
    fireEvent.click(load);
    expect(names(container)).toEqual(['a', 'b', 'c']);
    expect(container.querySelectorAll('th')[1].getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(load);
    expect(names(container)).toEqual(['c', 'b', 'a']);
    expect(container.querySelectorAll('th')[1].getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(container.querySelector('[data-sort="name"]')!);
    expect(names(container)).toEqual(['a', 'b', 'c']);
    expect(container.querySelectorAll('th')[1].getAttribute('aria-sort')).toBe('none');
  });
  it('sorts on a click on the heading cell itself', () => {
    const { container } = render(wrap(<PanelTables tables={tables} />));
    const cell = container.querySelectorAll('th')[1];
    fireEvent.click(cell);
    expect(cell.getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(cell);
    expect(cell.getAttribute('aria-sort')).toBe('descending');
  });
  it('shows the tables inside a panel', () => {
    const { container } = render(
      wrap(
        <PanelView
          panel={parsePanel({
            version: 1,
            id: 't',
            tables: [{ columns: [{ key: 'a', label: 'A' }], rows: [{ a: 'x' }] }],
          })}
          kiosk={false}
          editing={false}
        />
      )
    );
    expect(container.querySelectorAll('[data-table]')).toHaveLength(1);
  });
});
