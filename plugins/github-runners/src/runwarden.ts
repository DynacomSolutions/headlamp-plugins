/*
 * RunWarden data source. RunWarden serves the widget panel API (PanelModel v1)
 * on a Service. This module is pure (no React, no network): it validates the
 * panels, builds the service-proxy paths and maps the panels to the shapes the
 * GitHub Runners page shows. Panel rows carry their numbers as text in `detail`
 * and `value`, so each parser is tolerant: a number it cannot read becomes null
 * and the page falls back to the panel's own text. Nothing is cut to a top N
 * and nothing is grouped into an "Other" row.
 */
import type { PluginConfig } from './types';

export type PanelStatus = 'ok' | 'warn' | 'crit' | 'unknown';

export interface PanelStat {
  label: string;
  value: string;
  status: PanelStatus;
}

export interface PanelRow {
  label: string;
  detail: string;
  value: string;
  fraction?: number;
  status: PanelStatus;
  link?: string;
}

export interface PanelSeries {
  label: string;
  points: number[];
}

export interface Panel {
  version: 1;
  id: string;
  title: string;
  status: PanelStatus;
  summary: string;
  generatedAt: string;
  link: string;
  stats: PanelStat[];
  rows: PanelRow[];
  series: PanelSeries[];
}

export const PANEL_IDS = [
  'pools',
  'queue',
  'job-times',
  'failures',
  'runners',
  'nodes',
  'persistent',
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

/** Generic defaults. The settings or a deployment defaults.json override them. */
export const DEFAULT_RUNWARDEN = { namespace: 'runwarden', service: 'runwarden-widgets', port: '80' };

export type RunWardenMode = 'auto' | 'on' | 'off';

export interface RunWardenSource {
  mode: RunWardenMode;
  namespace: string;
  service: string;
  port: string;
  /** Set when a field is not a valid Kubernetes name or port. The source is then unusable. */
  problem: string | null;
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const PORT = /^([0-9]{1,5}|[a-z0-9]([-a-z0-9]{0,13}[a-z0-9])?)$/;

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The effective RunWarden source: stored settings over the generic defaults. */
export function resolveSource(cfg: PluginConfig): RunWardenSource {
  const raw = text(cfg.runwardenMode).toLowerCase();
  const mode: RunWardenMode = raw === 'on' || raw === 'off' ? raw : 'auto';
  const namespace = text(cfg.runwardenNamespace) || DEFAULT_RUNWARDEN.namespace;
  const service = text(cfg.runwardenService) || DEFAULT_RUNWARDEN.service;
  const port = text(cfg.runwardenPort) || DEFAULT_RUNWARDEN.port;
  let problem: string | null = null;
  if (!DNS_LABEL.test(namespace)) problem = 'The namespace is not a valid Kubernetes name.';
  else if (!DNS_LABEL.test(service)) problem = 'The service is not a valid Kubernetes name.';
  else if (!PORT.test(port)) problem = 'The port must be a number or a port name.';
  return { mode, namespace, service, port, problem };
}

/** Path of the Kubernetes API service proxy for one RunWarden path (such as `/api/widgets`). */
export function proxyPath(src: RunWardenSource, path: string): string {
  const e = encodeURIComponent;
  const tail = path.startsWith('/') ? path : `/${path}`;
  return `/api/v1/namespaces/${e(src.namespace)}/services/${e(src.service)}:${e(src.port)}/proxy${tail}`;
}

export const listPath = (src: RunWardenSource): string => proxyPath(src, '/api/widgets');
export const panelPath = (src: RunWardenSource, id: string): string =>
  proxyPath(src, `/api/widgets/${encodeURIComponent(id)}`);

/* ------------------------------------------------------------ validation */

const STATUSES: readonly string[] = ['ok', 'warn', 'crit', 'unknown'];
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const status = (x: unknown): PanelStatus => (STATUSES.includes(x as string) ? (x as PanelStatus) : 'unknown');
const str = (x: unknown): string => (typeof x === 'string' ? x : x === null || x === undefined ? '' : String(x));

/** Only http and https links are kept. A panel link is never trusted as a script URL. */
export function safeLink(x: unknown): string | undefined {
  const v = text(x);
  return /^https?:\/\//i.test(v) ? v : undefined;
}

/** Validate one PanelModel v1 document. Null when it is not one. */
export function parsePanel(x: unknown): Panel | null {
  if (!isObj(x) || x.version !== 1 || typeof x.id !== 'string' || !Array.isArray(x.rows)) return null;
  const rows: PanelRow[] = x.rows.filter(isObj).map(r => ({
    label: str(r.label),
    detail: str(r.detail),
    value: str(r.value),
    ...(typeof r.fraction === 'number' && Number.isFinite(r.fraction) ? { fraction: r.fraction } : {}),
    status: status(r.status),
    ...(safeLink(r.link) ? { link: safeLink(r.link) } : {}),
  }));
  const stats: PanelStat[] = (Array.isArray(x.stats) ? x.stats : []).filter(isObj).map(s => ({
    label: str(s.label),
    value: str(s.value),
    status: status(s.status),
  }));
  const series: PanelSeries[] = (Array.isArray(x.series) ? x.series : []).filter(isObj).map(s => ({
    label: str(s.label),
    points: (Array.isArray(s.points) ? s.points : []).filter(
      (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p)
    ),
  }));
  return {
    version: 1,
    id: x.id,
    title: str(x.title) || x.id,
    status: status(x.status),
    summary: str(x.summary),
    generatedAt: str(x.generatedAt),
    link: safeLink(x.link) ?? '',
    stats,
    rows,
    series,
  };
}

/* --------------------------------------------------------------- parsers */

/** Count pairs such as "busy 25, idle 0" or "24 running, 5 queued", in the order given. */
export function countPairs(detail: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const part of detail.split(',').map(p => p.trim()).filter(Boolean)) {
    const lead = part.match(/^(\d+)\s+([A-Za-z][A-Za-z ]*)$/);
    const trail = part.match(/^([A-Za-z][A-Za-z ]*?)\s+(\d+)$/);
    if (lead) out.push([lead[2].trim().toLowerCase(), Number(lead[1])]);
    else if (trail) out.push([trail[1].trim().toLowerCase(), Number(trail[2])]);
  }
  return out;
}

const countOf = (pairs: Array<[string, number]>, key: string): number | null => {
  const hit = pairs.find(([k]) => k === key);
  return hit ? hit[1] : null;
};

/** "24/200" gives 24 and 200. Anything else gives nulls. */
export function ratio(value: string): { used: number | null; total: number | null } {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  return m ? { used: Number(m[1]), total: Number(m[2]) } : { used: null, total: null };
}

/** "-" and empty mean no value. */
const dash = (v: string | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' || t === '-' ? null : t;
};

export interface Pool {
  name: string;
  running: number | null;
  queued: number | null;
  free: number | null;
  /** Slot cap of the pool. */
  cap: number | null;
  fraction: number | null;
  status: PanelStatus;
  detail: string;
  /** Runner pods by state (busy, idle, warm, ...), from the runners panel. */
  runners: Array<[string, number]>;
  runnersDetail: string;
  runnerStatus: PanelStatus | null;
}

export interface QueueEntry {
  owner: string;
  pool: string;
  queued: number | null;
  /** Wait of the oldest queued job, as text. */
  oldest: string;
  status: PanelStatus;
  detail: string;
}

export interface JobTimes {
  pool: string;
  waitP50: string | null;
  waitP90: string | null;
  startP50: string | null;
  jobs: number | null;
  /** Median run time, as text. */
  run: string | null;
  status: PanelStatus;
  detail: string;
}

export interface Failure {
  repository: string;
  failed: number | null;
  cancelled: number | null;
  timedOut: number | null;
  jobs: number | null;
  rate: string;
  fraction: number | null;
  status: PanelStatus;
  detail: string;
}

export interface NodeLoad {
  name: string;
  cpuUsed: number | null;
  cpuTotal: number | null;
  memUsed: number | null;
  memTotal: number | null;
  runners: number | null;
  value: string;
  fraction: number | null;
  status: PanelStatus;
  detail: string;
  link?: string;
}

export interface Machine {
  name: string;
  detail: string;
  value: string;
  status: PanelStatus;
}

export function mapPools(pools: Panel | null, runners: Panel | null): Pool[] {
  const out = new Map<string, Pool>();
  for (const r of pools?.rows ?? []) {
    const pairs = countPairs(r.detail);
    const { total } = ratio(r.value);
    out.set(r.label, {
      name: r.label,
      running: countOf(pairs, 'running'),
      queued: countOf(pairs, 'queued'),
      free: countOf(pairs, 'free'),
      cap: total,
      fraction: r.fraction ?? null,
      status: r.status,
      detail: r.detail,
      runners: [],
      runnersDetail: '',
      runnerStatus: null,
    });
  }
  for (const r of runners?.rows ?? []) {
    const hit = out.get(r.label);
    const pairs = countPairs(r.detail);
    if (hit) {
      hit.runners = pairs;
      hit.runnersDetail = r.detail;
      hit.runnerStatus = r.status;
    } else {
      // A pool that only the runners panel knows still gets a row.
      out.set(r.label, {
        name: r.label,
        running: null,
        queued: null,
        free: null,
        cap: null,
        fraction: null,
        status: r.status,
        detail: '',
        runners: pairs,
        runnersDetail: r.detail,
        runnerStatus: r.status,
      });
    }
  }
  return [...out.values()];
}

export function mapQueue(queue: Panel | null): QueueEntry[] {
  return (queue?.rows ?? []).map(r => {
    const m = r.detail.match(/^pool\s+(.+?),\s*(\d+)\s+queued$/i);
    return {
      owner: r.label,
      pool: m ? m[1] : '',
      queued: m ? Number(m[2]) : null,
      oldest: r.value,
      status: r.status,
      detail: r.detail,
    };
  });
}

export function mapJobTimes(panel: Panel | null): JobTimes[] {
  return (panel?.rows ?? []).map(r => {
    const wait = r.detail.match(/wait p50\s+([^,]+),\s*p90\s+([^,]+)/i);
    const start = r.detail.match(/start p50\s+([^,]+)/i);
    const jobs = r.detail.match(/(\d+)\s+jobs?\b/i);
    return {
      pool: r.label,
      waitP50: dash(wait?.[1]),
      waitP90: dash(wait?.[2]),
      startP50: dash(start?.[1]),
      jobs: jobs ? Number(jobs[1]) : null,
      run: dash(r.value),
      status: r.status,
      detail: r.detail,
    };
  });
}

export function mapFailures(panel: Panel | null): Failure[] {
  return (panel?.rows ?? []).map(r => {
    const n = (re: RegExp): number | null => {
      const m = r.detail.match(re);
      return m ? Number(m[1]) : null;
    };
    return {
      repository: r.label,
      failed: n(/(\d+)\s+failed/i),
      cancelled: n(/(\d+)\s+cancelled/i),
      timedOut: n(/(\d+)\s+timed out/i),
      jobs: n(/\bof\s+(\d+)/i),
      rate: r.value,
      fraction: r.fraction ?? null,
      status: r.status,
      detail: r.detail,
    };
  });
}

export function mapNodes(panel: Panel | null): NodeLoad[] {
  return (panel?.rows ?? []).map(r => {
    const cpu = r.detail.match(/CPU\s+([\d.]+)\s*\/\s*([\d.]+)/i);
    const mem = r.detail.match(/Mem(?:ory)?\s+([\d.]+)\s*\/\s*([\d.]+)/i);
    const runners = r.detail.match(/(\d+)\s+runners?\b/i);
    return {
      name: r.label,
      cpuUsed: cpu ? Number(cpu[1]) : null,
      cpuTotal: cpu ? Number(cpu[2]) : null,
      memUsed: mem ? Number(mem[1]) : null,
      memTotal: mem ? Number(mem[2]) : null,
      runners: runners ? Number(runners[1]) : null,
      value: r.value,
      fraction: r.fraction ?? null,
      status: r.status,
      detail: r.detail,
      ...(r.link ? { link: r.link } : {}),
    };
  });
}

export function mapMachines(panel: Panel | null): Machine[] {
  return (panel?.rows ?? []).map(r => ({ name: r.label, detail: r.detail, value: r.value, status: r.status }));
}

/* ----------------------------------------------------------------- board */

export type Panels = Partial<Record<PanelId, Panel>>;

export interface RunWardenBoard {
  pools: Pool[];
  queue: QueueEntry[];
  jobTimes: JobTimes[];
  failures: Failure[];
  nodes: NodeLoad[];
  machines: Machine[];
  /** Stats shown on top of the page, in order. Only stats the panels gave. */
  headline: PanelStat[];
  series: PanelSeries[];
  /** The oldest generatedAt of the panels, for the stale check. */
  generatedAt: string;
  panels: Panels;
}

const pick = (panel: Panel | undefined, label: string, as?: string): PanelStat[] => {
  const s = panel?.stats.find(x => x.label.toLowerCase() === label.toLowerCase());
  return s ? [{ ...s, label: as ?? s.label }] : [];
};

export function buildRunWarden(panels: Panels): RunWardenBoard {
  const headline: PanelStat[] = [
    ...pick(panels.pools, 'Running', 'Running jobs'),
    ...pick(panels.pools, 'Queued', 'Queued jobs'),
    ...pick(panels.queue, 'Oldest', 'Oldest queued'),
    ...pick(panels.pools, 'Free', 'Free slots'),
    ...pick(panels.runners, 'Busy', 'Busy runners'),
    ...pick(panels.runners, 'Idle', 'Idle runners'),
    ...pick(panels.runners, 'Pending', 'Pending runners'),
    ...pick(panels.runners, 'Stuck', 'Stuck runners'),
    ...pick(panels['job-times'], 'Wait p50', 'Wait p50'),
    ...pick(panels['job-times'], 'Wait p90', 'Wait p90'),
    ...pick(panels['job-times'], 'Start p50', 'Start p50'),
    ...pick(panels.failures, 'Failed', 'Failed (recent)'),
  ];
  const stamps = Object.values(panels)
    .map(p => p?.generatedAt ?? '')
    .filter(t => Number.isFinite(Date.parse(t)))
    .sort();
  return {
    pools: mapPools(panels.pools ?? null, panels.runners ?? null),
    queue: mapQueue(panels.queue ?? null),
    jobTimes: mapJobTimes(panels['job-times'] ?? null),
    failures: mapFailures(panels.failures ?? null),
    nodes: mapNodes(panels.nodes ?? null),
    machines: mapMachines(panels.persistent ?? null),
    headline,
    series: panels['job-times']?.series ?? [],
    generatedAt: stamps[0] ?? '',
    panels,
  };
}

/* --------------------------------------------------------------- filters */

export interface PoolFilter {
  /** Selected pool names. Empty selects all. */
  pools: string[];
  /** Selected node names. Empty selects all. */
  nodes: string[];
  terms: string[];
}

const matchesTerms = (terms: string[], ...fields: string[]): boolean => {
  const hay = fields.join(' ').toLowerCase();
  return terms.every(t => hay.includes(t));
};
const inPools = (f: PoolFilter, pool: string): boolean => !f.pools.length || f.pools.includes(pool);

export const filterPools = (rows: Pool[], f: PoolFilter): Pool[] =>
  rows.filter(r => inPools(f, r.name) && matchesTerms(f.terms, r.name, r.detail, r.runnersDetail));
export const filterQueue = (rows: QueueEntry[], f: PoolFilter): QueueEntry[] =>
  rows.filter(r => inPools(f, r.pool) && matchesTerms(f.terms, r.owner, r.pool));
export const filterJobTimes = (rows: JobTimes[], f: PoolFilter): JobTimes[] =>
  rows.filter(r => inPools(f, r.pool) && matchesTerms(f.terms, r.pool));
export const filterFailures = (rows: Failure[], f: PoolFilter): Failure[] =>
  rows.filter(r => matchesTerms(f.terms, r.repository));
export const filterNodes = (rows: NodeLoad[], f: PoolFilter): NodeLoad[] =>
  rows.filter(r => (!f.nodes.length || f.nodes.includes(r.name)) && matchesTerms(f.terms, r.name));

/** Panels refresh every 30 to 60 seconds, so older data than this is flagged stale. */
export const RUNWARDEN_STALE_AFTER_S = 300;
