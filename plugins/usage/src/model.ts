/*
 * Pure data model: metric samples to usage rows, the live-pod remainder,
 * client-side label/Service joins, grouping with the workload fallback,
 * filters and drill-down.
 */
import type { MetricSample } from './metrics';
import { labelNameFor, Measure, MEASURES, POD_NAME_RULES, QUERY_KEYS, QueryKey } from './resources';

/**
 * One row of usage. Aggregated rows have no `pod`: they cover every pod (live
 * or ended) of one workload on one node. Live rows are single pods that exist
 * now (restricted with kube_pod_info). `label` is set only on rows joined server-side from kube_pod_labels.
 */
export interface UsageRow {
  namespace: string;
  node: string;
  /** "Kind/name", ReplicaSet rolled up to Deployment and Job to CronJob. */
  workload: string;
  pod?: string;
  label?: string;
  /** Pods this row stands for (1 for a live pod). */
  pods: number;
  values: Record<Measure, number>;
}

export const emptyValues = (): Record<Measure, number> =>
  Object.fromEntries(MEASURES.map(m => [m, 0])) as Record<Measure, number>;

export const podKey = (namespace: string, pod: string) => `${namespace}/${pod}`;

/** Workload of a pod with no owner series, from its name (same rules as the query, POD_NAME_RULES). */
export function workloadFromPodName(pod: string): string {
  for (const [kind, re] of [...POD_NAME_RULES].reverse()) {
    const m = new RegExp(`^${re}$`).exec(pod);
    if (m) {
      return `${kind}/${m[1]}`;
    }
  }
  return `Pod/${pod}`;
}

/**
 * "Kind/name" of the workload that owns a pod: ReplicaSet rolled up to
 * Deployment (pod-template-hash stripped), Job to CronJob (timestamp
 * stripped) and EphemeralRunner to its AutoscalingRunnerSet. A pod with no controller is named after its pod-name prefix (workloadFromPodName).
 */
export function workloadOf(ownerKind: string | undefined, ownerName: string | undefined, pod?: string): string {
  if (!ownerKind || ownerKind === '<none>' || !ownerName || ownerName === '<none>') {
    return workloadFromPodName(pod ?? ownerName ?? '');
  }
  if (ownerKind === 'ReplicaSet') {
    const m = /^(.+)-[a-z0-9]{5,10}$/.exec(ownerName);
    return m ? `Deployment/${m[1]}` : `ReplicaSet/${ownerName}`;
  }
  if (ownerKind === 'Job') {
    const m = /^(.+)-\d{6,}$/.exec(ownerName);
    return m ? `CronJob/${m[1]}` : `Job/${ownerName}`;
  }
  if (ownerKind === 'EphemeralRunner') {
    const m = /^(.+)-runner-[a-z0-9]{5}$/.exec(ownerName);
    return m ? `AutoscalingRunnerSet/${m[1]}` : `EphemeralRunner/${ownerName}`;
  }
  return `${ownerKind}/${ownerName}`;
}

export type MeasureSamples = Partial<Record<QueryKey, MetricSample[]>>;

/** What part of a recorded range actually has data. */
export interface Coverage {
  /** Start of the covered part (seconds since the epoch): the later of the window start and the first recorded hour. */
  startSec: number;
  /** Seconds from `startSec` to the newest recorded hour. */
  coveredSeconds: number;
  /** The recorded data starts noticeably after the window does. */
  partial: boolean;
}

/**
 * Coverage from the first and last sample times of usage:cpu_seconds:increase1h. A sample at time T
 * covers the hour before T, so the data starts at `firstTs - 3600`. One hour of slack absorbs the
 * alignment of the first rule evaluation.
 */
export function coverageFor(firstTs: number, lastTs: number, nowSec: number, windowSeconds: number): Coverage {
  const windowStart = nowSec - windowSeconds;
  const startSec = Math.max(windowStart, firstTs - 3600);
  return { startSec, coveredSeconds: Math.max(3600, lastTs - startSec), partial: firstTs - 3600 > windowStart + 3600 };
}

/** First and last recorded sample times from the two coverage queries; null when the rules have produced nothing. */
export function recordedSpan(first: MetricSample[], last: MetricSample[]): { first: number; last: number } | null {
  const f = Number(first[0]?.value?.[1]);
  const l = Number(last[0]?.value?.[1]);
  return Number.isFinite(f) && Number.isFinite(l) ? { first: f, last: l } : null;
}

