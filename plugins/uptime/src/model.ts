/*
 * Pure model of the uptime page: one row per check, combined over its sites by
 * the check's policy, exactly as the alert rule does it:
 *   policy "any": down while any site fails;
 *   policy "all": down only while every site fails (some failing is "degraded").
 */
import type { MetricSample, RangeSeries } from './metrics';

export type Policy = 'all' | 'any';
export type Status = 'up' | 'down' | 'degraded' | 'unknown';

export interface SiteResult {
  location: string;
  up?: boolean;
  latencySec?: number;
  httpStatus?: number;
  uptime24h?: number;
}

export interface Check {
  name: string;
  type: string;
  instance: string;
  policy: Policy;
  sites: Map<string, SiteResult>;
  status: Status;
  tlsDaysLeft?: number;
  uptime24h?: number;
  uptime7d?: number;
  /** Combined availability per history bucket (0..1), undefined = no data. */
  history: (number | undefined)[];
}

export interface Raw {
  success: MetricSample[];
  duration: MetricSample[];
  httpStatus: MetricSample[];
  tlsExpiry: MetricSample[];
  siteUptime24h: MetricSample[];
  uptime24h: MetricSample[];
  uptime7d: MetricSample[];
  history: RangeSeries[];
}

export const HISTORY_HOURS = 24;
export const HISTORY_STEP_SEC = 15 * 60;
export const HISTORY_BUCKETS = (HISTORY_HOURS * 3600) / HISTORY_STEP_SEC;
export const TLS_WARN_DAYS = 14;
export const TLS_CRIT_DAYS = 7;

const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

export function policyOf(raw: string | undefined): Policy {
  return raw === 'any' ? 'any' : 'all';
}

/** Combine per-site availability (1 up, 0 down, or a fraction) by policy. */
export function combine(policy: Policy, values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return policy === 'any' ? Math.min(...values) : Math.max(...values);
}

export function statusOf(policy: Policy, ups: boolean[]): Status {
  if (ups.length === 0) return 'unknown';
  const failing = ups.filter(u => !u).length;
  if (failing === 0) return 'up';
  if (policy === 'any' || failing === ups.length) return 'down';
  return 'degraded';
}

/** PromQL for the combined (policy-aware) availability of every check over a window. */
export function combinedUptimeQuery(job: string, window: string, step: string): string {
  const s = (p: Policy) => `probe_success{job="${job}",policy="${p}"}`;
  return (
    `avg_over_time((min by (target) (${s('any')}))[${window}:${step}])` +
    ` or avg_over_time((max by (target) (${s('all')}))[${window}:${step}])`
  );
}

export function queries(job: string) {
  const sel = `{job="${job}"}`;
  return {
    success: `probe_success${sel}`,
    duration: `probe_duration_seconds${sel}`,
    httpStatus: `probe_http_status_code${sel}`,
    tlsExpiry: `min by (target) (probe_ssl_earliest_cert_expiry${sel})`,
    siteUptime24h: `avg_over_time(probe_success${sel}[24h])`,
    uptime24h: combinedUptimeQuery(job, '24h', '1m'),
    uptime7d: combinedUptimeQuery(job, '7d', '5m'),
    history: `avg_over_time(probe_success${sel}[${HISTORY_STEP_SEC}s])`,
  };
}

function siteOf(check: Check, location: string): SiteResult {
  let site = check.sites.get(location);
  if (!site) {
    site = { location };
    check.sites.set(location, site);
  }
  return site;
}

/** End of the history grid: VictoriaMetrics aligns range queries to the step, so do the same. */
export function historyEnd(nowSec: number): number {
  return Math.floor(nowSec / HISTORY_STEP_SEC) * HISTORY_STEP_SEC;
}

export function historyStart(nowSec: number): number {
  return historyEnd(nowSec) - (HISTORY_BUCKETS - 1) * HISTORY_STEP_SEC;
}

