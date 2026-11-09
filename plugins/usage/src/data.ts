/*
 * Data hooks: metrics (polled on the range's refresh interval while mounted) and the live Pods and
 * Services used for the label and Service joins.
 */
import { K8s } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { MetricSample, queryMetrics } from './metrics';
import { buildAggregatedRows, buildLiveRows, Coverage, coverageFor, FetchPlan, MeasureSamples, PodMeta, recordedSpan, ServiceMeta, UsageRow, withEndedRemainder } from './model';
import { aggQuery, buildQueries, isRecordedRange, LABEL_NAMES_QUERY, labelNameFor, LABELS_PRESENT_QUERY, MEASURES, QUERY_KEYS, QueryKey, Range, rangeSeconds, recordedCoverageQueries, recordedQuery, refreshIntervalMs, windowFor } from './resources';

export interface UsageData {
  rows: UsageRow[];
  /** Whether label values came from kube_pod_labels (ended pods keep labels) or from live pods. */
  labelSource: 'server' | 'client' | null;
  /** Recorded ranges only: what part of the window has data. */
  coverage?: Coverage | null;
  /** Recorded ranges only: the recording rules have produced nothing yet. */
  recordedMissing?: boolean;
}

/** Aggregated raw samples (up to 24h): one query per key. */
export async function fetchAggregated(range: Range, labelName: string | undefined, keys: QueryKey[]): Promise<MeasureSamples> {
  const win = windowFor(range);
  const results = await Promise.all(keys.map(k => queryMetrics(aggQuery(win, k, labelName))));
  const samples: MeasureSamples = {};
  keys.forEach((k, i) => {
    samples[k] = results[i];
  });
  return samples;
}

/** The first and last recorded sample times in the window, or null when the recording rules have not produced data. */
export async function fetchCoverage(range: Range): Promise<{ first: number; last: number } | null> {
  const q = recordedCoverageQueries(range);
  const [first, last] = await Promise.all([queryMetrics(q.first), queryMetrics(q.last)]);
  return recordedSpan(first, last);
}

/** Recorded series (7d, 30d): one query per key over the hourly rules, after finding what the rules cover. */
export async function fetchRecorded(range: Range, labelKey?: string): Promise<UsageData> {
  const cov = await fetchCoverage(range);
  if (!cov) {
    return { rows: [], labelSource: null, coverage: null, recordedMissing: true };
  }
  const coverage = coverageFor(cov.first, cov.last, Date.now() / 1000, rangeSeconds(range));
  const name = labelKey ? labelNameFor(labelKey) : undefined;
  const results = await Promise.all(QUERY_KEYS.map(k => queryMetrics(recordedQuery(range, k, coverage.coveredSeconds, name))));
  const samples: MeasureSamples = {};
  QUERY_KEYS.forEach((k, i) => {
    samples[k] = results[i];
  });
  return { rows: buildAggregatedRows(samples, name), labelSource: name ? 'server' : null, coverage, recordedMissing: false };
}

async function queryLive(range: Range): Promise<{ live: MeasureSamples; owners: MetricSample[] }> {
  const q = buildQueries(range);
  const results = await Promise.all(MEASURES.map(m => queryMetrics(q.live[m])));
  const live: MeasureSamples = {};
  MEASURES.forEach((m, i) => {
    live[m] = results[i];
  });
  return { live, owners: await queryMetrics(q.liveOwners) };
}

/** Runs only the queries the plan needs. */
export async function fetchUsage(range: Range, plan: FetchPlan): Promise<UsageData> {
  if (isRecordedRange(range)) {
    return fetchRecorded(range, plan.labelKey);
  }
  if (plan.live) {
    // Single pods that exist now (restricted with kube_pod_info); ended pods are not shown.
    const { live, owners } = await queryLive(range);
    return { rows: buildLiveRows(live, owners), labelSource: plan.labelKey ? 'client' : null };
  }
  if (plan.labelKey) {
    const present = (await queryMetrics(LABELS_PRESENT_QUERY).catch((): MetricSample[] => [])).length > 0;
    const name = labelNameFor(plan.labelKey);
    if (present) {
      return { rows: buildAggregatedRows(await fetchAggregated(range, name, QUERY_KEYS), name), labelSource: 'server' };
    }
    // No kube_pod_labels: labels of live pods only, everything else under its workload.
    const [agg, { live, owners }] = await Promise.all([fetchAggregated(range, undefined, QUERY_KEYS), queryLive(range)]);
    return { rows: withEndedRemainder(buildLiveRows(live, owners), buildAggregatedRows(agg)), labelSource: 'client' };
  }
  return { rows: buildAggregatedRows(await fetchAggregated(range, undefined, QUERY_KEYS)), labelSource: null };
}

