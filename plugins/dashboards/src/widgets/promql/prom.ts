/* The Prometheus HTTP API calls (instant and range queries) through the API service proxy. */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import type { DashboardFilters } from '../../contract';
import type { MetricsEndpoint } from './endpoint';
import { assertSuccess, PromEnvelope } from './mapping';
import { chooseStep, rangeSeconds } from './step';
import { buildVars, substitute } from './template';

export interface QueryResult {
  resultType: string;
  result: unknown;
}

/** What a caller needs to run: the endpoint, a signal to abort and the transport (a test passes a fake). */
export interface RunOptions {
  endpoint: MetricsEndpoint;
  signal?: AbortSignal;
  request?: (
    path: string,
    params: { method: string; isJSON: boolean; signal?: AbortSignal }
  ) => Promise<any>;
}

export function apiBase(endpoint: MetricsEndpoint): string {
  return `/api/v1/namespaces/${endpoint.namespace}/services/${endpoint.service}:${endpoint.port}/proxy${endpoint.pathPrefix}/api/v1`;
}

export function queryUrl(
  endpoint: MetricsEndpoint,
  kind: 'query' | 'query_range',
  params: Record<string, string>
): string {
  return `${apiBase(endpoint)}/${kind}?${new URLSearchParams(params).toString()}`;
}

async function run(url: string, opts: RunOptions): Promise<QueryResult> {
  const request = opts.request ?? ((p, o) => ApiProxy.request(p, o));
  const response = await request(url, { method: 'GET', isJSON: false, signal: opts.signal });
  if (!response || typeof response.json !== 'function')
    throw new Error('The metrics service sent an unreadable answer.');
  let body: PromEnvelope | undefined;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const detail = body?.error ? `: ${body.error}` : '';
    throw new Error(`The metrics service answered HTTP ${response.status}${detail}`);
  }
  assertSuccess(body);
  return { resultType: body.data?.resultType ?? '', result: body.data?.result ?? [] };
}

export interface TimeWindow {
  /** Epoch seconds. */
  start: number;
  end: number;
  step: number;
}

export function windowFor(filters: DashboardFilters, widthPx: number, nowMs: number): TimeWindow {
  const span = rangeSeconds(filters.range);
  const step = chooseStep(span, widthPx);
  // End on a step boundary, so the points line up from one refresh to the next.
  const end = Math.floor(nowMs / 1000 / step) * step;
  return { start: end - span, end, step };
}

export function runRange(
  expr: string,
  filters: DashboardFilters,
  win: TimeWindow,
  opts: RunOptions
): Promise<QueryResult> {
  const query = substitute(expr, buildVars(filters, win.step));
  return run(
    queryUrl(opts.endpoint, 'query_range', {
      query,
      start: String(win.start),
      end: String(win.end),
      step: String(win.step),
    }),
    opts
  );
}

export function runInstant(
  expr: string,
  filters: DashboardFilters,
  nowMs: number,
  opts: RunOptions
): Promise<QueryResult> {
  // An instant query has no chart, so the step variable follows the range as for a 600 px chart.
  const step = chooseStep(rangeSeconds(filters.range), 600);
  const query = substitute(expr, buildVars(filters, step));
  return run(
    queryUrl(opts.endpoint, 'query', { query, time: String(Math.floor(nowMs / 1000)) }),
    opts
  );
}