const ICT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** The caption for a partly covered view, or null when the recorded data covers the whole window. */
export function coverageCaption(c: Coverage): string | null {
  if (!c.partial) {
    return null;
  }
  const days = Math.round((c.coveredSeconds / 86400) * 10) / 10;
  return `Recorded data starts ${ICT.format(new Date(c.startSec * 1000))} ICT, so this view covers ${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * Merges one aggregated result per query key into rows by
 * (namespace, node, workload[, label]). Several owners (every ReplicaSet of a
 * Deployment, every Job of a CronJob) roll up into one row, so values add.
 */
export function buildAggregatedRows(samples: MeasureSamples, labelName?: string): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const key of QUERY_KEYS) {
    for (const s of samples[key] ?? []) {
      const { namespace, node = '', owner_kind, owner_name } = s.metric;
      const value = Number(s.value?.[1]);
      if (!namespace || !Number.isFinite(value)) {
        continue;
      }
      const workload = workloadOf(owner_kind, owner_name);
      const label = labelName ? (s.metric[labelName] ?? '') : undefined;
      const k = [namespace, node, workload, label].join('\u0000');
      let row = rows.get(k);
      if (!row) {
        row = { namespace, node, workload, label, pods: 0, values: emptyValues() };
        rows.set(k, row);
      }
      if (key === 'pods') {
        row.pods += Math.max(0, value);
      } else {
        row.values[key] += Math.max(0, value);
      }
    }
  }
  return [...rows.values()];
}

/** Merges per-pod results for live pods into one row per pod. */
export function buildLiveRows(samples: MeasureSamples, owners: MetricSample[]): UsageRow[] {
  const ownerByPod = new Map<string, MetricSample['metric']>();
  for (const s of owners) {
    const { namespace, pod } = s.metric;
    if (namespace && pod) {
      ownerByPod.set(podKey(namespace, pod), s.metric);
    }
  }
  const rows = new Map<string, UsageRow>();
  for (const measure of MEASURES) {
    for (const s of samples[measure] ?? []) {
      const { namespace, pod, node = '' } = s.metric;
      const value = Number(s.value?.[1]);
      if (!namespace || !pod || !Number.isFinite(value)) {
        continue;
      }
      const key = podKey(namespace, pod);
      let row = rows.get(key);
      if (!row) {
        const o = ownerByPod.get(key);
        row = { namespace, pod, node, workload: workloadOf(o?.owner_kind, o?.owner_name, pod), pods: 1, values: emptyValues() };
        rows.set(key, row);
      }
      row.values[measure] += Math.max(0, value);
    }
  }
  return [...rows.values()];
}

/**
 * Live rows plus, per (namespace, workload, node), whatever the aggregated
 * rows hold beyond them: the pods that have ended. Totals stay exact.
 */
export function withEndedRemainder(live: UsageRow[], aggregated: UsageRow[]): UsageRow[] {
  const keyOf = (r: UsageRow) => [r.namespace, r.node, r.workload].join('\u0000');
  const liveSum = new Map<string, { values: Record<Measure, number>; pods: number }>();
  for (const r of live) {
    const acc = liveSum.get(keyOf(r)) ?? { values: emptyValues(), pods: 0 };
    for (const m of MEASURES) {
      acc.values[m] += r.values[m];
    }
    acc.pods += r.pods;
    liveSum.set(keyOf(r), acc);
  }
  const out = [...live];
  for (const a of aggregated) {
    const l = liveSum.get(keyOf(a));
    const values = emptyValues();
    let any = false;
    for (const m of MEASURES) {
      const rest = a.values[m] - (l?.values[m] ?? 0);
      // Ignore float noise: less than 0.1 % of the aggregate is treated as nothing.
      if (rest > a.values[m] * 1e-3 && rest > 0) {
        values[m] = rest;
        any = true;
      }
    }
    if (any) {
      out.push({ namespace: a.namespace, node: a.node, workload: a.workload, pods: Math.max(0, a.pods - (l?.pods ?? 0)), values });
    }
  }
  return out;
}

// ---- Client-side join with live Pods and Services ----

export interface PodMeta {
  namespace: string;
  name: string;
  labels: Record<string, string>;
}

export interface ServiceMeta {
  namespace: string;
  name: string;
  selector: Record<string, string>;
}

export interface GroupContext {
  pods: Map<string, PodMeta>;
  /** podKey -> "namespace/service" of the first matching Service (by name). */
  serviceByPod: Map<string, string>;
}

export function selectorMatches(selector: Record<string, string>, labels: Record<string, string>): boolean {
  const entries = Object.entries(selector);
  return entries.length > 0 && entries.every(([k, v]) => labels[k] === v);
}

export function buildContext(pods: PodMeta[], services: ServiceMeta[]): GroupContext {
  const podMap = new Map(pods.map(p => [podKey(p.namespace, p.name), p]));
  const sorted = [...services].sort((a, b) => a.name.localeCompare(b.name));
  const serviceByPod = new Map<string, string>();
  for (const p of pods) {
    const svc = sorted.find(s => s.namespace === p.namespace && selectorMatches(s.selector, p.labels));
    if (svc) {
      serviceByPod.set(podKey(p.namespace, p.name), `${svc.namespace}/${svc.name}`);
    }
  }
  return { pods: podMap, serviceByPod };
}

/** All label keys present on live pods, sorted. */
export function labelKeys(pods: PodMeta[]): string[] {
  return [...new Set(pods.flatMap(p => Object.keys(p.labels)))].sort();
}

/**
 * Keys offered by the picker: the original keys of live pods, plus label_*
 * names seen on kube_pod_labels that no live key explains (shown sanitised).
 */
export function mergeLabelKeys(liveKeys: string[], metricLabelNames: string[]): string[] {
  const explained = new Set(liveKeys.map(labelNameFor));
  const extra = metricLabelNames.filter(n => n.startsWith('label_') && !explained.has(n));
  return [...new Set([...liveKeys, ...extra])].sort();
}

export const LABEL_PREFIX = 'label:';
export const BASE_GROUPINGS = ['namespace', 'workload', 'service', 'node', 'pod'] as const;

export interface GroupKey {
  key: string;
  /** True when the row could not be placed in the grouping and sits under its workload. */
  fallback: boolean;
}

/** Looks up a pod label by original key, or by its sanitised label_* name. */
function podLabel(labels: Record<string, string>, key: string): string | undefined {
  if (labels[key] !== undefined) {
    return labels[key];
  }
  const name = labelNameFor(key);
  const found = Object.keys(labels).find(k => labelNameFor(k) === name);
  return found === undefined ? undefined : labels[found];
}

/**
 * The group of a row. Anything that cannot be placed (no such label, no
 * matching Service, ended pod) falls back to its workload identity,
 * "namespace/Kind/name" ("namespace/Pod/<name>" with no owner).
 */
export function groupOf(row: UsageRow, groupBy: string, ctx: GroupContext): GroupKey {
  const fallback: GroupKey = { key: `${row.namespace}/${row.workload}`, fallback: true };
  const ok = (key: string): GroupKey => ({ key, fallback: false });
  switch (groupBy) {
    case 'namespace':
      return ok(row.namespace);
    case 'workload':
      return ok(`${row.namespace}/${row.workload}`);
    case 'node':
      return row.node ? ok(row.node) : fallback;
    case 'pod':
      return row.pod ? ok(podKey(row.namespace, row.pod)) : fallback;
    case 'service': {
      const svc = row.pod ? ctx.serviceByPod.get(podKey(row.namespace, row.pod)) : undefined;
      return svc ? ok(svc) : fallback;
    }
    default: {
      if (!groupBy.startsWith(LABEL_PREFIX)) {
        return fallback;
      }
      const key = groupBy.slice(LABEL_PREFIX.length);
      let value: string | undefined;
      if (row.label !== undefined) {
        value = row.label;
      } else if (row.pod) {
        value = podLabel(ctx.pods.get(podKey(row.namespace, row.pod))?.labels ?? {}, key);
      }
      return value ? ok(value) : fallback;
    }
  }
}

export const groupKeyOf = (row: UsageRow, groupBy: string, ctx: GroupContext): string => groupOf(row, groupBy, ctx).key;

// ---- Filters and drill-down ----

export interface DrillStep {
  groupBy: string;
  key: string;
}

export interface Filters {
  namespaces: string[];
  nodes: string[];
  include: string[];
  exclude: string[];
}

/** Rows after the namespace and node filters (empty list = no restriction). */
export function filterRows(rows: UsageRow[], f: Pick<Filters, 'namespaces' | 'nodes'>): UsageRow[] {
  return rows.filter(
    r => (f.namespaces.length === 0 || f.namespaces.includes(r.namespace)) && (f.nodes.length === 0 || f.nodes.includes(r.node))
  );
}

/** Include-only / exclude on the top-level grouping, before any drill-down. */
export function filterGroups(rows: UsageRow[], groupBy: string, ctx: GroupContext, f: Pick<Filters, 'include' | 'exclude'>): UsageRow[] {
  if (f.include.length === 0 && f.exclude.length === 0) {
    return rows;
  }
  return rows.filter(r => {
    const k = groupKeyOf(r, groupBy, ctx);
    return (f.include.length === 0 || f.include.includes(k)) && !f.exclude.includes(k);
  });
}

export function applyDrill(rows: UsageRow[], drill: DrillStep[], ctx: GroupContext): UsageRow[] {
  return drill.reduce((acc, step) => acc.filter(r => groupKeyOf(r, step.groupBy, ctx) === step.key), rows);
}

/** namespace -> workload -> pod; every other grouping drills straight to pod. */
export function nextGroupBy(groupBy: string): string {
  return groupBy === 'namespace' ? 'workload' : 'pod';
}

export function effectiveGroupBy(base: string, drill: DrillStep[]): string {
  return drill.length === 0 ? base : nextGroupBy(drill[drill.length - 1].groupBy);
}

export const canDrill = (groupBy: string) => groupBy !== 'pod';

/** Strips the namespace prefix a drill-down already implies, for display only. */
export function displayKey(key: string, drill: DrillStep[]): string {
  const ns = drill.find(d => d.groupBy === 'namespace')?.key ?? drill.find(d => d.groupBy === 'workload')?.key.split('/')[0];
  return ns && key.startsWith(`${ns}/`) ? key.slice(ns.length + 1) : key;
}

// ---- What the page has to fetch ----

export interface FetchPlan {
  /** Single pods that exist now are needed (pod and Service grouping). */
  live: boolean;
  /** Label key (original or label_*) to join server-side, when grouping by label. */
  labelKey?: string;
}

/** Only the queries a view needs: namespace/workload/node need aggregated rows alone. */
export function planFor(groupBy: string, drill: DrillStep[]): FetchPlan {
  const used = [groupBy, effectiveGroupBy(groupBy, drill), ...drill.map(d => d.groupBy)];
  const labelUse = used.find(g => g.startsWith(LABEL_PREFIX));
  return {
    live: used.some(g => g === 'pod' || g === 'service'),
    labelKey: labelUse ? labelUse.slice(LABEL_PREFIX.length) : undefined,
  };
}

// ---- Aggregation ----

export interface Group {
  key: string;
  /** Sits under its workload because it could not be placed in the grouping. */
  fallback: boolean;
  /** Pods placed by the workload fallback. */
  fallbackPods: number;
  values: Record<Measure, number>;
}

export function aggregate(rows: UsageRow[], groupBy: string, ctx: GroupContext): Group[] {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const { key, fallback } = groupOf(r, groupBy, ctx);
    let g = groups.get(key);
    if (!g) {
      g = { key, fallback, fallbackPods: 0, values: emptyValues() };
      groups.set(key, g);
    }
    if (fallback) {
      g.fallbackPods += r.pods;
    }
    for (const m of MEASURES) {
      g.values[m] += r.values[m];
    }
  }
  return [...groups.values()];
}

export interface Slice {
  key: string;
  value: number;
}

/** Every group with usage, largest first. No top-N: each group keeps its real slice. */
export function slicesFor(groups: Group[], measure: Measure): Slice[] {
  return groups
    .map(g => ({ key: g.key, value: g.values[measure] }))
    .filter(g => g.value > 0)
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}

export const totalOf = (groups: Group[], measure: Measure) => groups.reduce((s, g) => s + g.values[measure], 0);
