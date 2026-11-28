import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeMetrics } from './types';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn() } }));
vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));
vi.mock('../settings', () => ({
  useNodesSettings: () => ({ idleSeconds: 120, displayNames: {}, agentBackends: [] }),
}));

const { fetchNodeMetrics, fetchAgentHosts } = vi.hoisted(() => ({
  fetchNodeMetrics: vi.fn(),
  fetchAgentHosts: vi.fn(),
}));
vi.mock('./queries', () => ({ fetchNodeMetrics }));
vi.mock('./agents', async importOriginal => ({
  ...(await importOriginal<typeof import('./agents')>()),
  fetchAgentHosts,
}));

import { usageDashboardRingsWidget } from '../dashboardWidgets';
import { ringsOf, UsageRings } from './UsageRings';

const metric = (node: string, used: number): NodeMetrics => ({
  node,
  cpuCapacity: 8,
  cpuUsed: used,
  memCapacity: 16e9,
  memUsed: used * 1e9,
  pods: [{ namespace: 'ns', pod: 'p1', container: 'c1', cpuCores: 2, memBytes: 2e9 }],
});

function Probe() {
  const l = useLocation();
  return <output data-testid="url">{l.pathname + l.search}</output>;
}

const config = { rings: 4, filters: true };
const mount = (over: Partial<Parameters<typeof UsageRings>[0]> = {}, theme = 'light') => {
  const p = {
    config,
    refreshSignal: 0,
    reportRefreshed: vi.fn(),
    kiosk: false,
    ...over,
  };
  const ui = (q: typeof p) => (
    <ThemeProvider theme={createTheme({ palette: { mode: theme as 'light' | 'dark' } })}>
      <MemoryRouter initialEntries={['/c/main/dashboards/x?tab=1']}>
        <UsageRings {...q} />
        <Probe />
      </MemoryRouter>
    </ThemeProvider>
  );
  const r = render(ui(p));
  return { ...r, p, again: (q: Partial<typeof p>) => r.rerender(ui({ ...p, ...q })) };
};

const flush = () => act(async () => {});
const url = () => screen.getByTestId('url').textContent;

beforeEach(() => {
  fetchNodeMetrics.mockReset();
  fetchAgentHosts.mockReset();
  fetchNodeMetrics.mockResolvedValue([metric('worker-1', 4), metric('worker-2', 5)]);
  fetchAgentHosts.mockResolvedValue({ hosts: [], errors: [] });
});
afterEach(cleanup);

describe('usage.dashboard-rings widget definition', () => {
  const d = usageDashboardRingsWidget;
  it('has a valid definition and settings', () => {
    expect(d.type).toBe('usage.dashboard-rings');
    expect(d.category).toBe('Charts');
    expect(d.defaultConfig).toEqual({ rings: 4, filters: true });
    expect(d.configSchema?.map(f => f.key)).toEqual(['rings', 'filters']);
    expect(d.selfScroll).toBe(true);
  });
  it('is registered through the dashboards contract', () => {
    const reg = window.headlampDashboards as any;
    const types = reg.stub ? reg.queue.map((w: any) => w.type) : [];
    expect(types).toContain('usage.dashboard-rings');
  });
  it('clamps junk ring counts', () => {
    expect([ringsOf(4), ringsOf(9), ringsOf(0), ringsOf('3'), ringsOf('x'), ringsOf(2.5)]).toEqual([
      4, 6, 2, 3, 4, 4,
    ]);
  });
});

describe('UsageRings CPU source label', () => {
  it('shows the source and window under the CPU heading only', async () => {
    fetchNodeMetrics.mockResolvedValue([
      { ...metric('worker-1', 4), cpuSource: 'node exporter, 1 min average' },
    ]);
    mount();
    await flush();
    const labels = screen.getAllByTestId('cpu-source');
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toBe('node exporter, 1 min average');
  });

  it('renders the caption as a block, so its margins apply', async () => {
    fetchNodeMetrics.mockResolvedValue([
      { ...metric('worker-1', 4), cpuSource: 'node exporter, 1 min average' },
    ]);
    mount();
    await flush();
    expect(screen.getByTestId('cpu-source').tagName).toBe('DIV');
  });

  it('shows no label when the data has no source', async () => {
    mount();
    await flush();
    expect(screen.queryByTestId('cpu-source')).toBeNull();
  });
});

