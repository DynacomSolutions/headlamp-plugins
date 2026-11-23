import { describe, expect, it } from 'vitest';
import type { MetricSample } from './metrics';
import {
  buildAll,
  buildCronJobRows,
  buildRows,
  buildWorkflowRows,
  buildWorkloadRows,
  cronJobScope,
  deploymentOfReplicaSet,
  deriveStatus,
  deriveWorkloadStatus,
  emptyRaw,
  errorLabel,
  formatAge,
  formatDuration,
  formatExit,
  formatNextDue,
  groupKeyOf,
  groupRows,
  healthSummary,
  isUnhealthy,
  kubeQueries,
  nextDue,
  normaliseConfig,
  prefixOf,
  Raw,
  resolveSettings,
  Scope,
  SUFFIXES,
  SuffixKey,
  summarise,
  workflowQueries,
  WorkloadKey,
} from './model';

const NOW = 1_800_000_000;
const sample = (metric: Record<string, string>, value: number): MetricSample => ({ metric, value: [NOW, String(value)] });

interface Wf {
  workflow: string;
  kind?: string;
  prefix?: string;
  namespace?: string | null;
  pod?: string;
  component?: string;
  interval?: number;
  registered?: number;
  lastRun?: number;
  lastSuccess?: number;
  nextRun?: number;
  failures?: number;
  overdue?: number;
  errorClass?: string;
}

/** Adds one workflow series set to the raw samples. */
function add(raw: Raw, w: Wf): void {
  const prefix = w.prefix ?? 'example';
  const labels: Record<string, string> = { workflow: w.workflow, kind: w.kind ?? 'poller', pod: w.pod ?? 'pod-a', component: w.component ?? 'api' };
  if (w.namespace !== null) labels.namespace = w.namespace ?? 'example-ns';
  const values: Record<Exclude<SuffixKey, 'errorInfo'>, number> = {
    interval: w.interval ?? 60,
    registered: w.registered ?? NOW - 86400,
    lastRun: w.lastRun ?? NOW - 30,
    lastSuccess: w.lastSuccess ?? NOW - 30,
    nextRun: w.nextRun ?? 0,
    failures: w.failures ?? 0,
    overdue: w.overdue ?? 0,
  };
  for (const key of Object.keys(values) as (keyof typeof values)[]) {
    raw[key].push(sample({ __name__: `${prefix}_workflow_${SUFFIXES[key]}`, ...labels }, values[key]));
  }
  raw.errorInfo.push(sample({ __name__: `${prefix}_workflow_${SUFFIXES.errorInfo}`, ...labels, error_class: w.errorClass ?? 'none' }, 1));
}

const rowOf = (w: Wf) => {
  const raw = emptyRaw();
  add(raw, w);
  return buildWorkflowRows(raw)[0];
};

describe('queries', () => {
  it('finds the prefixes at run time and fixes none', () => {
    const q = workflowQueries();
    expect(q.lastSuccess).toBe('{__name__=~".+_workflow_last_success_timestamp_seconds"}');
    for (const text of Object.values(q)) expect(text).toMatch(/^\{__name__=~"\.\+_workflow_[a-z_]+"\}$/);
  });

  it('reads the prefix from a series name', () => {
    expect(prefixOf('example_workflow_overdue', 'overdue')).toBe('example');
    expect(prefixOf('a_b_workflow_overdue', 'overdue')).toBe('a_b');
    expect(prefixOf('example_workflow_overdue', 'consecutive_failures')).toBeUndefined();
    expect(prefixOf(undefined, 'overdue')).toBeUndefined();
  });

  it('keeps the failed Job query to Jobs that did not succeed', () => {
    const q = kubeQueries({ all: true, namespaces: new Set() })!.cron.failedJobs;
    expect(q).toContain('kube_job_owner{owner_kind="CronJob"}');
    expect(q).toContain('kube_job_status_failed > 0');
    expect(q).toContain('unless on(namespace, job_name) (kube_job_status_succeeded > 0)');
  });

  it('limits the kube-state-metrics queries to the namespaces in scope', () => {
    const q = kubeQueries({ all: false, namespaces: new Set(['example-ns', 'other.ns', 'bad"ns']) })!;
    expect(q.cron.lastSuccess).toBe('kube_cronjob_status_last_successful_time{namespace=~"example-ns|other\\\\.ns"}');
    expect(q.workloads.deployDesired).toContain('namespace=~"example-ns|other');
    expect(JSON.stringify(q)).not.toContain('bad');
    expect(q.workloads.crashLoop).toBe('kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff",namespace=~"example-ns|other\\\\.ns"} == 1');
    expect(q.workloads.restarts).toMatch(/^increase\(kube_pod_container_status_restarts_total\{.*\}\[24h\]\)$/);
  });

  it('reads the whole cluster for the scope *, and nothing for an empty scope', () => {
    expect(kubeQueries({ all: true, namespaces: new Set() })!.cron.lastSuccess).toBe('kube_cronjob_status_last_successful_time');
    expect(kubeQueries({ all: false, namespaces: new Set() })).toBeUndefined();
  });
});

