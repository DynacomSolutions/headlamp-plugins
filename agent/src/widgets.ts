/**
 * Panels for the Headlamps phone app: small, read-only summaries of what the
 * plugin providers show. Each panel calls existing provider tools through the
 * registry and maps the result to one model (see the widget API contract in
 * the README). No provider logic is copied here.
 */
import { mask, maskText } from './mask.js';

export type PanelStatus = 'ok' | 'warn' | 'crit' | 'unknown';

export interface Stat {
  label: string;
  value: string;
  status: PanelStatus;
}

export interface Row {
  label: string;
  detail: string;
  value: string;
  fraction?: number;
  status: PanelStatus;
  link?: string;
}

export interface Series {
  label: string;
  points: number[];
}

export interface PanelBody {
  status: PanelStatus;
  summary: string;
  stats: Stat[];
  rows: Row[];
  series?: Series[];
}

export interface PanelModel extends PanelBody {
  version: 1;
  id: string;
  title: string;
  generatedAt: string;
  link: string;
}

export interface PanelInfo {
  id: string;
  title: string;
  description: string;
  plugin: string;
  link: string;
  refreshSeconds: number;
}

/** What a panel may use. `call` runs a registry tool and returns its masked data, or throws. */
export interface PanelDeps {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  serviceGet(url: string): Promise<unknown>;
  agentMemoryUrl: string;
  query: URLSearchParams;
  now: Date;
}

/** A backend failed. The message is short and safe to show. */
export class PanelError extends Error {}

export interface PanelDefinition extends PanelInfo {
  build(deps: PanelDeps): Promise<PanelBody>;
}

const RANK: Record<PanelStatus, number> = { crit: 0, warn: 1, unknown: 2, ok: 3 };
export const MAX_ROWS = 50;

export function worst(statuses: PanelStatus[]): PanelStatus {
  if (statuses.length === 0) return 'unknown';
  return statuses.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
}

/** Worst first (crit, warn, unknown, ok). The sort is stable, so the panel's own order stays within a group. */
export function sortRows(rows: Row[]): Row[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => RANK[a.row.status] - RANK[b.row.status] || a.i - b.i)
    .map(x => x.row)
    .slice(0, MAX_ROWS);
}

export function stat(label: string, value: string | number, status: PanelStatus = 'ok'): Stat {
  return { label: label.slice(0, 12), value: String(value).slice(0, 8), status };
}

export const clamp01 = (n: number): number => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
const round = (n: number, digits = 0): number => Math.round(n * 10 ** digits) / 10 ** digits;
export const pctText = (n: number | null | undefined): string => (n === null || n === undefined ? '-' : `${round(n, 1)}%`);

type Obj = Record<string, any>;
const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);

// ---------- uptime ----------

const UPTIME_STATUS: Record<string, PanelStatus> = { up: 'ok', degraded: 'warn', down: 'crit', unknown: 'unknown' };

async function uptime(d: PanelDeps): Promise<PanelBody> {
  const data = (await d.call('uptime_status', { onlyFailing: false })) as Obj;
  const checks = list(data.checks);
  const count = (s: string) => checks.filter(c => c.status === s).length;
  const up = count('up');
  const degraded = count('degraded');
  const down = count('down');
  const rows: Row[] = checks.map(c => {
    const sites = list(c.sites);
    const good = sites.filter(s => s.up);
    const shown = good.length > 0 ? good : sites;
    const first = shown[0];
    const latencies = good.map(s => s.latencyMs).filter((n): n is number => typeof n === 'number');
    const parts: string[] = [];
    if (first?.httpStatus) parts.push(`HTTP ${first.httpStatus}`);
    if (latencies.length > 0) parts.push(`${Math.min(...latencies)} ms`);
    if (c.status === 'down' || c.status === 'degraded') {
      const failing = sites.filter(s => !s.up).map(s => s.location);
      if (failing.length > 0) parts.push(`down at ${failing.join(', ')}`);
    }
    const uptime24h = typeof c.uptime24h === 'number' ? c.uptime24h : null;
    return {
      label: String(c.target),
      detail: parts.join(', '),
      value: pctText(uptime24h),
      ...(uptime24h !== null ? { fraction: clamp01(uptime24h / 100) } : {}),
      status: UPTIME_STATUS[c.status] ?? 'unknown',
    };
  });
  return {
    status: checks.length === 0 ? 'unknown' : down > 0 ? 'crit' : degraded > 0 ? 'warn' : 'ok',
    summary: checks.length === 0 ? 'No uptime checks found' : `${up} up, ${degraded} degraded, ${down} down`,
    stats: [stat('Up', up, 'ok'), stat('Degraded', degraded, degraded ? 'warn' : 'ok'), stat('Down', down, down ? 'crit' : 'ok')],
    rows: sortRows(rows),
  };
}

