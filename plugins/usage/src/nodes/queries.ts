import { MetricSample, queryMetrics } from '../metrics';
import { assembleNodeMetrics, nodeQueries, OPTIONAL_QUERIES, QueryKey } from './nodeMetrics';
import type { NodeMetrics } from './types';

export {
  NODE_QUERIES,
  OPTIONAL_QUERIES,
  assembleNodeMetrics,
  nodeQueries,
  runnerQueries,
} from './nodeMetrics';
export type { QueryKey } from './nodeMetrics';

/**
 * `poolPrefix` is the `runnerPoolPrefix` setting. With it blank, the two runner pool queries stay
 * empty and no request goes out for them.
 */
export async function fetchNodeMetrics(poolPrefix?: string): Promise<NodeMetrics[]> {
  const queries = nodeQueries(poolPrefix);
  const keys = Object.keys(queries) as QueryKey[];
  // Runner pool info is optional: a failed query (metric not live yet) counts as no data.
  const samples = await Promise.all(
    keys.map(key => {
      if (!queries[key]) return Promise.resolve<MetricSample[]>([]);
      return OPTIONAL_QUERIES.includes(key)
        ? queryMetrics(queries[key]).catch((): MetricSample[] => [])
        : queryMetrics(queries[key]);
    })
  );
  const results = {} as Record<QueryKey, MetricSample[]>;
  keys.forEach((key, i) => {
    results[key] = samples[i];
  });
  return assembleNodeMetrics(results, poolPrefix);
}
