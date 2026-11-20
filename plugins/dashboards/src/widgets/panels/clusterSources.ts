/*
 * Cluster sources: panel sources that every browser shares. They live in the ConfigMap
 * `dashboard-sources` in the dashboards namespace (label headlamp.dev/dashboard-sources=true,
 * key `sources.json` = `{ "version": 1, "sources": [...] }`).
 *
 * The content is untrusted: `parseClusterSources` checks it with the rules of a browser source.
 * The result is cached here, one entry per cluster and namespace. Widgets never fetch it
 * themselves: they read the cache, and a refresh is one shared request (see `useSources`).
 */
import type { Transport } from '../../storage/storage';
import { FIELD_MANAGER } from '../../storage/storage';
import {
  CLUSTER_SOURCES_KEY,
  CLUSTER_SOURCES_LABEL,
  CLUSTER_SOURCES_NAME,
  PanelSource,
  parseClusterSources,
  serialiseClusterSources,
} from './sources';

export interface ClusterSourcesState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** The valid sources. After a failed refresh these are the last good ones. */
  sources: PanelSource[];
  /** Entries that were ignored, and why. */
  problems: string[];
  /** The reason the last read failed. Set only while `status` is `error`. */
  error?: string;
  /** False when the ConfigMap does not exist yet. */
  exists: boolean;
  resourceVersion: string;
  /** The ConfigMap as loaded. A save keeps everything in it except the sources key and the label. */
  raw?: any;
  /** When the state was last set, in ms. */
  at: number;
}

const EMPTY: ClusterSourcesState = {
  status: 'idle',
  sources: [],
  problems: [],
  exists: false,
  resourceVersion: '',
  at: 0,
};

/** A cached state is fresh for this long. A mounted widget asks again after it. */
export const CLUSTER_SOURCES_TTL_MS = 5 * 60_000;
/** After a failed read the next automatic try waits this long. */
export const CLUSTER_SOURCES_RETRY_MS = 60_000;

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const configMaps = (ns: string) => `/api/v1/namespaces/${encodeURIComponent(ns)}/configmaps`;

const keyOf = (cluster: string | undefined, namespace: string): string =>
  `${cluster ?? ''}|${namespace}`;

const states = new Map<string, ClusterSourcesState>();
const inflight = new Map<string, Promise<ClusterSourcesState>>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach(l => l());

export function subscribeClusterSources(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getClusterSourcesState = (
  cluster: string | undefined,
  namespace: string
): ClusterSourcesState => states.get(keyOf(cluster, namespace)) ?? EMPTY;

/**
 * Marks the cached state of every other cluster key for a namespace as old. The settings page names
 * a cluster, a dashboard page does not, so a save on one must reach the other.
 */
export function invalidateClusterSources(namespace: string, exceptKey?: string): void {
  states.forEach((v, k) => {
    if (k !== exceptKey && k.endsWith(`|${namespace}`)) states.set(k, { ...v, at: 0 });
  });
}

/** Test helper: forget every cached state. */
export function clearClusterSources(): void {
  states.clear();
  inflight.clear();
  emit();
}

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

export function describeSourcesError(e: unknown, ns: string, verb: 'read' | 'write'): Error {
  const s = statusOf(e);
  if (s === 401 || s === 403)
    return new Error(
      verb === 'read'
        ? `You are not allowed to read the cluster sources in the namespace "${ns}". Ask a cluster admin for list on ConfigMaps there.`
        : `You have read-only access to the cluster sources in the namespace "${ns}". Ask a cluster admin for create and update on ConfigMaps there to save changes.`
    );
  if (s === 409)
    return new Error(
      'Someone else saved the cluster sources since you opened them. Reload them to see the changes. Your edits stay on screen until you reload.'
    );
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(msg.trim() === '' ? 'The request failed.' : msg.slice(0, 240));
}

/** The state for a ConfigMap, or for no ConfigMap. */
export function stateFromConfigMap(cm: any | undefined, at = Date.now()): ClusterSourcesState {
  if (!cm) return { ...EMPTY, status: 'ready', at };
  const { sources, problems } = parseClusterSources(cm?.data?.[CLUSTER_SOURCES_KEY]);
  return {
    status: 'ready',
    sources,
    problems,
    exists: true,
    resourceVersion: cm?.metadata?.resourceVersion ?? '',
    raw: cm,
    at,
  };
}

/** Keeps the old `sources` array when the content did not change, so dependents do not rerun. */
function settle(key: string, next: ClusterSourcesState): ClusterSourcesState {
  const prev = states.get(key);
  const out =
    prev && JSON.stringify(prev.sources) === JSON.stringify(next.sources)
      ? { ...next, sources: prev.sources }
      : next;
  states.set(key, out);
  emit();
  return out;
}

/**
 * Reads the ConfigMap. Calls that overlap share one request. A failed read keeps the last good
 * sources and sets `error`. A missing ConfigMap is not an error: there are no cluster sources.
 */
export function loadClusterSources(
  transport: Transport,
  cluster: string | undefined,
  namespace: string
): Promise<ClusterSourcesState> {
  const key = keyOf(cluster, namespace);
  const running = inflight.get(key);
  if (running) return running;
  const prev = states.get(key) ?? EMPTY;
  states.set(key, { ...prev, status: 'loading' });
  emit();
  const run = transport
    .request(
      `${configMaps(namespace)}?labelSelector=${encodeURIComponent(
        `${CLUSTER_SOURCES_LABEL}=true`
      )}`
    )
    .then(
      res => {
        const items: any[] = Array.isArray(res?.items) ? res.items : [];
        const cm = items.find(i => i?.metadata?.name === CLUSTER_SOURCES_NAME);
        return settle(key, stateFromConfigMap(cm));
      },
      e =>
        settle(key, {
          ...prev,
          status: 'error',
          error: describeSourcesError(e, namespace, 'read').message,
          at: Date.now(),
        })
    )
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, run);
  return run;
}

