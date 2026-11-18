import { MetricSample, numberFromValue, queryMetrics } from '../metrics';
import type { NodeMetrics, PodUsage } from './types';

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
  | 'podMem';

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
