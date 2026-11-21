/*
 * Scanner data from a Prometheus-compatible store (VictoriaMetrics). The scanner
 * pushes one set of samples per scan, with the scan time as the sample time.
 * This module is pure (no React, no network): it builds the query paths and turns
 * the query results into the Status and History shapes the page already uses.
 *
 * Series the scanner writes (see the scanner README):
 *   gh_runner_node_info, gh_runner_job_info, gh_runner_starting_info,
 *   gh_runner_scale_set_info: text fields as labels, the value is the scan time in
 *   seconds. When a label changes (state, status, phase) the old series stops and a
 *   new one starts, so the reader keeps the newest row per node, job or scale set.
 *   gh_runner_scale_set_runners{scale_set,field}: min, max, current, pending, running.
 *
 * A job series ends when the job leaves the live list. Its last sample time is the
 * completion time, and its lifetime in the store is the job history.
 */
import type { History, Job, NodeState, NodeStatus, PluginConfig, ScaleSetSummary, Starting, Status } from './types';

export interface MetricsSource {
  namespace: string;
  service: string;
  port: string;
  /** Null when the settings are valid. */
  problem: string | null;
}

/** Generic defaults. The settings or a deployment defaults.json override them. */
export const DEFAULT_METRICS = { namespace: 'monitoring', service: 'victoria-metrics', port: '8428' };

/** The newest scan older than this is stale: nodes and live jobs stay visible for this long. */
export const LIVE_WINDOW_SECONDS = 150;
export const HISTORY_DAYS = 14;
export const HISTORY_MAX_JOBS = 2000;

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const PORT = /^([0-9]{1,5}|[a-z0-9]([-a-z0-9]{0,13}[a-z0-9])?)$/;
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Metrics are on when the settings or a defaults.json name a service. */
export function metricsConfigured(cfg: PluginConfig): boolean {
  return !!text(cfg.metricsService);
}

export function resolveMetricsSource(cfg: PluginConfig): MetricsSource {
  const namespace = text(cfg.metricsNamespace) || DEFAULT_METRICS.namespace;
  const service = text(cfg.metricsService) || DEFAULT_METRICS.service;
  const port = text(cfg.metricsPort) || DEFAULT_METRICS.port;
  let problem: string | null = null;
  if (!DNS_LABEL.test(namespace)) problem = 'The namespace is not a valid Kubernetes name.';
  else if (!DNS_LABEL.test(service)) problem = 'The service is not a valid Kubernetes name.';
  else if (!PORT.test(port)) problem = 'The port must be a number or a port name.';
  return { namespace, service, port, problem };
}

/** Path of an instant query through the Kubernetes API service proxy. */
export function queryPath(src: MetricsSource, promql: string): string {
  const e = encodeURIComponent;
  return (
    `/api/v1/namespaces/${e(src.namespace)}/services/${e(src.service)}:${e(src.port)}` +
    `/proxy/api/v1/query?query=${e(promql)}`
  );
}

export const QUERIES = {
  nodes: `last_over_time(gh_runner_node_info[${LIVE_WINDOW_SECONDS}s])`,
  starting: `last_over_time(gh_runner_starting_info[${LIVE_WINDOW_SECONDS}s])`,
  scaleSets: `last_over_time(gh_runner_scale_set_info[${LIVE_WINDOW_SECONDS}s])`,
  scaleSetRunners: `last_over_time(gh_runner_scale_set_runners[${LIVE_WINDOW_SECONDS}s])`,
  jobs: `last_over_time(gh_runner_job_info[${HISTORY_DAYS}d])`,
} as const;

export type QueryId = keyof typeof QUERIES;

/** One series of an instant query. */
export interface Sample {
  labels: Record<string, string>;
  value: number;
}

/** Samples from the body of an instant query. Null when it is not a successful vector. */
export function parseVector(body: unknown): Sample[] | null {
  const b = body as any;
  if (!b || b.status !== 'success' || !Array.isArray(b.data?.result)) return null;
  const out: Sample[] = [];
  for (const r of b.data.result) {
    const value = Number(r?.value?.[1]);
    if (r && typeof r.metric === 'object' && r.metric && Number.isFinite(value)) {
      out.push({ labels: r.metric as Record<string, string>, value });
    }
  }
  return out;
}

export type MetricsInput = Record<QueryId, Sample[]>;

