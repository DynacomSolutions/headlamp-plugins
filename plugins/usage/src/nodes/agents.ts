/*
 * Agent hosts: reads the agent-resource backend (/api/state) through the Kubernetes API service
 * proxy. Plugins cannot share code, so the small helpers here are copies of the agent-resource
 * ones. The backend Service was called agent-memory before: agent-resource is tried first and
 * agent-memory is the fallback, so the dashboard works before and after the backend rollout.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';

export interface AgentProc {
  pid: number;
  command: string;
  rss: number;
  cpuCores?: number;
  children: AgentProc[];
}

export interface AgentUnit {
  name: string;
  orchestrator?: string;
  role?: '' | 'control' | 'agents' | 'agent';
  kind: string;
  /** The parent unit's name; empty or missing at the top level. */
  parent?: string;
  depth?: number;
  memBytes: number;
  cpuCores?: number;
  /** The CPU limit in cores (cpu.max); null for none; absent when the backend does not report it. */
  cpuLimitCores?: number | null;
  /** Time throttled over the last two samples, in cores' worth (0.25 is a quarter of one core). */
  cpuThrottledRatio?: number;
  project?: string;
  projectId?: string;
  thread?: string;
  threadUrl?: string;
  icon?: { kind: 'file' | 'lucide'; name?: string; color?: string };
  procs: AgentProc[];
}

export interface AgentHost {
  node: string;
  backend: string;
  units: AgentUnit[];
  orchestrators: { name: string; title: string }[];
}

export interface NodesSettings {
  agentBackends: string[];
  idleSeconds: number;
  /** Arc id (or key) to display name: overrides every guess. */
  displayNames: Record<string, string>;
}

export const DEFAULT_NODES_SETTINGS: NodesSettings = {
  agentBackends: ['service/agent-memory/agent-resource:80'],
  idleSeconds: 120,
  displayNames: {},
};

const MIN_IDLE_SECONDS = 30;
const MAX_PROC_DEPTH = 32;

/** Turns service/<ns>/<name>[:port] plus an API path into a Kubernetes service-proxy URL. */
function backendUrl(backend: string, path: string): string {
  const m = /^service\/([^/]+)\/([^/:]+)(?::([^/]+))?$/.exec(backend.trim());
  if (!m)
    throw new Error(`Backend must look like service/<namespace>/<name>:<port>, got "${backend}"`);
  const [, ns, name, port] = m;
  const svc = port ? `${name}:${port}` : name;
  return `/api/v1/namespaces/${ns}/services/${svc}/proxy${
    path.startsWith('/') ? path : `/${path}`
  }`;
}

const SERVICE = 'agent-resource';
const LEGACY_SERVICE = 'agent-memory';

/**
 * The backends to try, best first. A backend named agent-resource also has its agent-memory twin
 * as a fallback, and the other way round. Any other name stays alone.
 */
export function backendCandidates(backend: string): string[] {
  const b = backend.trim();
  const m = /^(service\/[^/]+\/)([^/:]+)(.*)$/.exec(b);
  if (!m || (m[2] !== SERVICE && m[2] !== LEGACY_SERVICE)) return [b];
  const twin = `${m[1]}${m[2] === SERVICE ? LEGACY_SERVICE : SERVICE}${m[3]}`;
  return m[2] === SERVICE ? [b, twin] : [twin, b];
}

/** The candidate that answered last for each configured backend. */
const answered = new Map<string, string>();

function orderedCandidates(backend: string): string[] {
  const list = backendCandidates(backend);
  const good = answered.get(backend);
  return good && list.includes(good) ? [good, ...list.filter(c => c !== good)] : list;
}

/** The first error that is not a 404 (the Service is missing), else the first error. */
function pickError(errors: any[]): any {
  return errors.find(e => e?.status !== 404) ?? errors[0];
}

/** GET with the fallback: the candidate that answers is remembered for the next poll. */
async function requestBackend(backend: string, path: string): Promise<unknown> {
  const errors: unknown[] = [];
  for (const c of orderedCandidates(backend)) {
    try {
      const json = await ApiProxy.request(backendUrl(c, path));
      answered.set(backend, c);
      return json;
    } catch (e) {
      errors.push(e);
    }
  }
  throw pickError(errors) ?? new Error('Request failed');
}

/**
 * The project icon route of a backend, as the Kubernetes service-proxy path. An <img> cannot send
 * Headlamp's auth headers, so this only loads where the proxy path is reachable without them.
 */
