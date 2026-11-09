import { describe, expect, it } from 'vitest';
import type { MetricSample } from './metrics';
import {
  aggregate,
  applyDrill,
  buildAggregatedRows,
  buildContext,
  buildLiveRows,
  coverageCaption,
  coverageFor,
  displayKey,
  effectiveGroupBy,
  emptyValues,
  filterGroups,
  filterRows,
  groupOf,
  labelKeys,
  mergeLabelKeys,
  planFor,
  recordedSpan,
  slicesFor,
  UsageRow,
  withEndedRemainder,
  workloadFromPodName,
  workloadOf,
} from './model';

const sample = (metric: Record<string, string>, value: number): MetricSample => ({ metric, value: [0, String(value)] });

const row = (namespace: string, node: string, workload: string, values: Partial<UsageRow['values']> = {}, extra: Partial<UsageRow> = {}): UsageRow => ({
  namespace,
  node,
  workload,
  pods: 1,
  values: { ...emptyValues(), ...values },
  ...extra,
});

describe('workloadOf', () => {
  it('rolls ReplicaSets up to their Deployment, Jobs to their CronJob and runners to their set', () => {
    expect(workloadOf('ReplicaSet', 'web-79596b7b7f')).toBe('Deployment/web');
    expect(workloadOf('Job', 'backup-29012345')).toBe('CronJob/backup');
    expect(workloadOf('Job', 'migrate')).toBe('Job/migrate');
    expect(workloadOf('EphemeralRunner', 'linux-x64-runner-ab12c')).toBe('AutoscalingRunnerSet/linux-x64');
  });
  it('keeps other owners and names an ownerless pod after itself', () => {
    expect(workloadOf('StatefulSet', 'db')).toBe('StatefulSet/db');
    expect(workloadOf(undefined, undefined, 'p-1')).toBe('Pod/p-1');
    expect(workloadOf('<none>', '<none>', 'p-2')).toBe('Pod/p-2');
    expect(workloadOf('Pod', 'p-3')).toBe('Pod/p-3');
  });
});

describe('buildAggregatedRows (merge and remainder)', () => {
  const own = (kind: string, name: string, extra: Record<string, string> = {}) => ({ namespace: 'a', node: 'worker-1', owner_kind: kind, owner_name: name, ...extra });
  it('merges measures per (namespace, node, workload) and rolls owners up', () => {
    const rows = buildAggregatedRows({
      cpuSeconds: [sample(own('ReplicaSet', 'web-79596b7b7f'), 100), sample(own('ReplicaSet', 'web-5d8f9c7b6d'), 20)],
      netIn: [sample(own('ReplicaSet', 'web-79596b7b7f'), 1000)],
      pods: [sample(own('ReplicaSet', 'web-79596b7b7f'), 2), sample(own('ReplicaSet', 'web-5d8f9c7b6d'), 1)],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workload: 'Deployment/web', pods: 3 });
    expect(rows[0].values).toMatchObject({ cpuSeconds: 120, netIn: 1000, memAvg: 0 });
  });
  it('keeps pods with no owner series as their own Pod workload so totals stay exact', () => {
    const rows = buildAggregatedRows({
      cpuSeconds: [sample(own('Pod', 'solo-1'), 5), sample(own('Deployment', 'web'), 7)],
    });
    expect(rows.map(r => r.workload).sort()).toEqual(['Deployment/web', 'Pod/solo-1']);
    expect(rows.reduce((s, r) => s + r.values.cpuSeconds, 0)).toBe(12);
  });
  it('treats a series with no owner labels as an ownerless pod, not as a dropped row', () => {
    expect(buildAggregatedRows({ cpuSeconds: [sample({ namespace: 'b', node: 'worker-2' }, 5)] })).toHaveLength(1);
  });
  it('keeps the server-joined label, empty when the pod had none', () => {
    const rows = buildAggregatedRows(
      { cpuSeconds: [sample(own('Deployment', 'w', { label_app: 'web' }), 1), sample(own('Deployment', 'w2'), 2)] },
      'label_app'
    );
    expect(rows.map(r => r.label)).toEqual(['web', '']);
  });
  it('handles empty results, bad values and negatives', () => {
    expect(buildAggregatedRows({})).toEqual([]);
    expect(buildAggregatedRows({ cpuSeconds: [sample({ namespace: 'a' }, NaN), sample({ node: 'n' }, 1)] })).toEqual([]);
    expect(buildAggregatedRows({ diskRead: [sample({ namespace: 'a' }, -4)] })[0].values.diskRead).toBe(0);
  });
});

