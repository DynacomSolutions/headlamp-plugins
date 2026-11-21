/* Data hooks: the dashboard list, one dashboard, the write permission and cluster names. */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import type { WidgetDefinition } from './contract';
import { getRegistry } from './registry';
import { backoffDelay } from './resilience/backoff';
import { useDashboardNamespace } from './settings';
import {
  AccessError,
  ConflictError,
  createStorage,
  DashboardStorage,
  NameTakenError,
  NotFoundError,
  StoredDashboard,
} from './storage/storage';
import { apiTransport, canWriteConfigMaps } from './transport';
import { loadClusterSources } from './widgets/panels/clusterSources';
import { transportFor, useSources } from './widgets/panels/sourcesConfig';
import { useSyncSourceWidgets } from './widgets/panels/variants';

export function useStorage(): DashboardStorage {
  const namespace = useDashboardNamespace();
  return React.useMemo(() => createStorage(apiTransport, namespace), [namespace]);
}

export interface Loaded<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
  /** Replace the data without a request, for example with the result of a save. */
  set: (data: T) => void;
}

/**
 * True for a failure that can pass by itself: no answer at all (the server restarts), a gateway or
 * server error, or too many requests. A refusal (401, 403), a missing object (404) and a bad
 * request will not pass, so there is no point in a retry.
 */
export function isTransientError(e: unknown): boolean {
  if (
    e instanceof AccessError ||
    e instanceof NotFoundError ||
    e instanceof ConflictError ||
    e instanceof NameTakenError
  )
    return false;
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status !== 'number' || status >= 500 || status === 429 || status === 408;
}

/**
 * Runs `load` on mount and whenever its deps change. A stale answer is ignored. With `retry`, a
 * failure that `isTransientError` calls transient is tried again after 2 s, 4 s, 8 s and so on up to
 * 30 s, so a page that opened while the server restarted fills itself when the server is back.
 */
function useLoaded<T>(
  load: () => Promise<T>,
  deps: React.DependencyList,
  retry = false
): Loaded<T> {
  const [state, setState] = React.useState<{ data?: T; error?: Error; loading: boolean }>({
    loading: true,
  });
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const run = () => {
      setState(s => ({ ...s, loading: true }));
      load().then(
        data => live && setState({ data, loading: false }),
        error => {
          if (!live) return;
          setState(s => ({
            data: s.data,
            error: error instanceof Error ? error : new Error(String(error)),
            loading: false,
          }));
          if (retry && isTransientError(error)) {
            failures += 1;
            timer = setTimeout(run, backoffDelay(failures, 2_000, 30_000, 0.2));
          }
        }
      );
    };
    run();
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    reload: () => setTick(t => t + 1),
    set: data => setState({ data, loading: false }),
  };
}

/** The dashboards. Each load also refreshes the shared cluster sources, in one request. */
export function useDashboardList(storage: DashboardStorage): Loaded<StoredDashboard[]> {
  return useLoaded(() => {
    // The page is a cluster route, so no cluster name is needed. Widgets use the same cache entry.
    void loadClusterSources(transportFor(undefined), undefined, storage.namespace);
    return storage.list();
  }, [storage]);
}

export function useDashboard(storage: DashboardStorage, name: string): Loaded<StoredDashboard> {
  return useLoaded(() => storage.get(name), [storage, name], true);
}

/** Whether the user can create, update and delete ConfigMaps in the namespace. undefined while unknown. */
export function useCanWrite(namespace: string): boolean | undefined {
  const [allowed, setAllowed] = React.useState<boolean | undefined>(undefined);
  React.useEffect(() => {
    let live = true;
    setAllowed(undefined);
    canWriteConfigMaps(apiTransport, namespace).then(v => live && setAllowed(v));
    return () => {
      live = false;
    };
  }, [namespace]);
  return allowed;
}

/** One widget type from the registry. Rerenders when a plugin registers or replaces it. */
export function useWidgetDefinition(type: string): WidgetDefinition | undefined {
  const store = getRegistry();
  return React.useSyncExternalStore(store.subscribe, () => store.get(type));
}

/** All registered widget types, for the palette. */
export function useWidgetDefinitions(): WidgetDefinition[] {
  // One palette entry per panel source.
  useSyncSourceWidgets(useSources());
  const store = getRegistry();
  return React.useSyncExternalStore(store.subscribe, () => store.list());
}

/** Names of cluster objects (namespaces, nodes) for the filter pick lists. An error gives an empty list. */
export function useClusterNames(path: '/api/v1/namespaces' | '/api/v1/nodes'): string[] {
  const [names, setNames] = React.useState<string[]>([]);
  React.useEffect(() => {
    let live = true;
    Promise.resolve(ApiProxy.request(path))
      .then(res => {
        const out = ((res as { items?: Array<{ metadata?: { name?: string } }> }).items ?? [])
          .map(i => i.metadata?.name ?? '')
          .filter(Boolean)
          .sort();
        if (live) setNames(out);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [path]);
  return names;
}

/** The current time, updated each `ms`. For the relative "Last refreshed" text. */
export function useNow(ms: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
