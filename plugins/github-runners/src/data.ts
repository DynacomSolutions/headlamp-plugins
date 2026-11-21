import { ApiProxy, ConfigStore, K8s } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { migrateKeys } from './legacy-keys';
import {
  buildFromMetrics,
  metricsConfigured,
  MetricsInput,
  parseVector,
  QUERIES,
  QueryId,
  queryPath,
  resolveMetricsSource,
} from './metrics';
import {
  buildLocalStatus,
  historyUrlFor,
  isHistory,
  isStatus,
  mergeEnrichment,
  parseAliases,
} from './model';
import {
  buildPoolBoard,
  PANEL_IDS,
  panelPath,
  Panels,
  parsePanel,
  PoolBoard,
  PoolSource,
  resolveSource,
} from './pool';
import type { History, PluginConfig, Raw, Status } from './types';

export const CONFIG_KEY = 'github-runners';
export const configStore = new ConfigStore<PluginConfig>(CONFIG_KEY);
export const POLL_MS = 10000;

let defaultsPromise: Promise<PluginConfig> | null = null;

/**
 * Deployment-supplied defaults: an optional defaults.json shipped next to
 * main.js in the plugin directory (Headlamp serves it as a static file). Lets
 * an installer preconfigure the endpoint without touching each browser.
 */
function loadDefaults(): Promise<PluginConfig> {
  if (!defaultsPromise) {
    defaultsPromise = fetch(`/plugins/${CONFIG_KEY}/defaults.json`)
      .then(r => (r.ok ? r.json() : {}))
      .then(j => (j && typeof j === 'object' ? (j as PluginConfig) : {}))
      .catch(() => ({}));
  }
  return defaultsPromise;
}

/** Stored settings layered over the deployment defaults (non-empty values win). */
export function useConfig(): PluginConfig {
  const stored = (configStore.useConfig()() || {}) as PluginConfig;
  const [defaults, setDefaults] = React.useState<PluginConfig>({});
  React.useEffect(() => {
    let alive = true;
    loadDefaults().then(d => alive && setDefaults(d));
    return () => {
      alive = false;
    };
  }, []);
  return React.useMemo(() => {
    // Old key names are moved to the new ones in each layer first, so a stored value wins over a default.
    const out: PluginConfig = { ...migrateKeys(defaults) };
    for (const [k, v] of Object.entries(migrateKeys(stored))) if (v) (out as Record<string, unknown>)[k] = v;
    return out;
  }, [defaults, stored]);
}

const ARC_GROUP = 'actions.github.com';
const ARC_VERSION = 'v1alpha1';

function arcClass(kind: string, plural: string) {
  return K8s.crd.makeCustomResourceClass({
    apiInfo: [{ group: ARC_GROUP, version: ARC_VERSION }],
    kind,
    pluralName: plural,
    singularName: kind.toLowerCase(),
    isNamespaced: true,
  });
}

export const AutoscalingRunnerSet = arcClass('AutoscalingRunnerSet', 'autoscalingrunnersets');
export const EphemeralRunnerSet = arcClass('EphemeralRunnerSet', 'ephemeralrunnersets');
export const EphemeralRunner = arcClass('EphemeralRunner', 'ephemeralrunners');
export const AutoscalingListener = arcClass('AutoscalingListener', 'autoscalinglisteners');

export interface ListState {
  items: Raw[];
  /** true while the first response is pending */
  loading: boolean;
  /** true when the API says the resource type does not exist (CRD not installed) */
  absent: boolean;
  /** any other error (for example RBAC) */
  error: string | null;
}

/** Normalise a KubeObject.useList() result. */
export function useKind(cls: any): ListState {
  const [items, err] = cls.useList();
  const status = (err as any)?.status;
  return {
    items: (items || []).map((i: any) => i.jsonData as Raw),
    loading: items === null && !err,
    absent: status === 404,
    error: err && status !== 404 ? String((err as any).message || err) : null,
  };
}