describe('live rows and the ended remainder', () => {
  const live = buildLiveRows(
    {
      cpuSeconds: [sample({ namespace: 'a', pod: 'web-79596b7b7f-x1', node: 'worker-1' }, 30)],
      memAvg: [sample({ namespace: 'a', pod: 'web-79596b7b7f-x1', node: 'worker-1' }, 100)],
    },
    [sample({ namespace: 'a', pod: 'web-79596b7b7f-x1', owner_kind: 'ReplicaSet', owner_name: 'web-79596b7b7f' }, 1)]
  );
  it('builds one row per live pod with its workload', () => {
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ pod: 'web-79596b7b7f-x1', workload: 'Deployment/web' });
  });
  it('adds one remainder row per workload and node so totals equal the aggregate', () => {
    const agg = [row('a', 'worker-1', 'Deployment/web', { cpuSeconds: 100, memAvg: 100 }), row('a', 'worker-2', 'Job/x', { cpuSeconds: 7 })];
    const rows = withEndedRemainder(live, agg);
    expect(rows).toHaveLength(3);
    const remainder = rows.filter(r => r.pod === undefined);
    expect(remainder.map(r => [r.workload, r.values.cpuSeconds])).toEqual([
      ['Deployment/web', 70],
      ['Job/x', 7],
    ]);
    // memAvg of the first workload is fully live: no remainder for it.
    expect(remainder[0].values.memAvg).toBe(0);
    expect(rows.reduce((s, r) => s + r.values.cpuSeconds, 0)).toBe(107);
  });
  it('ignores float noise and never goes negative', () => {
    const agg = [row('a', 'worker-1', 'Deployment/web', { cpuSeconds: 30.00001, memAvg: 90 })];
    expect(withEndedRemainder(live, agg)).toHaveLength(1);
  });
});

const ctx = buildContext(
  [
    { namespace: 'a', name: 'web-1', labels: { app: 'web', 'tier.io/x': 'fe' } },
    { namespace: 'a', name: 'db-1', labels: { app: 'db' } },
    { namespace: 'a', name: 'job-1', labels: {} },
  ],
  [
    { namespace: 'a', name: 'web', selector: { app: 'web' } },
    { namespace: 'a', name: 'all-web', selector: { app: 'web', 'tier.io/x': 'fe' } },
    { namespace: 'a', name: 'headless', selector: {} },
  ]
);

describe('groupOf and the workload fallback', () => {
  const web = row('a', 'worker-1', 'Deployment/web', {}, { pod: 'web-1' });
  const job = row('a', 'worker-1', 'Job/j', {}, { pod: 'job-1' });
  const ended = row('a', 'worker-1', 'Deployment/web');
  it('groups by simple fields', () => {
    expect(groupOf(web, 'namespace', ctx)).toEqual({ key: 'a', fallback: false });
    expect(groupOf(web, 'workload', ctx).key).toBe('a/Deployment/web');
    expect(groupOf(web, 'node', ctx).key).toBe('worker-1');
    expect(groupOf(web, 'pod', ctx).key).toBe('a/web-1');
  });
  it('uses the first matching Service by name and ignores empty selectors', () => {
    expect(groupOf(web, 'service', ctx)).toEqual({ key: 'a/all-web', fallback: false });
  });
  it('falls back to the workload for pods with no Service, no label or no pod identity', () => {
    const fb = { key: 'a/Job/j', fallback: true };
    expect(groupOf(job, 'service', ctx)).toEqual(fb);
    expect(groupOf(job, 'label:app', ctx)).toEqual(fb);
    expect(groupOf(ended, 'pod', ctx)).toEqual({ key: 'a/Deployment/web', fallback: true });
    expect(groupOf(ended, 'service', ctx).fallback).toBe(true);
    expect(groupOf(ended, 'label:app', ctx).fallback).toBe(true);
    expect(groupOf(row('a', '', 'Job/j'), 'node', ctx).fallback).toBe(true);
  });
  it('reads labels from live pods by original or sanitised key', () => {
    expect(groupOf(web, 'label:app', ctx).key).toBe('web');
    expect(groupOf(web, 'label:tier.io/x', ctx).key).toBe('fe');
    expect(groupOf(web, 'label:label_tier_io_x', ctx).key).toBe('fe');
  });
  it('prefers the server-joined label and falls back when it is empty', () => {
    expect(groupOf(row('a', 'n', 'w', {}, { label: 'cache' }), 'label:app', ctx)).toEqual({ key: 'cache', fallback: false });
    expect(groupOf(row('a', 'n', 'Deployment/w', {}, { label: '' }), 'label:app', ctx)).toEqual({ key: 'a/Deployment/w', fallback: true });
  });
});

