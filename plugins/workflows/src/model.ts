/*
 * The workflow model: turns the raw instant-query samples into one row per workflow.
 *
 * Two sources feed it:
 *  - `<prefix>_workflow_*` series that an app exports itself (see the README). The prefix is found at
 *    run time from the series names, never fixed in the plugin.
 *  - CronJobs from kube-state-metrics (`kube_cronjob_*`, `kube_job_*`).
 *
 * Everything here is pure: the page and the widget call it with samples and a clock.
 */
import type { MetricSample } from './metrics';

/** The workflow series suffixes that the plugin reads (after `<prefix>_workflow_`). */
export const SUFFIXES = {
  interval: 'expected_interval_seconds',
  registered: 'registered_timestamp_seconds',
  lastRun: 'last_run_timestamp_seconds',
  lastSuccess: 'last_success_timestamp_seconds',
  nextRun: 'next_run_timestamp_seconds',
  failures: 'consecutive_failures',
  overdue: 'overdue',
  errorInfo: 'last_error_info',
} as const;

export type SuffixKey = keyof typeof SUFFIXES;

/** Instant queries, one per series family. The prefix is the series name without the suffix. */
export function workflowQueries(): Record<SuffixKey, string> {
  const out = {} as Record<SuffixKey, string>;
  for (const key of Object.keys(SUFFIXES) as SuffixKey[]) {
    out[key] = `{__name__=~".+_workflow_${SUFFIXES[key]}"}`;
  }
  return out;
}

export type CronJobKey = 'lastSuccess' | 'lastSchedule' | 'nextSchedule' | 'suspended' | 'created' | 'failedJobs';
export type WorkloadKey =
  | 'deployDesired'
  | 'deployReady'
  | 'stsDesired'
  | 'stsReady'
  | 'podOwner'
  | 'restarts'
  | 'exitCode'
  | 'exitReason'
  | 'crashLoop'
  | 'notReady'
  | 'sinceReady'
  | 'podAge';

export type Raw = Record<SuffixKey, MetricSample[]> & {
  cron: Record<CronJobKey, MetricSample[]>;
  workloads: Record<WorkloadKey, MetricSample[]>;
};

export function emptyRaw(): Raw {
  return {
    interval: [],
    registered: [],
    lastRun: [],
    lastSuccess: [],
    nextRun: [],
    failures: [],
    overdue: [],
    errorInfo: [],
    cron: { lastSuccess: [], lastSchedule: [], nextSchedule: [], suspended: [], created: [], failedJobs: [] },
    workloads: {
      deployDesired: [],
      deployReady: [],
      stsDesired: [],
      stsReady: [],
      podOwner: [],
      restarts: [],
      exitCode: [],
      exitReason: [],
      crashLoop: [],
      notReady: [],
      sinceReady: [],
      podAge: [],
    },
  };
}

/** Which namespaces the kube-state-metrics queries read: all of them, or a list. */
export interface Scope {
  all: boolean;
  namespaces: Set<string>;
}

