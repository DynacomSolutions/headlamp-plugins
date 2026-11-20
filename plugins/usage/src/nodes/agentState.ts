/*
 * Agent hosts, pure part: the types and the parser of the agent-resource /api/state payload. This
 * file imports no React and no Headlamp library, so the agent service can bundle it. Plugins
 * cannot share code, so the small helpers here are copies of the agent-resource ones.
 */

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

const MAX_PROC_DEPTH = 32;

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
