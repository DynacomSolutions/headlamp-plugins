import { describe, expect, it } from 'vitest';
import type { MetricSample, RangeSeries } from './metrics';
import {
  bucketSeverity,
  buildChecks,
  combine,
  combinedUptimeQuery,
  formatDays,
  formatLatency,
  formatPercent,
  HISTORY_BUCKETS,
  HISTORY_STEP_SEC,
  historyStart,
  latencyRows,
  queries,
  Raw,
  statusOf,
  summarise,
  tlsSeverity,
} from './model';

const NOW = 1_800_000_000;
const s = (metric: Record<string, string>, value: number): MetricSample => ({ metric, value: [NOW, String(value)] });
const empty = (): Raw => ({
  success: [],
  duration: [],
  httpStatus: [],
  tlsExpiry: [],
  siteUptime24h: [],
  uptime24h: [],
  uptime7d: [],
  history: [],
});
const web = { target: 'web', type: 'http', instance: 'https://example.com/', policy: 'all' };
const dns = { target: 'dns', type: 'dns', instance: '192.0.2.53', policy: 'any' };

describe('policy', () => {
  it('any is down when one site fails, all only when every site fails', () => {
    expect(statusOf('any', [true, false])).toBe('down');
    expect(statusOf('all', [true, false])).toBe('degraded');
    expect(statusOf('all', [false, false])).toBe('down');
    expect(statusOf('all', [true, true])).toBe('up');
    expect(statusOf('any', [])).toBe('unknown');
  });
  it('combines availability like the alert rule', () => {
    expect(combine('any', [1, 0.5])).toBe(0.5);
    expect(combine('all', [0, 0.5])).toBe(0.5);
    expect(combine('all', [])).toBeUndefined();
  });
  it('the combined uptime query uses min for any and max for all', () => {
    const q = combinedUptimeQuery('uptime', '24h', '1m');
    expect(q).toContain('min by (target) (probe_success{job="uptime",policy="any"})');
    expect(q).toContain('max by (target) (probe_success{job="uptime",policy="all"})');
    expect(q).toContain('[24h:1m]');
    expect(queries('uptime').history).toBe(`avg_over_time(probe_success{job="uptime"}[${HISTORY_STEP_SEC}s])`);
  });
});

describe('buildChecks', () => {
  it('builds one row per check with per-site results, sorted worst first', () => {
    const raw = empty();
    raw.success = [
      s({ ...web, location: 'eu' }, 1),
      s({ ...web, location: 'hq' }, 0),
      s({ ...dns, location: 'eu' }, 1),
      s({ ...dns, location: 'hq' }, 0),
    ];
    raw.duration = [s({ ...web, location: 'eu' }, 0.123)];
    raw.httpStatus = [s({ ...web, location: 'eu' }, 200), s({ ...web, location: 'hq' }, 0)];
    raw.tlsExpiry = [s({ target: 'web' }, NOW + 10 * 86400)];
    raw.uptime24h = [s({ target: 'web' }, 0.99)];
    const { checks, locations } = buildChecks(raw, NOW);
    expect(locations).toEqual(['eu', 'hq']);
    expect(checks.map(c => [c.name, c.status])).toEqual([
      ['dns', 'down'],
      ['web', 'degraded'],
    ]);
    const w = checks[1];
    expect(w.instance).toBe('https://example.com/');
    expect(w.sites.get('eu')).toMatchObject({ up: true, latencySec: 0.123, httpStatus: 200 });
    expect(w.sites.get('hq')?.up).toBe(false);
    expect(w.sites.get('hq')?.httpStatus).toBeUndefined();
    expect(w.tlsDaysLeft).toBeCloseTo(10);
    expect(w.uptime24h).toBe(0.99);
  });

  it('combines history per bucket by policy on the aligned grid', () => {
    const raw = empty();
    raw.success = [s({ ...web, location: 'eu' }, 1), s({ ...dns, location: 'eu' }, 1)];
    const start = historyStart(NOW);
    const last = start + (HISTORY_BUCKETS - 1) * HISTORY_STEP_SEC;
    const series = (m: Record<string, string>, v: string): RangeSeries => ({
      metric: m,
      values: [
        [start, '1'],
        [last, v],
      ],
    });
    raw.history = [
      series({ ...web, location: 'eu' }, '1'),
      series({ ...web, location: 'hq' }, '0'),
      series({ ...dns, location: 'eu' }, '1'),
      series({ ...dns, location: 'hq' }, '0'),
    ];
    const { checks } = buildChecks(raw, NOW);
    const byName = Object.fromEntries(checks.map(c => [c.name, c]));
    expect(byName.web.history[0]).toBe(1);
    expect(byName.web.history[HISTORY_BUCKETS - 1]).toBe(1);
    expect(byName.dns.history[HISTORY_BUCKETS - 1]).toBe(0);
    expect(byName.dns.history[5]).toBeUndefined();
    expect(byName.dns.history).toHaveLength(HISTORY_BUCKETS);
  });

  it('ignores series without a target and counts statuses', () => {
    const raw = empty();
    raw.success = [s({ location: 'eu' }, 1), s({ ...web, location: 'eu' }, 1)];
    const { checks } = buildChecks(raw, NOW);
    expect(checks).toHaveLength(1);
    expect(summarise(checks)).toEqual({ up: 1, degraded: 0, down: 0, unknown: 0 });
  });
});