// ---------- usage ----------

function levelOf(pct: number): PanelStatus {
  return pct > 90 ? 'crit' : pct > 75 ? 'warn' : 'ok';
}

async function usage(d: PanelDeps): Promise<PanelBody> {
  const [cpu, mem] = (await Promise.all([
    d.call('usage_top', { resource: 'cpu', by: 'node', limit: 50 }),
    d.call('usage_top', { resource: 'memory', by: 'node', limit: 50 }),
  ])) as Obj[];
  // Capacity is optional: without it the rows show absolute use and no bar.
  const capacity = async (query: string): Promise<Map<string, number>> => {
    try {
      const out = (await d.call('query_metrics', { query })) as Obj;
      return new Map(list(out.samples).map(s => [String(s.metric?.node ?? ''), Number(s.value)] as const));
    } catch {
      return new Map();
    }
  };
  const [cpuCap, memCap] = await Promise.all([capacity('max by (node) (kube_node_status_allocatable{resource="cpu"})'), capacity('max by (node) (kube_node_status_allocatable{resource="memory"})')]);
  const cpuUse = new Map(list(cpu.rows).map(r => [String(r.group), Number(r.value)] as const));
  const memUse = new Map(list(mem.rows).map(r => [String(r.group), Number(r.value)] as const));
  const nodes = [...new Set([...cpuUse.keys(), ...memUse.keys()])].filter(n => n !== '');
  const GIB = 2 ** 30;
  let cpuSum = 0;
  let cpuCapSum = 0;
  let memSum = 0;
  let memCapSum = 0;
  const rows: Row[] = nodes.map(node => {
    const c = cpuUse.get(node) ?? 0;
    const m = memUse.get(node) ?? 0;
    const cc = cpuCap.get(node);
    const mc = memCap.get(node);
    cpuSum += c;
    memSum += m;
    if (cc) cpuCapSum += cc;
    if (mc) memCapSum += mc;
    const cpuPct = cc ? (c / cc) * 100 : null;
    const memPct = mc ? (m / mc) * 100 : null;
    const worstPct = Math.max(cpuPct ?? -1, memPct ?? -1);
    if (worstPct < 0) return { label: node, detail: `CPU ${round(c, 2)} cores, Mem ${round(m / GIB, 1)} GiB`, value: '-', status: 'unknown' as const };
    return {
      label: node,
      detail: `CPU ${pctText(cpuPct)}, Mem ${pctText(memPct)}`,
      value: pctText(worstPct),
      fraction: clamp01(worstPct / 100),
      status: levelOf(worstPct),
    };
  });
  const cpuTotal = cpuCapSum ? (cpuSum / cpuCapSum) * 100 : null;
  const memTotal = memCapSum ? (memSum / memCapSum) * 100 : null;
  // Rows are worst first by status, then by their fraction.
  rows.sort((a, b) => (b.fraction ?? -1) - (a.fraction ?? -1));
  return {
    status: worst(rows.map(r => r.status)),
    summary: nodes.length === 0 ? 'No usage data' : `CPU ${pctText(cpuTotal)}, memory ${pctText(memTotal)} on ${nodes.length} nodes`,
    stats: [
      stat('CPU', pctText(cpuTotal), cpuTotal === null ? 'unknown' : levelOf(cpuTotal)),
      stat('Memory', pctText(memTotal), memTotal === null ? 'unknown' : levelOf(memTotal)),
      stat('Nodes', nodes.length),
    ],
    rows: sortRows(rows),
  };
}

// ---------- alerts ----------

async function alerts(d: PanelDeps): Promise<PanelBody> {
  const data = (await d.call('list_alerts', { state: 'any' })) as Obj;
  const all = list(data.alerts);
  const firing = all.filter(a => a.state === 'firing');
  const critical = firing.filter(a => a.severity === 'critical').length;
  const warning = firing.filter(a => a.severity !== 'critical').length;
  const pending = all.filter(a => a.state === 'pending').length;
  const rows: Row[] = all.map(a => ({
    label: String(a.name),
    detail: String(a.annotations?.summary ?? a.annotations?.description ?? a.labels?.namespace ?? a.severity ?? '').slice(0, 160),
    value: String(a.state),
    status: a.state !== 'firing' ? 'unknown' : a.severity === 'critical' ? 'crit' : 'warn',
  }));
  return {
    status: critical > 0 ? 'crit' : firing.length > 0 ? 'warn' : 'ok',
    summary: all.length === 0 ? 'No alerts' : `${critical} critical, ${warning} other firing, ${pending} pending`,
    stats: [stat('Critical', critical, critical ? 'crit' : 'ok'), stat('Warning', warning, warning ? 'warn' : 'ok'), stat('Pending', pending, pending ? 'unknown' : 'ok')],
    rows: sortRows(rows),
  };
}

