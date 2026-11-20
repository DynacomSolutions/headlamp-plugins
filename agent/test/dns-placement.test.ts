import { describe, expect, it } from 'vitest';
import { evidencePlan } from '../src/agent/engine.js';
import { Registry } from '../src/registry.js';
import { allProviders } from '../src/providers/index.js';
import type { ToolContext } from '../src/sdk.js';

type Metric = Record<string, string>;
type Sample = { metric: Metric; value: number; time: string };
const sample = (metric: Metric, value: number): Sample => ({ metric, value, time: '2026-11-20T00:00:00Z' });
const match = (host: string, expected: string, actual: string, ok: number) => sample({ host, expected, actual }, ok);

const settings = {
  zone: 'example.com',
  defaultNode: 'node-a',
  homeNodes: ['node-a', 'home-1'],
  remoteNodes: ['remote-1'],
  pinned: { 'pinned.example.com': ['remote-1'] },
  exclude: ['^FAILOVER-'],
  slowSeconds: 2,
};

function ctx(queries: Record<string, Sample[]>, overrides: Record<string, unknown> = settings): ToolContext {
  return {
    settings: overrides,
    now: new Date('2026-11-20T00:10:00Z'),
    prom: {
      query: async (q: string) => {
        const key = Object.keys(queries).find(k => q.startsWith(k));
        return key ? queries[key] : [];
      },
    },
    kube: {
      list: async () => ({
        items: [
          { metadata: { name: 'node-a' }, status: { addresses: [{ type: 'InternalIP', address: '192.0.2.1' }] } },
          { metadata: { name: 'home-1' }, status: { addresses: [{ type: 'InternalIP', address: '192.0.2.2' }] } },
          { metadata: { name: 'remote-1' }, status: { addresses: [{ type: 'Hostname', address: 'remote-1' }, { type: 'InternalIP', address: '192.0.2.3' }] } },
        ],
      }),
    },
  } as unknown as ToolContext;
}

const data: Record<string, Sample[]> = {
  dns_placement_match: [
    match('home.example.com', 'home-1,remote-1', 'home-1,remote-1', 1), // check ok, rules want home-1 only
    match('moved.example.com', 'home-1', 'remote-1', 0), // drift
    match('default.example.com', 'node-a', 'node-a', 1), // default node, own record
    match('wild.example.com', 'node-a', '', 0), // absent record, wildcard answers
    match('own.example.com', 'node-a', 'home-1,node-a', 0), // default only but own record elsewhere
    match('remote.example.com', 'remote-1', 'remote-1', 1), // no home pods
    match('pinned.example.com', 'home-1', 'remote-1', 0), // pinned wins: ok
    match('failover-x.example.com', 'home-1', 'remote-1', 0), // excluded
    match('ok.example.com', 'home-1', 'home-1', 1),
  ],
  dns_placement_skipped: [sample({ host: 'ext.example.com', reason: 'external' }, 1), sample({ host: 'failover-y.example.com', reason: 'no_endpoints' }, 1)],
  dns_placement_check_success: [sample({}, 1)],
  dns_placement_last_success_timestamp_seconds: [sample({}, Date.parse('2026-11-20T00:10:00Z') / 1000 - 60)],
  probe_duration_seconds: [
    sample({ instance: 'https://moved.example.com/', location: 'home', target: 'moved' }, 3.4),
    sample({ instance: 'https://moved.example.com/', location: 'remote', target: 'moved' }, 0.2),
    sample({ instance: 'https://ok.example.com/path', location: 'home', target: 'ok' }, 0.3),
  ],
};

const registry = new Registry(allProviders());
const call = async (tool: string, args: Record<string, unknown>, c: ToolContext) => {
  const out = await registry.call(tool, args, () => c);
  expect(out.ok, out.summary).toBe(true);
  return out.data as any;
};