/** Loads when nothing is cached or the cache is old. Otherwise it does nothing. */
export function ensureClusterSources(
  transport: Transport,
  cluster: string | undefined,
  namespace: string,
  now: number = Date.now()
): void {
  const s = getClusterSourcesState(cluster, namespace);
  if (s.status === 'loading') return;
  const age = now - s.at;
  const limit = s.status === 'error' ? CLUSTER_SOURCES_RETRY_MS : CLUSTER_SOURCES_TTL_MS;
  if (s.status === 'idle' || age >= limit) void loadClusterSources(transport, cluster, namespace);
}

/**
 * The ConfigMap to write. With `base` (the object as loaded), only the sources key and the label
 * change, so other labels, annotations, data keys and the resourceVersion stay.
 */
export function toSourcesConfigMap(
  namespace: string,
  sources: ReadonlyArray<PanelSource>,
  resourceVersion?: string,
  base?: any
): any {
  const loaded = base && typeof base === 'object' ? base : undefined;
  const meta: Record<string, any> = { ...loaded?.metadata };
  delete meta.managedFields;
  const cm: any = {
    ...loaded,
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      ...meta,
      name: CLUSTER_SOURCES_NAME,
      namespace,
      labels: { ...meta.labels, [CLUSTER_SOURCES_LABEL]: 'true' },
    },
    data: { ...loaded?.data, [CLUSTER_SOURCES_KEY]: serialiseClusterSources(sources) },
  };
  const version = resourceVersion || meta.resourceVersion;
  if (version) cm.metadata.resourceVersion = version;
  return cm;
}

/**
 * Saves the list. An existing ConfigMap is replaced with its resourceVersion, so a change made
 * since the read is a conflict (HTTP 409) and not a silent overwrite. A missing one is created.
 * Argo CD or another tool may own the ConfigMap: it can revert a change made here.
 */
export async function saveClusterSources(
  transport: Transport,
  cluster: string | undefined,
  namespace: string,
  sources: ReadonlyArray<PanelSource>
): Promise<ClusterSourcesState> {
  const key = keyOf(cluster, namespace);
  const current = states.get(key) ?? EMPTY;
  try {
    const cm = current.exists
      ? await transport.request(
          `${configMaps(namespace)}/${encodeURIComponent(
            CLUSTER_SOURCES_NAME
          )}?fieldManager=${FIELD_MANAGER}`,
          {
            method: 'PUT',
            headers: JSON_HEADERS,
            body: JSON.stringify(
              toSourcesConfigMap(namespace, sources, current.resourceVersion, current.raw)
            ),
          }
        )
      : await transport.request(`${configMaps(namespace)}?fieldManager=${FIELD_MANAGER}`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(toSourcesConfigMap(namespace, sources)),
        });
    const saved = settle(key, stateFromConfigMap(cm));
    invalidateClusterSources(namespace, key);
    return saved;
  } catch (e) {
    if (statusOf(e) === 409) {
      // Show the new content on the page. The edits in the dialog stay.
      void loadClusterSources(transport, cluster, namespace);
      if (!current.exists)
        throw new Error(
          `A ConfigMap named ${CLUSTER_SOURCES_NAME} already exists in the namespace "${namespace}" without the label ${CLUSTER_SOURCES_LABEL}=true. Add the label to it, or remove it, then try again.`
        );
    }
    throw describeSourcesError(e, namespace, 'write');
  }
}
