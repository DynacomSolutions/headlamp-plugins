import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMetrics } = vi.hoisted(() => ({ queryMetrics: vi.fn() }));
vi.mock('./metrics', () => ({ queryMetrics }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ConfigStore: class {
    useConfig() {
      return () => ({});
    }
  },
}));

import { visibleRows, visibleWorkloads, workflowsStatusWidget } from './dashboardWidgets';
import { buildWorkflowRows, emptyRaw } from './model';

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const labels = { workflow: 'sweep', kind: 'timer', pod: 'pod-a', component: 'api', namespace: 'example-ns' };
const s = (name: string, value: number, extra: Record<string, string> = {}, workflow = 'sweep') => ({
  metric: { __name__: `example_workflow_${name}`, ...labels, workflow, ...extra },
  value: [NOW, String(value)] as [number, string],
});

const ns = { namespace: 'example-ns' };
/** A Deployment in a crash loop and a healthy one, as kube-state-metrics returns them. */
function kube(q: string) {
  const v = (metric: Record<string, string>, value: number) => ({ metric: { ...ns, ...metric }, value: [NOW, String(value)] as [number, string] });
  if (q.startsWith('kube_deployment_spec_replicas')) return [v({ deployment: 'engine' }, 1), v({ deployment: 'web' }, 1)];
  if (q.startsWith('kube_deployment_status_replicas_ready')) return [v({ deployment: 'engine' }, 0), v({ deployment: 'web' }, 1)];
  if (q.startsWith('kube_pod_owner')) return [v({ pod: 'engine-1-x', owner_kind: 'ReplicaSet', owner_name: 'engine-1' }, 1)];
  if (q.includes('CrashLoopBackOff')) return [v({ pod: 'engine-1-x', container: 'main' }, 1)];
  if (q.startsWith('kube_pod_container_status_last_terminated_exitcode')) return [v({ pod: 'engine-1-x', container: 'main' }, 1)];
  return [];
}

function answer(query: string) {
  const m = /_workflow_([a-z_]+)"/.exec(query);
  const suffix = m?.[1];
  const wf = (name: string, vals: Record<string, number>) => [
    s(suffix!, vals[suffix!] ?? 0, suffix === 'last_error_info' ? { error_class: name === 'broken' ? 'timeout' : 'none' } : {}, name),
  ];
  const good = { expected_interval_seconds: 60, last_run_timestamp_seconds: NOW - 10, last_success_timestamp_seconds: NOW - 10, last_error_info: 1 };
  const bad = { ...good, consecutive_failures: 4, last_error_info: 1 };
  if (!suffix) return [];
  return [...wf('healthy', good), ...wf('broken', bad)];
}

const filters = { namespaces: [] as string[], nodes: [] as string[], labelSelector: '', range: '1h' as const };
const props = (config: object = {}, over: object = {}) => ({
  instanceId: 'w',
  config: { ...workflowsStatusWidget.defaultConfig, ...config },
  filters,
  refreshSignal: 0,
  reportRefreshed: vi.fn(),
  editing: false,
  kiosk: false,
  ...over,
});
const Widget = workflowsStatusWidget.Component;
const view = (ui: React.ReactNode) => render(<ThemeProvider theme={createTheme()}>{ui}</ThemeProvider>);
const flush = () => act(async () => {});

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  queryMetrics.mockReset();
  queryMetrics.mockImplementation(async (_t: unknown, q: string) => (q.includes('_workflow_') ? answer(q) : kube(q)));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('workflows.status definition', () => {
  it('has the contract fields', () => {
    expect(workflowsStatusWidget.type).toBe('workflows.status');
    expect(workflowsStatusWidget.title).toBe('Workflows');
    expect(workflowsStatusWidget.category).toBe('Monitoring');
    expect(workflowsStatusWidget.defaultConfig).toEqual({ onlyFailing: false, groupBy: 'auto' });
    expect(workflowsStatusWidget.configSchema?.map(f => f.key)).toEqual(['onlyFailing', 'groupBy']);
  });
});

