import { ApiProxy, ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import {
  AgentMemoryState,
  backendUrl,
  ChangeRecord,
  CONFIG_KEY,
  EditField,
  parseState,
  resolveSettings,
  Settings,
} from './model';

export const configStore = new ConfigStore<Partial<Settings>>(CONFIG_KEY);

let defaultsPromise: Promise<Partial<Settings>> | null = null;

/** Deployment-supplied defaults: an optional defaults.json served next to main.js. */
function loadDefaults(): Promise<Partial<Settings>> {
  if (!defaultsPromise) {
    defaultsPromise = fetch(`/plugins/${CONFIG_KEY}/defaults.json`)
      .then(r => (r.ok ? r.json() : {}))
      .then(j => (j && typeof j === 'object' ? (j as Partial<Settings>) : {}))
      .catch(() => ({}));
  }
  return defaultsPromise;
}

/** Browser-local overrides layered over the deployment defaults and built-ins. */
export function useSettings(): Settings {
  const stored = configStore.useConfig()() as Partial<Settings> | undefined;
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
  state: AgentMemoryState | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Polls the backend through the Kubernetes API service proxy while the page is mounted. */
export function useAgentMemory(s: Settings): StateResult {
  const [res, setRes] = React.useState<Omit<StateResult, 'refresh'>>({
    state: null,
    loading: true,
    error: null,
  });
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    let url: string;
    try {
      url = backendUrl(s.backend, '/api/state');
    } catch (e: any) {
      setRes({ state: null, loading: false, error: String(e?.message || e) });
      return;
    }
    const load = async () => {
      try {
        const json = await ApiProxy.request(url);
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
    ApiProxy.request(backendUrl(s.backend, '/api/changes'))
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
  return ApiProxy.request(backendUrl(s.backend, '/api/limits'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Memory-Write': '1' },
    body: JSON.stringify(body),
  });
}