describe('dns_placement_status', () => {
  it('applies the rules, not only the check verdict', async () => {
    const out = await call('dns_placement_status', {}, ctx(data));
    const by = Object.fromEntries(out.hosts.map((h: any) => [h.host, h]));
    expect(by['home.example.com']).toMatchObject({ status: 'drift', ruleExpected: ['home-1'], checkMatch: true });
    expect(by['moved.example.com']).toMatchObject({ status: 'drift', ruleExpected: ['home-1'], checkMatch: false });
    expect(by['default.example.com'].status).toBe('ok');
    expect(by['wild.example.com'].status).toBe('ok');
    expect(by['own.example.com'].status).toBe('drift');
    expect(by['remote.example.com'].status).toBe('ok');
    expect(by['pinned.example.com']).toMatchObject({ status: 'ok', checkMatch: false, ruleExpected: ['remote-1'] });
    expect(by['failover-x.example.com'].status).toBe('excluded');
    expect(by['failover-y.example.com'].status).toBe('excluded');
    expect(by['ext.example.com']).toMatchObject({ status: 'skipped', reason: 'external' });
    expect(by['moved.example.com']).toMatchObject({ homeLatencyMs: 3400, remoteLatencyMs: 200, slow: true });
    expect(by['ok.example.com']).toMatchObject({ homeLatencyMs: 300, remoteLatencyMs: null, slow: false });
    expect(by['wild.example.com'].homeLatencyMs).toBeNull();
    expect(out.check.success).toBe(true);
    expect(out.check.lastSuccessAgeSeconds).toBe(60);
    expect(out.counts).toMatchObject({ drift: 3, excluded: 2, skipped: 1 });
  });

  it('filters by host and drift', async () => {
    const out = await call('dns_placement_status', { onlyDrift: true, host: 'moved' }, ctx(data));
    expect(out.hosts.map((h: any) => h.host)).toEqual(['moved.example.com']);
  });

  it('ignores settings of the wrong type and uses a custom metric prefix', async () => {
    const queries = { acme_match: [match('a.example.com', 'home-1', 'home-1', 1)] };
    const out = await call('dns_placement_status', {}, ctx(queries, { metricPrefix: 'acme', homeNodes: 'home-1', slowSeconds: 'x', exclude: ['('], pinned: 5 }));
    expect(out.hosts[0]).toMatchObject({ host: 'a.example.com', status: 'ok' });
    expect(out.check).toEqual({ success: null, lastSuccessAgeSeconds: null });
  });
});

describe('dns_placement_plan', () => {
  it('proposes records with node IPs and never touches excluded hosts', async () => {
    const out = await call('dns_placement_plan', {}, ctx(data));
    expect(out.applyMode).toBe('propose-only');
    const by = Object.fromEntries(out.changes.map((c: any) => [c.host, c]));
    expect(Object.keys(by).sort()).toEqual(['home.example.com', 'moved.example.com', 'own.example.com']);
    expect(by['moved.example.com'].remove).toEqual([{ node: 'remote-1', ip: '192.0.2.3', type: 'A', proxied: false, ttl: 1 }]);
    expect(by['moved.example.com'].add).toEqual([{ node: 'home-1', ip: '192.0.2.2', type: 'A', proxied: false, ttl: 1 }]);
    expect(by['moved.example.com'].evidence).toEqual({ homeLatencyMs: 3400, remoteLatencyMs: 200, slow: true });
    expect(by['home.example.com'].remove.map((r: any) => r.node)).toEqual(['remote-1']);
    expect(by['home.example.com'].add).toEqual([]);
    expect(by['own.example.com']).toMatchObject({ useWildcard: true, add: [] });
    expect(by['own.example.com'].remove.map((r: any) => r.node)).toEqual(['home-1', 'node-a']);
    expect(by['own.example.com'].reason).toMatch(/wildcard/);
    expect(by['own.example.com'].note).toMatch(/wildcard answer/);
    expect(by['moved.example.com'].note).toBeNull();
    expect(out.notes.join(' ')).toMatch(/never proxied|not proxied/i);
    expect(out.notes.join(' ')).toMatch(/board row/);
    expect(out.steps.length).toBeGreaterThan(3);
  });

  it('plans only the requested hosts and reports the others', async () => {
    const out = await call('dns_placement_plan', { hosts: ['moved.example.com', 'failover-x.example.com', 'ok.example.com', 'nope.example.com'] }, ctx(data));
    expect(out.changes.map((c: any) => c.host)).toEqual(['moved.example.com']);
    expect(out.notPlanned).toEqual([
      { host: 'failover-x.example.com', status: 'excluded' },
      { host: 'ok.example.com', status: 'ok' },
      { host: 'nope.example.com', status: 'unknown' },
    ]);
  });
});

