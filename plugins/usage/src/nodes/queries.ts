import { MetricSample, numberFromValue, queryMetrics } from '../metrics';
import type { CgroupUsage, NodeMetrics, PodUsage, ProgramUsage, SystemUsage } from './types';

export type QueryKey =
  | 'cpuCount'
  | 'cpuIdleRate'
  | 'macCpuRate'
  | 'kubeCpuCapacity'
  | 'memTotal'
  | 'memAvailable'
  | 'macMemTotal'
  | 'macMemActive'
  | 'macMemWired'
  | 'macMemCompressed'
  | 'kubeMemCapacity'
  | 'podCpu'
  | 'podMem'
  | 'cgroupInfo'
  | 'cgroupCpu'
  | 'cgroupMem'
  | 'programCpu'
  | 'programMem'
  | 'agentUnitCpu'
  | 'agentUnitMem'
  | 'remainderCpu'
  | 'remainderMem';

export const NODE_QUERIES: Record<QueryKey, string> = {
  cpuCount: 'count by (node) (node_cpu_seconds_total{mode="idle"})',
  cpuIdleRate: 'sum by (node) (rate(node_cpu_seconds_total{mode=~"idle|iowait"}[2m]))',
  macCpuRate: 'sum by (node) (rate(node_cpu_usage_seconds_total[2m]))',
  kubeCpuCapacity: 'sum by (node) (kube_node_status_capacity{resource="cpu"})',
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
  cgroupInfo: 'max by (node, unit, parent, agent_unit) (agent_memory_cgroup_info)',
  cgroupCpu: 'sum by (node, unit) (rate(agent_memory_cgroup_cpu_seconds_total[2m]))',
  cgroupMem:
    'sum by (node, unit) (agent_memory_cgroup_memory_bytes{type=~"anon|shmem|kernel"})',
  programCpu:
    'sum by (node, unit, program) (rate(agent_memory_process_cpu_seconds_total[2m]))',
  programMem: 'sum by (node, unit, program) (agent_memory_process_rss_bytes)',
  agentUnitCpu: 'sum by (node, unit) (rate(agent_memory_agent_unit_cpu_seconds_total[2m]))',
  agentUnitMem: 'sum by (node, unit) (agent_memory_agent_unit_memory_bytes)',
  remainderCpu: 'max by (node) (agent_memory_node_remainder_cpu_cores)',
  remainderMem: 'max by (node) (agent_memory_node_remainder_memory_bytes)',
};

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
  }
  return out;
}

export function assembleNodeMetrics(results: Record<QueryKey, MetricSample[]>): NodeMetrics[] {
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
    .map((node) => {
      const cpuCapacity = v.cpuCount.get(node) ?? v.kubeCpuCapacity.get(node) ?? 0;
      const memCapacity =
        v.memTotal.get(node) ?? v.macMemTotal.get(node) ?? v.kubeMemCapacity.get(node) ?? 0;

      let cpuUsed: number | null = null;
      const idle = v.cpuIdleRate.get(node);
      const macCpu = v.macCpuRate.get(node);
      if (idle !== undefined && v.cpuCount.has(node)) {
        cpuUsed = Math.max(0, cpuCapacity - idle);
      } else if (macCpu !== undefined) {
        cpuUsed = macCpu;
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
        memCapacity,
        memUsed,
        pods: [...(pods.get(node)?.values() ?? [])],
        ...(system.has(node) ? { system: system.get(node) } : {}),
      };
    });
}

export async function fetchNodeMetrics(): Promise<NodeMetrics[]> {
  const keys = Object.keys(NODE_QUERIES) as QueryKey[];
  const samples = await Promise.all(keys.map(key => queryMetrics(NODE_QUERIES[key])));
  const results = {} as Record<QueryKey, MetricSample[]>;
  keys.forEach((key, i) => {
    results[key] = samples[i];
  });
  return assembleNodeMetrics(results);
}