describe('label keys', () => {
  it('lists live keys sorted', () => {
    expect(labelKeys([{ namespace: 'a', name: 'p', labels: { b: '1', a: '2' } }, { namespace: 'a', name: 'q', labels: { a: '3' } }])).toEqual(['a', 'b']);
  });
  it('adds only metric label names no live key explains', () => {
    expect(mergeLabelKeys(['app.kubernetes.io/name', 'tier'], ['label_app_kubernetes_io_name', 'label_team', 'namespace'])).toEqual(['app.kubernetes.io/name', 'label_team', 'tier']);
  });
});

describe('filters and drill-down', () => {
  const rows = [
    row('a', 'worker-1', 'Deployment/web', { cpuSeconds: 10 }, { pod: 'web-1' }),
    row('a', 'worker-2', 'StatefulSet/db', { cpuSeconds: 30 }, { pod: 'db-1' }),
    row('b', 'worker-1', 'Deployment/x', { cpuSeconds: 5 }),
  ];
  it('filters by namespace and node, empty meaning all', () => {
    expect(filterRows(rows, { namespaces: [], nodes: [] })).toHaveLength(3);
    expect(filterRows(rows, { namespaces: ['a'], nodes: [] })).toHaveLength(2);
    expect(filterRows(rows, { namespaces: ['a'], nodes: ['worker-1'] })).toHaveLength(1);
  });
  it('includes and excludes groups', () => {
    expect(filterGroups(rows, 'namespace', ctx, { include: ['a'], exclude: [] })).toHaveLength(2);
    expect(filterGroups(rows, 'namespace', ctx, { include: [], exclude: ['a'] })).toHaveLength(1);
  });
  it('drills namespace -> workload -> pod and other groupings -> pod', () => {
    const d1 = [{ groupBy: 'namespace', key: 'a' }];
    const d2 = [...d1, { groupBy: 'workload', key: 'a/Deployment/web' }];
    expect(effectiveGroupBy('namespace', [])).toBe('namespace');
    expect(effectiveGroupBy('namespace', d1)).toBe('workload');
    expect(effectiveGroupBy('namespace', d2)).toBe('pod');
    expect(applyDrill(rows, d2, ctx).map(r => r.pod)).toEqual(['web-1']);
    expect(effectiveGroupBy('node', [{ groupBy: 'node', key: 'worker-1' }])).toBe('pod');
  });
  it('strips the namespace prefix a drill-down implies, for display only', () => {
    expect(displayKey('a/Deployment/web', [{ groupBy: 'namespace', key: 'a' }])).toBe('Deployment/web');
    expect(displayKey('a/web-1', [{ groupBy: 'namespace', key: 'a' }, { groupBy: 'workload', key: 'a/Deployment/web' }])).toBe('web-1');
    expect(displayKey('a/Deployment/web', [])).toBe('a/Deployment/web');
  });
});

describe('planFor', () => {
  it('needs only aggregated rows for namespace, workload and node, even when drilling to workload', () => {
    expect(planFor('namespace', [])).toEqual({ live: false, labelKey: undefined });
    expect(planFor('node', []).live).toBe(false);
  });
  it('needs live pods for pod and service grouping and for drilling down to pods', () => {
    expect(planFor('pod', []).live).toBe(true);
    expect(planFor('service', []).live).toBe(true);
    expect(planFor('namespace', [{ groupBy: 'namespace', key: 'a' }]).live).toBe(false);
    expect(planFor('namespace', [{ groupBy: 'namespace', key: 'a' }, { groupBy: 'workload', key: 'a/D/x' }]).live).toBe(true);
  });
  it('carries the label key', () => {
    expect(planFor('label:app', [])).toEqual({ live: false, labelKey: 'app' });
  });
});

