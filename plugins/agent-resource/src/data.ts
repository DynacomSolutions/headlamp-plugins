import { ApiProxy, ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import {
  AgentResourceState,
  backendCandidates,
  backendUrl,
  ChangeRecord,
  CONFIG_KEY,
  EditField,
  LEGACY_CONFIG_KEY,
  parseState,
  pickError,
  resolveSettings,
  Settings,
} from './model';

export const configStore = new ConfigStore<Partial<Settings>>(CONFIG_KEY);
/** Settings saved under the plugin's old name stay in use until new ones are saved. */
const legacyConfigStore = new ConfigStore<Partial<Settings>>(LEGACY_CONFIG_KEY);

let defaultsPromise: Promise<Partial<Settings>> | null = null;

async function fetchDefaults(key: string): Promise<Partial<Settings> | null> {
  try {
    const r = await fetch(`/plugins/${key}/defaults.json`);
    if (!r.ok) return null;
    const j = await r.json();
    return j && typeof j === 'object' ? (j as Partial<Settings>) : null;
  } catch {
    return null;
  }
}

/** Deployment-supplied defaults: an optional defaults.json served next to main.js. */
function loadDefaults(): Promise<Partial<Settings>> {
  if (!defaultsPromise) {
    defaultsPromise = fetchDefaults(CONFIG_KEY).then(
      async d => d ?? (await fetchDefaults(LEGACY_CONFIG_KEY)) ?? {}
    );
  }
  return defaultsPromise;
}

/** Browser-local overrides layered over the deployment defaults and built-ins. */
export function useSettings(): Settings {
  const current = configStore.useConfig()() as Partial<Settings> | undefined;
  const legacy = legacyConfigStore.useConfig()() as Partial<Settings> | undefined;
  const stored = React.useMemo(() => ({ ...legacy, ...current }), [legacy, current]);
  const [defaults, setDefaults] = React.useState<Partial<Settings>>({});
  React.useEffect(() => {
    let alive = true;
    loadDefaults().then(d => alive && setDefaults(d));
    return () => {
      alive = false;
    };
  }, []);
  return React.useMemo(() => resolveSettings(stored, defaults), [stored, defaults]);
}

export interface StateResult {
  state: AgentResourceState | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** The backend that answered last for each configured backend. */
const answered = new Map<string, string>();

/** The candidates in the order to try: the one that answered last first. */
function orderedCandidates(backend: string): string[] {
  const list = backendCandidates(backend);
  const good = answered.get(backend);
  return good && list.includes(good) ? [good, ...list.filter(c => c !== good)] : list;
}

/**
 * GET through the Kubernetes API service proxy. The new Service agent-resource in the
 * namespace agent-resource is tried first and the old place is the fallback, so the plugin works
 * before and after the backend rollout. The one that answers is remembered.
 */
export async function requestBackend(backend: string, path: string): Promise<any> {
  const errors: any[] = [];
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

/** Where changes go: the backend that last answered a read, else the preferred one. */
export function writeBackend(backend: string): string {
  return orderedCandidates(backend)[0];
}

/** Polls the backend through the Kubernetes API service proxy while the page is mounted. */
export function useAgentResource(s: Settings): StateResult {
  const [res, setRes] = React.useState<Omit<StateResult, 'refresh'>>({
    state: null,
    loading: true,
    error: null,
  });
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    try {
      backendUrl(s.backend, '/api/state');
    } catch (e: any) {
      setRes({ state: null, loading: false, error: String(e?.message || e) });
      return;
    }
    const load = async () => {
      try {
        const json = await requestBackend(s.backend, '/api/state');
        if (alive) setRes({ state: parseState(json), loading: false, error: null });
      } catch (e: any) {
        if (alive) setRes(r => ({ ...r, loading: false, error: describeError(e) }));
      }
    };
    load();
    const t = setInterval(load, s.refreshSeconds * 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [s.backend, s.refreshSeconds, tick]);
  const refresh = React.useCallback(() => setTick(n => n + 1), []);
  return { ...res, refresh };
}

/** Recent limit changes recorded by the backend (newest first). */
export function useChanges(s: Settings, enabled: boolean, version: number): ChangeRecord[] {
  const [changes, setChanges] = React.useState<ChangeRecord[]>([]);
  React.useEffect(() => {
    if (!enabled) return;
    let alive = true;
    requestBackend(s.backend, '/api/changes')
      .then((j: any) => alive && setChanges(Array.isArray(j?.changes) ? j.changes : []))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [s.backend, enabled, version]);
  return changes;
}

/** Strips the "Bad Request - " style prefix the API proxy puts in front of the backend's message. */
export function describeError(e: any): string {
  const msg = String(e?.message || e || 'Request failed');
  if (e?.status === 403 && /forbidden/i.test(msg) && /proxy/i.test(msg)) {
    return 'The Kubernetes API refused the request: this dashboard is not allowed to write through the service proxy.';
  }
  return msg.replace(/^[A-Za-z ]+ - /, '');
}

/** The write header of the backend, under its old and its new name. */
const WRITE_HEADERS = {
  'Content-Type': 'application/json',
  'X-Agent-Memory-Write': '1',
  'X-Agent-Resource-Write': '1',
};

export interface LimitUpdate {
  unit: string;
  changes: Partial<Record<EditField, string>>;
  persist: boolean;
  force: boolean;
  reason: string;
}

/**
 * Applies new limits. This is a POST through the Kubernetes API service proxy,
 * so the API server authorises it (RBAC verb "create" on services/proxy for
 * this one Service) before the backend sees it. The custom header is required
 * by the backend and forces a CORS preflight for any cross-site caller.
 */
export async function applyLimits(s: Settings, u: LimitUpdate): Promise<any> {
  const body: Record<string, unknown> = {
    unit: u.unit,
    ...u.changes,
    persist: u.persist,
    force: u.force,
  };
  if (u.reason.trim()) body.reason = u.reason.trim();
  return ApiProxy.request(backendUrl(writeBackend(s.backend), '/api/limits'), {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify(body),
  });
}

export interface DefaultsUpdate {
  /** The orchestrator whose default changes; omitted for an old backend. */
  orchestrator?: string;
  changes: Partial<Record<'memoryHigh' | 'memoryMax' | 'memorySwapMax', string>>;
  force: boolean;
  reason: string;
}

/**
 * Changes an orchestrator's per-agent default (T3: 50-agent-cap.conf, then
 * daemon-reload on the host). Same authorisation path as applyLimits.
 */
export async function applyDefaults(s: Settings, u: DefaultsUpdate): Promise<any> {
  const body: Record<string, unknown> = { ...u.changes, force: u.force };
  if (u.orchestrator) body.orchestrator = u.orchestrator;
  if (u.reason.trim()) body.reason = u.reason.trim();
  return ApiProxy.request(backendUrl(writeBackend(s.backend), '/api/defaults'), {
    method: 'POST',
    headers: WRITE_HEADERS,
    body: JSON.stringify(body),
  });
}