// ---------- disks ----------

async function disks(d: PanelDeps): Promise<PanelBody> {
  const data = (await d.call('disk_health_smart', {})) as Obj;
  const all = list(data.disks);
  const rows: Row[] = all.map(x => {
    const problems = (Array.isArray(x.problems) ? x.problems : []) as string[];
    const status: PanelStatus = x.smartPassed === false ? 'crit' : problems.length > 0 ? 'warn' : x.smartPassed === null ? 'unknown' : 'ok';
    const worn = typeof x.percentageUsed === 'number' ? x.percentageUsed : null;
    const detail = [x.model, typeof x.temperatureC === 'number' ? `${round(x.temperatureC)} C` : '', ...problems].filter(Boolean).join(', ');
    return {
      label: `${x.node} ${x.device}`.trim(),
      detail,
      value: x.smartPassed === false ? 'FAIL' : worn !== null ? `${round(worn)}% worn` : x.smartPassed ? 'PASS' : '-',
      ...(worn !== null ? { fraction: clamp01(worn / 100) } : {}),
      status,
    };
  });
  const failing = rows.filter(r => r.status === 'crit').length;
  const warn = rows.filter(r => r.status === 'warn').length;
  return {
    status: all.length === 0 ? 'unknown' : worst(rows.map(r => r.status)),
    summary: all.length === 0 ? 'No SMART data' : `${all.length} disks, ${failing} failing, ${warn} with warnings`,
    stats: [stat('Disks', all.length), stat('Failing', failing, failing ? 'crit' : 'ok'), stat('Warnings', warn, warn ? 'warn' : 'ok')],
    rows: sortRows(rows),
  };
}

// ---------- hardware ----------

async function hardware(d: PanelDeps): Promise<PanelBody> {
  const data = (await d.call('node_hardware_thermals', {})) as Obj;
  const nodes = list(data.nodes);
  const rows: Row[] = nodes.map(n => {
    const t = typeof n.hottestC === 'number' ? n.hottestC : null;
    const crit = typeof n.critC === 'number' && n.critC > 0 ? n.critC : null;
    const status: PanelStatus = t === null ? 'unknown' : crit ? (t >= crit ? 'crit' : t >= crit - 10 ? 'warn' : 'ok') : t >= 90 ? 'crit' : t >= 80 ? 'warn' : 'ok';
    const detail = [n.hottestSensor, typeof n.packageW === 'number' ? `${round(n.packageW)} W package` : '', typeof n.gpuW === 'number' ? `${round(n.gpuW)} W GPU` : ''].filter(Boolean).join(', ');
    return {
      label: String(n.node),
      detail,
      value: t === null ? '-' : `${round(t)} C`,
      ...(t !== null ? { fraction: clamp01(t / (crit ?? 100)) } : {}),
      status,
    };
  });
  const temps = nodes.map(n => n.hottestC).filter((t): t is number => typeof t === 'number');
  const power = nodes.reduce((sum, n) => sum + (typeof n.packageW === 'number' ? n.packageW : 0), 0);
  const hot = temps.length ? Math.max(...temps) : null;
  return {
    status: worst(rows.map(r => r.status)),
    summary: nodes.length === 0 ? 'No hardware data' : `Hottest sensor ${hot === null ? 'unknown' : `${round(hot)} C`} on ${nodes.length} nodes`,
    stats: [stat('Hottest', hot === null ? '-' : `${round(hot)} C`, worst(rows.map(r => r.status))), stat('Power', `${round(power)} W`), stat('Nodes', nodes.length)],
    rows: sortRows(rows),
  };
}

// ---------- sites ----------

