import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchUsage, queryMetrics } = vi.hoisted(() => ({
  fetchUsage: vi.fn(),
  queryMetrics: vi.fn(),
}));
vi.mock('./data', () => ({ fetchUsage }));
vi.mock('./metrics', async () => ({
  queryMetrics,
  numberFromValue: (s: any) => (s ? Number(s.value[1]) : undefined),
}));

import { usageDonutWidget, usageSunburstWidget } from './dashboardWidgets';
import { emptyValues, UsageRow } from './model';

const rows: UsageRow[] = [
  {
    namespace: 'shop',
    node: 'n1',
    workload: 'Deployment/web',
    pods: 1,
    values: { ...emptyValues(), cpuSeconds: 7200, memAvg: 2 ** 30 },
  },
  {
    namespace: 'ops',
    node: 'n2',
    workload: 'DaemonSet/agent',
    pods: 1,
    values: { ...emptyValues(), cpuSeconds: 3600, memAvg: 2 ** 29 },
  },
];
const filters = {
  namespaces: [] as string[],
  nodes: [] as string[],
  labelSelector: '',
  range: '1h' as const,
};
const props = (config: any, over: any = {}) => ({
  instanceId: 'w',
  config,
  filters,
  refreshSignal: 0,
  reportRefreshed: vi.fn(),
  editing: false,
  kiosk: false,
  ...over,
});
const view = (ui: React.ReactNode) =>
  render(<ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>{ui}</ThemeProvider>);

beforeEach(() => {
  fetchUsage.mockReset();
  queryMetrics.mockReset();
  fetchUsage.mockResolvedValue({ rows, labelSource: null });
  queryMetrics.mockResolvedValue([{ metric: {}, value: [0, '8'] }]);
});
afterEach(cleanup);

describe('registration', () => {
  it('registers both widgets through window.headlampDashboards, in any load order', () => {
    // Importing the module ran the registration. With no Dashboards plugin it left a stub with a queue.
    const reg = window.headlampDashboards as any;
    const queued = reg.stub
      ? reg.queue.map((d: any) => d.type)
      : ['usage.sunburst', 'usage.donut'].filter(t => reg.get(t));
    expect(queued).toEqual(expect.arrayContaining(['usage.sunburst', 'usage.donut']));
  });
  it('gives both widgets valid definitions', () => {
    for (const d of [usageSunburstWidget, usageDonutWidget]) {
      expect(d.type).toMatch(/^usage\.[a-z]+$/);
      expect(d.defaultSize.w).toBeGreaterThanOrEqual(1);
      expect(d.configSchema?.map(f => f.key)).toEqual(['resource', 'groupBy', 'labelKey']);
      expect(d.defaultConfig).toEqual({ resource: 'cpu', groupBy: 'namespace', labelKey: '' });
    }
    expect(usageSunburstWidget.category).toBe('Charts');
  });
});

describe('usage sunburst widget', () => {
  const Component = usageSunburstWidget.Component;
  it('fetches, draws every group and reports the refresh', async () => {
    const p = props({ resource: 'cpu', groupBy: 'namespace', labelKey: '' });
    const { container } = view(<Component {...p} />);
    expect(screen.getByLabelText('Loading usage')).toBeTruthy();
    await act(async () => {});
    expect(container.querySelectorAll('[data-arc="category"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-arc="child"]')).toHaveLength(2);
    expect(p.reportRefreshed).toHaveBeenCalledTimes(1);
    expect(fetchUsage).toHaveBeenCalledWith('1h', { live: false, labelKey: undefined });
    expect(queryMetrics).toHaveBeenCalledWith('sum(kube_node_status_capacity{resource="cpu"})');
    expect(container.querySelector('[data-sunburst-centre]')?.textContent).toContain('3.00 cores');
  });
  it('refetches on a refresh signal and when the range changes, not otherwise', async () => {
    const p = props({ resource: 'cpu', groupBy: 'namespace', labelKey: '' });
    const ui = (q: any) => (
      <ThemeProvider theme={createTheme()}>
        <Component {...q} />
      </ThemeProvider>
    );
    const { rerender } = render(ui(p));
    await act(async () => {});
    rerender(ui({ ...p, kiosk: true }));
    await act(async () => {});
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    rerender(ui({ ...p, refreshSignal: 1 }));
    await act(async () => {});
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    rerender(ui({ ...p, refreshSignal: 1, filters: { ...filters, range: '24h' } }));
    await act(async () => {});
    expect(fetchUsage).toHaveBeenLastCalledWith('24h', { live: false, labelKey: undefined });
  });
  it('applies the namespace filter', async () => {
    const { container } = view(
      <Component
        {...props(
          { resource: 'cpu', groupBy: 'namespace', labelKey: '' },
          { filters: { ...filters, namespaces: ['ops'] } }
        )}
      />
    );
    await act(async () => {});
    expect(container.querySelectorAll('[data-arc="category"]')).toHaveLength(1);
  });
  it('shows an error when the first load fails and keeps data when a refresh fails', async () => {
    fetchUsage.mockRejectedValueOnce(new Error('HTTP 503'));
    const { rerender } = view(
      <Component {...props({ resource: 'cpu', groupBy: 'namespace', labelKey: '' })} />
    );
    await act(async () => {});
    expect(screen.getByText(/Could not query the metrics service: HTTP 503/)).toBeTruthy();
    cleanup();
    const p = props({ resource: 'cpu', groupBy: 'namespace', labelKey: '' });
    const ui = (q: any) => (
      <ThemeProvider theme={createTheme()}>
        <Component {...q} />
      </ThemeProvider>
    );
    const r = render(ui(p));
    await act(async () => {});
    fetchUsage.mockRejectedValueOnce(new Error('HTTP 502'));
    r.rerender(ui({ ...p, refreshSignal: 1 }));
    await act(async () => {});
    expect(screen.getByText(/Refresh failed, showing the last data: HTTP 502/)).toBeTruthy();
    expect(r.container.querySelectorAll('[data-arc="category"]')).toHaveLength(2);
    void rerender;
  });
  it('shows an empty state', async () => {
    fetchUsage.mockResolvedValue({ rows: [], labelSource: null });
    view(<Component {...props({ resource: 'cpu', groupBy: 'namespace', labelKey: '' })} />);
    await act(async () => {});
    expect(screen.getByText(/No usage metrics match/)).toBeTruthy();
  });
});

describe('usage donut widget', () => {
  const Component = usageDonutWidget.Component;
  it('draws the donut card with every group in the legend, for the chosen resource', async () => {
    const { container } = view(
      <Component
        {...props({ resource: 'memory', groupBy: 'namespace', labelKey: '' }, { kiosk: true })}
      />
    );
    await act(async () => {});
    expect(screen.getByText('Memory')).toBeTruthy();
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(queryMetrics).not.toHaveBeenCalled();
  });
});