describe('deriveStatus', () => {
  const base = { interval: 60, failures: 0, overdue: false, lastRun: NOW };
  it('is ok after a run with no failures', () => {
    expect(deriveStatus(base)).toEqual({ status: 'ok', severity: 0 });
  });
  it('is amber for 1 or 2 failures in a row and red from 3', () => {
    expect(deriveStatus({ ...base, failures: 1 })).toEqual({ status: 'failing', severity: 2 });
    expect(deriveStatus({ ...base, failures: 2 })).toEqual({ status: 'failing', severity: 2 });
    expect(deriveStatus({ ...base, failures: 3 })).toEqual({ status: 'failing', severity: 3 });
  });
  it('is red when overdue', () => {
    expect(deriveStatus({ ...base, overdue: true })).toEqual({ status: 'overdue', severity: 3 });
    expect(deriveStatus({ ...base, overdue: true, failures: 1 })).toEqual({ status: 'overdue', severity: 3 });
  });
  it('is never run when there was no run and it is not overdue', () => {
    expect(deriveStatus({ ...base, lastRun: 0 })).toEqual({ status: 'never run', severity: 1 });
  });
  it('is idle when event driven with no failures', () => {
    expect(deriveStatus({ ...base, interval: 0, lastRun: 0 })).toEqual({ status: 'idle', severity: 0 });
    expect(deriveStatus({ ...base, interval: 0 })).toEqual({ status: 'idle', severity: 0 });
    expect(deriveStatus({ ...base, interval: 0, failures: 1 })).toEqual({ status: 'failing', severity: 2 });
  });
  it('is suspended for a suspended CronJob, whatever else is true', () => {
    expect(deriveStatus({ ...base, suspended: true, overdue: true, failures: 5, isCronJob: true })).toEqual({ status: 'suspended', severity: 0 });
  });
});