/** A namespace name is a DNS label. Anything else in the setting is dropped before it reaches a query. */
const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The kube-state-metrics queries for a scope, or undefined when the scope is empty (nothing to read). */
export function kubeQueries(scope: Scope): { cron: Record<CronJobKey, string>; workloads: Record<WorkloadKey, string> } | undefined {
  const names = [...scope.namespaces].filter(n => NAMESPACE_RE.test(n)).sort();
  if (!scope.all && names.length === 0) return undefined;
  const ns = scope.all ? '' : `namespace=~"${names.map(n => n.replace(/\./g, '\\\\.')).join('|')}"`;
  const m = (metric: string, extra?: string): string => {
    const matchers = [extra, ns].filter(Boolean).join(',');
    return matchers ? `${metric}{${matchers}}` : metric;
  };
  const notReady = `(${m('kube_pod_status_ready', 'condition="false"')} == 1 and on(namespace, pod) (${m('kube_pod_status_phase', 'phase=~"Pending|Running"')} == 1))`;
  return {
    cron: {
      lastSuccess: m('kube_cronjob_status_last_successful_time'),
      lastSchedule: m('kube_cronjob_status_last_schedule_time'),
      nextSchedule: m('kube_cronjob_next_schedule_time'),
      suspended: m('kube_cronjob_spec_suspend'),
      created: m('kube_cronjob_created'),
      // One series per failed Job, with its creation time as the value. A Job that also succeeded is not failed.
      failedJobs:
        `(${m('kube_job_created')} * on(namespace, job_name) group_left(owner_name) ${m('kube_job_owner', 'owner_kind="CronJob"')})` +
        ` and on(namespace, job_name) (${m('kube_job_status_failed')} > 0)` +
        ` unless on(namespace, job_name) (${m('kube_job_status_succeeded')} > 0)`,
    },
    workloads: {
      deployDesired: m('kube_deployment_spec_replicas'),
      deployReady: m('kube_deployment_status_replicas_ready'),
      stsDesired: m('kube_statefulset_replicas'),
      stsReady: m('kube_statefulset_status_replicas_ready'),
      podOwner: m('kube_pod_owner', 'owner_kind=~"ReplicaSet|StatefulSet"'),
      restarts: `increase(${m('kube_pod_container_status_restarts_total')}[24h])`,
      exitCode: m('kube_pod_container_status_last_terminated_exitcode'),
      exitReason: `${m('kube_pod_container_status_last_terminated_reason')} == 1`,
      crashLoop: `${m('kube_pod_container_status_waiting_reason', 'reason="CrashLoopBackOff"')} == 1`,
      notReady,
      // Seconds since the pod was last Ready (absent when it was not Ready in the last 24 hours) and the pod age.
      sinceReady: `(time() - max_over_time(timestamp(${m('kube_pod_status_ready', 'condition="true"')} == 1)[24h:1m])) and on(namespace, pod) ${notReady}`,
      podAge: `(time() - ${m('kube_pod_created')}) and on(namespace, pod) ${notReady}`,
    },
  };
}

export type Status = 'ok' | 'failing' | 'overdue' | 'never run' | 'idle' | 'suspended';
/** 3: red (failing 3 or more in a row, overdue). 2: amber (failing). 1: grey (never run). 0: quiet. */
export type Severity = 0 | 1 | 2 | 3;

export const FAILING_CRITICAL = 3;
/** A CronJob is overdue when it has no success for more than this many expected intervals. */
export const CRONJOB_OVERDUE_FACTOR = 2;

export interface StatusInput {
  /** Expected seconds between runs. 0 = event driven (workflows). */
  interval: number;
  failures: number;
  overdue: boolean;
  lastRun: number;
  suspended?: boolean;
  /** CronJobs never count as idle: an unknown interval is not "event driven". */
  isCronJob?: boolean;
}

/** Status and severity of one series. Failing 3 or more in a row beats overdue; both are red. */
export function deriveStatus(input: StatusInput): { status: Status; severity: Severity } {
  if (input.suspended) return { status: 'suspended', severity: 0 };
  if (input.failures >= FAILING_CRITICAL) return { status: 'failing', severity: 3 };
  if (input.overdue) return { status: 'overdue', severity: 3 };
  if (input.failures >= 1) return { status: 'failing', severity: 2 };
  if (!input.isCronJob && input.interval <= 0) return { status: 'idle', severity: 0 };
  if (input.lastRun <= 0) return { status: 'never run', severity: 1 };
  return { status: 'ok', severity: 0 };
}

/** One series of one workflow: one pod or component. */
export interface Instance {
  /** The pod, else the component, else the instance label. */
  label: string;
  component?: string;
  pod?: string;
  status: Status;
  severity: Severity;
  failures: number;
  lastRun: number;
  lastSuccess: number;
  nextRun: number;
  interval: number;
  registered: number;
  errorClass: string;
}

export type RowKind = 'poller' | 'timer' | 'worker' | 'cronjob' | string;

export interface Row {
  /** Unique: `<prefix>/<namespace>/<workflow>` or `cronjob/<namespace>/<name>`. */
  id: string;
  /** Group key before grouping choices: the namespace when present, else the prefix. */
  namespace?: string;
  prefix?: string;
  name: string;
  kind: RowKind;
  status: Status;
  severity: Severity;
  failures: number;
  lastRun: number;
  lastSuccess: number;
  /** Seconds. 0 = event driven (workflows) or unknown (CronJobs without a schedule yet). */
  interval: number;
  eventDriven: boolean;
  /** Unix seconds of the next run, or 0 when it is unknown. */
  nextDue: number;
  errorClass: string;
  /** Pod or component of the worst series. */
  where: string;
  /** Every series of the workflow, worst first (one entry for a CronJob). */
  instances: Instance[];
}

