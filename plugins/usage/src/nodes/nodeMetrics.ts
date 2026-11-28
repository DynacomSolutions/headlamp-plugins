/*
 * Pure part of the node queries: the query list and the assembly of the results into per-node
 * metrics. This file imports no React and no Headlamp library, so the agent service can bundle it.
 */
import type {
  AgentUnitUsage,
  CgroupUsage,
  NodeMetrics,
  PodUsage,
  ProgramUsage,
  RunnerInfo,
  SystemUsage,
} from './types';

/** One label/value sample, the shape of the Prometheus HTTP API (same as MetricSample). */
export interface NodeSample {
  metric: Record<string, string>;
  value: [number, string];
}

type MetricSample = NodeSample;

/** Reads the scalar value out of an instant-query sample, or undefined. */
function numberFromValue(sample: MetricSample | undefined): number | undefined {
  const raw = sample?.value?.[1];
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

export type RunnerQueryKey = 'runnerLabels' | 'runnerJobs';

export type QueryKey =
  | 'cpuCount'
  | 'cpuIdleRate'
  | 'cpuBusyRate'
  | 'macCpuRate'
  | 'kubeCpuCapacity'
  | 'kubeCpuAllocatable'
  | 'memTotal'
  | 'memAvailable'
  | 'macMemTotal'
  | 'macMemActive'
  | 'macMemWired'
  | 'macMemCompressed'
  | 'kubeMemCapacity'
  | 'podCpu'
  | 'podMem'
  | 'runnerLabels'
  | 'runnerJobs'
  | 'cgroupInfo'
  | 'cgroupCpu'
  | 'cgroupMem'
  | 'programCpu'
  | 'programMem'
  | 'agentUnitCpu'
  | 'agentUnitMem'
  | 'remainderCpu'
  | 'remainderMem';

/** Window of the rate in the busy CPU query. The CPU label reads it, so label and query agree. */
export const CPU_BUSY_WINDOW = '1m';
/** Window of the older CPU queries, used when a node has no busy series. */
export const CPU_FALLBACK_WINDOW = '2m';

const WINDOW_UNITS: Record<string, string> = { s: 's', m: 'min', h: 'h', d: 'd' };

/** "1m" as "1 min", "30s" as "30 s". Text that is not a plain window stays as it is. */
export function windowText(window: string): string {
  const m = /^(\d+)([smhd])$/.exec(window);
  return m ? `${m[1]} ${WINDOW_UNITS[m[2]]}` : window;
}

/** Where a CPU figure comes from and over what time: "node exporter, 1 min average". */
export function cpuSourceLabel(window: string = CPU_BUSY_WINDOW): string {
  return `node exporter, ${windowText(window)} average`;
}

const STATIC_QUERIES: Record<Exclude<QueryKey, RunnerQueryKey>, string> = {
  cpuCount: 'count by (node) (node_cpu_seconds_total{mode="idle"})',
  cpuIdleRate: `sum by (node) (rate(node_cpu_seconds_total{mode=~"idle|iowait"}[${CPU_FALLBACK_WINDOW}]))`,
  // The node's real busy CPU: every mode except idle, iowait and steal, over a short window so a
  // burst of CI jobs shows at once. It is the figure the CPU ring reports for the node.
  cpuBusyRate: `sum by (node) (rate(node_cpu_seconds_total{mode!~"idle|iowait|steal"}[${CPU_BUSY_WINDOW}]))`,
  macCpuRate: `sum by (node) (rate(node_cpu_usage_seconds_total[${CPU_FALLBACK_WINDOW}]))`,
  kubeCpuCapacity: 'sum by (node) (kube_node_status_capacity{resource="cpu"})',
  // What Kubernetes can schedule. The CPU ring measures use against this, as `kubectl top` does.
  kubeCpuAllocatable: 'sum by (node) (kube_node_status_allocatable{resource="cpu"})',
  memTotal: 'sum by (node) (node_memory_MemTotal_bytes)',
  memAvailable: 'sum by (node) (node_memory_MemAvailable_bytes)',
  macMemTotal: 'sum by (node) (node_memory_total_bytes)',
  macMemActive: 'sum by (node) (node_memory_active_bytes)',
  macMemWired: 'sum by (node) (node_memory_wired_bytes)',
  macMemCompressed: 'sum by (node) (node_memory_compressed_bytes)',
  kubeMemCapacity: 'sum by (node) (kube_node_status_capacity{resource="memory"})',
  podCpu:
    'sum by (node, namespace, pod, container) (rate(container_cpu_usage_seconds_total{container!=""}[2m]))',
  podMem:
    'sum by (node, namespace, pod, container) (container_memory_working_set_bytes{container!=""})',
  cgroupInfo: 'max by (node, unit, parent, agent_unit) (agent_resource_cgroup_info)',
  cgroupCpu: 'sum by (node, unit) (rate(agent_resource_cgroup_cpu_seconds_total[2m]))',
  cgroupMem: 'sum by (node, unit) (agent_resource_cgroup_memory_bytes{type=~"anon|shmem|kernel"})',
  programCpu: 'sum by (node, unit, program) (rate(agent_resource_process_cpu_seconds_total[2m]))',
  programMem: 'sum by (node, unit, program) (agent_resource_process_rss_bytes)',
  agentUnitCpu: 'sum by (node, unit) (rate(agent_resource_agent_unit_cpu_seconds_total[2m]))',
  agentUnitMem: 'sum by (node, unit) (agent_resource_agent_unit_memory_bytes)',
  remainderCpu: 'max by (node) (agent_resource_node_remainder_cpu_cores)',
  remainderMem: 'max by (node) (agent_resource_node_remainder_memory_bytes)',
};

/** A pool prefix is a plain word: letters, digits, dash and underscore. Anything else counts as unset. */
export function cleanPoolPrefix(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : '';
}

/** Pod label name (as kube-state-metrics writes it) for a key of the runner pool service. */
const poolLabel = (prefix: string, key: string): string =>
  `label_${prefix.replace(/-/g, '_')}_io_${key}`;

/**
 * Queries for the runner pool service. Its metric and label names start with a prefix that the
 * user sets (`runnerPoolPrefix`). With no prefix there is no query: nothing is requested.
 */
export function runnerQueries(rawPrefix: unknown): Record<RunnerQueryKey, string> {
  const prefix = cleanPoolPrefix(rawPrefix);
  if (!prefix) return { runnerLabels: '', runnerJobs: '' };
  const metricPrefix = prefix.replace(/-/g, '_');
  const tenant = poolLabel(prefix, 'tenant');
  const pool = poolLabel(prefix, 'pool');
  const role = poolLabel(prefix, 'role');
  return {
    runnerLabels: `max by (namespace, pod, ${tenant}, ${pool}, ${role}) (kube_pod_labels{${poolLabel(
      prefix,
      'managed_by'
    )}="${prefix}"})`,
    // The scrape adds its own pod and job labels, so the series keeps the runner's as exported_pod and
    // exported_job. Copy them back when present. A scrape with honor_labels keeps pod and job as they are.
    runnerJobs: `max by (namespace, pod, owner, repo, pool, runs_on, workflow, job, run_id) (label_replace(label_replace(${metricPrefix}_runner_job_info, "pod", "$1", "exported_pod", "(.+)"), "job", "$1", "exported_job", "(.+)"))`,
  };
}

/** Every query for a prefix. */
export function nodeQueries(poolPrefix?: unknown): Record<QueryKey, string> {
  return { ...STATIC_QUERIES, ...runnerQueries(poolPrefix) };
}

/** The queries with the runner pool service off. */
export const NODE_QUERIES: Record<QueryKey, string> = nodeQueries('');

type NodeValues = Map<string, number>;

/** Maps node name to the sample value; samples without a node label are dropped. */
function byNode(samples: MetricSample[]): NodeValues {
  const out: NodeValues = new Map();
  for (const sample of samples) {
    const node = sample.metric.node;
    const value = numberFromValue(sample);
    if (node && value !== undefined) {
      out.set(node, value);
    }
  }
  return out;
}

/** Sums the values of samples per node and a key made of the given labels. */
function byLabels(samples: MetricSample[], labels: string[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const sample of samples) {
    const { node } = sample.metric;
    const value = numberFromValue(sample);
    if (!node || value === undefined) continue;
    const inner = out.get(node) ?? new Map<string, number>();
    out.set(node, inner);
    const id = JSON.stringify(labels.map(l => sample.metric[l] ?? ''));
    inner.set(id, (inner.get(id) ?? 0) + value);
  }
  return out;
}

/** The cgroup breakdown per node; a node without cgroup info series has none. */
function assembleSystem(
  results: Record<QueryKey, MetricSample[]>,
  v: Record<QueryKey, NodeValues>
): Map<string, SystemUsage> {
  const cpu = byLabels(results.cgroupCpu ?? [], ['unit']);
  const mem = byLabels(results.cgroupMem ?? [], ['unit']);
  const agentCpu = byLabels(results.agentUnitCpu ?? [], ['unit']);
  const agentMem = byLabels(results.agentUnitMem ?? [], ['unit']);
  const progCpu = byLabels(results.programCpu ?? [], ['unit', 'program']);
  const progMem = byLabels(results.programMem ?? [], ['unit', 'program']);
  const key = (...parts: string[]) => JSON.stringify(parts);
  const out = new Map<string, SystemUsage>();
  for (const sample of results.cgroupInfo ?? []) {
    const { node, unit, parent = '', agent_unit: agentUnit = '' } = sample.metric;
    if (!node || !unit) continue;
    const sys = out.get(node) ?? {
      cgroups: [],
      programs: [],
      agentUnits: [],
      remainderMem: v.remainderMem.get(node) ?? null,
      remainderCpu: v.remainderCpu.get(node) ?? null,
    };
    out.set(node, sys);
    // An agent cgroup is not in the cgroup series: its values come from the agent series.
    const [c, m] = agentUnit
      ? [agentCpu.get(node)?.get(key(agentUnit)), agentMem.get(node)?.get(key(agentUnit))]
      : [cpu.get(node)?.get(key(unit)), mem.get(node)?.get(key(unit))];
    const row: CgroupUsage = { unit, parent, agentUnit, cpuCores: c ?? 0, memBytes: m ?? 0 };
    sys.cgroups.push(row);
  }
  for (const [node, sys] of out) {
    const progs = new Map<string, ProgramUsage>();
    const add = (m: Map<string, number> | undefined, field: 'cpuCores' | 'memBytes') => {
      for (const [id, value] of m ?? []) {
        const [unit, program] = JSON.parse(id) as string[];
        const p = progs.get(id) ?? { unit, program, cpuCores: 0, memBytes: 0 };
        p[field] += value;
        progs.set(id, p);
      }
    };
    add(progCpu.get(node), 'cpuCores');
    add(progMem.get(node), 'memBytes');
    sys.programs = [...progs.values()];
    const units = new Map<string, AgentUnitUsage>();
    const addUnit = (m: Map<string, number> | undefined, field: 'cpuCores' | 'memBytes') => {
      for (const [id, value] of m ?? []) {
        const [unit] = JSON.parse(id) as string[];
        const u = units.get(unit) ?? { unit, cpuCores: 0, memBytes: 0 };
        u[field] += value;
        units.set(unit, u);
      }
    };
    addUnit(agentCpu.get(node), 'cpuCores');
    addUnit(agentMem.get(node), 'memBytes');
    sys.agentUnits = [...units.values()];
  }
  return out;
}

/** Queries whose failure or empty result only means "no data": the rest of the page still works. */
export const OPTIONAL_QUERIES: QueryKey[] = ['runnerLabels', 'runnerJobs'];

/** Runner pool info per pod (key `namespace/pod`): pod labels first, job info on top. */
function assembleRunners(
  results: Record<QueryKey, MetricSample[]>,
  prefix: string
): Map<string, RunnerInfo> {
  const out = new Map<string, RunnerInfo>();
  for (const { metric: m } of results.runnerLabels ?? []) {
    if (!m.namespace || !m.pod) continue;
    out.set(`${m.namespace}/${m.pod}`, {
      tenant: m[poolLabel(prefix, 'tenant')] ?? '',
      pool: m[poolLabel(prefix, 'pool')] ?? '',
      role: m[poolLabel(prefix, 'role')] ?? '',
    });
  }
  for (const { metric: m } of results.runnerJobs ?? []) {
    if (!m.namespace || !m.pod) continue;
    const id = `${m.namespace}/${m.pod}`;
    const known = out.get(id) ?? { tenant: '', pool: m.pool ?? '', role: 'runner' };
    out.set(id, {
      ...known,
      pool: known.pool || (m.pool ?? ''),
      job: {
        owner: m.owner ?? '',
        repo: m.repo ?? '',
        runsOn: m.runs_on ?? '',
        workflow: m.workflow ?? '',
        job: m.job ?? '',
        runId: m.run_id ?? '',
      },
    });
  }
  return out;
}

export function assembleNodeMetrics(
  results: Record<QueryKey, MetricSample[]>,
  poolPrefix?: unknown
): NodeMetrics[] {
  const v = {} as Record<QueryKey, NodeValues>;
  for (const key of Object.keys(NODE_QUERIES) as QueryKey[]) {
    v[key] = byNode(results[key] ?? []);
  }

  const pods = new Map<string, Map<string, PodUsage>>();
  const addPods = (samples: MetricSample[], field: 'cpuCores' | 'memBytes') => {
    for (const sample of samples) {
      const { node, namespace = '', pod = '', container = '' } = sample.metric;
      const value = numberFromValue(sample);
      if (!node || value === undefined) {
        continue;
      }
      const byKey = pods.get(node) ?? new Map<string, PodUsage>();
      pods.set(node, byKey);
      const id = `${namespace}/${pod}/${container}`;
      const usage = byKey.get(id) ?? { namespace, pod, container, cpuCores: 0, memBytes: 0 };
      usage[field] = value;
      byKey.set(id, usage);
    }
  };
  addPods(results.podCpu ?? [], 'cpuCores');
  addPods(results.podMem ?? [], 'memBytes');

  const system = assembleSystem(results, v);
  const runners = assembleRunners(results, cleanPoolPrefix(poolPrefix));

  const names = new Set<string>();
  for (const map of Object.values(v)) {
    for (const node of map.keys()) {
      names.add(node);
    }
  }
  for (const node of pods.keys()) {
    names.add(node);
  }

  return [...names]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(node => {
      // Allocatable is the denominator: the node's own count of cores (and its capacity) include
      // the cores that Kubernetes reserves for the system, so the same load would read too low.
      const cpuCapacity =
        v.kubeCpuAllocatable.get(node) ?? v.cpuCount.get(node) ?? v.kubeCpuCapacity.get(node) ?? 0;
      const memCapacity =
        v.memTotal.get(node) ?? v.macMemTotal.get(node) ?? v.kubeMemCapacity.get(node) ?? 0;

      let cpuUsed: number | null = null;
      let cpuSource: string | undefined;
      const busy = v.cpuBusyRate.get(node);
      const idle = v.cpuIdleRate.get(node);
      const macCpu = v.macCpuRate.get(node);
      if (busy !== undefined) {
        cpuUsed = Math.max(0, busy);
        cpuSource = cpuSourceLabel(CPU_BUSY_WINDOW);
      } else if (idle !== undefined && v.cpuCount.has(node)) {
        // Older data without the busy series: the logical cores minus the idle time.
        cpuUsed = Math.max(0, v.cpuCount.get(node)! - idle);
        cpuSource = cpuSourceLabel(CPU_FALLBACK_WINDOW);
      } else if (macCpu !== undefined) {
        cpuUsed = macCpu;
        cpuSource = cpuSourceLabel(CPU_FALLBACK_WINDOW);
      }

      let memUsed: number | null = null;
      const total = v.memTotal.get(node);
      const available = v.memAvailable.get(node);
      const active = v.macMemActive.get(node);
      if (total !== undefined && available !== undefined) {
        memUsed = Math.max(0, total - available);
      } else if (active !== undefined) {
        memUsed = active + (v.macMemWired.get(node) ?? 0) + (v.macMemCompressed.get(node) ?? 0);
      }

      return {
        node,
        cpuCapacity,
        cpuUsed,
        ...(cpuSource ? { cpuSource } : {}),
        memCapacity,
        memUsed,
        pods: [...(pods.get(node)?.values() ?? [])].map(p => {
          const runner = runners.get(`${p.namespace}/${p.pod}`);
          return runner ? { ...p, runner } : p;
        }),
        ...(system.has(node) ? { system: system.get(node) } : {}),
      };
    });
}