describe('workflow rows', () => {
  it('builds one row from the series of one workflow', () => {
    const r = rowOf({ workflow: 'fx-rates', interval: 3600, lastSuccess: NOW - 600, errorClass: 'none' });
    expect(r).toMatchObject({ name: 'fx-rates', kind: 'poller', status: 'ok', interval: 3600, failures: 0, namespace: 'example-ns', prefix: 'example', errorClass: 'none' });
    expect(r.lastSuccess).toBe(NOW - 600);
  });

  it('reports the last error class of a failing workflow', () => {
    const r = rowOf({ workflow: 'news', failures: 2, errorClass: 'rate_limited' });
    expect(r.status).toBe('failing');
    expect(r.severity).toBe(2);
    expect(r.errorClass).toBe('rate_limited');
  });

  it('marks a workflow that never ran, unless it is overdue', () => {
    expect(rowOf({ workflow: 'a', lastRun: 0, lastSuccess: 0 }).status).toBe('never run');
    expect(rowOf({ workflow: 'a', lastRun: 0, lastSuccess: 0, overdue: 1 }).status).toBe('overdue');
  });

  it('marks an event driven workflow idle and gives it no due time', () => {
    const r = rowOf({ workflow: 'mail', kind: 'worker', interval: 0, lastRun: 0, lastSuccess: 0 });
    expect(r.status).toBe('idle');
    expect(r.eventDriven).toBe(true);
    expect(r.nextDue).toBe(0);
    expect(formatNextDue(r, NOW)).toBe('event driven');
  });

  it('folds several pods into the worst one and lists them all', () => {
    const raw = emptyRaw();
    add(raw, { workflow: 'sweep', kind: 'timer', pod: 'pod-a', component: 'api' });
    add(raw, { workflow: 'sweep', kind: 'timer', pod: 'pod-b', component: 'engine', failures: 4, errorClass: 'timeout' });
    const rows = buildWorkflowRows(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failing');
    expect(rows[0].severity).toBe(3);
    expect(rows[0].errorClass).toBe('timeout');
    expect(rows[0].where).toBe('engine (pod-b)');
    expect(rows[0].instances.map(i => i.label)).toEqual(['pod-b', 'pod-a']);
  });

  it('keeps the same workflow in two namespaces or prefixes apart', () => {
    const raw = emptyRaw();
    add(raw, { workflow: 'sweep', namespace: 'example-ns' });
    add(raw, { workflow: 'sweep', namespace: 'other-ns' });
    add(raw, { workflow: 'sweep', prefix: 'sample', namespace: 'example-ns' });
    expect(buildWorkflowRows(raw)).toHaveLength(3);
  });

  it('drops a series that vanished (the pod is gone)', () => {
    const raw = emptyRaw();
    add(raw, { workflow: 'sweep', pod: 'pod-a' });
    add(raw, { workflow: 'old-job', pod: 'pod-a' });
    add(raw, { workflow: 'sweep', pod: 'pod-old', failures: 9 });
    expect(buildWorkflowRows(raw).map(r => r.name).sort()).toEqual(['old-job', 'sweep']);
    // The next refresh has no series of the old pod and none of old-job.
    const next = emptyRaw();
    add(next, { workflow: 'sweep', pod: 'pod-a' });
    const rows = buildWorkflowRows(next);
    expect(rows.map(r => r.name)).toEqual(['sweep']);
    expect(rows[0].instances).toHaveLength(1);
    expect(rows[0].status).toBe('ok');
  });

  it('ignores a sample with no workflow label or a foreign series name', () => {
    const raw = emptyRaw();
    raw.lastSuccess.push(sample({ __name__: 'example_workflow_last_success_timestamp_seconds' }, NOW));
    raw.lastSuccess.push(sample({ __name__: 'something_else', workflow: 'x' }, NOW));
    expect(buildWorkflowRows(raw)).toEqual([]);
  });
});

describe('nextDue', () => {
  it('uses the next run of the workflow first', () => {
    expect(nextDue({ nextRun: NOW + 100, lastSuccess: NOW - 10, interval: 60 })).toBe(NOW + 100);
  });
  it('falls back to last success plus the interval', () => {
    expect(nextDue({ nextRun: 0, lastSuccess: NOW - 10, interval: 60 })).toBe(NOW + 50);
  });
  it('uses the registration time while there is no success', () => {
    expect(nextDue({ nextRun: 0, lastSuccess: 0, interval: 60, registered: NOW - 5 })).toBe(NOW + 55);
    expect(nextDue({ nextRun: 0, lastSuccess: 0, interval: 60 })).toBe(0);
  });
  it('is unknown for an event driven workflow', () => {
    expect(nextDue({ nextRun: 0, lastSuccess: NOW, interval: 0 })).toBe(0);
  });
  it('is shown as overdue by the lateness', () => {
    const r = rowOf({ workflow: 'a', interval: 60, lastSuccess: NOW - 3 * 3600, lastRun: NOW - 3 * 3600, overdue: 1 });
    expect(r.nextDue).toBe(NOW - 3 * 3600 + 60);
    expect(formatNextDue(r, NOW)).toBe('overdue by 3 h');
  });
  it('is shown as in the future when due later', () => {
    const r = rowOf({ workflow: 'a', interval: 3600, lastSuccess: NOW - 600 });
    expect(formatNextDue(r, NOW)).toBe('in 50 min');
  });
});

describe('CronJob rows', () => {
  const NS = 'example-ns';
  const cj = (name: string, vals: { success?: number; schedule?: number; next?: number; suspend?: number; created?: number }, ns = NS): Raw => {
    const raw = emptyRaw();
    const m = { namespace: ns, cronjob: name };
    if (vals.success !== undefined) raw.cron.lastSuccess.push(sample(m, vals.success));
    if (vals.schedule !== undefined) raw.cron.lastSchedule.push(sample(m, vals.schedule));
    if (vals.next !== undefined) raw.cron.nextSchedule.push(sample(m, vals.next));
    raw.cron.suspended.push(sample(m, vals.suspend ?? 0));
    raw.cron.created.push(sample(m, vals.created ?? NOW - 30 * 86400));
    return raw;
  };
  const all = { all: true, namespaces: new Set<string>() };

  it('derives an ok CronJob with its interval from the schedule times', () => {
    const raw = cj('backup', { success: NOW - 3600, schedule: NOW - 3600, next: NOW + 82800 });
    const [r] = buildCronJobRows(raw, all, NOW);
    expect(r).toMatchObject({ name: 'backup', kind: 'cronjob', status: 'ok', interval: 86400, lastSuccess: NOW - 3600, lastRun: NOW - 3600, nextDue: NOW + 82800, failures: 0 });
  });

  it('is overdue after more than twice the interval without a success', () => {
    const raw = cj('check', { success: NOW - 2 * 1200 - 1, schedule: NOW - 600, next: NOW + 600 });
    const [r] = buildCronJobRows(raw, all, NOW);
    expect(r.interval).toBe(1200);
    expect(r.status).toBe('overdue');
    const ok = buildCronJobRows(cj('check', { success: NOW - 2 * 1200, schedule: NOW - 600, next: NOW + 600 }), all, NOW)[0];
    expect(ok.status).toBe('ok');
  });

  it('counts from the creation time when there was never a success', () => {
    const raw = cj('new', { schedule: NOW - 600, next: NOW + 600, created: NOW - 10 * 1200 });
    const [r] = buildCronJobRows(raw, all, NOW);
    expect(r.lastSuccess).toBe(0);
    expect(r.status).toBe('overdue');
    const fresh = buildCronJobRows(cj('new', { schedule: NOW - 600, next: NOW + 600, created: NOW - 1200 }), all, NOW)[0];
    expect(fresh.status).toBe('ok');
  });

  it('shows a suspended CronJob as suspended and never overdue', () => {
    const raw = cj('paused', { success: NOW - 100 * 86400, schedule: NOW - 100 * 86400, next: NOW - 99 * 86400, suspend: 1 });
    const [r] = buildCronJobRows(raw, all, NOW);
    expect(r.status).toBe('suspended');
    expect(r.nextDue).toBe(0);
    expect(formatNextDue(r, NOW)).toBe('suspended');
  });

  it('shows a CronJob that has not been scheduled yet as never run', () => {
    const raw = cj('fresh', { created: NOW - 100 });
    const [r] = buildCronJobRows(raw, all, NOW);
    expect(r.status).toBe('never run');
    expect(r.interval).toBe(0);
    expect(r.eventDriven).toBe(false);
  });

  it('counts the failed Jobs that are newer than the last success', () => {
    const raw = cj('sync', { success: NOW - 1000, schedule: NOW - 100, next: NOW + 500 });
    const failed = (created: number, owner = 'sync', ns = NS) => sample({ namespace: ns, job_name: `${owner}-${created}`, owner_name: owner }, created);
    raw.cron.failedJobs.push(failed(NOW - 2000), failed(NOW - 900), failed(NOW - 300), failed(NOW - 100), failed(NOW - 50, 'other'));
    const [r] = buildCronJobRows(raw, all, NOW);
    expect(r.failures).toBe(3);
    expect(r.status).toBe('failing');
    expect(r.severity).toBe(3);
  });

  it('shows 1 or 2 failed Jobs as amber', () => {
    const raw = cj('sync', { success: NOW - 1000, schedule: NOW - 100, next: NOW + 500 });
    raw.cron.failedJobs.push(sample({ namespace: NS, job_name: 'j1', owner_name: 'sync' }, NOW - 100));
    const [r] = buildCronJobRows(raw, all, NOW);
    expect(r).toMatchObject({ failures: 1, status: 'failing', severity: 2 });
  });

  it('keeps only the namespaces in scope', () => {
    const raw = cj('in', { success: NOW, schedule: NOW, next: NOW + 60 });
    const other = cj('out', { success: NOW, schedule: NOW, next: NOW + 60 }, 'other-ns');
    for (const k of Object.keys(raw.cron) as (keyof Raw['cron'])[]) raw.cron[k].push(...other.cron[k]);
    expect(buildCronJobRows(raw, { all: false, namespaces: new Set([NS]) }, NOW).map(r => r.name)).toEqual(['in']);
    expect(buildCronJobRows(raw, all, NOW).map(r => r.name).sort()).toEqual(['in', 'out']);
    expect(buildCronJobRows(raw, { all: false, namespaces: new Set() }, NOW)).toEqual([]);
  });
});

describe('cronJobScope and buildRows', () => {
  it('defaults to the namespaces that have workflow series', () => {
    const raw = emptyRaw();
    add(raw, { workflow: 'a', namespace: 'example-ns' });
    add(raw, { workflow: 'b', namespace: null });
    const rows = buildWorkflowRows(raw);
    expect(cronJobScope('', rows)).toEqual({ all: false, namespaces: new Set(['example-ns']) });
    expect(cronJobScope('extra-ns, more-ns', rows).namespaces).toEqual(new Set(['example-ns', 'extra-ns', 'more-ns']));
    expect(cronJobScope('*', rows).all).toBe(true);
  });

  it('puts workflows and CronJobs of one namespace in one table', () => {
    const raw = emptyRaw();
    add(raw, { workflow: 'poll' });
    raw.cron.lastSuccess.push(sample({ namespace: 'example-ns', cronjob: 'backup' }, NOW - 60));
    raw.cron.lastSchedule.push(sample({ namespace: 'example-ns', cronjob: 'backup' }, NOW - 60));
    raw.cron.nextSchedule.push(sample({ namespace: 'example-ns', cronjob: 'backup' }, NOW + 60));
    raw.cron.lastSuccess.push(sample({ namespace: 'unrelated-ns', cronjob: 'x' }, NOW - 60));
    expect(buildRows(raw, '', NOW).map(r => r.id).sort()).toEqual(['cronjob/example-ns/backup', 'example/example-ns/poll']);
    expect(buildRows(raw, '*', NOW)).toHaveLength(3);
  });
});

describe('grouping and sorting', () => {
  const raw = emptyRaw();
  add(raw, { workflow: 'z-ok' });
  add(raw, { workflow: 'a-ok' });
  add(raw, { workflow: 'warn', failures: 1 });
  add(raw, { workflow: 'bad', failures: 5 });
  add(raw, { workflow: 'late', overdue: 1 });
  add(raw, { workflow: 'plain', namespace: null, prefix: 'sample' });
  add(raw, { workflow: 'fail-elsewhere', namespace: 'aaa-ns', failures: 1 });
  const rows = buildWorkflowRows(raw);

  it('groups by the namespace label, else the prefix', () => {
    expect(groupKeyOf(rows.find(r => r.name === 'plain')!, 'auto')).toBe('sample');
    expect(groupKeyOf(rows.find(r => r.name === 'bad')!, 'auto')).toBe('example-ns');
    expect(groupKeyOf(rows.find(r => r.name === 'bad')!, 'namespace')).toBe('example-ns');
    expect(groupKeyOf(rows.find(r => r.name === 'bad')!, 'prefix')).toBe('example');
  });

  it('sorts failing and overdue rows first inside a group', () => {
    const g = groupRows(rows, 'auto').find(x => x.key === 'example-ns')!;
    expect(g.rows.map(r => r.name)).toEqual(['bad', 'late', 'warn', 'a-ok', 'z-ok']);
  });

  it('sorts the groups with problems first, then by name', () => {
    expect(groupRows(rows, 'auto').map(g => g.key)).toEqual(['example-ns', 'aaa-ns', 'sample']);
  });

  it('groups by prefix and counts the statuses', () => {
    const groups = groupRows(rows, 'prefix');
    expect(groups.map(g => g.key)).toEqual(['example', 'sample']);
    expect(groups[0].counts).toMatchObject({ ok: 2, failing: 3, overdue: 1 });
    expect(groups[0].prefixes).toEqual(['example']);
  });

  it('puts a CronJob without a prefix in its namespace when grouping by prefix', () => {
    const cron = emptyRaw();
    cron.cron.lastSuccess.push(sample({ namespace: 'example-ns', cronjob: 'backup' }, NOW));
    const [r] = buildCronJobRows(cron, { all: true, namespaces: new Set() }, NOW);
    expect(groupKeyOf(r, 'prefix')).toBe('example-ns');
  });

  it('summarises the statuses', () => {
    expect(summarise(rows)).toEqual({ total: 7, failing: 3, overdue: 1, neverRun: 0, ok: 3 });
  });
});

describe('formatting', () => {
  it('formats durations and ages', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(600)).toBe('10 min');
    expect(formatDuration(3 * 3600)).toBe('3 h');
    expect(formatDuration(3 * 86400)).toBe('3 d');
    expect(formatAge(NOW - 600, NOW)).toBe('10 min ago');
    expect(formatAge(0, NOW)).toBe('-');
  });
});