describe('workflows.status widget', () => {
  it('lists the workflows by group, failing first, and reports the refresh', async () => {
    const p = props();
    view(<Widget {...p} />);
    await flush();
    const names = screen.getAllByText(/^(healthy|broken)$/).map(n => n.textContent);
    expect(names).toEqual(['broken', 'healthy']);
    expect(screen.getByText('example-ns')).toBeTruthy();
    expect(screen.getByText('failing')).toBeTruthy();
    expect(p.reportRefreshed).toHaveBeenCalledWith(NOW_MS);
    expect(screen.getByText(/2 workflows, 1 failing, 0 overdue, 0 never run/)).toBeTruthy();
  });

  it('shows the summary bar and the unhealthy workloads', async () => {
    view(<Widget {...props()} />);
    await flush();
    const bar = screen.getByRole('group', { name: 'Summary' });
    expect(bar.textContent).toBe('1 failing workflows0 overdue workflows0 failing CronJobs1 unhealthy workloads');
    expect(screen.getByText('engine')).toBeTruthy();
    expect(screen.getByText('crash loop')).toBeTruthy();
    expect(screen.getByText('exit 1')).toBeTruthy();
    expect(screen.queryByText('web')).toBeNull();
  });

  it('asks only for the namespaces that have workflow series', async () => {
    view(<Widget {...props()} />);
    await flush();
    const asked = queryMetrics.mock.calls.map(c => c[1] as string).filter(q => q.startsWith('kube_deployment_spec_replicas'));
    expect(asked).toEqual(['kube_deployment_spec_replicas{namespace=~"example-ns"}']);
  });

  it('shows only failing rows with onlyFailing', async () => {
    view(<Widget {...props({ onlyFailing: true })} />);
    await flush();
    expect(screen.queryByText('healthy')).toBeNull();
    expect(screen.getByText('broken')).toBeTruthy();
  });

  it('fetches again when the refresh signal changes', async () => {
    const { rerender } = view(<Widget {...props()} />);
    await flush();
    const calls = queryMetrics.mock.calls.length;
    rerender(
      <ThemeProvider theme={createTheme()}>
        <Widget {...props({}, { refreshSignal: 1 })} />
      </ThemeProvider>
    );
    await flush();
    expect(queryMetrics.mock.calls.length).toBe(calls * 2);
  });

  it('shows an error and keeps going when the metrics service fails', async () => {
    queryMetrics.mockRejectedValue(new Error('Metrics service returned HTTP 403'));
    view(<Widget {...props()} />);
    await flush();
    expect(screen.getByText(/HTTP 403/)).toBeTruthy();
  });

  it('keeps the workflows when only the CronJob queries fail', async () => {
    queryMetrics.mockImplementation(async (_t: unknown, q: string) => {
      if (q.includes('_workflow_')) return answer(q);
      throw new Error('no kube-state-metrics');
    });
    view(<Widget {...props()} />);
    await flush();
    expect(screen.getByText('broken')).toBeTruthy();
    expect(screen.getByText(/CronJobs and workloads are missing/)).toBeTruthy();
  });
});

describe('visibleRows', () => {
  const raw = emptyRaw();
  for (const [ns, name] of [['a-ns', 'one'], ['b-ns', 'two']]) {
    raw.lastSuccess.push(s('last_success_timestamp_seconds', NOW, { namespace: ns }, name));
    raw.interval.push(s('expected_interval_seconds', 60, { namespace: ns }, name));
  }
  const rows = buildWorkflowRows(raw);
  it('applies the dashboard namespace filter', () => {
    expect(visibleRows(rows, ['a-ns'], false).map(r => r.name)).toEqual(['one']);
    expect(visibleRows(rows, [], false)).toHaveLength(2);
  });
  it('keeps only problems with onlyFailing', () => {
    expect(visibleRows(rows, [], true)).toHaveLength(0);
  });
});

describe('visibleWorkloads', () => {
  it('keeps unhealthy workloads and applies the namespace filter', () => {
    const w = (namespace: string, severity: 0 | 3) => ({ namespace, severity }) as never;
    expect(visibleWorkloads([w('a', 3), w('a', 0), w('b', 3)], [])).toHaveLength(2);
    expect(visibleWorkloads([w('a', 3), w('b', 3)], ['b'])).toHaveLength(1);
  });
});
