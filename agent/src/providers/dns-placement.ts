/**
 * DNS placement for the cluster's wildcard zone, in propose-only mode.
 * The provider reads the placement check's metrics, applies the placement
 * rules and the uptime probe latency, and outputs an exact change plan.
 * It never applies a change: it has no write client and no DNS credential.
 *
 * Settings (key `dns_placement` in the provider config file). A value of the
 * wrong type is ignored and the default applies:
 *   metricPrefix  string    metric name prefix of the check (default dns_placement)
 *   zone          string    host suffix of the wildcard zone (shown in the plan)
 *   defaultNode   string    the node that answers through the zone wildcard
 *   homeNodes     string[]  nodes at the home site
 *   remoteNodes   string[]  nodes at remote sites
 *   pinned        Record<host, string[]>  hosts with fixed nodes, which win over placement
 *   exclude       string[]  case-insensitive regexes for hosts that another system owns
 *   homeLocation  string    probe location label of home clients (default home)
 *   slowSeconds   number    home latency above this marks a host slow (default 2)
 *   uptimeJob     string    job label of the uptime probes (default uptime)
 */
import { defineProvider, defineTool, promString, setting, z, type ToolContext } from '../sdk.js';

export interface DnsPlacementSettings {
  metricPrefix: string;
  zone: string;
  defaultNode: string;
  homeNodes: string[];
  remoteNodes: string[];
  pinned: Record<string, string[]>;
  exclude: RegExp[];
  homeLocation: string;
  slowSeconds: number;
  uptimeJob: string;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : []);

export function parseSettings(raw: Record<string, unknown>): DnsPlacementSettings {
  const prefix = setting(raw, 'metricPrefix', 'dns_placement');
  const pinned: Record<string, string[]> = {};
  if (raw.pinned && typeof raw.pinned === 'object' && !Array.isArray(raw.pinned)) {
    for (const [host, nodes] of Object.entries(raw.pinned as Record<string, unknown>)) {
      const list = strings(nodes);
      if (list.length > 0) pinned[host.toLowerCase()] = list;
    }
  }
  const exclude: RegExp[] = [];
  for (const pattern of strings(raw.exclude)) {
    try {
      exclude.push(new RegExp(pattern, 'i'));
    } catch {
      /* a bad regex is ignored */
    }
  }
  return {
    metricPrefix: /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(prefix) ? prefix : 'dns_placement',
    zone: setting(raw, 'zone', ''),
    defaultNode: setting(raw, 'defaultNode', ''),
    homeNodes: strings(raw.homeNodes),
    remoteNodes: strings(raw.remoteNodes),
    pinned,
    exclude,
    homeLocation: setting(raw, 'homeLocation', 'home'),
    slowSeconds: typeof raw.slowSeconds === 'number' && Number.isFinite(raw.slowSeconds) && raw.slowSeconds > 0 ? raw.slowSeconds : 2,
    uptimeJob: setting(raw, 'uptimeJob', 'uptime'),
  };
}

const nodeList = (v: string | undefined): string[] =>
  [...new Set((v ?? '').split(',').map(s => s.trim()).filter(s => s !== '' && s !== 'none'))].sort();
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The placement the rules want for a host, from the nodes that have ready endpoints. */
export function ruleExpected(host: string, checkExpected: string[], s: DnsPlacementSettings): string[] {
  const pinned = s.pinned[host.toLowerCase()];
  if (pinned) return [...new Set(pinned)].sort();
  const home = checkExpected.filter(n => s.homeNodes.includes(n));
  return (home.length > 0 ? home : [...checkExpected]).sort();
}

export type PlacementStatus = 'ok' | 'drift' | 'excluded' | 'skipped';

export interface HostPlacement {
  host: string;
  status: PlacementStatus;
  reason: string | null;
  actual: string[];
  checkExpected: string[];
  ruleExpected: string[];
  checkMatch: boolean | null;
  homeLatencyMs: number | null;
  remoteLatencyMs: number | null;
  slow: boolean;
}

