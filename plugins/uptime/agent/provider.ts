/**
 * Agent data provider for the uptime plugin: blackbox probe results per check
 * and probing site, read from the `probe_*` series of the probe scrape job.
 * Status uses the plugin's own policy rule (src/model.ts), so the agent, the
 * page and the alert agree: policy "any" is down while any site fails, policy
 * "all" is down only while every site fails (degraded while some do).
 */
import { defineProvider, defineTool, promString, setting, z } from '../../../agent/src/sdk.js';
import { parseDuration } from '../../../agent/src/prom.js';

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

const phaseSchema = z.object({ resolve: z.number().nullable(), connect: z.number().nullable(), tls: z.number().nullable(), processing: z.number().nullable(), transfer: z.number().nullable() });

const responseTimes = defineTool({
  name: 'uptime_response_times',
  title: 'Uptime response times',
  description:
    'Probe response times per target and probing site: current, average, 95th percentile and maximum over a window, the HTTP phase breakdown (resolve, connect, TLS, processing, transfer) in ms, the content length and a slow flag. Slowest first. Use it for slow pages: a site that is slow while another is fast points at routing or DNS placement.',
  input: z.object({
    target: z.string().optional().describe('Substring of the check name (the target label)'),
    host: z.string().optional().describe('Hostname matched against the host of the probe instance URL'),
    location: z.string().optional().describe('Probing site (the location label)'),
    window: z.string().default('6h').describe('Window for avg, p95 and max, for example 30m, 6h, 2d (max 7d)'),
  }),
  output: z.object({
    job: z.string(),
    window: z.string(),
    slowSeconds: z.number(),
    rows: z.array(
      z.object({
        target: z.string(),
        location: z.string(),
        instance: z.string(),
        currentMs: z.number().nullable(),
        avgMs: z.number().nullable(),
        p95Ms: z.number().nullable(),
        maxMs: z.number().nullable(),
        phasesMs: phaseSchema,
        contentBytes: z.number().nullable(),
        slow: z.boolean(),
      }),
    ),
  }),
  async run(args, ctx) {
    const job = setting(ctx.settings, 'job', 'uptime');
    const slowRaw = ctx.settings.slowSeconds;
    const slowSeconds = typeof slowRaw === 'number' && Number.isFinite(slowRaw) && slowRaw > 0 ? slowRaw : 2;
    const seconds = Math.min(parseDuration(args.window), 7 * 86400);
    const window = seconds % 3600 === 0 ? `${seconds / 3600}h` : `${Math.round(seconds)}s`;
    const esc = (v: string) => promString(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const sel = `{job="${promString(job)}"${args.target ? `,target=~".*${esc(args.target)}.*"` : ''}${args.location ? `,location="${promString(args.location)}"` : ''}}`;
    const phaseSel = sel.slice(0, -1) + ',phase=~".+"}';
    const [cur, avg, p95, max, phases, length, ulength] = await Promise.all([
      ctx.prom.query(`probe_duration_seconds${sel}`),
      ctx.prom.query(`avg_over_time(probe_duration_seconds${sel}[${window}])`).catch(() => []),
      ctx.prom.query(`quantile_over_time(0.95, probe_duration_seconds${sel}[${window}])`).catch(() => []),
      ctx.prom.query(`max_over_time(probe_duration_seconds${sel}[${window}])`).catch(() => []),
      ctx.prom.query(`probe_http_duration_seconds${phaseSel}`).catch(() => []),
      ctx.prom.query(`probe_http_content_length${sel}`).catch(() => []),
      ctx.prom.query(`probe_http_uncompressed_body_length${sel}`).catch(() => []),
    ]);
    const key = (m: Record<string, string>) => `${m.target}|${m.location}`;
    const index = (list: Array<{ metric: Record<string, string>; value: number }>) => new Map(list.map(s => [key(s.metric), s.value]));
    const [avgBy, p95By, maxBy, lenBy, ulenBy] = [avg, p95, max, length, ulength].map(index);
    const phaseBy = new Map<string, Record<string, number>>();
    for (const s of phases) {
      const k = key(s.metric);
      phaseBy.set(k, { ...(phaseBy.get(k) ?? {}), [s.metric.phase ?? '']: s.value });
    }
    const ms = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000));
    const hostOf = (instance: string) => {
      try {
        return new URL(instance).hostname.toLowerCase();
      } catch {
        return instance.replace(/^[a-z]+:\/\//i, '').split(/[/:]/)[0].toLowerCase();
      }
    };
    const wantHost = args.host?.toLowerCase();
    const rows = cur
      .filter(s => s.metric.target && (!wantHost || hostOf(s.metric.instance ?? '') === wantHost))
      .map(s => {
        const k = key(s.metric);
        const ph = phaseBy.get(k) ?? {};
        const contentLength = lenBy.get(k);
        const content = contentLength !== undefined && contentLength > 0 ? contentLength : ulenBy.get(k);
        const current = ms(s.value);
        const p = ms(p95By.get(k));
        return {
          target: s.metric.target,
          location: s.metric.location ?? 'default',
          instance: s.metric.instance ?? '',
          currentMs: current,
          avgMs: ms(avgBy.get(k)),
          p95Ms: p,
          maxMs: ms(maxBy.get(k)),
          phasesMs: { resolve: ms(ph.resolve), connect: ms(ph.connect), tls: ms(ph.tls), processing: ms(ph.processing), transfer: ms(ph.transfer) },
          contentBytes: content === undefined ? null : Math.round(content),
          slow: (current ?? 0) > slowSeconds * 1000 || (p ?? 0) > slowSeconds * 1000,
        };
      })
      .sort((a, b) => (b.currentMs ?? -1) - (a.currentMs ?? -1) || a.target.localeCompare(b.target))
      .slice(0, 50);
    const slow = rows.filter(r => r.slow).length;
    return {
      data: { job, window, slowSeconds, rows },
      summary: rows.length ? `${rows.length} probe series over ${window}: ${slow} slow (over ${slowSeconds} s).` : `No probe series for job "${job}" with these filters.`,
      view: {
        title: 'Response times',
        rows: rows.map(r => ({
          label: `${r.target} (${r.location})`,
          detail: `now ${r.currentMs ?? '?'} ms · avg ${r.avgMs ?? '?'} · p95 ${r.p95Ms ?? '?'} · max ${r.maxMs ?? '?'}`,
          status: r.slow ? 'slow' : 'ok',
        })),
      },
    };
  },
});

export const provider = defineProvider({
  name: 'uptime',
  title: 'Uptime',
  description: 'Uptime checks per target and probing site (blackbox probes)',
  tools: [status, responseTimes],
});