export function iconUrl(backend: string, projectId: string): string {
  return backendUrl(
    orderedCandidates(backend)[0],
    `/api/project-icon?project=${encodeURIComponent(projectId)}`
  );
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function optNum(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function text(v: unknown): string {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
}

function optText(v: unknown): string | undefined {
  return text(v) || undefined;
}

function parseProc(p: any, depth: number): AgentProc {
  const children =
    depth < MAX_PROC_DEPTH && Array.isArray(p?.children)
      ? p.children.map((c: any) => parseProc(c, depth + 1))
      : [];
  return {
    pid: num(p?.pid),
    command: text(p?.command),
    rss: num(p?.rss),
    cpuCores: optNum(p?.cpuCores),
    children,
  };
}

/** A limit of 0 or less is no limit. A backend that sends CPU stats without a quota means none. */
function parseCpuLimit(u: any): number | null | undefined {
  const reported =
    u?.cpuQuotaCores !== undefined ||
    u?.cpuWeight !== undefined ||
    u?.cpuNrPeriods !== undefined ||
    u?.cpuThrottledRatio !== undefined;
  if (!reported) return undefined;
  const q = optNum(u?.cpuQuotaCores);
  return q !== undefined && q > 0 ? q : null;
}

function parseIcon(i: any): AgentUnit['icon'] {
  if (!i || (i.kind !== 'file' && i.kind !== 'lucide')) return undefined;
  return { kind: i.kind, name: optText(i.name), color: optText(i.color) };
}

const ROLES = ['', 'control', 'agents', 'agent'];

function parseUnit(u: any): AgentUnit {
  const names = u?.agent?.names;
  const url = typeof u?.agent?.threadUrl === 'string' ? u.agent.threadUrl.trim() : '';
  return {
    name: text(u?.name),
    orchestrator: optText(u?.orchestrator),
    role: ROLES.includes(u?.role) ? u.role : undefined,
    kind: text(u?.kind),
    parent: optText(u?.parent),
    depth: optNum(u?.depth),
    memBytes: num(u?.anon) + num(u?.shmem) + num(u?.kernel),
    cpuCores: optNum(u?.cpuCores),
    cpuLimitCores: parseCpuLimit(u),
    cpuThrottledRatio: optNum(u?.cpuThrottledRatio),
    project: optText(names?.workspace),
    projectId: optText(names?.projectId),
    thread: optText(names?.title) ?? optText(names?.tab),
    threadUrl: /^https?:\/\//i.test(url) ? url : undefined,
    icon: parseIcon(names?.icon),
    procs: Array.isArray(u?.processes?.roots)
      ? u.processes.roots.map((r: any) => parseProc(r, 0))
      : [],
  };
}

/** Reads one backend's /api/state; throws when it is not an agent-resource payload. */
export function parseAgentState(json: unknown, backend: string): AgentHost {
  const j = json as any;
  if (!j || typeof j !== 'object' || !Array.isArray(j.units)) {
    throw new Error('Not an agent-resource state');
  }
  return {
    node: text(j.node),
    backend,
    units: j.units.map(parseUnit),
    orchestrators: (Array.isArray(j.orchestrators) ? j.orchestrators : []).map((o: any) => ({
      name: text(o?.name),
      title: text(o?.title) || text(o?.name),
    })),
  };
}

export async function fetchAgentHosts(
  backends: string[]
): Promise<{ hosts: AgentHost[]; errors: { backend: string; message: string }[] }> {
  const results = await Promise.allSettled(
    backends.map(async b => parseAgentState(await requestBackend(b, '/api/state'), b))
  );
  const hosts: AgentHost[] = [];
  const errors: { backend: string; message: string }[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') hosts.push(r.value);
    else
      errors.push({
        backend: backends[i],
        message: String((r.reason as any)?.message ?? r.reason),
      });
  });
  return { hosts, errors };
}

/** Browser-local settings over the built-in defaults. Blank or bad values fall back. */
/** Parses `id=Name` lines (or a ready object) into a map; bad lines are skipped. */
export function parseDisplayNames(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (k && typeof v === 'string' && v) out[k] = v;
    return out;
  }
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i < 1) continue;
    const id = line.slice(0, i).trim();
    const name = line.slice(i + 1).trim();
    if (id && name) out[id] = name;
  }
  return out;
}

export function resolveNodesSettings(raw: unknown): NodesSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r.agentBackends)
    ? r.agentBackends
    : typeof r.agentBackends === 'string'
    ? r.agentBackends.split(',')
    : [];
  const backends = list.map(s => String(s).trim()).filter(Boolean);
  const idle = Number(r.idleSeconds);
  const hasIdle =
    r.idleSeconds !== '' &&
    r.idleSeconds !== null &&
    r.idleSeconds !== undefined &&
    Number.isFinite(idle);
  return {
    agentBackends: backends.length ? backends : DEFAULT_NODES_SETTINGS.agentBackends,
    idleSeconds: hasIdle
      ? Math.max(MIN_IDLE_SECONDS, Math.round(idle))
      : DEFAULT_NODES_SETTINGS.idleSeconds,
    displayNames: parseDisplayNames(r.displayNames),
  };
}
