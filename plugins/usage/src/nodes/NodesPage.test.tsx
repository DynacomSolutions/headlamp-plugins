import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useHistory, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeMetrics } from './types';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn() } }));
vi.mock('@kinvolk/headlamp-plugin/lib/CommonComponents', () => ({
  Loader: () => <div>loading</div>,
  SectionBox: (p: {
    title: string;
    children: React.ReactNode;
    headerProps?: { actions?: React.ReactNode[] };
  }) => (
    <section>
      <h1>{p.title}</h1>
      {p.headerProps?.actions}
      {p.children}
    </section>
  ),
}));
vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));
vi.mock('../settings', () => ({ useNodesSettings: () => ({ idleSeconds: 120, displayNames: {} }) }));

const metric = (node: string, used: number): NodeMetrics => ({
  node,
  cpuCapacity: 8,
  cpuUsed: used,
  memCapacity: 16e9,
  memUsed: used * 1e9,
  pods: [{ namespace: 'ns', pod: 'p1', container: 'c1', cpuCores: 2, memBytes: 2e9 }],
});

vi.mock('./useNodesData', () => ({
  useNodesData: () => ({
    metrics: [metric('worker-1', 4), metric('worker-2', 5)],
    agents: new Map(),
    errors: [],
    nodeErrors: new Map(),
    agentsAsOf: new Map(),
    metricsError: null,
    stale: false,
    loading: false,
  }),
}));

import { NodesPage } from './NodesPage';

function Probe() {
  const l = useLocation();
  return <output data-testid="url">{l.pathname + l.search}</output>;
}

let history: ReturnType<typeof useHistory>;
function HistoryGrab() {
  history = useHistory();
  return null;
}

const mount = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <NodesPage />
      <Probe />
      <HistoryGrab />
    </MemoryRouter>
  );

const selectArc = (container: HTMLElement, key: string) => {
  const arc = container.querySelector(`path[data-key="${key}"]`) as Element;
  fireEvent.pointerDown(arc, { clientX: 1, clientY: 1 });
  fireEvent.pointerUp(arc, { clientX: 1, clientY: 1 });
};

const url = () => screen.getByTestId('url').textContent;

afterEach(cleanup);