describe('settings', () => {
  it('lets blank fields fall back to the deployment default, then the built-in default', () => {
    expect(resolveSettings(undefined, undefined).metricsService).toBe('victoria-metrics');
    expect(resolveSettings({ metricsService: ' ' }, { metricsService: 'vm', cronJobNamespaces: '*' })).toMatchObject({ metricsService: 'vm', cronJobNamespaces: '*' });
    expect(resolveSettings({ metricsService: 'mine' }, { metricsService: 'vm' }).metricsService).toBe('mine');
  });
  it('falls back to defaults for bad widget settings', () => {
    expect(normaliseConfig({ groupBy: 'nope' as never, onlyFailing: 'yes' as never })).toEqual({ onlyFailing: false, groupBy: 'auto' });
    expect(normaliseConfig({ groupBy: 'prefix', onlyFailing: true })).toEqual({ onlyFailing: true, groupBy: 'prefix' });
    expect(normaliseConfig(undefined)).toEqual({ onlyFailing: false, groupBy: 'auto' });
  });
});

describe('state error class and event driven failures', () => {
  it('shows the state class as "condition not met"', () => {
    expect(errorLabel('state')).toBe('condition not met');
    expect(errorLabel('timeout')).toBe('timeout');
    expect(errorLabel('none')).toBe('-');
  });
  it('marks an event driven workflow with a failure streak as failing', () => {
    const r = rowOf({ workflow: 'trading-loop', kind: 'worker', interval: 0, failures: 5, errorClass: 'state' });
    expect(r).toMatchObject({ status: 'failing', severity: 3, eventDriven: true, errorClass: 'state' });
    expect(rowOf({ workflow: 'trading-loop', kind: 'worker', interval: 0, failures: 1 })).toMatchObject({ status: 'failing', severity: 2 });
  });
  it('keeps overdue working for a worker with an interval', () => {
    expect(rowOf({ workflow: 'archive', kind: 'worker', interval: 150, overdue: 1 }).status).toBe('overdue');
  });
});

