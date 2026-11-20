import { describe, expect, it } from 'vitest';
import {
  buildGroups,
  gridFor,
  gridLabel,
  groupKeyOf,
  meanAvailability,
  namePrefix,
  NOT_IN_CLUSTER,
  Placements,
  resolveGroupBy,
  worstHistory,
  worstStatus,
} from './groups';
import { Check, DEFAULT_GRID, Status } from './model';

const check = (
  name: string,
  status: Status,
  history: (number | undefined)[] = [1, 1, 1],
  labels: Record<string, string> = {},
  type = 'http'
): Check => ({
  name,
  type,
  instance: `https://${name}/`,
  policy: 'all',
  sites: new Map(),
  status,
  labels,
  history,
});
const placed = (m: Record<string, [string, string]>): Placements =>
  new Map(
    Object.entries(m).map(([name, [namespace, app]]) => [
      name,
      { namespace, app, route: { kind: 'httproute', namespace, name: 'r', host: 'h', path: '/', exact: false, labels: {} } },
    ])
  );
const grid3 = { stepSec: 60, buckets: 3 };

describe('grouping keys', () => {
  it('uses the first word of the check name', () => {
    expect(namePrefix('t3.hq.example.com')).toBe('t3');
    expect(namePrefix('api-edge-probe-2')).toBe('api');
    expect(namePrefix('github')).toBe('github');
  });
  it('auto prefers the resolved namespace, then the app, then the name', () => {
    const plain = [check('a-1', 'up')];
    expect(resolveGroupBy('auto', plain)).toBe('name');
    // A group label alone is not an auto choice: pick it by hand.
    expect(resolveGroupBy('auto', [check('b', 'up', [], { group: 'edge' })])).toBe('name');
    expect(resolveGroupBy('auto', [check('b', 'up', [], { app: 'web' })])).toBe('app');
    expect(resolveGroupBy('auto', [check('b', 'up', [], { app: 'web' }), check('c', 'up', [], { namespace: 'shop' })])).toBe(
      'namespace'
    );
    // A namespace that the cluster routes give.
    expect(resolveGroupBy('auto', plain, placed({ 'a-1': ['shop', 'web'] }))).toBe('namespace');
    expect(resolveGroupBy('type', plain)).toBe('type');
  });
  it('reads a label, falls back to the namespace or to Not in cluster, and upper-cases the type', () => {
    const c = check('a', 'up', [], { namespace: 'shop' }, 'tcp');
    expect(groupKeyOf(c, 'namespace')).toBe('shop');
    expect(groupKeyOf(c, 'app')).toBe('shop');
    expect(groupKeyOf(check('b', 'up', [], {}, 'tcp'), 'app')).toBe('Not in cluster · TCP');
    expect(groupKeyOf(c, 'type')).toBe('TCP');
    expect(groupKeyOf(check('a', 'up', [], { app_kubernetes_io_name: 'web' }), 'app')).toBe('web');
  });
});

describe('cluster groups', () => {
  const checks = [
    check('web', 'up'),
    check('api', 'down', [1, 0, 1]),
    check('dns-a', 'up', [1, 1, 1], {}, 'dns'),
    check('dns-b', 'up', [1, 1, 1], {}, 'dns'),
    check('ssh', 'up', [1, 1, 1], {}, 'tcp'),
    check('stray', 'up'),
  ];
  const placements = placed({ web: ['shop', 'storefront'], api: ['shop', 'storefront'] });
  it('groups by namespace and splits "Not in cluster" by check type', () => {
    const { groups, resolved } = buildGroups(checks, 'auto', grid3, false, placements);
    expect(resolved).toBe('namespace');
    expect(groups.map(g => g.key).sort()).toEqual([
      `${NOT_IN_CLUSTER} · DNS`,
      `${NOT_IN_CLUSTER} · HTTP`,
      `${NOT_IN_CLUSTER} · TCP`,
      'shop',
    ]);
    expect(groups.find(g => g.key === 'shop')?.checks.map(c => c.name)).toEqual(['web', 'api']);
    expect(groups.find(g => g.key === `${NOT_IN_CLUSTER} · DNS`)?.checks).toHaveLength(2);
    expect(groups.flatMap(g => g.checks)).toHaveLength(checks.length);
    expect(groups.some(g => /other/i.test(g.key))).toBe(false);
  });
  it('groups by app, which falls back to the namespace of the route', () => {
    const p = placed({ web: ['shop', 'storefront'], api: ['shop', 'shop'] });
    const { groups } = buildGroups(checks, 'app', grid3, false, p);
    expect(groups.map(g => g.key)).toContain('storefront');
    expect(groups.map(g => g.key)).toContain('shop');
    expect(groups.find(g => g.key === 'shop')?.checks.map(c => c.name)).toEqual(['api']);
  });
  it('a series label wins over the cluster', () => {
    const c = check('web', 'up', [], { namespace: 'labelled' });
    expect(groupKeyOf(c, 'namespace', placements)).toBe('labelled');
  });
  it('without routes every check is not in the cluster, never one Other group', () => {
    const { groups } = buildGroups(checks, 'namespace', grid3, false);
    expect(groups.every(g => g.key.startsWith(NOT_IN_CLUSTER))).toBe(true);
    expect(groups).toHaveLength(3);
  });
});

