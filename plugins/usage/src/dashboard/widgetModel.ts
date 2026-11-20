/*
 * Pure helpers for the dashboard widgets of the Usage plugin: the dashboard time range mapped to
 * a Usage range, the sunburst data built from usage rows, and the capacity query. No React.
 */
import type { TimeRange } from '../dashboardsContract';
import { filterRows, GroupContext, groupOf, LABEL_PREFIX, UsageRow } from '../model';
import type { Range } from '../resources';
import type { SunburstData } from './geometry';

export type SunburstResource = 'cpu' | 'memory';
export type SunburstGroup = 'namespace' | 'workload' | 'node' | 'label';

/** The Usage range that covers a dashboard range. Usage has no range under 1 h, so 5 and 15 minutes use 1 h. */
export function usageRange(range: TimeRange): Range {
  switch (range) {
    case '5m':
    case '15m':
    case '1h':
      return '1h';
    default:
      return range;
  }
}

/** What the children of a group are, so every sunburst has two levels. */
const CHILD_DIMENSION: Record<SunburstGroup, 'namespace' | 'workload' | 'node'> = {
  namespace: 'workload',
  workload: 'node',
  node: 'namespace',
  label: 'workload',
};

export const childDimension = (group: SunburstGroup): 'namespace' | 'workload' | 'node' =>
  CHILD_DIMENSION[group];

/** The grouping string the Usage model uses: `label:<key>` for a label. */
export const groupingOf = (group: SunburstGroup, labelKey: string): string =>
  group === 'label' && labelKey.trim() !== ''
    ? `${LABEL_PREFIX}${labelKey.trim()}`
    : group === 'label'
    ? 'namespace'
    : group;

const EMPTY_CONTEXT: GroupContext = { pods: new Map(), serviceByPod: new Map() };

function rowValue(r: UsageRow, resource: SunburstResource, windowSeconds: number): number {
  // CPU is core-seconds over the window, shown as average cores. Memory is the time-weighted average in bytes.
  return resource === 'cpu' ? r.values.cpuSeconds / Math.max(1, windowSeconds) : r.values.memAvg;
}

/**
 * The sunburst data for the rows. The categories are the groups, the children are the second
 * dimension inside each group. Every group and every child is kept at its real size.
 */
export function buildSunburst(
  rows: UsageRow[],
  opts: {
    resource: SunburstResource;
    group: SunburstGroup;
    labelKey: string;
    windowSeconds: number;
    namespaces: string[];
    nodes: string[];
    capacity: number;
  }
): SunburstData {
  const scoped = filterRows(rows, { namespaces: opts.namespaces, nodes: opts.nodes });
  const grouping = groupingOf(opts.group, opts.labelKey);
  const dim = childDimension(opts.group);
  const keyOf = (r: UsageRow): string =>
    dim === 'workload'
      ? `${r.namespace}/${r.workload}`
      : dim === 'node'
      ? r.node || 'no node'
      : r.namespace;
  const groups = new Map<string, { value: number; kids: Map<string, number> }>();
  for (const r of scoped) {
    const v = rowValue(r, opts.resource, opts.windowSeconds);
    if (!(v > 0)) continue;
    const key = groupOf(r, grouping, EMPTY_CONTEXT).key;
    const g = groups.get(key) ?? { value: 0, kids: new Map<string, number>() };
    groups.set(key, g);
    g.value += v;
    g.kids.set(keyOf(r), (g.kids.get(keyOf(r)) ?? 0) + v);
  }
  const categories = [...groups.entries()]
    .map(([key, g]) => ({
      key,
      label: key,
      value: g.value,
      children: [...g.kids.entries()]
        .map(([k, v]) => ({ key: `${key}\u0000${k}`, label: k, value: v }))
        .sort((x, y) => y.value - x.value || x.label.localeCompare(y.label)),
    }))
    .sort((x, y) => y.value - x.value || x.key.localeCompare(y.key));
  return { capacity: Math.max(0, opts.capacity), categories };
}

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '\\\\"');

/** The PromQL for the cluster capacity of CPU (cores) or memory (bytes), limited to the chosen nodes. */
export function capacityQuery(resource: SunburstResource, nodes: string[]): string {
  const node = nodes.length > 0 ? `, node=~"${nodes.map(escapeRegex).join('|')}"` : '';
  return `sum(kube_node_status_capacity{resource="${
    resource === 'cpu' ? 'cpu' : 'memory'
  }"${node}})`;
}