describe('workload status', () => {
  const base = { desired: 2, ready: 2, crashLoop: false, notReadySeconds: 0 };
  it('is ok when every replica is ready', () => {
    expect(deriveWorkloadStatus(base)).toEqual({ status: 'ok', severity: 0 });
  });
  it('is amber when not ready for under 2 minutes, then red', () => {
    expect(deriveWorkloadStatus({ ...base, ready: 1, notReadySeconds: 119 })).toEqual({ status: 'not ready', severity: 2 });
    expect(deriveWorkloadStatus({ ...base, ready: 1, notReadySeconds: 120 })).toEqual({ status: 'not ready', severity: 3 });
  });
  it('is red in a crash loop, even when another replica is ready', () => {
    expect(deriveWorkloadStatus({ ...base, ready: 1, crashLoop: true })).toEqual({ status: 'crash loop', severity: 3 });
    expect(deriveWorkloadStatus({ ...base, crashLoop: true })).toEqual({ status: 'crash loop', severity: 3 });
  });
  it('treats a workload scaled to zero as no failure', () => {
    expect(deriveWorkloadStatus({ desired: 0, ready: 0, crashLoop: false, notReadySeconds: 9999 })).toEqual({ status: 'scaled to zero', severity: 0 });
    expect(deriveWorkloadStatus({ desired: 0, ready: 0, crashLoop: true, notReadySeconds: 0 })).toEqual({ status: 'scaled to zero', severity: 0 });
  });
});

