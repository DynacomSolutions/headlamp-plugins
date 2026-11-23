/*
 * Prometheus HTTP API (instant queries) against a Prometheus-compatible Service (VictoriaMetrics,
 * Prometheus, ...) through the Kubernetes API server's Service proxy, so the browser needs no extra
 * credential: the request carries the same Kubernetes identity as the rest of Headlamp and needs `get`
 * on `services/proxy` for that one Service.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';

export interface MetricSample {
  metric: Record<string, string>;
  value: [number, string];
}

export interface MetricsTarget {
  namespace: string;
  service: string;
  port: string;
}

/** The proxy path of an instant query. */
export function queryUrl(target: MetricsTarget, promql: string): string {
  return (
    `/api/v1/namespaces/${encodeURIComponent(target.namespace)}/services/${encodeURIComponent(target.service)}:${encodeURIComponent(target.port)}` +
    `/proxy/api/v1/query?${new URLSearchParams({ query: promql }).toString()}`
  );
}

export async function queryMetrics(target: MetricsTarget, promql: string): Promise<MetricSample[]> {
  const response = await ApiProxy.request(queryUrl(target, promql), { method: 'GET', isJSON: false });
  if (!response.ok) {
    throw new Error(`Metrics service returned HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body.status !== 'success') {
    throw new Error(body.error || 'Metrics query failed');
  }
  return body.data?.result ?? [];
}