export interface UsageResult {
  loading: boolean;
  error: string | null;
  rows: UsageRow[];
  labelSource: UsageData['labelSource'];
  /** When the shown data was fetched. */
  updatedAt: Date | null;
  /** Recorded ranges: what the recorded data covers. */
  coverage: Coverage | null;
  /** Recorded ranges: the recording rules have produced nothing yet. */
  recordedMissing: boolean;
}

interface Loaded {
  requestKey: string;
  data: UsageData;
  error: string | null;
  at: Date;
}

export function useUsage(range: Range, plan: FetchPlan, enabled = true): UsageResult {
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const requestKey = `${range}|${plan.live}|${plan.labelKey ?? ''}`;

  // External sync: fetch now and then on the range's refresh interval.
  React.useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let cancelled = false;
    const load = () =>
      fetchUsage(range, { live: plan.live, labelKey: plan.labelKey }).then(
        data => !cancelled && setLoaded({ requestKey, data, error: null, at: new Date() }),
        (err: Error) =>
          !cancelled &&
          // Keep the last-known-good data for the same request on a failed refresh.
          setLoaded(prev => ({
            requestKey,
            data: prev?.requestKey === requestKey ? prev.data : { rows: [], labelSource: null },
            error: err.message || 'Failed to query metrics service',
            at: prev?.requestKey === requestKey ? prev.at : new Date(),
          }))
      );
    load();
    const timer = setInterval(load, refreshIntervalMs(range));
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [requestKey, range, plan.live, plan.labelKey, enabled]);

  // The previous data stays on screen while a refresh of the same request runs.
  const current = loaded?.requestKey === requestKey ? loaded : null;
  return {
    loading: enabled && current === null,
    error: current?.error ?? null,
    rows: current?.data.rows ?? [],
    labelSource: current?.data.labelSource ?? null,
    updatedAt: current?.at ?? null,
    coverage: current?.data.coverage ?? null,
    recordedMissing: current?.data.recordedMissing ?? false,
  };
}

/** The label_* names exported on kube_pod_labels (empty when it is not exported). */
export function useMetricLabelNames(): string[] {
  const [names, setNames] = React.useState<string[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    queryMetrics(LABEL_NAMES_QUERY).then(
      samples => !cancelled && setNames([...new Set(samples.flatMap(s => Object.keys(s.metric)).filter(k => k.startsWith('label_')))]),
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return names;
}

export interface ClusterMeta {
  loading: boolean;
  error: string | null;
  pods: PodMeta[];
  services: ServiceMeta[];
}

/** Live Pods and Services through Headlamp's Kubernetes API (needs list on both). */
export function useClusterMeta(): ClusterMeta {
  const [podItems, podErr] = (K8s.ResourceClasses as any).Pod.useList();
  const [svcItems, svcErr] = (K8s.ResourceClasses as any).Service.useList();

  const pods = React.useMemo<PodMeta[]>(
    () =>
      (podItems ?? []).map((p: any) => ({
        namespace: p.jsonData?.metadata?.namespace ?? '',
        name: p.jsonData?.metadata?.name ?? '',
        labels: p.jsonData?.metadata?.labels ?? {},
      })),
    [podItems]
  );
  const services = React.useMemo<ServiceMeta[]>(
    () =>
      (svcItems ?? []).map((s: any) => ({
        namespace: s.jsonData?.metadata?.namespace ?? '',
        name: s.jsonData?.metadata?.name ?? '',
        selector: s.jsonData?.spec?.selector ?? {},
      })),
    [svcItems]
  );
  const err = podErr || svcErr;
  return {
    loading: (podItems === null || svcItems === null) && !err,
    error: err ? String((err as any).message ?? err) : null,
    pods,
    services,
  };
}