/** Build the rows. History bucket i is the range point at historyStart + i*step. */
export function buildChecks(raw: Raw, nowSec: number): { checks: Check[]; locations: string[] } {
  const byName = new Map<string, Check>();
  const locations = new Set<string>();
  const ensure = (m: Record<string, string>): Check | undefined => {
    const name = m.target;
    if (!name) return undefined;
    let c = byName.get(name);
    if (!c) {
      c = {
        name,
        type: m.type || '',
        instance: m.instance || '',
        policy: policyOf(m.policy),
        sites: new Map(),
        status: 'unknown',
        history: new Array(HISTORY_BUCKETS).fill(undefined),
      };
      byName.set(name, c);
    }
    if (m.location) locations.add(m.location);
    return c;
  };

  for (const s of raw.success) {
    const c = ensure(s.metric);
    if (c && s.metric.location) siteOf(c, s.metric.location).up = num(s.value[1]) === 1;
  }
  for (const s of raw.duration) {
    const c = byName.get(s.metric.target);
    if (c && s.metric.location) siteOf(c, s.metric.location).latencySec = num(s.value[1]);
  }
  for (const s of raw.httpStatus) {
    const c = byName.get(s.metric.target);
    const v = num(s.value[1]);
    if (c && s.metric.location && v) siteOf(c, s.metric.location).httpStatus = v;
  }
  for (const s of raw.siteUptime24h) {
    const c = byName.get(s.metric.target);
    if (c && s.metric.location) siteOf(c, s.metric.location).uptime24h = num(s.value[1]);
  }
  for (const s of raw.tlsExpiry) {
    const c = byName.get(s.metric.target);
    const v = num(s.value[1]);
    if (c && v) c.tlsDaysLeft = (v - nowSec) / 86400;
  }
  for (const s of raw.uptime24h) {
    const c = byName.get(s.metric.target);
    if (c) c.uptime24h = num(s.value[1]);
  }
  for (const s of raw.uptime7d) {
    const c = byName.get(s.metric.target);
    if (c) c.uptime7d = num(s.value[1]);
  }

  // History: per check, per bucket, the values of every site, combined by policy.
  const start = historyStart(nowSec);
  const perBucket = new Map<string, number[][]>();
  for (const series of raw.history) {
    const c = byName.get(series.metric.target);
    if (!c) continue;
    let buckets = perBucket.get(c.name);
    if (!buckets) {
      buckets = Array.from({ length: HISTORY_BUCKETS }, () => []);
      perBucket.set(c.name, buckets);
    }
    for (const [t, v] of series.values) {
      const i = Math.round((t - start) / HISTORY_STEP_SEC);
      const n = num(v);
      if (i >= 0 && i < HISTORY_BUCKETS && n !== undefined) buckets[i].push(n);
    }
  }
  for (const [name, buckets] of perBucket) {
    const c = byName.get(name)!;
    c.history = buckets.map(vals => combine(c.policy, vals));
  }

  for (const c of byName.values()) {
    const ups = [...c.sites.values()].filter(s => s.up !== undefined).map(s => s.up as boolean);
    c.status = statusOf(c.policy, ups);
  }
  const order: Record<Status, number> = { down: 0, degraded: 1, unknown: 2, up: 3 };
  const checks = [...byName.values()].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  return { checks, locations: [...locations].sort() };
}

export type Severity = 'ok' | 'warn' | 'crit';

export function tlsSeverity(days: number | undefined): Severity {
  if (days === undefined) return 'ok';
  if (days < TLS_CRIT_DAYS) return 'crit';
  if (days < TLS_WARN_DAYS) return 'warn';
  return 'ok';
}

export function bucketSeverity(v: number | undefined): Severity | 'none' {
  if (v === undefined) return 'none';
  if (v >= 0.999) return 'ok';
  if (v <= 0.001) return 'crit';
  return 'warn';
}

export function formatPercent(v: number | undefined): string {
  if (v === undefined) return '-';
  const p = v * 100;
  if (p >= 99.995) return '100%';
  return `${p >= 99 ? p.toFixed(2) : p.toFixed(1)}%`;
}

export function formatLatency(sec: number | undefined): string {
  if (sec === undefined) return '-';
  if (sec < 1) return `${Math.round(sec * 1000)} ms`;
  return `${sec.toFixed(2)} s`;
}

export function formatDays(days: number | undefined): string {
  if (days === undefined) return '-';
  if (days < 0) return 'expired';
  if (days < 2) return `${Math.max(0, Math.floor(days * 24))} h`;
  return `${Math.floor(days)} d`;
}

export interface CountSummary {
  up: number;
  degraded: number;
  down: number;
  unknown: number;
}

export function summarise(checks: Check[]): CountSummary {
  const s: CountSummary = { up: 0, degraded: 0, down: 0, unknown: 0 };
  for (const c of checks) s[c.status] += 1;
  return s;
}

/** Latency series per site for one check, for the chart: [{t, <site>: ms}]. */
export function latencyRows(series: RangeSeries[], name: string): { rows: Record<string, number>[]; sites: string[] } {
  const byT = new Map<number, Record<string, number>>();
  const sites = new Set<string>();
  for (const s of series) {
    if (s.metric.target !== name || !s.metric.location) continue;
    sites.add(s.metric.location);
    for (const [t, v] of s.values) {
      const n = num(v);
      if (n === undefined) continue;
      const row = byT.get(t) ?? { t };
      row[s.metric.location] = Math.round(n * 1000);
      byT.set(t, row);
    }
  }
  return { rows: [...byT.values()].sort((a, b) => a.t - b.t), sites: [...sites].sort() };
}