const num = (s: MetricSample | undefined): number => {
  if (!s) return 0;
  const v = Number(s.value[1]);
  return Number.isFinite(v) ? v : 0;
};

const PREFIX_RE = /^(.+)_workflow_(.+)$/;

/** The app prefix of a series name: `example_workflow_overdue` gives `example`. */
export function prefixOf(name: string | undefined, suffix: string): string | undefined {
  if (!name) return undefined;
  const m = PREFIX_RE.exec(name);
  if (!m || m[2] !== suffix) return undefined;
  return m[1];
}

const SEP = '\u0001';

interface Partial1 {
  prefix: string;
  namespace?: string;
  workflow: string;
  seriesId: string;
  kind?: string;
  component?: string;
  pod?: string;
  instanceLabel?: string;
  values: Partial<Record<SuffixKey, number>>;
  errorClass?: string;
}

/** The label that tells two series of one workflow apart: the pod, else the component, else the instance. */
function seriesLabel(m: Record<string, string>): string {
  return m.pod || m.component || m.instance || 'process';
}

/** Joins every `<prefix>_workflow_*` sample into one record per (prefix, namespace, workflow, pod or component). */
function collect(raw: Raw): Partial1[] {
  const byId = new Map<string, Partial1>();
  for (const key of Object.keys(SUFFIXES) as SuffixKey[]) {
    for (const sample of raw[key]) {
      const m = sample.metric;
      const prefix = prefixOf(m.__name__, SUFFIXES[key]);
      const workflow = m.workflow;
      if (!prefix || !workflow) continue;
      const label = seriesLabel(m);
      const id = [prefix, m.namespace ?? '', workflow, m.pod ?? '', m.component ?? '', m.instance ?? ''].join(SEP);
      let p = byId.get(id);
      if (!p) {
        p = {
          prefix,
          namespace: m.namespace || undefined,
          workflow,
          seriesId: id,
          component: m.component || undefined,
          pod: m.pod || undefined,
          instanceLabel: label,
          values: {},
        };
        byId.set(id, p);
      }
      if (m.kind && !p.kind) p.kind = m.kind;
      if (key === 'errorInfo') {
        // The info series has value 1 and the class in a label. Keep the class of a series that is 1.
        if (num(sample) === 1 || p.errorClass === undefined) p.errorClass = m.error_class || 'none';
      } else {
        p.values[key] = num(sample);
      }
    }
  }
  return [...byId.values()];
}

function instanceOf(p: Partial1): Instance {
  const v = p.values;
  const interval = v.interval ?? 0;
  const failures = Math.max(0, Math.floor(v.failures ?? 0));
  const lastRun = v.lastRun ?? 0;
  const { status, severity } = deriveStatus({
    interval,
    failures,
    overdue: (v.overdue ?? 0) === 1,
    lastRun,
  });
  return {
    label: p.instanceLabel ?? 'process',
    component: p.component,
    pod: p.pod,
    status,
    severity,
    failures,
    lastRun,
    lastSuccess: v.lastSuccess ?? 0,
    nextRun: v.nextRun ?? 0,
    interval,
    registered: v.registered ?? 0,
    errorClass: p.errorClass ?? 'none',
  };
}

/** Worse first: higher severity, then more failures, then the older last success. */
export function worseFirst(a: Instance, b: Instance): number {
  if (a.severity !== b.severity) return b.severity - a.severity;
  if (a.failures !== b.failures) return b.failures - a.failures;
  const sa = a.lastSuccess || Number.MAX_SAFE_INTEGER;
  const sb = b.lastSuccess || Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  return a.label.localeCompare(b.label);
}

/**
 * When the next run is due, in unix seconds, or 0 when unknown. The workflow's own plan wins. Else the
 * last success plus the expected interval, and while there is no success yet the registration time
 * plus the interval. An event driven workflow (interval 0) has no due time.
 */