describe('workload rows', () => {
  const NS = 'example-ns';
  const all: Scope = { all: true, namespaces: new Set() };
  const k = (kind: WorkloadKey, labels: Record<string, string>, value: number): [WorkloadKey, MetricSample] => [kind, sample({ namespace: NS, ...labels }, value)];
  const rawOf = (entries: [WorkloadKey, MetricSample][]): Raw => {
    const raw = emptyRaw();
    for (const [key, s] of entries) raw.workloads[key].push(s);
    return raw;
  };
  const deploy = (name: string, desired: number, ready: number) => [
    k('deployDesired', { deployment: name }, desired),
    k('deployReady', { deployment: name }, ready),
  ];
  const pod = (name: string, owner: string, kind = 'ReplicaSet') => k('podOwner', { pod: name, owner_kind: kind, owner_name: owner }, 1);

  it('finds the Deployment of a ReplicaSet by its hash suffix', () => {
    expect(deploymentOfReplicaSet('api-7d9f8c6b5d')).toBe('api');
    expect(deploymentOfReplicaSet('my-api-server-6c4d8f9b7')).toBe('my-api-server');
  });

  it('shows a healthy Deployment and a StatefulSet as ok', () => {
    const raw = rawOf([
      ...deploy('api', 2, 2),
      k('stsDesired', { statefulset: 'db' }, 3),
      k('stsReady', { statefulset: 'db' }, 3),
    ]);
    const rows = buildWorkloadRows(raw, all);
    expect(rows.map(r => [r.kind, r.name, r.status, `${r.ready}/${r.desired}`])).toEqual([
      ['Deployment', 'api', 'ok', '2/2'],
      ['StatefulSet', 'db', 'ok', '3/3'],
    ]);
  });

  it('finds a crash loop, the restarts in 24 hours and the last exit', () => {
    const raw = rawOf([
      ...deploy('engine', 1, 0),
      pod('engine-5d6f7b8c9-abcde', 'engine-5d6f7b8c9'),
      k('crashLoop', { pod: 'engine-5d6f7b8c9-abcde', container: 'main' }, 1),
      k('restarts', { pod: 'engine-5d6f7b8c9-abcde', container: 'main' }, 41.6),
      k('restarts', { pod: 'engine-5d6f7b8c9-abcde', container: 'sidecar' }, 0.2),
      k('exitCode', { pod: 'engine-5d6f7b8c9-abcde', container: 'main' }, 137),
      k('exitCode', { pod: 'engine-5d6f7b8c9-abcde', container: 'sidecar' }, 0),
      k('exitReason', { pod: 'engine-5d6f7b8c9-abcde', container: 'main', reason: 'OOMKilled' }, 1),
      k('exitReason', { pod: 'engine-5d6f7b8c9-abcde', container: 'sidecar', reason: 'Completed' }, 1),
    ]);
    const [r] = buildWorkloadRows(raw, all);
    expect(r).toMatchObject({ status: 'crash loop', severity: 3, crashLoop: true, restarts24h: 42, ready: 0, desired: 1 });
    expect(r.lastExit).toMatchObject({ code: 137, reason: 'OOMKilled', container: 'main' });
    expect(formatExit(r.lastExit)).toBe('exit 137 (OOMKilled)');
    expect(r.pods).toEqual(['engine-5d6f7b8c9-abcde']);
  });

  it('measures how long a pod was not ready, from the last ready time or the pod age', () => {
    const raw = rawOf([
      ...deploy('api', 2, 1),
      pod('api-aaa111-pod1', 'api-aaa111'),
      pod('api-aaa111-pod2', 'api-aaa111'),
      k('notReady', { pod: 'api-aaa111-pod2' }, 1),
      k('sinceReady', { pod: 'api-aaa111-pod2' }, 90),
      k('podAge', { pod: 'api-aaa111-pod2' }, 3600),
    ]);
    const [r] = buildWorkloadRows(raw, all);
    expect(r).toMatchObject({ status: 'not ready', severity: 2, notReadySeconds: 90 });
    // A pod that was never ready in 24 hours has no "since ready" value: the pod age counts.
    const never = rawOf([
      ...deploy('api', 1, 0),
      pod('api-bbb222-pod1', 'api-bbb222'),
      k('notReady', { pod: 'api-bbb222-pod1' }, 1),
      k('podAge', { pod: 'api-bbb222-pod1' }, 8 * 86400),
    ]);
    expect(buildWorkloadRows(never, all)[0]).toMatchObject({ status: 'not ready', severity: 3, notReadySeconds: 8 * 86400 });
    // The pod age is the upper bound.
    const young = rawOf([
      ...deploy('api', 1, 0),
      pod('api-ccc333-pod1', 'api-ccc333'),
      k('notReady', { pod: 'api-ccc333-pod1' }, 1),
      k('sinceReady', { pod: 'api-ccc333-pod1' }, 5000),
      k('podAge', { pod: 'api-ccc333-pod1' }, 30),
    ]);
    expect(buildWorkloadRows(young, all)[0].notReadySeconds).toBe(30);
  });

  it('does not count a workload scaled to zero as a failure', () => {
    const raw = rawOf([...deploy('paused', 0, 0), ...deploy('api', 1, 1)]);
    const rows = buildWorkloadRows(raw, all);
    expect(rows.find(r => r.name === 'paused')).toMatchObject({ status: 'scaled to zero', severity: 0 });
    expect(rows.filter(isUnhealthy)).toEqual([]);
  });

  it('sorts failing workloads first', () => {
    const raw = rawOf([
      ...deploy('a-ok', 1, 1),
      ...deploy('b-slow', 1, 0),
      ...deploy('c-loop', 1, 0),
      pod('c-loop-111-x', 'c-loop-111'),
      k('crashLoop', { pod: 'c-loop-111-x', container: 'main' }, 1),
      pod('b-slow-222-x', 'b-slow-222'),
      k('notReady', { pod: 'b-slow-222-x' }, 1),
      k('podAge', { pod: 'b-slow-222-x' }, 10),
    ]);
    expect(buildWorkloadRows(raw, all).map(r => [r.name, r.status])).toEqual([
      ['c-loop', 'crash loop'],
      ['b-slow', 'not ready'],
      ['a-ok', 'ok'],
    ]);
  });

  it('keeps only the namespaces in scope and ignores pods of other owners', () => {
    const raw = rawOf([...deploy('api', 1, 1), pod('job-pod', 'some-job', 'Job'), k('restarts', { pod: 'job-pod', container: 'x' }, 9)]);
    raw.workloads.deployDesired.push(sample({ namespace: 'other-ns', deployment: 'api' }, 1));
    const rows = buildWorkloadRows(raw, { all: false, namespaces: new Set([NS]) });
    expect(rows).toHaveLength(1);
    expect(rows[0].restarts24h).toBe(0);
    expect(buildWorkloadRows(raw, all)).toHaveLength(2);
  });
});

