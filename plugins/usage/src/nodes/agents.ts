/*
 * Agent hosts: reads the agent-resource backend (/api/state) through the Kubernetes API service
 * proxy. Plugins cannot share code, so the small helpers here are copies of the agent-resource
 * ones. The backend Service was called agent-memory before: the new place is tried first and
 * the old namespace agent-memory is the fallback, so the dashboard works before and after the backend rollout.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import type { AgentHost } from './agentState';
import { parseAgentState } from './agentState';

export { parseAgentState } from './agentState';
export type { AgentHost, AgentProc, AgentUnit } from './agentState';

export interface NodesSettings {
  agentBackends: string[];
  idleSeconds: number;
  /** Arc id (or key) to display name: overrides every guess. */
  displayNames: Record<string, string>;
}

export const DEFAULT_NODES_SETTINGS: NodesSettings = {
  agentBackends: ['service/agent-resource/agent-resource:80'],
  idleSeconds: 120,
  displayNames: {},
};

const MIN_IDLE_SECONDS = 30;

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
const NAMESPACE = 'agent-resource';
const LEGACY_NAMESPACE = 'agent-memory';

/**
 * The backends to try, best first. The backend now runs as Service agent-resource in the
 * namespace agent-resource. A backend in the new or the old namespace tries the new place first
 * and the old place second. In another namespace, an agent-resource Service also has its
 * agent-memory twin as a fallback, and the other way round. Any other name stays alone.
 */
export function backendCandidates(backend: string): string[] {
  const b = backend.trim();
  const m = /^(service\/[^/]+\/)([^/:]+)(.*)$/.exec(b);
  if (!m || (m[2] !== SERVICE && m[2] !== LEGACY_SERVICE)) return [b];
  if (m[1] === `service/${NAMESPACE}/` || m[1] === `service/${LEGACY_NAMESPACE}/`) {
    return [`service/${NAMESPACE}/${SERVICE}${m[3]}`, `service/${LEGACY_NAMESPACE}/${SERVICE}${m[3]}`];
  }
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