describe('UsageRings', () => {
  it('shows a spinner, then both sunbursts of the Usage dashboard, and reports the refresh', async () => {
    const { container, p } = mount();
    expect(screen.getByLabelText('Loading usage')).toBeTruthy();
    await flush();
    expect(screen.getAllByRole('group', { name: /usage by group/ })).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'CPU' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Memory' })).toBeTruthy();
    expect(container.querySelector('[data-detail-panel]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Up one level' })).toBeTruthy();
    expect(p.reportRefreshed).toHaveBeenCalledTimes(1);
  });

  it('fetches again on a new refresh signal only, not on a re-render with the same signal', async () => {
    const { again, p } = mount();
    await flush();
    expect(fetchNodeMetrics).toHaveBeenCalledTimes(1);
    again({ kiosk: true });
    await flush();
    again({ kiosk: false, config: { ...config } });
    await flush();
    expect(fetchNodeMetrics).toHaveBeenCalledTimes(1);
    again({ refreshSignal: 1 });
    await flush();
    expect(fetchNodeMetrics).toHaveBeenCalledTimes(2);
    expect(p.reportRefreshed).toHaveBeenCalledTimes(2);
  });

  it('has no timer of its own', async () => {
    vi.useFakeTimers();
    try {
      mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(fetchNodeMetrics).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('zooms into an arc and back with local state, and never writes to the page URL', async () => {
    const { container } = mount();
    await flush();
    const before = url();
    const arc = container.querySelector('path[data-key="k8s"]') as Element;
    fireEvent.pointerDown(arc, { clientX: 1, clientY: 1 });
    fireEvent.pointerUp(arc, { clientX: 1, clientY: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Open the selected segment' }));
    const crumbs = screen.getByRole('navigation', { name: 'Focus' });
    expect(crumbs.textContent).toContain('Kubernetes');
    expect(
      (screen.getByRole('button', { name: 'Up one level' }) as HTMLButtonElement).disabled
    ).toBe(false);
    // Two nodes show the node ring, so the zoom is two levels deep.
    fireEvent.click(screen.getByRole('button', { name: 'Up one level' }));
    fireEvent.click(screen.getByRole('button', { name: 'Up one level' }));
    expect(
      (screen.getByRole('button', { name: 'Up one level' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(url()).toBe(before);
    expect(before).toBe('/c/main/dashboards/x?tab=1');
  });

  it('keeps the zoom when the dashboard refreshes', async () => {
    const { container, again } = mount();
    await flush();
    const arc = container.querySelector('path[data-key="k8s"]') as Element;
    fireEvent.pointerDown(arc, { clientX: 1, clientY: 1 });
    fireEvent.pointerUp(arc, { clientX: 1, clientY: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Open the selected segment' }));
    again({ refreshSignal: 1 });
    await flush();
    expect(screen.getByRole('navigation', { name: 'Focus' }).textContent).toContain('Kubernetes');
  });

  it('keeps the last data and warns when a refresh fails', async () => {
    const { again } = mount();
    await flush();
    fetchNodeMetrics.mockRejectedValueOnce(new Error('HTTP 502'));
    again({ refreshSignal: 1 });
    await flush();
    expect(
      screen.getByText(/Refresh failed, showing the last data received: HTTP 502/)
    ).toBeTruthy();
    expect(screen.getAllByRole('group', { name: /usage by group/ })).toHaveLength(2);
  });

  it('shows an error when the first load fails, and an empty state with no nodes', async () => {
    fetchNodeMetrics.mockRejectedValueOnce(new Error('HTTP 503'));
    mount();
    await flush();
    expect(screen.getByText(/Could not query the metrics service: HTTP 503/)).toBeTruthy();
    cleanup();
    fetchNodeMetrics.mockResolvedValue([]);
    mount();
    await flush();
    expect(screen.getByText(/No node metrics found/)).toBeTruthy();
  });

  it('hides the filters when the setting is off, and starts with the chosen ring count', async () => {
    const { container } = mount({ config: { rings: 2, filters: false } });
    await flush();
    expect(screen.queryByRole('search', { name: 'Filters' })).toBeNull();
    expect(screen.getByRole('button', { name: '2 rings' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(container.querySelector('[data-usage-rings]')).not.toBeNull();
  });

  it('filters by node with local state', async () => {
    mount();
    await flush();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Nodes' }));
    fireEvent.click(screen.getByRole('option', { name: 'worker-2' }));
    expect(screen.getByRole('navigation', { name: 'Focus' }).textContent).toContain('worker-2');
    expect(url()).toBe('/c/main/dashboards/x?tab=1');
  });

  it('uses the kiosk look: black surfaces in a dark theme, touch filters, no scrollbar', async () => {
    const { container } = mount({ kiosk: true }, 'dark');
    await flush();
    const root = container.querySelector('[data-usage-rings]') as HTMLElement;
    expect(getComputedStyle(root).scrollbarWidth).toBe('none');
    // The touch filters are buttons that open a sheet, not text fields.
    expect(screen.getByRole('button', { name: /Nodes filter: All/ })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Nodes' })).toBeNull();
    // The centre discs and arc gaps use the black paper colour.
    const disc = container.querySelector('svg circle[fill="#000"]');
    expect(disc).not.toBeNull();
  });

  it('goes back to the overview after the idle time in the kiosk', async () => {
    vi.useFakeTimers();
    try {
      const { container } = mount({ kiosk: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const arc = container.querySelector('path[data-key="k8s"]') as Element;
      fireEvent.pointerDown(arc, { clientX: 1, clientY: 1 });
      fireEvent.pointerUp(arc, { clientX: 1, clientY: 1 });
      fireEvent.click(screen.getByRole('button', { name: 'Open the selected segment' }));
      expect(screen.getByRole('navigation', { name: 'Focus' }).textContent).toContain('Kubernetes');
      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(
        (screen.getByRole('button', { name: 'Up one level' }) as HTMLButtonElement).disabled
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
