/*
 * Polls VictoriaMetrics and the agent-memory backends every 10 s. A failed metrics refresh keeps
 * the last data and marks it stale; a failing agent backend only loses that node's agent detail,
 * and its error is shown on the node it served last time (or page-wide if it never answered).
 */
import React from 'react';
import { useNodesSettings } from '../settings';
import { AgentHost, fetchAgentHosts } from './agents';
import { fetchNodeMetrics } from './queries';
import type { NodeMetrics } from './types';

export const REFRESH_MS = 10_000;

export interface NodesData {
  metrics: NodeMetrics[];
  /** Agent hosts by node name. */
  agents: Map<string, AgentHost>;
  /** Errors that belong to no known node (an agent backend that never answered). */
  errors: string[];
  /** Agent backend errors by the node the backend served last time. */
  nodeErrors: Map<string, string>;
  /** The last metrics error, or null when the last refresh worked. */
  metricsError: string | null;
  /** The last refresh failed and older data is on screen. */
  stale: boolean;
  /** No metrics result (success or failure) has arrived yet. */
  loading: boolean;
}

export function mergeAgents(
  backendNodes: Map<string, string>,
  result: Awaited<ReturnType<typeof fetchAgentHosts>>
): {
  agents: Map<string, AgentHost>;
  backendNodes: Map<string, string>;
  nodeErrors: Map<string, string>;
  errors: string[];
} {
  const known = new Map(backendNodes);
  const agents = new Map<string, AgentHost>();
  for (const h of result.hosts) {
    if (!h.node) continue;
    agents.set(h.node, h);
    known.set(h.backend, h.node);
  }
  const nodeErrors = new Map<string, string>();
  const errors: string[] = [];
  for (const e of result.errors) {
    const msg = `${e.backend}: ${e.message}`;
    const node = known.get(e.backend);
    if (node) nodeErrors.set(node, msg);
    else errors.push(msg);
  }
  return { agents, backendNodes: known, nodeErrors, errors };
}

const message = (e: unknown) => String((e as Error)?.message ?? e) || 'Request failed';

export function useNodesData(): NodesData {
  const backends = useNodesSettings().agentBackends;
  const [data, setData] = React.useState<NodesData>({
    metrics: [],
    agents: new Map(),
    errors: [],
    nodeErrors: new Map(),
    metricsError: null,
    stale: false,
    loading: true,
  });
  const backendNodes = React.useRef(new Map<string, string>());
  const key = backends.join(',');

  React.useEffect(() => {
    let cancelled = false;
    let busy = false;
    const list = key ? key.split(',') : [];
    const load = async () => {
      // A slow round is not overlapped by the next tick.
      if (busy) return;
      busy = true;
      try {
        const [metrics, agentResult] = await Promise.allSettled([
          fetchNodeMetrics(),
          fetchAgentHosts(list),
        ]);
        if (cancelled) return;
        const merged =
          agentResult.status === 'fulfilled'
            ? mergeAgents(backendNodes.current, agentResult.value)
            : {
                agents: new Map<string, AgentHost>(),
                backendNodes: backendNodes.current,
                nodeErrors: new Map<string, string>(),
                errors: [message(agentResult.reason)],
              };
        backendNodes.current = merged.backendNodes;
        setData(prev => {
          const ok = metrics.status === 'fulfilled';
          const kept = ok ? metrics.value : prev.metrics;
          return {
            metrics: kept,
            agents: merged.agents,
            errors: merged.errors,
            nodeErrors: merged.nodeErrors,
            metricsError: ok ? null : message(metrics.reason),
            stale: !ok && kept.length > 0,
            loading: false,
          };
        });
      } finally {
        busy = false;
      }
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key]);

  return data;
}
