/*
 * Resource and range definitions plus the PromQL query builder. One query per
 * measure, at pod granularity; grouping happens in TypeScript.
 */

export type ResourceId = 'cpu' | 'memory' | 'diskRead' | 'diskWrite' | 'netIn' | 'netOut';
export type Measure = 'cpuSeconds' | 'memAvg' | 'memPeak' | 'diskRead' | 'diskWrite' | 'netIn' | 'netOut';

export const MEASURES: Measure[] = ['cpuSeconds', 'memAvg', 'memPeak', 'diskRead', 'diskWrite', 'netIn', 'netOut'];
/** Query keys: the usage measures plus the pod count (used for the fallback caption). */
export type QueryKey = Measure | 'pods';
export const QUERY_KEYS: QueryKey[] = [...MEASURES, 'pods'];

export interface ResourceDef {
  id: ResourceId;
  label: string;
  /** The measure the pie and the share column are based on. */
  measure: Measure;
}

export const RESOURCES: ResourceDef[] = [
  { id: 'cpu', label: 'CPU', measure: 'cpuSeconds' },
  { id: 'memory', label: 'Memory', measure: 'memAvg' },
  { id: 'diskRead', label: 'Disk read', measure: 'diskRead' },
  { id: 'diskWrite', label: 'Disk write', measure: 'diskWrite' },
  { id: 'netIn', label: 'Network in', measure: 'netIn' },
  { id: 'netOut', label: 'Network out', measure: 'netOut' },
];

export const RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = '24h';

const RANGE_SECONDS: Record<Range, number> = {
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': 24 * 3600,
  '7d': 7 * 24 * 3600,
  '30d': 30 * 24 * 3600,
};

export const rangeSeconds = (range: Range): number => RANGE_SECONDS[range];

/**
 * Pod network series carry no container label (they are pod-level), but
 * host-network pods report the node's physical NICs, which would count the
 * same traffic once per such pod. Pod interfaces are named eth*, so only
 * those are summed. Adjust if your CNI names pod interfaces differently.
 */
export const POD_INTERFACE_FILTER = 'interface=~"eth[0-9]+"';

/** How often the page refreshes: short ranges often, long (expensive) ranges rarely. */
export function refreshIntervalMs(range: Range): number {
  if (range === '1h' || range === '6h') {
    return 60_000;
  }
  return range === '24h' ? 5 * 60_000 : 15 * 60_000;
}