export function nextDue(i: { nextRun: number; lastSuccess: number; interval: number; registered?: number }): number {
  if (i.interval <= 0 && i.nextRun <= 0) return 0;
  if (i.nextRun > 0) return i.nextRun;
  if (i.lastSuccess > 0) return i.lastSuccess + i.interval;
  if (i.registered && i.registered > 0) return i.registered + i.interval;
  return 0;
}

function rowFromInstances(p: { prefix: string; namespace?: string; workflow: string; kind?: string }, list: Instance[]): Row {
  const instances = [...list].sort(worseFirst);
  const worst = instances[0];
  return {
    id: [p.prefix, p.namespace ?? '', p.workflow].join('/'),
    namespace: p.namespace,
    prefix: p.prefix,
    name: p.workflow,
    kind: p.kind || 'workflow',
    status: worst.status,
    severity: worst.severity,
    failures: worst.failures,
    lastRun: worst.lastRun,
    lastSuccess: worst.lastSuccess,
    interval: worst.interval,
    eventDriven: worst.interval <= 0,
    nextDue: nextDue(worst),
    errorClass: worst.errorClass,
    where: worst.component && worst.pod ? `${worst.component} (${worst.pod})` : worst.label,
    instances,
  };
}

/** One row per workflow. Several series of one workflow (pods, components) fold into the worst one. */
export function buildWorkflowRows(raw: Raw): Row[] {
  const groups = new Map<string, { prefix: string; namespace?: string; workflow: string; kind?: string; list: Instance[] }>();
  for (const p of collect(raw)) {
    const key = [p.prefix, p.namespace ?? '', p.workflow].join(SEP);
    let g = groups.get(key);
    if (!g) {
      g = { prefix: p.prefix, namespace: p.namespace, workflow: p.workflow, kind: p.kind, list: [] };
      groups.set(key, g);
    }
    if (p.kind && !g.kind) g.kind = p.kind;
    g.list.push(instanceOf(p));
  }
  return [...groups.values()].map(g => rowFromInstances(g, g.list));
}

/** The namespaces that have workflow series. */
export function workflowNamespaces(rows: Row[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) if (r.namespace) out.add(r.namespace);
  return out;
}

/**
 * Which namespaces to read CronJobs from. `*` means all. Otherwise the namespaces that have workflow
 * series, plus the namespaces in the setting (a comma or space separated list).
 */
export function cronJobScope(setting: string | undefined, rows: Row[]): Scope {
  const entries = (setting ?? '')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (entries.includes('*')) return { all: true, namespaces: new Set() };
  const namespaces = workflowNamespaces(rows);
  for (const e of entries) namespaces.add(e);
  return { all: false, namespaces };
}

const cronKey = (m: Record<string, string>) => `${m.namespace ?? ''}${SEP}${m.cronjob ?? ''}`;

function byCron(samples: MetricSample[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of samples) out.set(cronKey(s.metric), num(s));
  return out;
}