describe('NodesPage', () => {
  it('names the root card for the whole selection, not "7 nodes, shown"', () => {
    const { container } = mount('/usage/dashboard');
    const panel = container.querySelector('[data-detail-panel]') as HTMLElement;
    expect(panel.textContent).toContain('2 nodes');
    expect(panel.textContent).not.toContain('shown');
    expect(panel.querySelector('[data-icon="mdi:server"]')).not.toBeNull();
    cleanup();
    const one = mount('/usage/dashboard?nodes=worker-1');
    const p1 = one.container.querySelector('[data-detail-panel]') as HTMLElement;
    expect(p1.textContent).toContain('worker-1');
  });

  it('names the breadcrumb root after the only selected node, or All nodes', () => {
    mount('/usage/dashboard?nodes=worker-1');
    const crumbs = screen.getByRole('navigation', { name: 'Focus' });
    expect(crumbs.textContent).toContain('worker-1');
    expect(crumbs.textContent).not.toContain('All nodes');
    cleanup();
    mount('/usage/dashboard');
    expect(screen.getByRole('navigation', { name: 'Focus' }).textContent).toContain('All nodes');
  });

  it('hides the filter placeholder once something is selected', () => {
    mount('/usage/dashboard?nodes=worker-1');
    expect(screen.getByRole('combobox', { name: 'Nodes' }).getAttribute('placeholder')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Category' }).getAttribute('placeholder')).toBe('All');
  });

  it('shows the friendly name as the title and the raw id under it', () => {
    const { container } = mount('/usage/dashboard?nodes=worker-1&sel=k8s%2Ck8s%2Fns%3Ans');
    const panel = container.querySelector('[data-detail-panel]') as HTMLElement;
    expect(panel.textContent).toContain('Ns');
    expect(panel.querySelector('[data-raw-id]')?.textContent).toBe('ns');
    expect(panel.textContent).toContain('Namespace');
  });

  it('shows the heading and one CPU and one memory chart', () => {
    mount('/usage/dashboard');
    expect(screen.getByText('Usage dashboard')).not.toBeNull();
    expect(screen.getAllByRole('group', { name: /usage by group/ })).toHaveLength(2);
  });

  it('puts a node filter in the URL, and a new mount from that URL shows it', () => {
    const first = mount('/usage/dashboard');
    const nodes = screen.getByRole('combobox', { name: 'Nodes' });
    fireEvent.mouseDown(nodes);
    fireEvent.click(screen.getByRole('option', { name: 'worker-2' }));
    const written = url() as string;
    expect(written).toBe('/usage/dashboard?nodes=worker-2');
    first.unmount();

    mount(written);
    const chips = [...document.querySelectorAll('.MuiChip-label')].map(c => c.textContent);
    expect(chips).toEqual(['worker-2']);
  });

  it('selects an arc into sel= without zooming, and Open zooms and clears it', () => {
    const { container } = mount('/usage/dashboard');
    const arc = container.querySelector('path[data-key="k8s"]') as Element;
    fireEvent.pointerDown(arc, { clientX: 1, clientY: 1 });
    fireEvent.pointerUp(arc, { clientX: 1, clientY: 1 });
    expect(url()).toContain('sel=');
    expect(url()).not.toContain('path=');
    expect(url()).toMatch(/^\/usage\/dashboard\?sel=/);
    // The details card names the segment with its shares.
    const panel = container.querySelector('[data-detail-panel]') as HTMLElement;
    expect(panel.textContent).toContain('Kubernetes');
    expect(panel.textContent).toContain('of capacity');
    expect(panel.textContent).not.toContain('of parent');
    expect(panel.textContent).not.toContain('of root');
    fireEvent.click(screen.getByRole('button', { name: 'Open the selected segment' }));
    // Two nodes show the node ring, so the path starts with the node arc.
    expect(url()).toBe('/usage/dashboard/node%3Aworker-2/k8s');
  });

  it('renders the kiosk overlay from ?kiosk=1 and Exit clears it', () => {
    const { container } = mount('/usage/dashboard?kiosk=1&nodes=worker-1');
    expect(container.querySelector('[data-kiosk-overlay]')).not.toBeNull();
    expect(screen.queryByText('Usage dashboard')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    expect(url()).toBe('/usage/dashboard?nodes=worker-1');
    expect(container.querySelector('[data-kiosk-overlay]')).toBeNull();
  });

  it('enters the kiosk from the Full screen button, keeping the filters', () => {
    mount('/usage/dashboard?cats=k8s');
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(url()).toBe('/usage/dashboard?cats=k8s&kiosk=1');
  });

  it('goes back to the root after the idle time, keeping the filters and the kiosk', () => {
    vi.useFakeTimers();
    try {
      mount('/usage/dashboard/k8s?nodes=worker-1&kiosk=1&sel=k8s%2Fns%3Ans');
      expect(url()).toContain('/usage/dashboard/k8s');
      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(url()).toBe('/usage/dashboard?nodes=worker-1&kiosk=1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('pushes a zoom, and Back goes up one level, redrawing from the URL', () => {
    const { container } = mount('/usage/dashboard?nodes=worker-1');
    selectArc(container, 'k8s');
    fireEvent.click(screen.getByRole('button', { name: 'Open the selected segment' }));
    // The filter stays in the query on the zoomed entry.
    expect(url()).toBe('/usage/dashboard/k8s?nodes=worker-1');
    expect(screen.getByRole('navigation', { name: 'Focus' }).textContent).toContain('Kubernetes');
    expect(history.length).toBeGreaterThan(1);
    act(() => history.goBack());
    expect(url()).toBe('/usage/dashboard?nodes=worker-1&sel=k8s');
    expect(screen.getByRole('navigation', { name: 'Focus' }).textContent).not.toContain('Kubernetes');
    act(() => history.goForward());
    expect(url()).toBe('/usage/dashboard/k8s?nodes=worker-1');
    expect(screen.getByRole('navigation', { name: 'Focus' }).textContent).toContain('Kubernetes');
  });

  it('goes up one level per Back after two zooms', () => {
    const { container } = mount('/usage/dashboard?nodes=worker-1');
    selectArc(container, 'k8s');
    fireEvent.click(screen.getByRole('button', { name: 'Open the selected segment' }));
    selectArc(container, 'k8s/ns:ns');
    fireEvent.click(screen.getByRole('button', { name: 'Open the selected segment' }));
    expect(url()).toBe('/usage/dashboard/k8s/k8s%2Fns%3Ans?nodes=worker-1');
    act(() => history.goBack());
    expect(url().startsWith('/usage/dashboard/k8s')).toBe(true);
    expect(url()).not.toContain('ns%3Ans/');
    expect(parseCount(url())).toBe(1);
  });

  it('replaces, not pushes, on a filter change and resets the zoom to the root path', () => {
    mount('/usage/dashboard/k8s?cats=k8s');
    const before = history.length;
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Nodes' }));
    fireEvent.click(screen.getByRole('option', { name: 'worker-2' }));
    expect(url()).toBe('/usage/dashboard?nodes=worker-2&cats=k8s');
    expect(history.length).toBe(before);
  });

  it('keeps the zoom path when the kiosk or selection changes, with replace', () => {
    mount('/c/main/usage/dashboard/k8s');
    const before = history.length;
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(url()).toBe('/c/main/usage/dashboard/k8s?kiosk=1');
    expect(history.length).toBe(before);
  });

  it('replaces, not pushes, when the ring count changes, and keeps the zoom path', () => {
    mount('/c/main/usage/dashboard/k8s?nodes=worker-1&kiosk=1');
    const before = history.length;
    fireEvent.click(screen.getByRole('button', { name: '6 rings' }));
    expect(url()).toBe('/c/main/usage/dashboard/k8s?nodes=worker-1&kiosk=1&rings=6');
    expect(history.length).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: '4 rings' }));
    expect(url()).toBe('/c/main/usage/dashboard/k8s?nodes=worker-1&kiosk=1');
    expect(history.length).toBe(before);
  });

  it('shows the ring count from the URL, also in kiosk, and keeps it through zoom and filters', () => {
    const { container } = mount('/usage/dashboard?nodes=worker-1&kiosk=1&rings=5');
    expect(screen.getByRole('button', { name: '5 rings' }).getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-kiosk-overlay]')).not.toBeNull();
    selectArc(container, 'k8s');
    fireEvent.click(screen.getByRole('button', { name: 'Open the selected segment' }));
    expect(url()).toBe('/usage/dashboard/k8s?nodes=worker-1&kiosk=1&rings=5');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Nodes' }));
    fireEvent.click(screen.getByRole('option', { name: 'worker-2' }));
    expect(url()).toBe('/usage/dashboard?nodes=worker-1%2Cworker-2&kiosk=1&rings=5');
  });

  it('redirects an old ?path= link to segments with replace, keeping other params', () => {
    mount('/c/main/usage/dashboard?nodes=worker-1&path=k8s%2Ck8s%2Fns%3Ans&kiosk=1');
    expect(url()).toBe('/c/main/usage/dashboard/k8s/k8s%2Fns%3Ans?nodes=worker-1&kiosk=1');
    expect(history.length).toBe(1);
  });

  it('parses a trailing slash and an empty path as the root view', () => {
    mount('/usage/dashboard/');
    expect(screen.getByRole('navigation', { name: 'Focus' }).textContent).toContain('All nodes');
  });
});

const parseCount = (u: string) => u.split('/usage/dashboard/')[1].split('/').length;