async function sites(d: PanelDeps): Promise<PanelBody> {
  const data = (await d.call('sites_lookup', { query: d.query.get('q') || '.' })) as Obj;
  const all = list(data.sites);
  const hosts = new Set(all.map(s => s.host));
  const namespaces = new Set(all.map(s => s.namespace));
  const rows: Row[] = all.map(s => ({ label: `${s.host}${s.prefix}`, detail: `${s.namespace}/${s.service}`, value: String(s.mapping), status: 'ok' as const }));
  return {
    status: all.length === 0 ? 'unknown' : 'ok',
    summary: `${all.length} routes on ${hosts.size} hosts`,
    stats: [stat('Routes', all.length), stat('Hosts', hosts.size), stat('Namespaces', namespaces.size)],
    rows: sortRows(rows),
  };
}

// ---------- updates ----------

async function updates(d: PanelDeps): Promise<PanelBody> {
  const data = (await d.call('updates_components', { status: 'any' })) as Obj;
  const all = list(data.components);
  const rows: Row[] = all
    .filter(c => c.status !== 'up-to-date')
    .map(c => {
      const blockers = (Array.isArray(c.blockers) ? c.blockers : []) as string[];
      const status: PanelStatus = c.status === 'available' ? (c.security ? 'crit' : 'warn') : 'unknown';
      return {
        label: String(c.name),
        detail: `${c.current} to ${c.latest}${blockers.length ? `, ${blockers.join('; ')}` : ''}`,
        value: c.security ? 'security' : String(c.status),
        status,
      };
    });
  const count = (s: string) => all.filter(c => c.status === s).length;
  const available = count('available');
  const blocked = count('blocked');
  const security = all.filter(c => c.security && c.status === 'available').length;
  return {
    status: all.length === 0 ? 'unknown' : security > 0 ? 'crit' : available > 0 ? 'warn' : 'ok',
    summary: all.length === 0 ? 'No update report' : `${available} updates available, ${blocked} blocked`,
    stats: [stat('Available', available, available ? 'warn' : 'ok'), stat('Security', security, security ? 'crit' : 'ok'), stat('Blocked', blocked, blocked ? 'unknown' : 'ok'), stat('Total', all.length)],
    rows: sortRows(rows),
  };
}

// ---------- incidents ----------

async function incidents(d: PanelDeps): Promise<PanelBody> {
  const data = (await d.call('list_diagnoses', { limit: 30 })) as Obj;
  const all = list(data.diagnoses);
  const rows: Row[] = all.map(x => {
    const open = !x.resolved;
    return {
      label: String(x.alert),
      detail: String(x.likelyCause || x.status).slice(0, 160),
      value: open ? String(x.status) : 'resolved',
      status: !open ? 'ok' : x.status === 'failed' ? 'unknown' : x.severity === 'critical' ? 'crit' : 'warn',
    };
  });
  const open = all.filter(x => !x.resolved).length;
  const failed = all.filter(x => x.status === 'failed').length;
  return {
    status: rows.length === 0 ? 'ok' : worst(rows.filter(r => r.value !== 'failed').map(r => r.status).concat(['ok'])),
    summary: all.length === 0 ? 'No diagnoses yet' : `${open} open, ${all.length - open} resolved`,
    stats: [stat('Open', open, open ? 'warn' : 'ok'), stat('Resolved', all.length - open), stat('Failed', failed, failed ? 'unknown' : 'ok')],
    rows: sortRows(rows),
  };
}

// ---------- agent memory ----------

async function agentMemory(d: PanelDeps): Promise<PanelBody> {
  let state: Obj;
  try {
    state = (await d.serviceGet(d.agentMemoryUrl)) as Obj;
  } catch {
    throw new PanelError('agent-memory is not reachable');
  }
  if (typeof state.error === 'string' && state.error) throw new PanelError(`agent-memory reports: ${state.error.slice(0, 120)}`);
  const GIB = 2 ** 30;
  const orchestrators = list(state.orchestrators);
  const softLimit = new Map(orchestrators.map(o => [String(o.name), Number(o.policy?.agent?.memoryHigh) || 0] as const));
  const agents = orchestrators.reduce((sum, o) => sum + (Number(o.agents) || 0), 0);
  const total = Number(state.host?.total) || 0;
  const available = Number(state.host?.available) || 0;
  const freePct = total ? (available / total) * 100 : null;
  const warnings = list(state.warnings).length;
  const rows: Row[] = list(state.units)
    .filter(u => u.role === 'agent')
    .sort((a, b) => Number(b.current) - Number(a.current))
    .slice(0, 25)
    .map(u => {
      const limit = Number(u.high) || softLimit.get(String(u.orchestrator)) || 0;
      const fraction = limit ? Number(u.current) / limit : undefined;
      const events = u.eventsWindow?.events ?? {};
      const status: PanelStatus = Number(events.oom_kill) > 0 ? 'crit' : (fraction ?? 0) >= 0.9 || Number(events.high) > 0 ? 'warn' : 'ok';
      return {
        label: String(u.displayName || u.name),
        detail: `${round(Number(u.cpuCores) || 0, 1)} cores`,
        value: `${round(Number(u.current) / GIB, 1)} GiB`,
        ...(fraction !== undefined ? { fraction: clamp01(fraction) } : {}),
        status,
      };
    });
  const rowStatus = worst(rows.map(r => r.status));
  const lowFree = freePct !== null && freePct < 10;
  return {
    status: rows.length === 0 && total === 0 ? 'unknown' : rowStatus === 'crit' || lowFree ? 'crit' : rowStatus === 'warn' || warnings > 0 ? 'warn' : 'ok',
    summary: `${agents} agents, ${pctText(freePct)} memory free, ${warnings} recent warnings`,
    stats: [
      stat('Agents', agents),
      stat('Free', pctText(freePct), freePct === null ? 'unknown' : lowFree ? 'crit' : freePct < 20 ? 'warn' : 'ok'),
      stat('Warnings', warnings, warnings ? 'warn' : 'ok'),
    ],
    rows: sortRows(rows),
  };
}

