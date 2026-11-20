/* Data hooks: the dashboard list, one dashboard, the write permission and cluster names. */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import type { WidgetDefinition } from './contract';
import { getRegistry } from './registry';
import { useDashboardNamespace } from './settings';
import { createStorage, DashboardStorage, StoredDashboard } from './storage/storage';
import { apiTransport, canWriteConfigMaps } from './transport';
import { useSources } from './widgets/panels/sourcesConfig';
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

/** Runs `load` on mount and whenever its deps change. A stale answer is ignored. */
function useLoaded<T>(load: () => Promise<T>, deps: React.DependencyList): Loaded<T> {
  const [state, setState] = React.useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    setState(s => ({ ...s, loading: true }));
    load().then(
      data => live && setState({ data, loading: false }),
      error => live && setState(s => ({ data: s.data, error: error instanceof Error ? error : new Error(String(error)), loading: false }))
    );
    return () => {
      live = false;
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

export function useDashboardList(storage: DashboardStorage): Loaded<StoredDashboard[]> {
  return useLoaded(() => storage.list(), [storage]);
}

export function useDashboard(storage: DashboardStorage, name: string): Loaded<StoredDashboard> {
  return useLoaded(() => storage.get(name), [storage, name]);
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