/** The CronJob rows for the namespaces in scope. `now` is unix seconds. */
export function buildCronJobRows(raw: Raw, scope: Scope, now: number): Row[] {
  const c = raw.cron;
  const lastSuccess = byCron(c.lastSuccess);
  const lastSchedule = byCron(c.lastSchedule);
  const nextSchedule = byCron(c.nextSchedule);
  const suspended = byCron(c.suspended);
  const created = byCron(c.created);

  // Every CronJob that any of the CronJob series names.
  const known = new Map<string, { namespace: string; name: string }>();
  for (const list of [c.lastSuccess, c.lastSchedule, c.nextSchedule, c.suspended, c.created]) {
    for (const s of list) {
      const namespace = s.metric.namespace ?? '';
      const name = s.metric.cronjob ?? '';
      if (name) known.set(cronKey(s.metric), { namespace, name });
    }
  }

  // Failed Jobs of each CronJob, with their creation time (the sample value).
  const failedTimes = new Map<string, number[]>();
  for (const s of c.failedJobs) {
    const key = `${s.metric.namespace ?? ''}${SEP}${s.metric.owner_name ?? ''}`;
    const list = failedTimes.get(key) ?? [];
    list.push(num(s));
    failedTimes.set(key, list);
  }

  const rows: Row[] = [];
  for (const [key, { namespace, name }] of known) {
    if (!scope.all && !scope.namespaces.has(namespace)) continue;
    const success = lastSuccess.get(key) ?? 0;
    const last = lastSchedule.get(key) ?? 0;
    const next = nextSchedule.get(key) ?? 0;
    const isSuspended = (suspended.get(key) ?? 0) === 1;
    const interval = next > 0 && last > 0 && next > last ? next - last : 0;
    const since = success > 0 ? success : (created.get(key) ?? 0);
    const overdue = !isSuspended && interval > 0 && since > 0 && now - since > CRONJOB_OVERDUE_FACTOR * interval;
    const failures = (failedTimes.get(key) ?? []).filter(t => t > success).length;
    const { status, severity } = deriveStatus({ interval, failures, overdue, lastRun: last, suspended: isSuspended, isCronJob: true });
    const instance: Instance = {
      label: name,
      status,
      severity,
      failures,
      lastRun: last,
      lastSuccess: success,
      nextRun: isSuspended ? 0 : next,
      interval,
      registered: created.get(key) ?? 0,
      errorClass: failures > 0 ? 'job_failed' : 'none',
    };
    rows.push({
      id: `cronjob/${namespace}/${name}`,
      namespace,
      name,
      kind: 'cronjob',
      status,
      severity,
      failures,
      lastRun: last,
      lastSuccess: success,
      interval,
      eventDriven: false,
      nextDue: isSuspended ? 0 : nextDue(instance),
      errorClass: instance.errorClass,
      where: name,
      instances: [instance],
    });
  }
  return rows;
}

export type GroupBy = 'auto' | 'namespace' | 'prefix';
export const GROUP_BY_VALUES: GroupBy[] = ['auto', 'namespace', 'prefix'];

/**
 * The group key of a row. `auto` and `namespace`: the namespace label when present, else the prefix.
 * `prefix`: the metric prefix, and for a CronJob (no prefix) its namespace.
 */
export function groupKeyOf(row: Row, groupBy: GroupBy): string {
  if (groupBy === 'prefix') return row.prefix || row.namespace || 'other';
  return row.namespace || row.prefix || 'other';
}

export interface Group {
  key: string;
  rows: Row[];
  /** Highest severity of its rows. */
  severity: Severity;
  /** Distinct metric prefixes of its rows. */
  prefixes: string[];
  counts: Record<Status, number>;
}

const emptyCounts = (): Record<Status, number> => ({ ok: 0, failing: 0, overdue: 0, 'never run': 0, idle: 0, suspended: 0 });

/** Failing and overdue rows first, then by name. */
export function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if (a.severity !== b.severity) return b.severity - a.severity;
    if (a.failures !== b.failures) return b.failures - a.failures;
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

/** Groups the rows. Groups with failing or overdue rows come first. */
export function groupRows(rows: Row[], groupBy: GroupBy): Group[] {
  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const key = groupKeyOf(r, groupBy);
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }
  const groups: Group[] = [...map.entries()].map(([key, list]) => {
    const sorted = sortRows(list);
    const counts = emptyCounts();
    for (const r of sorted) counts[r.status] += 1;
    return {
      key,
      rows: sorted,
      severity: sorted.reduce<Severity>((m, r) => (r.severity > m ? r.severity : m), 0),
      prefixes: [...new Set(sorted.map(r => r.prefix).filter((p): p is string => !!p))].sort(),
      counts,
    };
  });
  return groups.sort((a, b) => b.severity - a.severity || a.key.localeCompare(b.key));
}

/** All rows from both sources. */
export function buildRows(raw: Raw, cronJobNamespaces: string | undefined, now: number): Row[] {
  return buildAll(raw, cronJobNamespaces, now).rows;
}

/** The workflow rows, the CronJob rows and the workload rows for one load. */
export function buildAll(raw: Raw, cronJobNamespaces: string | undefined, now: number): { rows: Row[]; workloads: WorkloadRow[]; scope: Scope } {
  const workflows = buildWorkflowRows(raw);
  const scope = cronJobScope(cronJobNamespaces, workflows);
  return { rows: [...workflows, ...buildCronJobRows(raw, scope, now)], workloads: buildWorkloadRows(raw, scope), scope };
}

export interface Summary {
  total: number;
  failing: number;
  overdue: number;
  neverRun: number;
  ok: number;
}

