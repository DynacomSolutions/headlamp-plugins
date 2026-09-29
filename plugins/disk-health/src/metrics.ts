/*
 * Shared helper for querying a Prometheus-compatible metrics service
 * (VictoriaMetrics, Prometheus, ...) through the Kubernetes API server's
 * Service proxy. Used by both the per-node SMART section and the
 * cluster-wide disk pages, so the query path lives in one place.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';

// A Prometheus-compatible Service. Adjust these defaults to match your
// cluster. Only the plain Prometheus HTTP API (instant `/api/v1/query`) is
// used.
export const VM_NAMESPACE = 'monitoring';
export const VM_SERVICE = 'victoria-metrics';
export const VM_PORT = '8428';

/** One label/value sample as returned by the Prometheus HTTP API. */
export interface MetricSample {
  metric: Record<string, string>;
  value: [number, string];
}

/**
 * Runs a single PromQL instant query against the metrics service through the
 * Kubernetes API server's Service proxy - the same
 * /api/v1/namespaces/<ns>/services/<name>:<port>/proxy/... path the
 * bundled Prometheus plugin uses for its own Service-backed queries.
 */
export async function queryMetrics(promql: string): Promise<MetricSample[]> {
  const params = new URLSearchParams({ query: promql });
  const url =
    `/api/v1/namespaces/${VM_NAMESPACE}/services/${VM_SERVICE}:${VM_PORT}` +
    `/proxy/api/v1/query?${params.toString()}`;

  const response = await ApiProxy.request(url, { method: 'GET', isJSON: false });
  if (!response.ok) {
    throw new Error(`Metrics service returned HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body.status !== 'success') {
    throw new Error(body.error || 'Metrics query failed');
  }
  return body.data?.result ?? [];
}

/** Reads the scalar value out of an instant-query sample, or undefined. */
export function numberFromValue(sample: MetricSample | undefined): number | undefined {
  const raw = sample?.value?.[1];
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}