describe('health summary', () => {
  it('counts failing and overdue workflows, failing CronJobs and unhealthy workloads', () => {
    const raw = emptyRaw();
    add(raw, { workflow: 'one', failures: 1 });
    add(raw, { workflow: 'two', failures: 4 });
    add(raw, { workflow: 'three', overdue: 1 });
    add(raw, { workflow: 'four' });
    const m = { namespace: 'example-ns', cronjob: 'backup' };
    raw.cron.lastSuccess.push(sample(m, NOW - 10 * 86400));
    raw.cron.lastSchedule.push(sample(m, NOW - 600));
    raw.cron.nextSchedule.push(sample(m, NOW + 600));
    raw.workloads.deployDesired.push(sample({ namespace: 'example-ns', deployment: 'api' }, 1));
    raw.workloads.deployReady.push(sample({ namespace: 'example-ns', deployment: 'api' }, 0));
    const built = buildAll(raw, '', NOW);
    expect(healthSummary(built.rows, built.workloads)).toEqual({ failingWorkflows: 2, overdueWorkflows: 1, failingCronJobs: 1, unhealthyWorkloads: 1 });
  });
  it('is all zero when nothing is wrong', () => {
    expect(healthSummary([], [])).toEqual({ failingWorkflows: 0, overdueWorkflows: 0, failingCronJobs: 0, unhealthyWorkloads: 0 });
  });
});
