/*
 * Prometheus HTTP API (instant and range queries) against a
 * Prometheus-compatible Service (VictoriaMetrics, Prometheus, ...) through the
 * Kubernetes API server's Service proxy, so the browser needs no extra
 * credential: the request carries the same Kubernetes identity as the rest of
 * Headlamp and needs `get` on `services/proxy` for that one Service.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';

// Adjust to match your cluster.
export const VM_NAMESPACE = 'monitoring';
export const VM_SERVICE = 'victoria-metrics';
export const VM_PORT = '8428';
// The scrape job that runs the blackbox_exporter probes.
export const PROBE_JOB = 'uptime';

export interface MetricSample {
  metric: Record<string, string>;
  value: [number, string];
}

export interface RangeSeries {
  metric: Record<string, string>;
  values: [number, string][];
}

async function call<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const url =
    `/api/v1/namespaces/${VM_NAMESPACE}/services/${VM_SERVICE}:${VM_PORT}` +
    `/proxy/api/v1/${path}?${new URLSearchParams(params).toString()}`;
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

export function queryMetrics(promql: string): Promise<MetricSample[]> {
  return call<MetricSample>('query', { query: promql });
}

export function queryRange(promql: string, startSec: number, endSec: number, stepSec: number): Promise<RangeSeries[]> {
  return call<RangeSeries>('query_range', {
    query: promql,
    start: String(startSec),
    end: String(endSec),
    step: String(stepSec),
  });
}
