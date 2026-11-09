import { describe, expect, it } from 'vitest';
import { aggQuery, buildLabelQueries, buildQueries, isRecordedLabel, isRecordedRange, labelNameFor, RECORDED_LABEL_KEYS, recordedCoverageQueries, recordedQuery, refreshIntervalMs, sanitiseLabelKey, windowFor } from './resources';

describe('sanitiseLabelKey', () => {
  it('adds the label_ prefix and replaces every non [a-zA-Z0-9_] character', () => {
    expect(sanitiseLabelKey('app.kubernetes.io/name')).toBe('label_app_kubernetes_io_name');
    expect(sanitiseLabelKey('team-a')).toBe('label_team_a');
    expect(labelNameFor('app')).toBe('label_app');
    expect(labelNameFor('label_team')).toBe('label_team');
  });
});

describe('refreshIntervalMs', () => {
  it('is 60 s for 1h and 6h, 5 min for 24h and 15 min for 7d and 30d', () => {
    expect((['1h', '6h', '24h', '7d', '30d'] as const).map(r => refreshIntervalMs(r) / 1000)).toEqual([60, 60, 300, 900, 900]);
  });
});

describe('queries', () => {
  it('joins the owner server-side and keeps ownerless pods', () => {
    const q = aggQuery(windowFor('24h'), 'cpuSeconds');
    expect(q).toContain('sum by (namespace, node, owner_kind, owner_name)');
    expect(q).toContain('group_left (owner_kind, owner_name)');
    expect(q).toContain('last_over_time(kube_pod_owner');
    expect(q).toContain('or on (namespace, pod)');
  });
  it('joins kube_pod_labels for label grouping', () => {
    const q = buildLabelQueries('7d', 'label_app').cpuSeconds;
    expect(q).toContain('sum by (namespace, node, owner_kind, owner_name, label_app)');
    expect(q).toContain('group_left (label_app)');
    expect(q).toContain('last_over_time(kube_pod_labels[7d])');
  });
  it('counts pods and restricts live queries with kube_pod_info', () => {
    expect(aggQuery(windowFor('24h'), 'pods')).toMatch(/^count by/);
    expect(buildQueries('24h').live.cpuSeconds).toContain('and on (namespace, pod) kube_pod_info');
  });
  it('keeps memory time-weighted', () => {
    expect(buildQueries('24h').agg.memAvg).toContain('integrate(');
    expect(buildQueries('24h').agg.memAvg).toContain('/ 86400');
  });
});

describe('ownerless pod workload from the pod name', () => {
  it('uses the same targets as the owner roll-ups', () => {
    const q = aggQuery(windowFor('24h'), 'cpuSeconds');
    expect(q).toContain('"AutoscalingRunnerSet/$1", "pod", "(.+)-runner-[a-z0-9]{5}"');
    expect(q).toContain('"Deployment/$1", "pod", "(.+)-[a-z0-9]{5,10}-[a-z0-9]{5}"');
  });
});

describe('recorded queries (7d, 30d)', () => {
  it('uses recorded series only for ranges over a day', () => {
    expect((['1h', '6h', '24h', '7d', '30d'] as const).map(isRecordedRange)).toEqual([false, false, false, true, true]);
  });
  it('sums the hourly series per grouping', () => {
    expect(recordedQuery('7d', 'cpuSeconds', 1)).toBe('sum by (namespace, node, owner_kind, owner_name) (sum_over_time(usage:cpu_seconds:increase1h[7d]))');
    expect(recordedQuery('30d', 'diskRead', 1, 'label_app')).toBe('sum by (namespace, node, owner_kind, owner_name, label_app) (sum_over_time(usage:disk_read_bytes:increase1h[30d]))');
    expect(recordedQuery('30d', 'pods', 1)).toContain('sum_over_time(usage:pods:count1h[30d])');
  });
  it('divides byte-seconds by the covered seconds for the memory average', () => {
    expect(recordedQuery('30d', 'memAvg', 172800)).toBe('sum by (namespace, node, owner_kind, owner_name) (sum_over_time(usage:memory_byte_seconds:integrate1h[30d])) / 172800');
  });
  it('takes the highest hour of the summed peak', () => {
    expect(recordedQuery('7d', 'memPeak', 1)).toBe('max_over_time(sum by (namespace, node, owner_kind, owner_name) (usage:memory_peak_bytes:max1h)[7d:1h])');
  });
  it('finds the first and last recorded hour', () => {
    expect(recordedCoverageQueries('30d')).toEqual({
      first: 'min(min_over_time(timestamp(usage:cpu_seconds:increase1h)[30d]))',
      last: 'max(max_over_time(timestamp(usage:cpu_seconds:increase1h)[30d]))',
    });
  });
  it('knows the five recorded label keys by original or sanitised name', () => {
    expect(RECORDED_LABEL_KEYS).toHaveLength(5);
    expect(isRecordedLabel('app.kubernetes.io/part-of')).toBe(true);
    expect(isRecordedLabel('label_app_kubernetes_io_name')).toBe(true);
    expect(isRecordedLabel('team')).toBe(false);
  });
});
