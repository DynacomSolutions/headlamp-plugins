import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { MetricsTarget, queryMetrics } from './metrics';
import {
  buildWorkflowRows,
  CONFIG_KEY,
  CronJobKey,
  cronJobScope,
  emptyRaw,
  kubeQueries,
  Raw,
  resolveSettings,
  Settings,
  SuffixKey,
  workflowQueries,
  WorkloadKey,
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
  // Keep one object while the values are the same: the page and the widget refetch when it changes.
  const resolved = resolveSettings(stored, defaults);
  const ref = React.useRef(resolved);
  if (JSON.stringify(ref.current) !== JSON.stringify(resolved)) ref.current = resolved;
  return ref.current;
}

export function targetOf(settings: Settings): MetricsTarget {
  return { namespace: settings.metricsNamespace, service: settings.metricsService, port: settings.metricsPort };
}

/**
 * Reads the series in two steps. First one instant query per workflow series family: a failure here
 * fails the load. Then, for the namespaces in scope (the namespaces that have workflow series, plus
 * the `cronJobNamespaces` setting), the CronJob and workload queries from kube-state-metrics. A
 * failure of one of those is kept apart: the workflow rows still show and the page says that the
 * CronJobs and workloads are missing.
 */
export async function loadRaw(settings: Settings): Promise<{ raw: Raw; kubeError?: string }> {
  const target = targetOf(settings);
  const raw = emptyRaw();
  const wq = workflowQueries();
  const wKeys = Object.keys(wq) as SuffixKey[];
  const workflow = await Promise.all(wKeys.map(k => queryMetrics(target, wq[k])));
  wKeys.forEach((k, i) => (raw[k] = workflow[i]));

  const queries = kubeQueries(cronJobScope(settings.cronJobNamespaces, buildWorkflowRows(raw)));
  if (!queries) return { raw };
  let kubeError: string | undefined;
  const read = (promql: string) =>
    queryMetrics(target, promql).catch(e => {
      kubeError = String(e?.message || e);
      return [];
    });
  const cKeys = Object.keys(queries.cron) as CronJobKey[];
  const kKeys = Object.keys(queries.workloads) as WorkloadKey[];
  const [cron, workloads] = await Promise.all([
    Promise.all(cKeys.map(k => read(queries.cron[k]))),
    Promise.all(kKeys.map(k => read(queries.workloads[k]))),
  ]);
  cKeys.forEach((k, i) => (raw.cron[k] = cron[i]));
  kKeys.forEach((k, i) => (raw.workloads[k] = workloads[i]));
  return { raw, kubeError };
}

export interface Loaded {
  raw?: Raw;
  kubeError?: string;
  error?: string;
  loading: boolean;
  /** Epoch milliseconds of the last good load. */
  at?: number;
}