const iso = (seconds: number): string => new Date(Math.round(seconds) * 1000).toISOString().replace('.000Z', 'Z');
const lab = (s: Sample, name: string): string => s.labels[name] ?? '';
const orNull = (v: string): string | null => (v === '' ? null : v);
const numberOrNull = (v: string): number | null => (v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** The newest sample of each group. A tie keeps the first one. */
function newest(samples: Sample[], key: (s: Sample) => string): Sample[] {
  const best = new Map<string, Sample>();
  for (const s of samples) {
    const k = key(s);
    const prev = best.get(k);
    if (!prev || s.value > prev.value) best.set(k, s);
  }
  return [...best.values()];
}

function jobOf(s: Sample, live: boolean): Job {
  const completedLabel = orNull(lab(s, 'completed_at'));
  // A job that left the live list finished at its last sample. The conclusion is whatever
  // GitHub reported while the job was live, which is usually nothing.
  const completed = live ? completedLabel : completedLabel ?? iso(s.value);
  const runId = lab(s, 'run_id');
  return {
    key: lab(s, 'key'),
    name: lab(s, 'name'),
    repository: lab(s, 'repository'),
    workflow: lab(s, 'workflow'),
    workflow_ref: lab(s, 'workflow_ref'),
    run_id: numberOrNull(runId) ?? orNull(runId),
    job_id: orNull(lab(s, 'job_id')),
    numeric_job_id: numberOrNull(lab(s, 'numeric_job_id')),
    url: orNull(lab(s, 'url')),
    run_url: orNull(lab(s, 'run_url')),
    runner_name: lab(s, 'runner_name'),
    scale_set: lab(s, 'scale_set'),
    node_id: orNull(lab(s, 'node')),
    status: live ? lab(s, 'status') : 'completed',
    conclusion: orNull(lab(s, 'conclusion')),
    started_at: orNull(lab(s, 'started_at')),
    completed_at: completed,
  };
}

const STATES: readonly string[] = ['online', 'busy', 'standby', 'starting', 'offline'];

/** Build the Status and the History the page uses. Null when no scan is in the window. */
export function buildFromMetrics(input: MetricsInput): { status: Status; history: History } | null {
  const nodeRows = newest(input.nodes, s => lab(s, 'node'));
  if (!nodeRows.length) return null;
  const scanTime = Math.max(...nodeRows.map(s => s.value));
  // A job is live when its last sample is from the newest scan.
  const isLive = (s: Sample): boolean => s.value >= scanTime - 1;

  const jobRows = newest(input.jobs, s => lab(s, 'key'));
  const liveJobs: Job[] = [];
  const done: Job[] = [];
  for (const s of jobRows) {
    if (!lab(s, 'key')) continue;
    (isLive(s) ? liveJobs : done).push(jobOf(s, isLive(s)));
  }

  const startingRows = newest(input.starting, s => `${lab(s, 'node')}|${lab(s, 'name')}`).filter(isLive);
  const nodes: NodeStatus[] = nodeRows
    .map(s => {
      const id = lab(s, 'node');
      const state = lab(s, 'state');
      const reason = lab(s, 'state_reason');
      const description = lab(s, 'description');
      const starting: Starting[] = startingRows
        .filter(r => lab(r, 'node') === id)
        .map(r => ({
          name: lab(r, 'name'),
          runner_name: lab(r, 'runner_name'),
          scale_set: lab(r, 'scale_set'),
          phase: orNull(lab(r, 'phase')) ?? undefined,
          started_at: orNull(lab(r, 'started_at')),
        }));
      const node: NodeStatus = {
        id,
        display_name: lab(s, 'display_name') || id,
        kind: lab(s, 'kind') === 'external' ? 'external' : 'kubernetes',
        ready: lab(s, 'ready') === '1',
        os: lab(s, 'os'),
        jobs: liveJobs.filter(j => j.node_id === id),
        starting,
      };
      if (STATES.includes(state)) node.state = state as NodeState;
      if (reason) node.state_reason = reason;
      if (lab(s, 'best_effort') === '1') node.best_effort = true;
      if (description) node.description = description;
      return node;
    })
    .filter(n => n.id)
    .sort((a, b) => a.id.localeCompare(b.id));

  const numbers = new Map<string, Partial<Record<string, number>>>();
  for (const s of input.scaleSetRunners) {
    const name = lab(s, 'scale_set');
    const row = numbers.get(name) ?? {};
    row[lab(s, 'field')] = s.value;
    numbers.set(name, row);
  }
  const scale_sets: ScaleSetSummary[] = newest(input.scaleSets, s => lab(s, 'scale_set'))
    .map(s => {
      const name = lab(s, 'scale_set');
      const n = numbers.get(name) ?? {};
      return {
        name,
        min_runners: n.min ?? null,
        max_runners: n.max ?? null,
        current_runners: n.current ?? null,
        pending: n.pending ?? null,
        running: n.running ?? null,
        phase: orNull(lab(s, 'phase')),
        organisation: orNull(lab(s, 'organisation')),
      };
    })
    .filter(s => s.name)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const startingCount = nodes.reduce((n, node) => n + node.starting.length, 0);
  const scalePending = scale_sets.reduce((n, s) => n + (s.pending || 0), 0);
  const status: Status = {
    generated_at: iso(scanTime),
    nodes,
    scale_sets,
    summary: {
      running_jobs: liveJobs.length,
      pending_runners: Math.max(startingCount, scalePending),
      nodes_ready: nodes.filter(n => n.ready).length,
      nodes_standby: nodes.filter(n => n.state === 'standby').length,
      nodes_total: nodes.length,
    },
  };

  const cutoff = scanTime - HISTORY_DAYS * 86400;
  const stamp = (j: Job): number => Date.parse(j.completed_at || j.started_at || '') / 1000;
  const past = [...liveJobs, ...done]
    .filter(j => !(stamp(j) < cutoff))
    .sort((a, b) => stamp(b) - stamp(a))
    .slice(0, HISTORY_MAX_JOBS);
  return { status, history: { generated_at: iso(scanTime), jobs: past } };
}