export function summarise(rows: Row[]): Summary {
  const out: Summary = { total: rows.length, failing: 0, overdue: 0, neverRun: 0, ok: 0 };
  for (const r of rows) {
    if (r.status === 'failing') out.failing += 1;
    else if (r.status === 'overdue') out.overdue += 1;
    else if (r.status === 'never run') out.neverRun += 1;
    else out.ok += 1;
  }
  return out;
}

/** A row that needs attention: failing or overdue (not "never run"). */
export const isProblem = (r: Row): boolean => r.severity >= 2;

/* ---------- workloads (Deployments and StatefulSets) ---------- */

export type WorkloadStatus = 'ok' | 'not ready' | 'crash loop' | 'scaled to zero';
export type WorkloadKind = 'Deployment' | 'StatefulSet';

/** A workload that is not Ready is amber for this long, then red. */
export const NOT_READY_RED_SECONDS = 120;

export interface WorkloadInput {
  desired: number;
  ready: number;
  crashLoop: boolean;
  notReadySeconds: number;
}

/** A workload that is scaled to zero is not a failure. A crash loop is red. Not Ready is amber, then red after 2 minutes. */
export function deriveWorkloadStatus(i: WorkloadInput): { status: WorkloadStatus; severity: Severity } {
  if (i.desired <= 0) return { status: 'scaled to zero', severity: 0 };
  if (i.crashLoop) return { status: 'crash loop', severity: 3 };
  if (i.ready < i.desired) return { status: 'not ready', severity: i.notReadySeconds >= NOT_READY_RED_SECONDS ? 3 : 2 };
  return { status: 'ok', severity: 0 };
}

export interface WorkloadRow {
  id: string;
  namespace: string;
  name: string;
  kind: WorkloadKind;
  status: WorkloadStatus;
  severity: Severity;
  desired: number;
  ready: number;
  /** Seconds that the longest not Ready pod has been not Ready. 0 when every pod is Ready. */
  notReadySeconds: number;
  /** Container restarts in the last 24 hours, all pods of the workload. */
  restarts24h: number;
  /** Exit code and reason of the last terminated container, when there is one. */
  lastExit?: { code: number; reason: string; pod: string; container: string };
  crashLoop: boolean;
  pods: string[];
}

/** The Deployment that a ReplicaSet belongs to: the ReplicaSet name without its hash suffix. */
export function deploymentOfReplicaSet(name: string): string {
  const m = /^(.+)-[a-z0-9]+$/.exec(name);
  return m ? m[1] : name;
}

const podKey = (m: Record<string, string>, pod = m.pod ?? '') => `${m.namespace ?? ''}${SEP}${pod}`;
const ctrKey = (m: Record<string, string>) => `${m.namespace ?? ''}${SEP}${m.pod ?? ''}${SEP}${m.container ?? ''}`;