/** Prometheus label name for a Kubernetes label key, as kube-state-metrics exports it. */
export function sanitiseLabelKey(key: string): string {
  return `label_${key.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

/** The kube_pod_labels label name for a key that is either original or already label_*. */
export const labelNameFor = (key: string): string => (/^label_[a-zA-Z0-9_]+$/.test(key) ? key : sanitiseLabelKey(key));

const BY = 'by (namespace, pod, node)';

interface Source {
  /** Pod-level expression for the whole window. */
  inner: string;
  /** Selector used to enumerate every pod seen in the window. */
  selector: string;
}

/**
 * A raw-query window: the PromQL range selector (`[24h]`) and the seconds memory is averaged over.
 */
export interface Window {
  w: string;
  secs: number;
}

export const windowFor = (range: Range): Window => ({ w: `[${range}]`, secs: rangeSeconds(range) });


function sources(win: Window): Record<QueryKey, Source> {
  const w = win.w;
  const secs = win.secs;
  const mem = 'container_memory_working_set_bytes{container!=""}';
  const net = (metric: string) => `${metric}{pod!="", ${POD_INTERFACE_FILTER}}`;
  const inc = (selector: string) => ({ inner: `sum ${BY} (increase(${selector}${w}))`, selector });
  return {
    cpuSeconds: inc('container_cpu_usage_seconds_total{container!=""}'),
    // Time-weighted: integrate() (MetricsQL, VictoriaMetrics) gives byte-seconds, so a pod
    // alive for part of the window counts for that part only.
    memAvg: { inner: `sum ${BY} (integrate(${mem}${w})) / ${secs}`, selector: mem },
    memPeak: { inner: `sum ${BY} (max_over_time(${mem}${w}))`, selector: mem },
    diskRead: inc('container_fs_reads_bytes_total{container!=""}'),
    diskWrite: inc('container_fs_writes_bytes_total{container!=""}'),
    netIn: inc(net('container_network_receive_bytes_total')),
    netOut: inc(net('container_network_transmit_bytes_total')),
    // Pod count: value 1 per pod seen in the window; counted per group after the join.
    pods: { inner: `group ${BY} (last_over_time(${mem}${w}))`, selector: mem },
  };
}

/** Owner kinds whose names are one per pod, with the regex that strips the per-pod suffix. Keep in step with workloadOf(). */
export const ROLL_UPS: [kind: string, to: string, re: string][] = [
  ['ReplicaSet', 'Deployment', '(.+)-[a-z0-9]{5,10}'],
  ['Job', 'CronJob', '(.+)-[0-9]{6,}'],
  ['EphemeralRunner', 'AutoscalingRunnerSet', '(.+)-runner-[a-z0-9]{5}'],
];

/**
 * Workload of a pod with no owner series, from its name, lowest priority first (later rules win).
 * Same targets as ROLL_UPS, so owned and ownerless pods of one workload merge. A name that matches
 * nothing is its own workload, "Pod/<name>".
 */
export const POD_NAME_RULES: [kind: string, re: string][] = [
  ['Pod', '(.+)-[a-z0-9]{5}'],
  ['Deployment', '(.+)-[a-z0-9]{5,10}-[a-z0-9]{5}'],
  ['CronJob', '(.+)-[0-9]{6,}-[a-z0-9]{5}'],
  ['AutoscalingRunnerSet', '(.+)-runner-[a-z0-9]{5}'],
];

/**
 * Older kube-state-metrics series carry the scraping pod in `pod` and the real
 * pod in `exported_pod`. Restore the real pod so one pod never has thousands
 * of owners (which also breaks the many-to-one join).
 */
const realPod = (expr: string) => `label_replace(${expr}, "pod", "$1", "exported_pod", "(.+)")`;

/**
 * Pod -> controlling owner, one series per pod, computed server-side. Pods with
 * no owner series are added back from the pods seen in the window as owner
 * a workload derived from the pod name (POD_NAME_RULES), so no pod is dropped and totals stay exact. The roll-up to
 * Deployment / CronJob is repeated client-side (workloadOf in model.ts).
 */
export function ownerJoin(win: Window, selector: string): string {
  const w = win.w;
  const raw = `max by (namespace, pod, owner_kind, owner_name) (${realPod(`last_over_time(kube_pod_owner{owner_is_controller="true"}${w})`)})`;
  // Roll one-per-pod owners up before they cross the wire, or a month of CI runners is hundreds of
  // thousands of rows: ReplicaSet to Deployment, Job to CronJob, EphemeralRunner to its runner set.
  let rolled = `label_join(${raw}, "k", "/", "owner_kind", "owner_name")`;
  for (const [kind, to, re] of ROLL_UPS) {
    rolled = `label_replace(label_replace(${rolled}, "owner_name", "$1", "k", "${kind}/${re}"), "owner_kind", "${to}", "k", "${kind}/${re}")`;
  }
  const owners = `max by (namespace, pod, owner_kind, owner_name) (${rolled})`;
  const bare = `group by (namespace, pod) (last_over_time(${selector}${w}))`;
  let named = `label_replace(${bare}, "k", "Pod/$1", "pod", "(.+)")`;
  for (const [kind, re] of POD_NAME_RULES) {
    named = `label_replace(${named}, "k", "${kind}/$1", "pod", "${re}")`;
  }
  const ownerless = `label_replace(label_replace(${named}, "owner_name", "$1", "k", "[^/]+/(.+)"), "owner_kind", "$1", "k", "([^/]+)/.+")`;
  return `(${owners} or on (namespace, pod) ${ownerless})`;
}

/** Owner labels, plus the pod's label_x when one is given. */
function joined(win: Window, selector: string, labelName?: string): { right: string; extra: string } {
  const own = ownerJoin(win, selector);
  if (!labelName) {
    return { right: own, extra: '' };
  }
  // kube_pod_labels exists from some date on: pods without a series keep no value for the label.
  const labels = `(max by (namespace, pod, ${labelName}) (${realPod(`last_over_time(kube_pod_labels${win.w})`)}) or on (namespace, pod) group by (namespace, pod) (last_over_time(${selector}${win.w})))`;
  return { right: `(${own} * on (namespace, pod) group_left (${labelName}) ${labels})`, extra: `, ${labelName}` };
}

export interface UsageQueries {
  /** Aggregated by (namespace, node, owner), including pods that have ended. */
  agg: Record<QueryKey, string>;
  /** Pods that exist now, by (namespace, pod, node). */
  live: Record<Measure, string>;
  /** Controlling owners of live pods. */
  liveOwners: string;
}

/** Aggregated query for one measure, optionally also carrying a pod label. */
export function aggQuery(win: Window, m: QueryKey, labelName?: string): string {
  const src = sources(win);
  const { inner, selector } = src[m];
  const { right, extra } = joined(win, selector, labelName);
  const op = m === 'pods' ? 'count' : 'sum';
  return `${op} by (namespace, node, owner_kind, owner_name${extra}) ((${inner}) * on (namespace, pod) group_left (owner_kind, owner_name${extra}) ${right})`;
}

export function buildQueries(range: Range): UsageQueries {
  const win = windowFor(range);
  const src = sources(win);
  const agg = {} as Record<QueryKey, string>;
  const live = {} as Record<Measure, string>;
  for (const m of QUERY_KEYS) {
    agg[m] = aggQuery(win, m);
  }
  for (const m of MEASURES) {
    live[m] = `(${src[m].inner}) and on (namespace, pod) kube_pod_info`;
  }
  return { agg, live, liveOwners: 'max by (namespace, pod, owner_kind, owner_name) (kube_pod_owner{owner_is_controller="true"})' };
}

/** Aggregated queries that also carry a pod label, joined server-side from kube_pod_labels. */
export function buildLabelQueries(range: Range, labelName: string): Record<QueryKey, string> {
  const out = {} as Record<QueryKey, string>;
  for (const m of QUERY_KEYS) {
    out[m] = aggQuery(windowFor(range), m, labelName);
  }
  return out;
}

/** Non-empty only when kube-state-metrics exports kube_pod_labels. */
export const LABELS_PRESENT_QUERY = 'count(kube_pod_labels)';
/** Instant series, used only to read the label_* names that exist. */
export const LABEL_NAMES_QUERY = 'kube_pod_labels';

// ---- Recorded series (7d and 30d) ----

/** Ranges up to this are queried from raw metrics; longer ones from the vmalert recording rules. */
export const RAW_MAX_SECONDS = 24 * 3600;
export const isRecordedRange = (range: Range): boolean => rangeSeconds(range) > RAW_MAX_SECONDS;

/** Recording rule (group `usage`, interval 1h) behind each query key. */
export const RECORDED_SERIES: Record<QueryKey, string> = {
  cpuSeconds: 'usage:cpu_seconds:increase1h',
  memAvg: 'usage:memory_byte_seconds:integrate1h',
  memPeak: 'usage:memory_peak_bytes:max1h',
  diskRead: 'usage:disk_read_bytes:increase1h',
  diskWrite: 'usage:disk_write_bytes:increase1h',
  netIn: 'usage:net_in_bytes:increase1h',
  netOut: 'usage:net_out_bytes:increase1h',
  pods: 'usage:pods:count1h',
};

/** The pod labels the recording rules carry, as Kubernetes label keys. */
export const RECORDED_LABEL_KEYS = ['app.kubernetes.io/name', 'app.kubernetes.io/instance', 'app.kubernetes.io/component', 'app.kubernetes.io/part-of', 'app'];

/** Whether a label key (original or label_*) is one of the recorded ones. */
export const isRecordedLabel = (key: string): boolean => RECORDED_LABEL_KEYS.some(k => labelNameFor(k) === labelNameFor(key));

/** Shown when a control is unavailable on the recorded ranges. */
export const RECORDED_UNAVAILABLE = 'available up to 24h';

/**
 * One query per measure from the hourly recorded series, grouped like the raw aggregated queries.
 * Sums add across hours; the peak is the highest hour of the group's summed peak. The memory average
 * is returned as byte-seconds divided by `coveredSeconds` (the part of the window that has recorded data).
 */
export function recordedQuery(range: Range, key: QueryKey, coveredSeconds: number, labelName?: string): string {
  const w = `[${range}]`;
  const by = `namespace, node, owner_kind, owner_name${labelName ? `, ${labelName}` : ''}`;
  const series = RECORDED_SERIES[key];
  if (key === 'memPeak') {
    return `max_over_time(sum by (${by}) (${series})[${range}:1h])`;
  }
  const total = `sum by (${by}) (sum_over_time(${series}${w}))`;
  return key === 'memAvg' ? `${total} / ${Math.max(1, Math.round(coveredSeconds))}` : total;
}

/** First and last sample time (seconds) of the recorded data inside the window; empty until the rules have run. */
export function recordedCoverageQueries(range: Range): { first: string; last: string } {
  const ts = `timestamp(${RECORDED_SERIES.cpuSeconds})`;
  return { first: `min(min_over_time(${ts}[${range}]))`, last: `max(max_over_time(${ts}[${range}]))` };
}