describe('formatting', () => {
  it('formats values', () => {
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.99512)).toBe('99.51%');
    expect(formatPercent(0.5)).toBe('50.0%');
    expect(formatPercent(undefined)).toBe('-');
    expect(formatLatency(0.0421)).toBe('42 ms');
    expect(formatLatency(1.5)).toBe('1.50 s');
    expect(formatDays(40.7)).toBe('40 d');
    expect(formatDays(1.5)).toBe('36 h');
    expect(formatDays(-1)).toBe('expired');
  });
  it('grades TLS days and history buckets', () => {
    expect(tlsSeverity(30)).toBe('ok');
    expect(tlsSeverity(10)).toBe('warn');
    expect(tlsSeverity(3)).toBe('crit');
    expect(bucketSeverity(undefined)).toBe('none');
    expect(bucketSeverity(1)).toBe('ok');
    expect(bucketSeverity(0.5)).toBe('warn');
    expect(bucketSeverity(0)).toBe('crit');
  });
  it('turns latency range series into chart rows per site', () => {
    const series: RangeSeries[] = [
      { metric: { target: 'web', location: 'eu' }, values: [[10, '0.1'], [20, '0.2']] },
      { metric: { target: 'web', location: 'hq' }, values: [[10, '0.3']] },
      { metric: { target: 'dns', location: 'hq' }, values: [[10, '9']] },
    ];
    expect(latencyRows(series, 'web')).toEqual({
      rows: [
        { t: 10, eu: 100, hq: 300 },
        { t: 20, eu: 200 },
      ],
      sites: ['eu', 'hq'],
    });
  });
});

describe('history grid', () => {
  it('the default grid is the page grid, and a custom grid sets the bucket count and width', () => {
    const w = { ...web };
    const grid = { stepSec: 60, buckets: 4 };
    const start = historyStart(NOW, grid);
    const raw = { ...empty(), success: [s({ ...w, location: 'a' }, 1)], history: [{ metric: { ...w, location: 'a' }, values: [[start + 120, '0.5'] as [number, string]] }] };
    const { checks } = buildChecks(raw, NOW, grid);
    expect(checks[0].history).toEqual([undefined, undefined, 0.5, undefined]);
    expect(buildChecks(raw, NOW).checks[0].history.length).toBe(HISTORY_BUCKETS);
    expect(historyStart(NOW)).toBe(historyStart(NOW, { stepSec: HISTORY_STEP_SEC, buckets: HISTORY_BUCKETS }));
  });
  it('keeps the series labels that are not probe plumbing, for grouping', () => {
    const raw = { ...empty(), success: [s({ ...web, location: 'a', namespace: 'shop', host: 'x' }, 1)] };
    expect(buildChecks(raw, NOW).checks[0].labels).toEqual({ namespace: 'shop', host: 'x' });
  });
  it('the history query uses the requested window', () => {
    expect(queries('uptime', 60).history).toBe('avg_over_time(probe_success{job="uptime"}[60s])');
    expect(queries('uptime').history).toBe(`avg_over_time(probe_success{job="uptime"}[${HISTORY_STEP_SEC}s])`);
  });
});