/** One row per Deployment and StatefulSet in scope, joined with its pods from kube-state-metrics. */
export function buildWorkloadRows(raw: Raw, scope: Scope): WorkloadRow[] {
  const w = raw.workloads;
  const rows = new Map<string, WorkloadRow>();
  const add = (kind: WorkloadKind, label: 'deployment' | 'statefulset', desired: MetricSample[], ready: MetricSample[]) => {
    const readyBy = new Map<string, number>();
    for (const r of ready) readyBy.set(`${r.metric.namespace ?? ''}${SEP}${r.metric[label] ?? ''}`, num(r));
    for (const d of desired) {
      const namespace = d.metric.namespace ?? '';
      const name = d.metric[label] ?? '';
      if (!name || (!scope.all && !scope.namespaces.has(namespace))) continue;
      const want = num(d);
      const have = readyBy.get(`${namespace}${SEP}${name}`) ?? 0;
      rows.set(`${kind}${SEP}${namespace}${SEP}${name}`, {
        id: `${kind.toLowerCase()}/${namespace}/${name}`,
        namespace,
        name,
        kind,
        status: 'ok',
        severity: 0,
        desired: want,
        ready: have,
        notReadySeconds: 0,
        restarts24h: 0,
        crashLoop: false,
        pods: [],
      });
    }
  };
  add('Deployment', 'deployment', w.deployDesired, w.deployReady);
  add('StatefulSet', 'statefulset', w.stsDesired, w.stsReady);

  // Pod -> workload, from the owner of each pod.
  const ownerOf = new Map<string, WorkloadRow>();
  for (const o of w.podOwner) {
    const kind = o.metric.owner_kind === 'StatefulSet' ? 'StatefulSet' : o.metric.owner_kind === 'ReplicaSet' ? 'Deployment' : undefined;
    if (!kind || !o.metric.owner_name) continue;
    const name = kind === 'Deployment' ? deploymentOfReplicaSet(o.metric.owner_name) : o.metric.owner_name;
    const row = rows.get(`${kind}${SEP}${o.metric.namespace ?? ''}${SEP}${name}`);
    if (row) {
      ownerOf.set(podKey(o.metric), row);
      if (o.metric.pod && !row.pods.includes(o.metric.pod)) row.pods.push(o.metric.pod);
    }
  }

  const bySeconds = (samples: MetricSample[]) => {
    const out = new Map<string, number>();
    for (const s of samples) out.set(podKey(s.metric), num(s));
    return out;
  };
  const sinceReady = bySeconds(w.sinceReady);
  const age = bySeconds(w.podAge);
  for (const s of w.notReady) {
    const key = podKey(s.metric);
    const row = ownerOf.get(key);
    if (!row) continue;
    // Not Ready since the last time it was Ready, never longer than the pod has existed.
    const since = sinceReady.get(key);
    const alive = age.get(key);
    const seconds = since !== undefined && alive !== undefined ? Math.min(since, alive) : (since ?? alive ?? 0);
    row.notReadySeconds = Math.max(row.notReadySeconds, Math.max(0, Math.round(seconds)));
  }

  const restartsByContainer = new Map<string, number>();
  for (const s of w.restarts) {
    const row = ownerOf.get(podKey(s.metric));
    if (!row) continue;
    const n = Math.max(0, Math.round(num(s)));
    restartsByContainer.set(ctrKey(s.metric), n);
    row.restarts24h += n;
  }

  for (const s of w.crashLoop) {
    const row = ownerOf.get(podKey(s.metric));
    if (row) row.crashLoop = true;
  }

  // The last exit of the container with the most restarts (a crash looping one wins a tie).
  const reasons = new Map<string, string>();
  for (const s of w.exitReason) reasons.set(ctrKey(s.metric), s.metric.reason ?? '');
  const crashing = new Set(w.crashLoop.map(s => ctrKey(s.metric)));
  const best = new Map<WorkloadRow, { score: number; code: number; reason: string; pod: string; container: string }>();
  for (const s of w.exitCode) {
    const row = ownerOf.get(podKey(s.metric));
    if (!row) continue;
    const key = ctrKey(s.metric);
    const score = (crashing.has(key) ? 1_000_000 : 0) + (restartsByContainer.get(key) ?? 0) + (num(s) !== 0 ? 0.5 : 0);
    const cur = best.get(row);
    if (!cur || score > cur.score) {
      best.set(row, { score, code: num(s), reason: reasons.get(key) ?? '', pod: s.metric.pod ?? '', container: s.metric.container ?? '' });
    }
  }
  for (const [row, b] of best) row.lastExit = { code: b.code, reason: b.reason, pod: b.pod, container: b.container };

  for (const row of rows.values()) {
    const { status, severity } = deriveWorkloadStatus(row);
    row.status = status;
    row.severity = severity;
    row.pods.sort();
  }
  return sortWorkloads([...rows.values()]);
}

/** Failing workloads first (crash loop and long not Ready, then short not Ready), then by namespace and name. */
export function sortWorkloads(rows: WorkloadRow[]): WorkloadRow[] {
  return [...rows].sort(
    (a, b) =>
      b.severity - a.severity ||
      b.restarts24h - a.restarts24h ||
      a.namespace.localeCompare(b.namespace) ||
      a.name.localeCompare(b.name)
  );
}

/** A workload that needs attention: crash loop or not Ready. */
export const isUnhealthy = (r: WorkloadRow): boolean => r.severity >= 2;

export interface HealthSummary {
  failingWorkflows: number;
  overdueWorkflows: number;
  failingCronJobs: number;
  unhealthyWorkloads: number;
}

