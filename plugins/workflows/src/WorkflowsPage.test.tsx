import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, render, screen, within } from '@testing-library/react';
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
vi.mock('@kinvolk/headlamp-plugin/lib/CommonComponents', () => ({
  SectionBox: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));

import { WorkflowsPage } from './WorkflowsPage';

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const m = (name: string, workflow: string, extra: Record<string, string> = {}) => ({
  __name__: `example_workflow_${name}`,
  workflow,
  kind: 'timer',
  namespace: 'example-ns',
  ...extra,
});
const v = (metric: Record<string, string>, value: number) => ({ metric, value: [NOW, String(value)] as [number, string] });

// Two workflows (one failing on two pods, one event driven) and one CronJob.
const BY_SUFFIX: Record<string, ReturnType<typeof v>[]> = {
  expected_interval_seconds: [
    v(m('expected_interval_seconds', 'sweep', { pod: 'pod-a', component: 'api' }), 300),
    v(m('expected_interval_seconds', 'sweep', { pod: 'pod-b', component: 'engine' }), 300),
    v(m('expected_interval_seconds', 'mail', { kind: 'worker', pod: 'pod-a', component: 'api' }), 0),
  ],
  last_run_timestamp_seconds: [
    v(m('last_run_timestamp_seconds', 'sweep', { pod: 'pod-a', component: 'api' }), NOW - 120),
    v(m('last_run_timestamp_seconds', 'sweep', { pod: 'pod-b', component: 'engine' }), NOW - 60),
  ],
  last_success_timestamp_seconds: [
    v(m('last_success_timestamp_seconds', 'sweep', { pod: 'pod-a', component: 'api' }), NOW - 120),
    v(m('last_success_timestamp_seconds', 'sweep', { pod: 'pod-b', component: 'engine' }), NOW - 7200),
  ],
  consecutive_failures: [
    v(m('consecutive_failures', 'sweep', { pod: 'pod-a', component: 'api' }), 0),
    v(m('consecutive_failures', 'sweep', { pod: 'pod-b', component: 'engine' }), 2),
  ],
  last_error_info: [v(m('last_error_info', 'sweep', { pod: 'pod-b', component: 'engine', error_class: 'http_5xx' }), 1)],
};
const CRON: Record<string, ReturnType<typeof v>[]> = {
  kube_cronjob_status_last_successful_time: [v({ namespace: 'example-ns', cronjob: 'backup' }, NOW - 3600)],
  kube_cronjob_status_last_schedule_time: [v({ namespace: 'example-ns', cronjob: 'backup' }, NOW - 3600)],
  kube_cronjob_next_schedule_time: [v({ namespace: 'example-ns', cronjob: 'backup' }, NOW + 82800)],
  kube_deployment_spec_replicas: [v({ namespace: 'example-ns', deployment: 'api' }, 2), v({ namespace: 'example-ns', deployment: 'idle' }, 0)],
  kube_deployment_status_replicas_ready: [v({ namespace: 'example-ns', deployment: 'api' }, 1)],
  kube_pod_owner: [v({ namespace: 'example-ns', pod: 'api-1-x', owner_kind: 'ReplicaSet', owner_name: 'api-1' }, 1)],
  kube_pod_container_status_restarts_total: [v({ namespace: 'example-ns', pod: 'api-1-x', container: 'main' }, 7)],
  kube_pod_container_status_last_terminated_exitcode: [v({ namespace: 'example-ns', pod: 'api-1-x', container: 'main' }, 2)],
};
const starts = (q: string) => Object.keys(CRON).find(k => q.startsWith(k) || q.startsWith(`increase(${k}`));

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  queryMetrics.mockReset();
  queryMetrics.mockImplementation(async (_t: unknown, q: string) => {
    const wf = /_workflow_([a-z_]+)"/.exec(q);
    if (wf) return BY_SUFFIX[wf[1]] ?? [];
    const key = starts(q);
    return key && !q.includes('kube_pod_status_ready') ? CRON[key] : [];
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const view = () =>
  render(
    <ThemeProvider theme={createTheme()}>
      <WorkflowsPage />
    </ThemeProvider>
  );

describe('WorkflowsPage', () => {
  it('shows one table grouped by namespace with the contract columns', async () => {
    view();
    await act(async () => {});
    const table = screen.getByRole('table', { name: 'Workflows' });
    const headers = within(table).getAllByRole('columnheader').map(h => h.textContent);
    expect(headers).toEqual([
      'Status',
      'Workflow',
      'Kind',
      'Last run',
      'Last success',
      'Failures in a row',
      'Expected interval',
      'Next due',
      'Last error class',
      'Component or pod',
    ]);
    expect(within(table).getByText('example-ns')).toBeTruthy();
  });

  it('sorts the failing row first and shows the worst pod', async () => {
    view();
    await act(async () => {});
    const table = screen.getByRole('table', { name: 'Workflows' });
    const body = within(table).getAllByRole('row').slice(2).map(r => r.textContent ?? '');
    expect(body[0]).toContain('sweep');
    expect(body[0]).toContain('failing');
    expect(body[0]).toContain('http_5xx');
    expect(body[0]).toContain('engine (pod-b) +1');
    expect(body[0]).toContain('2 h ago');
    expect(body.some(r => r.includes('backup') && r.includes('cronjob') && r.includes('ok'))).toBe(true);
    expect(body.some(r => r.includes('mail') && r.includes('idle') && r.includes('event driven'))).toBe(true);
  });

  it('shows the summary bar above both tables', async () => {
    view();
    await act(async () => {});
    const bar = screen.getByRole('group', { name: 'Summary' });
    expect(bar.textContent).toBe('1 failing workflows0 overdue workflows0 failing CronJobs1 unhealthy workloads');
  });

  it('shows the workloads with ready replicas, restarts and the last exit, failing first', async () => {
    view();
    await act(async () => {});
    const table = screen.getByRole('table', { name: 'Workloads' });
    const headers = within(table).getAllByRole('columnheader').map(h => h.textContent);
    expect(headers).toEqual(['Status', 'Workload', 'Kind', 'Ready', 'Not ready for', 'Restarts (24 h)', 'Last exit']);
    const body = within(table).getAllByRole('row').slice(2).map(r => r.textContent ?? '');
    expect(body[0]).toContain('api');
    expect(body[0]).toContain('not ready');
    expect(body[0]).toContain('1/2');
    expect(body[0]).toContain('7');
    expect(body[0]).toContain('exit 2');
    expect(body[1]).toContain('scaled to zero');
    expect(screen.getByText('2 workloads')).toBeTruthy();
  });

  it('shows the count of workflows in a footer', async () => {
    view();
    await act(async () => {});
    expect(screen.getByText('3 workflows')).toBeTruthy();
  });

  it('shows a message when there are no series', async () => {
    queryMetrics.mockResolvedValue([]);
    view();
    await act(async () => {});
    expect(screen.getByText(/No workflows yet/)).toBeTruthy();
  });

  it('shows the error when the metrics service fails', async () => {
    queryMetrics.mockRejectedValue(new Error('Metrics service returned HTTP 403'));
    view();
    await act(async () => {});
    expect(screen.getByText(/HTTP 403/)).toBeTruthy();
  });
});