describe('aggregate and slicesFor', () => {
  it('sums rows into groups and flags fallbacks', () => {
    const groups = aggregate(
      [row('a', 'n', 'Deployment/w', { cpuSeconds: 1 }, { pod: 'web-1' }), row('a', 'n', 'Deployment/w', { cpuSeconds: 2 }), row('a', 'n', 'Job/j', { cpuSeconds: 4 }, { pod: 'job-1' })],
      'label:app',
      ctx
    );
    expect(groups.find(g => g.key === 'web')?.values.cpuSeconds).toBe(1);
    expect(groups.find(g => g.key === 'a/Deployment/w')).toMatchObject({ fallback: true, fallbackPods: 1 });
    expect(groups.find(g => g.key === 'a/Job/j')?.values.cpuSeconds).toBe(4);
  });
  it('gives every group with usage its own slice, largest first, with no Other', () => {
    const groups = Array.from({ length: 30 }, (_, i) => ({ key: `g${i}`, fallback: false, fallbackPods: 0, values: { ...emptyValues(), cpuSeconds: i } }));
    const slices = slicesFor(groups, 'cpuSeconds');
    expect(slices).toHaveLength(29);
    expect(slices[0]).toEqual({ key: 'g29', value: 29 });
    expect(slices.some(s => s.key === 'Other')).toBe(false);
    expect(slices.reduce((s, x) => s + x.value, 0)).toBe(groups.reduce((s, g) => s + g.values.cpuSeconds, 0));
    expect(slicesFor(groups, 'netIn')).toEqual([]);
  });
});

describe('workloadFromPodName (ownerless pods)', () => {
  it('derives the same workload as the owner roll-ups', () => {
    expect(workloadFromPodName('linux-x64-runner-ab12c')).toBe('AutoscalingRunnerSet/linux-x64');
    expect(workloadFromPodName('web-79596b7b7f-x1abc')).toBe('Deployment/web');
    expect(workloadFromPodName('backup-29012345-x1abc')).toBe('CronJob/backup');
    expect(workloadFromPodName('worker-x1abc')).toBe('Pod/worker');
    expect(workloadFromPodName('solo')).toBe('Pod/solo');
  });
  it('merges with owned pods of the same workload', () => {
    const rows = buildAggregatedRows({
      cpuSeconds: [
        sample({ namespace: 'a', node: 'n', owner_kind: 'Deployment', owner_name: 'web' }, 1),
        sample({ namespace: 'a', node: 'n', owner_kind: 'ReplicaSet', owner_name: 'web-79596b7b7f' }, 2),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].values.cpuSeconds).toBe(3);
  });
});

describe('coverage of recorded data', () => {
  it('reports no recorded data for empty results (rules not deployed yet)', () => {
    expect(recordedSpan([], [])).toBeNull();
    expect(recordedSpan([sample({}, 1)], [])).toBeNull();
    expect(recordedSpan([sample({}, 100)], [sample({}, 200)])).toEqual({ first: 100, last: 200 });
  });
  const now = 1_800_000_000;
  const day = 86400;
  it('covers the whole window when recording started before it', () => {
    const c = coverageFor(now - 40 * day, now - 600, now, 30 * day);
    expect(c.partial).toBe(false);
    expect(c.startSec).toBe(now - 30 * day);
    expect(c.coveredSeconds).toBe(30 * day - 600);
    expect(coverageCaption(c)).toBeNull();
  });
  it('is partial when the first recorded hour is later than the window start', () => {
    const c = coverageFor(now - 3 * day + 3600, now, now, 30 * day);
    expect(c.partial).toBe(true);
    expect(c.startSec).toBe(now - 3 * day);
    expect(c.coveredSeconds).toBe(3 * day);
    expect(coverageCaption(c)).toMatch(/^Recorded data starts \d{2} \w{3} \d{4}, \d{2}:\d{2} ICT, so this view covers 3 days$/);
  });
  it('writes the start in ICT (UTC+7) and hours below 48h', () => {
    // 2026-11-09 17:00 UTC is 2026-11-10 00:00 ICT.
    const start = Date.UTC(2026, 10, 9, 17, 0) / 1000;
    const c = coverageFor(start + 3600, start + 86400, start + 86400 + 100, 30 * day);
    expect(coverageCaption(c)).toBe('Recorded data starts 10 Nov 2026, 00:00 ICT, so this view covers 24 hours');
  });
  it.each([
    [3600, '1 hour'],
    [5 * 3600, '5 hours'],
    [47 * 3600, '47 hours'],
    [48 * 3600, '2 days'],
    [3 * 86400, '3 days'],
  ])('words %i covered seconds as %s', (coveredSeconds, span) => {
    const c = { startSec: now - coveredSeconds, coveredSeconds, partial: true };
    expect(coverageCaption(c)).toMatch(new RegExp(`so this view covers ${span}$`));
  });
  it('never reports less than an hour of coverage', () => {
    expect(coverageFor(now, now, now, 7 * day).coveredSeconds).toBe(3600);
  });
});
