import { ApiProxy, ConfigStore, K8s } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import {
  buildLocalStatus,
  historyUrlFor,
  isHistory,
  isStatus,
  mergeEnrichment,
  parseAliases,
} from './model';
import type { History, PluginConfig, Raw, Status } from './types';

export const CONFIG_KEY = 'github-runners';
export const configStore = new ConfigStore<PluginConfig>(CONFIG_KEY);
export const POLL_MS = 10000;

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

async function getJson(url: string): Promise<any> {
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

/** Poll the optional scanner endpoint (status.json / history.json). */
export function useRemote(cfg: PluginConfig): Remote {
  const [state, setState] = React.useState<Remote>({
    status: null,
    history: null,
    error: null,
    configured: !!cfg.statusUrl,
  });
  const statusUrl = cfg.statusUrl || '';
  const historyUrl = historyUrlFor(cfg);
  React.useEffect(() => {
    if (!statusUrl) {
      setState({ status: null, history: null, error: null, configured: false });
      return;
    }
    let alive = true;
    const load = async () => {
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
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [statusUrl, historyUrl]);
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

export interface Board {
  loading: boolean;
  arcPresent: boolean;
  status: Status;
  local: Status;
  remote: Remote;
  lists: Record<'sets' | 'esets' | 'runners' | 'listeners', ListState>;
  pods: Raw[];
  errors: string[];
}

export function useBoard(): Board {
  const cfg = configStore.useConfig()() || {};
  const nodes = useKind(K8s.ResourceClasses.Node);
  const pods = useKind(K8s.ResourceClasses.Pod);
  const sets = useKind(AutoscalingRunnerSet);
  const esets = useKind(EphemeralRunnerSet);
  const runners = useKind(EphemeralRunner);
  const listeners = useKind(AutoscalingListener);
  const workers = useExternalWorkers(cfg);
  const remote = useRemote(cfg);

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
    loading: sets.loading || runners.loading,
    arcPresent,
    status,
    local,
    remote,
    lists: { sets, esets, runners, listeners },
    pods: pods.items,
    errors,
  };
}
