/*
 * The sources in use: the built-in agent, the cluster sources (ConfigMap `dashboard-sources`) and
 * the browser sources (the same key as the settings page). The cluster sources come from the
 * cache in `clusterSources.ts`.
 */
import { ApiProxy, ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { resolveNamespace } from '../../namespace';
import type { Transport } from '../../storage/storage';
import {
  ClusterSourcesState,
  ensureClusterSources,
  getClusterSourcesState,
  subscribeClusterSources,
} from './clusterSources';
import { PanelSource, resolveSources, SOURCES_KEY } from './sources';

let store: ConfigStore<Record<string, unknown>> | undefined;
/** Created on first use, so importing a widget does not need the Headlamp store. */
export const getSettingsStore = (): ConfigStore<Record<string, unknown>> =>
  (store ??= new ConfigStore<Record<string, unknown>>('dashboards'));

const INPUT_KEYS = ['agentNamespace', 'agentService', 'agentPort', SOURCES_KEY];

/**
 * A transport for the Kubernetes API. The settings page has no cluster in its URL, so a request
 * there names the cluster. On a cluster route `cluster` is left out.
 */
export const transportFor = (cluster: string | undefined): Transport => ({
  request: (path, params) =>
    cluster
      ? ApiProxy.clusterRequest(path, { ...params, cluster })
      : ApiProxy.request(path, params),
});

/** The cluster sources of the dashboards namespace. Asks the cache to load, and rerenders on a change. */
export function useClusterSourcesState(cluster?: string): ClusterSourcesState {
  const stored = getSettingsStore().useConfig()() as Record<string, unknown> | undefined;
  const namespace = resolveNamespace(stored);
  const state = React.useSyncExternalStore(subscribeClusterSources, () =>
    getClusterSourcesState(cluster, namespace)
  );
  React.useEffect(() => {
    ensureClusterSources(transportFor(cluster), cluster, namespace);
  }, [cluster, namespace]);
  return state;
}

/**
 * The sources, the agent first, then the cluster sources, then the browser sources. The list keeps
 * its identity until a source setting or the cluster sources change.
 */
export function useSources(cluster?: string): PanelSource[] {
  const stored = getSettingsStore().useConfig()() as Record<string, unknown> | undefined;
  const clusterSources = useClusterSourcesState(cluster).sources;
  const fingerprint = JSON.stringify(INPUT_KEYS.map(k => stored?.[k] ?? null));
  return React.useMemo(
    () => resolveSources(stored, clusterSources),
    // The fingerprint covers the only inputs, so an unrelated settings change does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fingerprint, clusterSources]
  );
}

/** The sources right now, outside React. A missing store gives only the agent. */
export function readSourcesNow(): PanelSource[] {
  try {
    const stored = getSettingsStore().get() as Record<string, unknown> | undefined;
    return resolveSources(
      stored,
      getClusterSourcesState(undefined, resolveNamespace(stored)).sources
    );
  } catch {
    return resolveSources(undefined);
  }
}

/**
 * One source by id. `pending` is true while the first read of the cluster sources runs and the id
 * is not known yet, so a widget shows a spinner and not a false "not configured" message.
 */
export function useSourceLookup(
  id: string,
  cluster?: string
): { source: PanelSource | undefined; pending: boolean } {
  const sources = useSources(cluster);
  const state = useClusterSourcesState(cluster);
  const source = sources.find(s => s.id === id);
  return { source, pending: !source && state.at === 0 };
}