export function judge(host: string, actual: string[], ruleNodes: string[], s: DnsPlacementSettings): PlacementStatus {
  if (s.defaultNode && sameSet(ruleNodes, [s.defaultNode])) return actual.length === 0 || sameSet(actual, [s.defaultNode]) ? 'ok' : 'drift';
  return sameSet(actual, ruleNodes) ? 'ok' : 'drift';
}

function hostOf(instance: string): string {
  try {
    return new URL(instance).hostname.toLowerCase();
  } catch {
    return instance.replace(/^[a-z]+:\/\//i, '').split(/[/:]/)[0].toLowerCase();
  }
}

const hostSchema = z.object({
  host: z.string(),
  status: z.enum(['ok', 'drift', 'excluded', 'skipped']),
  reason: z.string().nullable().describe('Why the host is skipped or excluded'),
  actual: z.array(z.string()).describe('Nodes the DNS records point at now'),
  checkExpected: z.array(z.string()).describe('Nodes with ready endpoints, as the check reports them'),
  ruleExpected: z.array(z.string()).describe('Nodes the placement rules want'),
  checkMatch: z.boolean().nullable().describe('The check verdict, which does not apply home-first'),
  homeLatencyMs: z.number().nullable(),
  remoteLatencyMs: z.number().nullable(),
  slow: z.boolean().describe('Home latency is above the slowSeconds setting'),
});

export interface Evaluation {
  settings: DnsPlacementSettings;
  hosts: HostPlacement[];
  health: { success: boolean | null; lastSuccessAgeSeconds: number | null };
}

export async function evaluate(ctx: ToolContext): Promise<Evaluation> {
  const s = parseSettings(ctx.settings);
  const [match, skipped, success, last, duration] = await Promise.all([
    ctx.prom.query(`${s.metricPrefix}_match`),
    ctx.prom.query(`${s.metricPrefix}_skipped`).catch(() => []),
    ctx.prom.query(`${s.metricPrefix}_check_success`).catch(() => []),
    ctx.prom.query(`${s.metricPrefix}_last_success_timestamp_seconds`).catch(() => []),
    ctx.prom.query(`probe_duration_seconds{job="${promString(s.uptimeJob)}"}`).catch(() => []),
  ]);
  const home = new Map<string, number>();
  const remote = new Map<string, number>();
  for (const d of duration) {
    const h = hostOf(d.metric.instance ?? '');
    if (!h) continue;
    const into = d.metric.location === s.homeLocation ? home : remote;
    into.set(h, Math.max(into.get(h) ?? 0, d.value));
  }
  const ms = (m: Map<string, number>, h: string) => (m.has(h) ? Math.round((m.get(h) as number) * 1000) : null);
  const excluded = (h: string) => s.exclude.some(re => re.test(h));
  const rows = new Map<string, HostPlacement>();
  const base = (host: string): HostPlacement => {
    const h = host.toLowerCase();
    const homeMs = ms(home, h);
    return {
      host,
      status: 'ok',
      reason: null,
      actual: [],
      checkExpected: [],
      ruleExpected: [],
      checkMatch: null,
      homeLatencyMs: homeMs,
      remoteLatencyMs: ms(remote, h),
      slow: homeMs !== null && homeMs > s.slowSeconds * 1000,
    };
  };
  for (const m of match) {
    const host = m.metric.host;
    if (!host) continue;
    const row = base(host);
    row.actual = nodeList(m.metric.actual);
    row.checkExpected = nodeList(m.metric.expected);
    row.checkMatch = m.value === 1;
    row.ruleExpected = ruleExpected(host, row.checkExpected, s);
    if (excluded(host)) {
      row.status = 'excluded';
      row.reason = 'Another system owns this host';
    } else {
      row.status = judge(host, row.actual, row.ruleExpected, s);
    }
    rows.set(host, row);
  }
  for (const m of skipped) {
    const host = m.metric.host;
    if (!host || rows.has(host)) continue;
    const row = base(host);
    row.status = excluded(host) ? 'excluded' : 'skipped';
    row.reason = row.status === 'excluded' ? 'Another system owns this host' : (m.metric.reason ?? 'skipped');
    rows.set(host, row);
  }
  const rank = { drift: 0, skipped: 2, excluded: 3, ok: 4 } as const;
  const hosts = [...rows.values()].sort((a, b) => rank[a.status] - rank[b.status] || a.host.localeCompare(b.host));
  const okSample = success[0];
  const lastSample = last[0];
  return {
    settings: s,
    hosts,
    health: {
      success: okSample ? okSample.value === 1 : null,
      lastSuccessAgeSeconds: lastSample ? Math.max(0, Math.round(ctx.now.getTime() / 1000 - lastSample.value)) : null,
    },
  };
}

const status = defineTool({
  name: 'dns_placement_status',
  title: 'DNS placement',
  description:
    'DNS placement per host in the wildcard zone: where the records point now, where the placement check expects them, where the rules want them (pinned hosts, home-first, default node), plus home and remote probe latency. Status is ok, drift, excluded or skipped. Use it for slow pages, DNS and placement alerts. The check verdict alone is not the rule verdict.',
  input: z.object({
    host: z.string().optional().describe('Substring of the host name'),
    onlyDrift: z.boolean().default(false).describe('Only hosts that drift from the rules'),
  }),
  output: z.object({
    check: z.object({ success: z.boolean().nullable(), lastSuccessAgeSeconds: z.number().nullable() }),
    counts: z.object({ ok: z.number(), drift: z.number(), excluded: z.number(), skipped: z.number() }),
    hosts: z.array(hostSchema),
  }),
  async run(args, ctx) {
    const ev = await evaluate(ctx);
    const needle = args.host?.toLowerCase();
    let hosts = needle ? ev.hosts.filter(h => h.host.toLowerCase().includes(needle)) : ev.hosts;
    const counts = { ok: 0, drift: 0, excluded: 0, skipped: 0 };
    for (const h of hosts) counts[h.status]++;
    if (args.onlyDrift) hosts = hosts.filter(h => h.status === 'drift');
    const slow = hosts.filter(h => h.slow).length;
    return {
      data: { check: ev.health, counts, hosts },
      summary: `${counts.drift} hosts drift from the placement rules, ${counts.ok} ok, ${counts.excluded} excluded, ${counts.skipped} skipped; ${slow} slow from home.${
        ev.health.success === false ? ' The placement check itself is failing.' : ''
      }`,
      view: {
        title: 'DNS placement',
        rows: hosts.map(h => ({
          label: h.host,
          detail: `now ${h.actual.join(',') || 'none'} · rules ${h.ruleExpected.join(',') || 'none'}${h.homeLatencyMs !== null ? ` · home ${h.homeLatencyMs} ms` : ''}${h.remoteLatencyMs !== null ? ` · remote ${h.remoteLatencyMs} ms` : ''}${h.slow ? ' · slow' : ''}`,
          status: h.status,
        })),
      },
    };
  },
});

const record = z.object({ node: z.string(), ip: z.string().nullable().describe('Node InternalIP, null when the node has none'), type: z.literal('A'), proxied: z.literal(false), ttl: z.literal(1) });

const plan = defineTool({
  name: 'dns_placement_plan',
  title: 'DNS placement change plan',
  description:
    'Propose-only change plan for hosts that drift from the DNS placement rules: records to remove and add (A, DNS-only, automatic TTL, node IPs from the cluster), evidence and the steps for a person or agent that has the DNS edit access. It never applies anything. Cite its fact id in a fix.',
  input: z.object({ hosts: z.array(z.string()).optional().describe('Hosts to plan; default every drift host') }),
  output: z.object({
    applyMode: z.literal('propose-only'),
    zone: z.string().nullable(),
    changes: z.array(
      z.object({
        host: z.string(),
        reason: z.string(),
        remove: z.array(record),
        add: z.array(record),
        note: z.string().nullable().describe('Extra care for the person who applies the change'),
        useWildcard: z.boolean().describe('True when the host needs no own record and the wildcard answers'),
        evidence: z.object({ homeLatencyMs: z.number().nullable(), remoteLatencyMs: z.number().nullable(), slow: z.boolean() }),
      }),
    ),
    notPlanned: z.array(z.object({ host: z.string(), status: z.string() })).describe('Requested hosts that are not drift (ok, excluded, skipped) or unknown'),
    steps: z.array(z.string()),
    notes: z.array(z.string()),
  }),
  async run(args, ctx) {
    const ev = await evaluate(ctx);
    const s = ev.settings;
    const wanted = args.hosts?.map(h => h.toLowerCase());
    const ips = new Map<string, string>();
    const drift = ev.hosts.filter(h => h.status === 'drift' && (!wanted || wanted.includes(h.host.toLowerCase())));
    if (drift.length > 0) {
      const { items } = await ctx.kube.list('nodes');
      for (const n of items) {
        const ip = (n.status?.addresses as Array<{ type: string; address: string }> | undefined)?.find(a => a.type === 'InternalIP')?.address;
        if (n.metadata?.name && ip) ips.set(n.metadata.name, ip);
      }
    }
    const rec = (node: string) => ({ node, ip: ips.get(node) ?? null, type: 'A' as const, proxied: false as const, ttl: 1 as const });
    const changes = drift.map(h => {
      const wildcard = Boolean(s.defaultNode) && sameSet(h.ruleExpected, [s.defaultNode]);
      const removeNodes = h.actual.filter(n => wildcard || !h.ruleExpected.includes(n));
      return {
        host: h.host,
        reason: wildcard
          ? `The app runs only on the default node ${s.defaultNode}, so the zone wildcard answers. The own records are not needed.`
          : `The rules want ${h.ruleExpected.join(', ')}; DNS has ${h.actual.join(', ') || 'no record'}.`,
        remove: removeNodes.map(rec),
        add: wildcard ? [] : h.ruleExpected.filter(n => !h.actual.includes(n)).map(rec),
        note: s.defaultNode && removeNodes.includes(s.defaultNode)
          ? 'A remove entry for the default node can be the wildcard answer. Remove it only when the host has its own record for that node.'
          : null,
        useWildcard: wildcard,
        evidence: { homeLatencyMs: h.homeLatencyMs, remoteLatencyMs: h.remoteLatencyMs, slow: h.slow },
      };
    });
    const known = new Map(ev.hosts.map(h => [h.host.toLowerCase(), h]));
    const notPlanned = (wanted ?? [])
      .filter(h => known.get(h)?.status !== 'drift')
      .map(h => ({ host: h, status: known.get(h)?.status ?? 'unknown' }));
    return {
      data: {
        applyMode: 'propose-only' as const,
        zone: s.zone || null,
        changes,
        notPlanned,
        steps: [
          `Get a short-lived DNS edit token for the one zone${s.zone ? ` (${s.zone})` : ''}, with the lowest rights that edit records.`,
          'Change only the records listed in this plan. Remove first, then add. Keep every record DNS-only, never proxied.',
          'Check each host with a DNS query: the answer must list exactly the planned node addresses, or the wildcard answer when the plan says so.',
          'Revoke the token.',
        ],
        notes: [
          'This plan is a proposal. The agent never applies it and has no DNS credential.',
          'Records are never proxied.',
          'Excluded hosts are not touched.',
          'A move away from these rules needs an open board row and a planned return to the rules.',
        ],
      },
      summary: `${changes.length} hosts to change (propose-only)${notPlanned.length ? `, ${notPlanned.length} requested hosts not planned` : ''}.`,
      view: {
        title: 'DNS placement plan',
        rows: changes.map(c => ({
          label: c.host,
          detail: `${c.useWildcard ? 'use wildcard' : `add ${c.add.map(r => r.ip ?? r.node).join(',') || 'none'}`} · remove ${c.remove.map(r => r.ip ?? r.node).join(',') || 'none'}`,
          status: c.evidence.slow ? 'slow' : 'drift',
        })),
      },
    };
  },
});

export default defineProvider({
  name: 'dns_placement',
  title: 'DNS placement',
  description: 'DNS placement drift for the wildcard zone: status from the check metrics and a propose-only change plan',
  tools: [status, plan],
});