// ---------- registry of panels ----------

const REFRESH = 900;

export const PANELS: PanelDefinition[] = [
  { id: 'uptime', title: 'Uptime', description: 'Up, degraded and down checks.', plugin: 'uptime', link: '/c/{cluster}/uptime', refreshSeconds: REFRESH, build: uptime },
  { id: 'usage', title: 'Usage', description: 'CPU and memory use of each node.', plugin: 'usage', link: '/c/{cluster}/usage/nodes', refreshSeconds: REFRESH, build: usage },
  { id: 'alerts', title: 'Alerts', description: 'Firing and pending alerts, by severity.', plugin: 'alerting', link: '/c/{cluster}/alerting/status', refreshSeconds: REFRESH, build: alerts },
  { id: 'disks', title: 'Disks', description: 'SMART health of each disk, worst first.', plugin: 'disk-health', link: '/c/{cluster}/disk-health', refreshSeconds: REFRESH, build: disks },
  { id: 'hardware', title: 'Hardware', description: 'Node temperatures and power.', plugin: 'node-hardware', link: '/c/{cluster}/node-hardware', refreshSeconds: REFRESH, build: hardware },
  { id: 'sites', title: 'Sites', description: 'Hostnames and the Services behind them.', plugin: 'sites', link: '/c/{cluster}/sites', refreshSeconds: 3600, build: sites },
  { id: 'updates', title: 'Updates', description: 'Components with a pending update.', plugin: 'updates', link: '/c/{cluster}/updates', refreshSeconds: 3600, build: updates },
  { id: 'incidents', title: 'Incidents', description: 'Latest diagnoses, open ones first.', plugin: 'incidents', link: '/c/{cluster}/incidents', refreshSeconds: REFRESH, build: incidents },
  { id: 'agent-memory', title: 'Agent memory', description: 'Memory use and warnings of the coding agents.', plugin: 'agent-memory', link: '/c/{cluster}/agent-memory', refreshSeconds: 300, build: agentMemory },
];

export function listPanels(): { version: 1; panels: PanelInfo[] } {
  return { version: 1, panels: PANELS.map(({ build: _build, ...info }) => info) };
}

/** Builds one panel, or returns undefined for an unknown id. Throws PanelError when the backend fails. */
export async function buildPanel(id: string, deps: PanelDeps): Promise<PanelModel | undefined> {
  const panel = PANELS.find(p => p.id === id);
  if (!panel) return undefined;
  let body: PanelBody;
  try {
    body = await panel.build(deps);
  } catch (error) {
    const message = error instanceof PanelError || error instanceof Error ? error.message : String(error);
    throw new PanelError(maskText(message).slice(0, 200));
  }
  const model: PanelModel = {
    version: 1,
    id: panel.id,
    title: panel.title,
    status: body.status,
    summary: body.summary,
    generatedAt: deps.now.toISOString(),
    link: panel.link,
    stats: body.stats.slice(0, 4),
    rows: body.rows.slice(0, MAX_ROWS).map(r => ({ ...r, link: r.link ?? panel.link })),
    ...(body.series?.length ? { series: body.series.slice(0, 2).map(s => ({ label: s.label, points: s.points.slice(-48) })) } : {}),
  };
  return mask(model);
}
