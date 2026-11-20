import { describe, expect, it } from 'vitest';
import {
  buildGroups,
  gridFor,
  gridLabel,
  groupKeyOf,
  meanAvailability,
  namePrefix,
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
const grid3 = { stepSec: 60, buckets: 3 };

describe('grouping keys', () => {
  it('uses the first word of the check name', () => {
    expect(namePrefix('t3.hq.example.com')).toBe('t3');
    expect(namePrefix('api-edge-probe-2')).toBe('api');
    expect(namePrefix('github')).toBe('github');
  });
  it('auto prefers namespace, then app, then group, then the name', () => {
    const plain = [check('a-1', 'up')];
    expect(resolveGroupBy('auto', plain)).toBe('name');
    expect(resolveGroupBy('auto', [...plain, check('b', 'up', [], { group: 'edge' })])).toBe('group');
    expect(resolveGroupBy('auto', [check('b', 'up', [], { app: 'web', group: 'edge' })])).toBe('app');
    expect(
      resolveGroupBy('auto', [check('b', 'up', [], { app: 'web' }), check('c', 'up', [], { namespace: 'shop' })])
    ).toBe('namespace');
    expect(resolveGroupBy('type', plain)).toBe('type');
  });
  it('reads a label, falls back to a named empty group, and upper-cases the type', () => {
    const c = check('a', 'up', [], { namespace: 'shop' }, 'tcp');
    expect(groupKeyOf(c, 'namespace')).toBe('shop');
    expect(groupKeyOf(c, 'app')).toBe('(no app)');
    expect(groupKeyOf(c, 'type')).toBe('TCP');
    expect(groupKeyOf(check('a', 'up', [], { app_kubernetes_io_name: 'web' }), 'app')).toBe('web');
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
