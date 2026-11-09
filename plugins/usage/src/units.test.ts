import { describe, expect, it } from 'vitest';
import { primaryFor, secondaryFor } from './describe';
import { emptyValues } from './model';
import { buildLabelQueries, buildQueries, RESOURCES } from './resources';
import { formatBytes, formatCoreHours, formatCores, formatPercent, formatRate } from './units';

describe('units', () => {
  it('humanises bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.50 KiB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.00 GiB');
    expect(formatBytes(NaN)).toBe('-');
    expect(formatRate(2048)).toBe('2.00 KiB/s');
  });
  it('formats cores and core-hours', () => {
    expect(formatCores(0.5)).toBe('0.50 cores');
    expect(formatCores(0.001)).toBe('<0.01 cores');
    expect(formatCoreHours(7200)).toBe('2.00 core-h');
  });
  it('formats percentages', () => {
    expect(formatPercent(1, 4)).toBe('25%');
    expect(formatPercent(1, 0)).toBe('0%');
    expect(formatPercent(1, 100000)).toBe('<0.1%');
  });
  it('describes each resource', () => {
    const cpu = RESOURCES[0];
    const mem = RESOURCES[1];
    const net = RESOURCES[4];
    const v = { ...emptyValues(), cpuSeconds: 3600, memAvg: 1024 ** 3, memPeak: 2 * 1024 ** 3, netIn: 3600 * 1024 };
    expect(primaryFor(cpu, v.cpuSeconds, 3600)).toBe('1.00 cores');
    expect(secondaryFor(cpu, v, 3600)).toBe('1.00 core-h');
    expect(secondaryFor(mem, v, 3600)).toBe('2.00 GiB sum of pod peaks');
    expect(primaryFor(net, v.netIn, 3600)).toBe('3.52 MiB');
    expect(secondaryFor(net, v, 3600)).toBe('1.00 KiB/s avg');
  });
});

describe('buildQueries', () => {
  it('uses the selected window in every query', () => {
    const q = buildQueries('7d');
    expect(Object.values(q.agg).every(s => s.includes('[7d]'))).toBe(true);
    expect(Object.values(q.live).every(s => s.includes('[7d]'))).toBe(true);
    expect(q.agg.cpuSeconds).toContain('sum by (namespace, node, owner_kind, owner_name) ((sum by (namespace, pod, node) (increase(container_cpu_usage_seconds_total{container!=""}[7d]))) * on (namespace, pod) group_left (owner_kind, owner_name)');
    expect(q.agg.memAvg).toContain('integrate(container_memory_working_set_bytes{container!=""}[7d])) / 604800');
    expect(q.agg.netIn).toContain('interface=~"eth[0-9]+"');
  });
  it('rolls owners up server-side and keeps pods with no owner via their pod name', () => {
    const agg = buildQueries('1h').agg.cpuSeconds;
    expect(agg).toContain('"Deployment", "k", "ReplicaSet/(.+)-[a-z0-9]{5,10}"');
    expect(agg).toContain('"CronJob", "k", "Job/(.+)-[0-9]{6,}"');
    expect(agg).toContain('"k", "Pod/$1", "pod", "(.+)"');
    expect(agg).toContain('label_replace(last_over_time(kube_pod_owner{owner_is_controller="true"}[1h]), "pod", "$1", "exported_pod", "(.+)")');
  });
  it('restricts the live queries to pods that exist now', () => {
    const q = buildQueries('24h');
    expect(q.live.cpuSeconds).toBe('(sum by (namespace, pod, node) (increase(container_cpu_usage_seconds_total{container!=""}[24h]))) and on (namespace, pod) kube_pod_info');
    expect(q.liveOwners).toContain('kube_pod_owner{owner_is_controller="true"}');
  });
  it('joins pod labels server-side, keeping pods that have none', () => {
    const q = buildLabelQueries('1h', 'label_app').cpuSeconds;
    expect(q).toContain('sum by (namespace, node, owner_kind, owner_name, label_app)');
    expect(q).toContain('last_over_time(kube_pod_labels[1h])');
    expect(q).toContain('group_left (owner_kind, owner_name, label_app)');
  });
});
