import { MetricSample, queryMetrics } from '../metrics';
import { assembleNodeMetrics, NODE_QUERIES, QueryKey } from './nodeMetrics';
import type { NodeMetrics } from './types';

export { NODE_QUERIES, assembleNodeMetrics } from './nodeMetrics';
export type { QueryKey } from './nodeMetrics';

export async function fetchNodeMetrics(): Promise<NodeMetrics[]> {
  const keys = Object.keys(NODE_QUERIES) as QueryKey[];
  const samples = await Promise.all(keys.map(key => queryMetrics(NODE_QUERIES[key])));
  const results = {} as Record<QueryKey, MetricSample[]>;
  keys.forEach((key, i) => {
    results[key] = samples[i];
  });
  return assembleNodeMetrics(results);
}
