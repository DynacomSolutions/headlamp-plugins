import { describe, expect, it } from 'vitest';
import { emptyValues, UsageRow } from '../model';
import {
  buildSunburst,
  capacityQuery,
  childDimension,
  groupingOf,
  usageRange,
} from './widgetModel';

const row = (
  namespace: string,
  node: string,
  workload: string,
  cpuSeconds: number,
  memAvg = 0,
  label?: string
): UsageRow => ({
  namespace,
  node,
  workload,
  label,
  pods: 1,
  values: { ...emptyValues(), cpuSeconds, memAvg },
});

const rows = [
  row('shop', 'n1', 'Deployment/web', 3600),
  row('shop', 'n2', 'Deployment/web', 3600),
  row('shop', 'n1', 'Deployment/db', 1800),
  row('ops', 'n1', 'DaemonSet/agent', 900),
  row('idle', 'n1', 'Deployment/none', 0),
];
const base = {
  resource: 'cpu' as const,
  group: 'namespace' as const,
  labelKey: '',
  windowSeconds: 3600,
  namespaces: [],
  nodes: [],
  capacity: 8,
};

describe('usageRange', () => {
  it('maps the short dashboard ranges to 1 h and keeps the rest', () => {
    expect(['5m', '15m', '1h'].map(r => usageRange(r as any))).toEqual(['1h', '1h', '1h']);
    expect(usageRange('6h')).toBe('6h');
    expect(usageRange('30d')).toBe('30d');
  });
});

describe('buildSunburst', () => {
  it('groups by namespace with workloads as children, as average cores', () => {
    const d = buildSunburst(rows, base);
    expect(d.capacity).toBe(8);
    expect(d.categories.map(c => [c.key, c.value])).toEqual([
      ['shop', 2.5],
      ['ops', 0.25],
    ]);
    expect(d.categories[0].children?.map(c => [c.label, c.value])).toEqual([
      ['shop/Deployment/web', 2],
      ['shop/Deployment/db', 0.5],
    ]);
  });
  it('keeps every group: no other bucket and no top-n', () => {
    const many = Array.from({ length: 80 }, (_, i) => row(`ns${i}`, 'n1', 'Deployment/a', 36 + i));
    const d = buildSunburst(many, base);
    expect(d.categories).toHaveLength(80);
    expect(JSON.stringify(d)).not.toMatch(/other/i);
  });
  it('takes the namespace and node dashboard filters into account', () => {
    expect(
      buildSunburst(rows, { ...base, namespaces: ['ops'] }).categories.map(c => c.key)
    ).toEqual(['ops']);
    const byNode = buildSunburst(rows, { ...base, nodes: ['n2'] });
    expect(byNode.categories.map(c => [c.key, c.value])).toEqual([['shop', 1]]);
  });
  it('groups by workload with nodes as children and by node with namespaces as children', () => {
    const w = buildSunburst(rows, { ...base, group: 'workload' });
    expect(w.categories[0].key).toBe('shop/Deployment/web');
    expect(w.categories[0].children?.map(c => c.label).sort()).toEqual(['n1', 'n2']);
    const n = buildSunburst(rows, { ...base, group: 'node' });
    expect(n.categories[0].key).toBe('n1');
    expect(n.categories[0].children?.map(c => c.label)).toEqual(['shop', 'ops']);
  });
  it('groups by label and puts rows without it under their workload', () => {
    const labelled = [
      row('shop', 'n1', 'Deployment/web', 3600, 0, 'web'),
      row('shop', 'n1', 'Deployment/db', 3600, 0, ''),
    ];
    const d = buildSunburst(labelled, { ...base, group: 'label', labelKey: 'app' });
    expect(d.categories.map(c => c.key).sort()).toEqual(['shop/Deployment/db', 'web']);
  });
  it('uses memory bytes for memory', () => {
    const d = buildSunburst([row('a', 'n', 'Deployment/x', 0, 1000)], {
      ...base,
      resource: 'memory',
    });
    expect(d.categories[0].value).toBe(1000);
  });
  it('returns no categories for no rows', () => {
    expect(buildSunburst([], base).categories).toEqual([]);
  });
});

describe('helpers', () => {
  it('names the child dimension and the grouping', () => {
    expect(childDimension('namespace')).toBe('workload');
    expect(groupingOf('label', ' app ')).toBe('label:app');
    expect(groupingOf('label', '')).toBe('namespace');
    expect(groupingOf('node', '')).toBe('node');
  });
  it('builds the capacity query, limited to the chosen nodes', () => {
    expect(capacityQuery('cpu', [])).toBe('sum(kube_node_status_capacity{resource="cpu"})');
    expect(capacityQuery('memory', ['a.b', 'c'])).toBe(
      'sum(kube_node_status_capacity{resource="memory", node=~"a\\.b|c"})'
    );
  });
});