describe('group status and history', () => {
  it('the worst status wins and no data never outranks up', () => {
    expect(worstStatus([check('a', 'up'), check('b', 'down'), check('c', 'degraded')])).toBe('down');
    expect(worstStatus([check('a', 'up'), check('b', 'degraded')])).toBe('degraded');
    expect(worstStatus([check('a', 'up'), check('b', 'unknown')])).toBe('up');
    expect(worstStatus([check('a', 'unknown')])).toBe('unknown');
  });
  it('takes the worst value per bucket and keeps empty buckets empty', () => {
    const a = check('a', 'up', [1, 0.5, undefined]);
    const b = check('b', 'up', [0.8, 1, undefined]);
    expect(worstHistory([a, b], 3)).toEqual([0.8, 0.5, undefined]);
    expect(worstHistory([], 2)).toEqual([undefined, undefined]);
  });
  it('averages the buckets that have data', () => {
    expect(meanAvailability([1, 0, undefined])).toBe(0.5);
    expect(meanAvailability([undefined])).toBeUndefined();
  });
});

describe('buildGroups', () => {
  const checks = [
    check('web-1', 'up'),
    check('web-2', 'down', [1, 0, 1]),
    check('db-1', 'up'),
    check('cache', 'degraded', [1, 0.5, 1]),
    check('solo', 'up'),
  ];
  it('puts every check in one group, with no top-N and no Other group', () => {
    const { groups, resolved } = buildGroups(checks, 'name', grid3, false);
    expect(resolved).toBe('name');
    expect(groups.map(g => g.key)).toEqual(['web', 'cache', 'db', 'solo']);
    expect(groups.flatMap(g => g.checks).length).toBe(checks.length);
    expect(groups.find(g => g.key === 'web')).toMatchObject({
      status: 'down',
      counts: { up: 1, down: 1, degraded: 0, unknown: 0 },
      history: [1, 0, 1],
    });
  });
  it('sorts failing groups first, then by name', () => {
    const { groups } = buildGroups(checks, 'name', grid3, false);
    expect(groups.map(g => g.status)).toEqual(['down', 'degraded', 'up', 'up']);
  });
  it('only failing keeps the down and degraded groups, with all their checks', () => {
    const { groups } = buildGroups(checks, 'name', grid3, true);
    expect(groups.map(g => g.key)).toEqual(['web', 'cache']);
    expect(groups[0].checks.map(c => c.name)).toEqual(['web-1', 'web-2']);
  });
});

describe('time range', () => {
  it('maps a range to a grid of 60 to 96 buckets', () => {
    expect(gridFor('24h', '1h')).toEqual(DEFAULT_GRID);
    expect(gridFor('dashboard', '7d')).toEqual({ stepSec: 7200, buckets: 84 });
    expect(gridFor('dashboard', '5m')).toEqual({ stepSec: 60, buckets: 60 });
    expect(gridFor('6h', '30d')).toEqual({ stepSec: 300, buckets: 72 });
    expect(gridFor('30d', '1h')).toEqual({ stepSec: 28800, buckets: 90 });
  });
  it('labels the window', () => {
    expect(gridLabel(DEFAULT_GRID)).toBe('24 h');
    expect(gridLabel(gridFor('30d', ''))).toBe('30 days');
    expect(gridLabel(gridFor('7d', ''))).toBe('7 days');
  });
});
