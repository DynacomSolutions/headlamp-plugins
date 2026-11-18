/**
 * Agent data provider for the uptime plugin: blackbox probe results per check
 * and probing site, read from the `probe_*` series of the probe scrape job.
 * Status uses the plugin's own policy rule (src/model.ts), so the agent, the
 * page and the alert agree: policy "any" is down while any site fails, policy
 * "all" is down only while every site fails (degraded while some do).
 */
import { defineProvider, defineTool, promString, setting, z } from '../../../agent/src/sdk.js';

// The policy rule, as in ../src/model.ts (not imported: that module pulls in the Headlamp library).
type Policy = 'all' | 'any';
const policyOf = (raw: string | undefined): Policy => (raw === 'any' ? 'any' : 'all');
function statusOf(policy: Policy, ups: boolean[]): 'up' | 'down' | 'degraded' | 'unknown' {
  if (ups.length === 0) return 'unknown';
  const failing = ups.filter(u => !u).length;
  if (failing === 0) return 'up';
  if (policy === 'any' || failing === ups.length) return 'down';
  return 'degraded';
}
function combinedUptimeQuery(job: string, window: string, step: string): string {
  const s = (p: Policy) => `probe_success{job="${job}",policy="${p}"}`;
  return `avg_over_time((min by (target) (${s('any')}))[${window}:${step}]) or avg_over_time((max by (target) (${s('all')}))[${window}:${step}])`;
}

const siteSchema = z.object({
  location: z.string(),
  up: z.boolean(),
  latencyMs: z.number().nullable(),
  httpStatus: z.number().nullable(),
  uptime24h: z.number().nullable().describe('Percent'),
});

const checkSchema = z.object({
  target: z.string(),
  type: z.string(),
  instance: z.string(),
  policy: z.enum(['all', 'any']),
  status: z.enum(['up', 'down', 'degraded', 'unknown']),
  sites: z.array(siteSchema),
  tlsDaysLeft: z.number().nullable(),
  uptime24h: z.number().nullable().describe('Percent, combined over sites by policy'),
  flaps1h: z.number().nullable().describe('Status changes in the last hour, the most of any site'),
});

const pct = (v: number | undefined) => (v === undefined ? null : Math.round(v * 10000) / 100);

const status = defineTool({
  name: 'uptime_status',
  title: 'Uptime checks',
  description:
    'Uptime checks (HTTP, TCP, TLS, DNS, ICMP blackbox probes) per target and probing site: status by the check policy, latency, HTTP status, TLS days left, 24-hour uptime and flaps in the last hour. Use it for probe, endpoint and certificate alerts, and to tell a local fault (one site) from a real outage (every site).',
  input: z.object({
    target: z.string().optional().describe('Substring of the check name (the target label)'),
    onlyFailing: z.boolean().default(false).describe('Only checks that are down or degraded'),
  }),
  output: z.object({ job: z.string(), checks: z.array(checkSchema) }),
  async run(args, ctx) {
    const job = setting(ctx.settings, 'job', 'uptime');
    const escaped = args.target ? promString(args.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : '';
    const sel = `{job="${promString(job)}"${escaped ? `,target=~".*${escaped}.*"` : ''}}`;
    const [success, duration, code, tls, siteUptime, flaps, combined] = await Promise.all([
      ctx.prom.query(`probe_success${sel}`),
      ctx.prom.query(`probe_duration_seconds${sel}`).catch(() => []),
      ctx.prom.query(`probe_http_status_code${sel}`).catch(() => []),
      ctx.prom.query(`min by (target) ((probe_ssl_earliest_cert_expiry${sel} - time()) / 86400)`).catch(() => []),
      ctx.prom.query(`avg_over_time(probe_success${sel}[24h])`).catch(() => []),
      ctx.prom.query(`max by (target) (changes(probe_success${sel}[1h]))`).catch(() => []),
      ctx.prom.query(combinedUptimeQuery(promString(job), '24h', '1m')).catch(() => []),
    ]);
    const key = (m: Record<string, string>) => `${m.target}|${m.location}`;
    const byKey = (list: Array<{ metric: Record<string, string>; value: number }>) => new Map(list.map(s => [key(s.metric), s.value]));
    const byTarget = (list: Array<{ metric: Record<string, string>; value: number }>) => new Map(list.map(s => [s.metric.target ?? '', s.value]));
    const dur = byKey(duration);
    const codes = byKey(code);
    const site24 = byKey(siteUptime);
    const tlsLeft = byTarget(tls);
    const flapCount = byTarget(flaps);
    const total24 = byTarget(combined);
    const checks = new Map<string, z.infer<typeof checkSchema>>();
    for (const s of success) {
      const m = s.metric;
      if (!m.target) continue;
      let c = checks.get(m.target);
      if (!c) {
        const days = tlsLeft.get(m.target);
        c = {
          target: m.target,
          type: m.type ?? '',
          instance: m.instance ?? '',
          policy: policyOf(m.policy),
          status: 'unknown',
          sites: [],
          tlsDaysLeft: days === undefined ? null : Math.round(days * 10) / 10,
          uptime24h: pct(total24.get(m.target)),
          flaps1h: flapCount.get(m.target) ?? null,
        };
        checks.set(m.target, c);
      }
      const d = dur.get(key(m));
      c.sites.push({
        location: m.location ?? 'default',
        up: s.value === 1,
        latencyMs: d === undefined ? null : Math.round(d * 1000),
        httpStatus: codes.get(key(m)) || null,
        uptime24h: pct(site24.get(key(m))),
      });
    }
    for (const c of checks.values()) c.status = statusOf(c.policy, c.sites.map(s => s.up));
    const order = ['down', 'degraded', 'unknown', 'up'];
    let list = [...checks.values()].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.target.localeCompare(b.target));
    if (args.onlyFailing) list = list.filter(c => c.status === 'down' || c.status === 'degraded');
    const down = list.filter(c => c.status === 'down').length;
    const degraded = list.filter(c => c.status === 'degraded').length;
    return {
      data: { job, checks: list },
      summary: checks.size
        ? `${list.length} uptime checks${args.onlyFailing ? ' failing' : ''}: ${down} down, ${degraded} degraded.`
        : `No probe results for job "${job}".`,
      view: {
        title: 'Uptime',
        rows: list.map(c => ({
          label: c.target,
          detail:
            c.sites.map(s => `${s.location}: ${s.up ? 'ok' : 'fail'}${s.httpStatus ? ` ${s.httpStatus}` : ''}${s.latencyMs !== null ? ` ${s.latencyMs} ms` : ''}`).join(' · ') +
            (c.tlsDaysLeft !== null ? ` · TLS ${c.tlsDaysLeft} d` : ''),
          status: `${c.status}${c.uptime24h !== null ? ` · ${c.uptime24h}%` : ''}`,
        })),
      },
    };
  },
});

export const provider = defineProvider({
  name: 'uptime',
  title: 'Uptime',
  description: 'Uptime checks per target and probing site (blackbox probes)',
  tools: [status],
});
