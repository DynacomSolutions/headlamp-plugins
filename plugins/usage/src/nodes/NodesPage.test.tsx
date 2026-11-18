import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
vi.mock('../settings', () => ({ useNodesSettings: () => ({ idleSeconds: 120 }) }));

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

const mount = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <NodesPage />
      <Probe />
    </MemoryRouter>
  );

const url = () => screen.getByTestId('url').textContent;

afterEach(cleanup);

describe('NodesPage', () => {
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
    // The details card names the segment with its shares.
    const panel = container.querySelector('[data-detail-panel]') as HTMLElement;
    expect(panel.textContent).toContain('Kubernetes');
    expect(panel.textContent).toContain('of capacity');
    expect(panel.textContent).toContain('of parent');
    expect(panel.textContent).toContain('of root');
    fireEvent.click(screen.getByRole('button', { name: 'Open the selected segment' }));
    // Two nodes show the node ring, so the path starts with the node arc.
    expect(url()).toBe('/usage/dashboard?path=node%3Aworker-2%2Ck8s');
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
      mount('/usage/dashboard?nodes=worker-1&kiosk=1&path=k8s&sel=k8s%2Fns%3Ans');
      expect(url()).toContain('path=k8s');
      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(url()).toBe('/usage/dashboard?nodes=worker-1&kiosk=1');
    } finally {
      vi.useRealTimers();
    }
  });
});