/** The counts of the summary bar. A CronJob counts as failing when it failed or missed its check-in. */
export function healthSummary(rows: Row[], workloads: WorkloadRow[]): HealthSummary {
  const out: HealthSummary = { failingWorkflows: 0, overdueWorkflows: 0, failingCronJobs: 0, unhealthyWorkloads: 0 };
  for (const r of rows) {
    if (r.kind === 'cronjob') {
      if (r.status === 'failing' || r.status === 'overdue') out.failingCronJobs += 1;
    } else if (r.status === 'failing') out.failingWorkflows += 1;
    else if (r.status === 'overdue') out.overdueWorkflows += 1;
  }
  out.unhealthyWorkloads = workloads.filter(isUnhealthy).length;
  return out;
}

/** The text of a last error class. `state` means that a checked condition is not met. */
export function errorLabel(errorClass: string): string {
  if (errorClass === 'none' || errorClass === '') return '-';
  if (errorClass === 'state') return 'condition not met';
  return errorClass;
}

/* ---------- formatting ---------- */

/** A short duration: `45 s`, `12 min`, `3 h`, `2 d`. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

/** `12 min ago`, or `-` for a time that is not set. */
export function formatAge(ts: number, now: number): string {
  if (!(ts > 0)) return '-';
  return now >= ts ? `${formatDuration(now - ts)} ago` : `in ${formatDuration(ts - now)}`;
}

/** The text of the "Next due" cell. */
export function formatNextDue(row: Pick<Row, 'eventDriven' | 'nextDue' | 'status' | 'kind'>, now: number): string {
  if (row.status === 'suspended') return 'suspended';
  if (row.eventDriven && row.nextDue <= 0) return 'event driven';
  if (!(row.nextDue > 0)) return '-';
  if (row.nextDue < now) return `overdue by ${formatDuration(now - row.nextDue)}`;
  return `in ${formatDuration(row.nextDue - now)}`;
}

export function formatInterval(row: Pick<Row, 'eventDriven' | 'interval'>): string {
  if (row.eventDriven) return 'event driven';
  return row.interval > 0 ? `every ${formatDuration(row.interval)}` : '-';
}

/** The text of a last exit: `exit 1 (Error)`. */
export function formatExit(e: WorkloadRow['lastExit']): string {
  if (!e) return '-';
  return e.reason ? `exit ${e.code} (${e.reason})` : `exit ${e.code}`;
}

/** The exact local time for a tooltip. */
export function formatExact(ts: number): string {
  return ts > 0 ? new Date(ts * 1000).toLocaleString() : 'never';
}

/* ---------- settings ---------- */

export interface Settings {
  metricsNamespace: string;
  metricsService: string;
  metricsPort: string;
  /** Empty: only namespaces with workflow series. `*`: all. Else a comma list that adds to those. */
  cronJobNamespaces: string;
}

export const CONFIG_KEY = 'workflows';

export const DEFAULT_SETTINGS: Settings = {
  metricsNamespace: 'monitoring',
  metricsService: 'victoria-metrics',
  metricsPort: '8428',
  cronJobNamespaces: '',
};

/** Blank fields fall back to the deployment default, then the built-in default. */
export function resolveSettings(stored: Partial<Settings> | undefined, defaults: Partial<Settings> | undefined): Settings {
  const out = { ...DEFAULT_SETTINGS };
  for (const source of [defaults, stored]) {
    if (!source) continue;
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const v = source[key];
      if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim();
    }
  }
  return out;
}

/* ---------- widget settings ---------- */

export interface WidgetConfig {
  onlyFailing: boolean;
  groupBy: GroupBy;
}

export const DEFAULT_WIDGET_CONFIG: WidgetConfig = { onlyFailing: false, groupBy: 'auto' };

/** Saved settings can be stale or hand-edited: fall back to the default for any bad value. */
export function normaliseConfig(raw: Partial<WidgetConfig> | undefined): WidgetConfig {
  const c = raw ?? {};
  return {
    onlyFailing: typeof c.onlyFailing === 'boolean' ? c.onlyFailing : DEFAULT_WIDGET_CONFIG.onlyFailing,
    groupBy: GROUP_BY_VALUES.includes(c.groupBy as GroupBy) ? (c.groupBy as GroupBy) : DEFAULT_WIDGET_CONFIG.groupBy,
  };
}