export async function getJson(url: string): Promise<any> {
  if (url.startsWith('/')) {
    // Same-cluster path (for example a Service proxy path) via Headlamp's API proxy.
    const res = await ApiProxy.request(url, { method: 'GET', isJSON: false });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  // Absolute URL: plain browser fetch. No credentials are ever attached.
  const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface Remote {
  status: Status | null;
  history: History | null;
  error: string | null;
  configured: boolean;
}

/**
 * Poll the optional scanner data. A status endpoint (status.json / history.json) wins when it is
 * set. Otherwise, when a metrics service is set, the scanner's samples are read from it.
 */
export function useRemote(cfg: PluginConfig): Remote {
  const statusUrl = cfg.statusUrl || '';
  const metricsOn = !statusUrl && metricsConfigured(cfg);
  const [state, setState] = React.useState<Remote>({
    status: null,
    history: null,
    error: null,
    configured: !!statusUrl || metricsOn,
  });
  const historyUrl = historyUrlFor(cfg);
  const metrics = React.useMemo(
    () => resolveMetricsSource(cfg),
    [cfg.metricsNamespace, cfg.metricsService, cfg.metricsPort]
  );
  React.useEffect(() => {
    if (!statusUrl && !metricsOn) {
      setState({ status: null, history: null, error: null, configured: false });
      return;
    }
    let alive = true;
    const loadEndpoint = async () => {
      const [s, h] = await Promise.allSettled([
        getJson(statusUrl),
        historyUrl ? getJson(historyUrl) : Promise.resolve(null),
      ]);
      if (!alive) return;
      setState(prev => ({
        configured: true,
        status:
          s.status === 'fulfilled' && isStatus(s.value) ? s.value : s.status === 'fulfilled' ? null : prev.status,
        history: h.status === 'fulfilled' && isHistory(h.value) ? h.value : prev.history,
        error:
          s.status === 'rejected'
            ? String((s.reason as Error)?.message || s.reason)
            : isStatus((s as PromiseFulfilledResult<any>).value)
            ? null
            : 'Endpoint did not return a status document',
      }));
    };
    const loadMetrics = async () => {
      if (metrics.problem) {
        setState({ status: null, history: null, error: metrics.problem, configured: true });
        return;
      }
      const ids = Object.keys(QUERIES) as QueryId[];
      const results = await Promise.allSettled(ids.map(id => getJson(queryPath(metrics, QUERIES[id]))));
      if (!alive) return;
      const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
      const input = {} as MetricsInput;
      let bad = false;
      ids.forEach((id, i) => {
        const r = results[i];
        const vector = r.status === 'fulfilled' ? parseVector(r.value) : null;
        if (vector) input[id] = vector;
        else bad = true;
      });
      if (failed || bad) {
        setState(prev => ({
          ...prev,
          configured: true,
          error: failed ? String((failed.reason as Error)?.message || failed.reason) : 'The metrics service did not return a result',
        }));
        return;
      }
      const built = buildFromMetrics(input);
      setState(prev => ({
        configured: true,
        status: built ? built.status : null,
        history: built ? built.history : prev.history,
        error: built ? null : 'No scan in the last few minutes',
      }));
    };
    const load = statusUrl ? loadEndpoint : loadMetrics;
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [statusUrl, historyUrl, metricsOn, metrics]);
  return state;
}

/** Poll an optional ExternalWorker-style CRD (group given in settings). */
export function useExternalWorkers(cfg: PluginConfig): { items: Raw[]; error: string | null } {
  const group = cfg.externalWorkerGroup || '';
  const version = cfg.externalWorkerVersion || 'v1alpha1';
  const [state, setState] = React.useState<{ items: Raw[]; error: string | null }>({
    items: [],
    error: null,
  });
  React.useEffect(() => {
    if (!group) {
      setState({ items: [], error: null });
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const body = await getJson(`/apis/${group}/${version}/externalworkers`);
        if (alive) setState({ items: body?.items || [], error: null });
      } catch (e) {
        // Absent CRD (404) or no access: show nothing rather than failing the page.
        if (alive) setState({ items: [], error: String((e as Error)?.message || e) });
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [group, version]);
  return state;
}

export type PoolServiceState = 'off' | 'loading' | 'ok' | 'error';

export interface PoolServiceData {
  source: PoolSource;
  state: PoolServiceState;
  board: PoolBoard | null;
  /** Panels that failed on the last poll, with the reason. The others still show. */
  failed: Array<{ id: string; reason: string }>;
  error: string | null;
}

const reasonOf = (e: unknown): string => String((e as Error)?.message || e);

/** Poll the runner service panels through the Kubernetes service proxy. Off when the mode is off. */
export function usePoolService(cfg: PluginConfig): PoolServiceData {
  const source = React.useMemo(
    () => resolveSource(cfg),
    [cfg.poolMode, cfg.poolNamespace, cfg.poolService, cfg.poolPort]
  );
  const enabled = source.mode !== 'off' && source.configured && source.problem === null;
  const key = `${source.namespace}/${source.service}:${source.port}`;
  const [state, setState] = React.useState<{
    key: string;
    panels: Panels;
    got: boolean;
    failed: Array<{ id: string; reason: string }>;
    error: string | null;
  }>({ key, panels: {}, got: false, failed: [], error: null });
  React.useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      const results = await Promise.allSettled(PANEL_IDS.map(id => getJson(panelPath(source, id))));
      if (!alive) return;
      setState(prev => {
        const base = prev.key === key ? prev.panels : {};
        const panels: Panels = { ...base };
        const failed: Array<{ id: string; reason: string }> = [];
        results.forEach((r, i) => {
          const id = PANEL_IDS[i];
          if (r.status === 'rejected') failed.push({ id, reason: reasonOf(r.reason) });
          else {
            const panel = parsePanel(r.value);
            if (panel) panels[id] = panel;
            else failed.push({ id, reason: 'Not a panel document' });
          }
        });
        const any = Object.keys(panels).length > 0;
        return {
          key,
          panels,
          got: any,
          failed,
          error: any ? null : failed[0]?.reason ?? 'No panel answered',
        };
      });
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled, key, source]);
  const fresh = state.key === key;
  const board = React.useMemo(
    () => (fresh && state.got ? buildPoolBoard(state.panels) : null),
    [fresh, state.got, state.panels]
  );
  let st: PoolServiceState = 'off';
  if (source.problem && source.mode !== 'off') st = 'error';
  else if (enabled) st = !fresh || (!state.got && !state.error) ? 'loading' : board ? 'ok' : 'error';
  return {
    source,
    state: st,
    board,
    failed: fresh ? state.failed : [],
    error: source.problem && source.mode !== 'off' ? source.problem : fresh ? state.error : null,
  };
}

export interface Board {
  cfg: PluginConfig;
  /** Where the numbers come from. The runner service when it answers, otherwise the ARC feed and Kubernetes. */
  dataSource: 'pool' | 'arc';
  pool: PoolServiceData;
  loading: boolean;
  arcPresent: boolean;
  status: Status;
  local: Status;
  remote: Remote;
  lists: Record<'sets' | 'esets' | 'runners' | 'listeners', ListState>;
  pods: Raw[];
  nodes: Raw[];
  workers: Raw[];
  errors: string[];
}

export function useBoard(): Board {
  const cfg = useConfig();
  const nodes = useKind(K8s.ResourceClasses.Node);
  const pods = useKind(K8s.ResourceClasses.Pod);
  const sets = useKind(AutoscalingRunnerSet);
  const esets = useKind(EphemeralRunnerSet);
  const runners = useKind(EphemeralRunner);
  const listeners = useKind(AutoscalingListener);
  const workers = useExternalWorkers(cfg);
  const remote = useRemote(cfg);
  const poolSvc = usePoolService(cfg);
  // Auto: the runner service while it loads or works, the ARC path once it fails. On: the runner service only. Off: ARC only.
  const dataSource: 'pool' | 'arc' =
    poolSvc.state === 'off' || (poolSvc.source.mode === 'auto' && poolSvc.state === 'error')
      ? 'arc'
      : 'pool';

  const arcPresent = !(sets.absent && runners.absent);
  const local = React.useMemo(
    () =>
      buildLocalStatus({
        nodes: nodes.items,
        pods: pods.items,
        runners: runners.items,
        scaleSets: sets.items,
        externalWorkers: workers.items,
        nodeAliases: parseAliases(cfg.nodeAliases),
      }),
    [nodes.items, pods.items, runners.items, sets.items, workers.items, cfg.nodeAliases]
  );
  const status = React.useMemo(
    () => mergeEnrichment(local, remote.status, arcPresent),
    [local, remote.status, arcPresent]
  );
  const errors = [nodes, pods, sets, esets, runners, listeners]
    .map(l => l.error)
    .filter((e): e is string => !!e);
  return {
    cfg,
    dataSource,
    pool: poolSvc,
    loading: sets.loading || runners.loading,
    arcPresent,
    status,
    local,
    remote,
    lists: { sets, esets, runners, listeners },
    pods: pods.items,
    nodes: nodes.items,
    workers: workers.items,
    errors,
  };
}