describe('uptime_response_times', () => {
  const q = (job = 'uptime'): Record<string, Sample[]> => ({
    'probe_duration_seconds{': [
      sample({ target: 'shop', location: 'home', instance: 'https://shop.example.com/' }, 3.5),
      sample({ target: 'shop', location: 'remote', instance: 'https://shop.example.com/' }, 0.25),
      sample({ target: 'blog', location: 'home', instance: 'https://blog.example.com/' }, 0.4),
    ],
    'avg_over_time(probe_duration_seconds': [sample({ target: 'shop', location: 'home' }, 2.5)],
    'quantile_over_time(0.95': [sample({ target: 'shop', location: 'home' }, 4)],
    'max_over_time(probe_duration_seconds': [sample({ target: 'shop', location: 'home' }, 6)],
    'probe_http_duration_seconds': [
      sample({ target: 'shop', location: 'home', phase: 'resolve' }, 0.01),
      sample({ target: 'shop', location: 'home', phase: 'processing' }, 3.2),
    ],
    'probe_http_content_length': [sample({ target: 'shop', location: 'home' }, -1)],
    'probe_http_uncompressed_body_length': [sample({ target: 'shop', location: 'home' }, 5120)],
  });

  it('returns the slowest first with phases, size and the slow flag', async () => {
    const out = await call('uptime_response_times', {}, ctx(q(), {}));
    expect(out.rows.map((r: any) => `${r.target}/${r.location}`)).toEqual(['shop/home', 'blog/home', 'shop/remote']);
    expect(out.rows[0]).toMatchObject({ currentMs: 3500, avgMs: 2500, p95Ms: 4000, maxMs: 6000, contentBytes: 5120, slow: true });
    expect(out.rows[0].phasesMs).toMatchObject({ resolve: 10, processing: 3200, tls: null });
    expect(out.rows[1].slow).toBe(false);
    expect(out.window).toBe('6h');
  });

  it('filters by host and honours slowSeconds and the window cap', async () => {
    const out = await call('uptime_response_times', { host: 'blog.example.com', window: '30d' }, ctx(q(), { slowSeconds: 0.3 }));
    expect(out.rows.map((r: any) => r.target)).toEqual(['blog']);
    expect(out.rows[0].slow).toBe(true);
    expect(out.window).toBe('168h');
  });
});

describe('evidence plan for DNS and slow alerts', () => {
  const all = new Set(['list_alert_rules', 'dns_placement_status', 'dns_placement_plan', 'uptime_response_times', 'uptime_status', 'list_events', 'cluster_overview']);
  const alert = (name: string, labels: Record<string, string> = {}) => ({ name, severity: 'warning', labels: { alertname: name, ...labels }, annotations: {}, startsAt: '2026-11-20T00:00:00Z', fingerprint: 'f' });

  it('adds placement tools for DNS alerts, scoped by host', () => {
    const plan = evidencePlan(alert('DnsPlacementDrift', { host: 'moved.example.com' }), all);
    expect(plan.find(p => p.tool === 'dns_placement_status')?.args).toEqual({ onlyDrift: true, host: 'moved.example.com' });
    expect(plan.find(p => p.tool === 'dns_placement_plan')?.args).toEqual({ hosts: ['moved.example.com'] });
    expect(plan.some(p => p.tool === 'uptime_response_times')).toBe(false);
  });

  it('adds response times for slow probe alerts', () => {
    const plan = evidencePlan(alert('UptimeSlowProbe', { target: 'shop' }), all);
    expect(plan.find(p => p.tool === 'uptime_response_times')?.args).toEqual({ target: 'shop' });
    expect(plan.some(p => p.tool === 'dns_placement_status')).toBe(false);
  });

  it('adds a placement check for a slow probe alert, with the host taken from the instance URL', () => {
    const plan = evidencePlan(alert('ProbeSlowFromHome', { target: 'shop', instance: 'https://Shop.example.com:8443/x' }), all);
    expect(plan.find(p => p.tool === 'dns_placement_status')).toMatchObject({ args: { host: 'shop.example.com' }, reason: 'Do the DNS records of this host point at the right nodes?' });
    expect(evidencePlan(alert('ProbeSlowFromHome', { host: 'a.example.com' }), all).find(p => p.tool === 'dns_placement_status')?.args).toEqual({ host: 'a.example.com' });
    expect(evidencePlan(alert('ProbeSlowFromHome', { target: 'shop' }), all).some(p => p.tool === 'dns_placement_status')).toBe(false);
  });

  it('adds both for a DNS alert that is also a latency alert and skips unavailable tools', () => {
    const plan = evidencePlan(alert('DnsPlacementLatency'), all).map(p => p.tool);
    expect(plan).toContain('dns_placement_plan');
    expect(plan).toContain('uptime_response_times');
    expect(evidencePlan(alert('DnsPlacementLatency'), new Set(['list_events'])).map(p => p.tool)).toEqual(['list_events']);
  });
});
