/*
 * Polls VictoriaMetrics and the agent-memory backends every 10 s. A failed metrics refresh keeps
 * the last data and marks it stale. A failing agent backend keeps its node's last good agent data
 * on screen, marked with its time, for up to MAX_AGENT_FAILURES failed polls in a row; its error
 * is shown on the node it served last time (or page-wide if it never answered).
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
  /** Nodes whose agent data is from an earlier poll, with the time (ms) it was received. */
  agentsAsOf: Map<string, number>;
  /** The last metrics error, or null when the last refresh worked. */
  metricsError: string | null;
  /** The last refresh failed and older data is on screen. */
  stale: boolean;
  /** No metrics result (success or failure) has arrived yet. */
  loading: boolean;
}

/** Failed polls in a row after which a backend's last good agent data is dropped. */
export const MAX_AGENT_FAILURES = 3;

/** What the agent merge remembers between polls. */
export interface AgentMemory {
  /** The node each backend served last time. */
  backendNodes: Map<string, string>;
  /** The last good host of each backend and when it arrived. */
  last: Map<string, { host: AgentHost; at: number }>;
  /** Failed polls in a row per backend. */
  failures: Map<string, number>;
}

export const emptyAgentMemory = (): AgentMemory => ({
  backendNodes: new Map(),
  last: new Map(),
  failures: new Map(),
});

export function mergeAgents(
  memory: AgentMemory,
  result: Awaited<ReturnType<typeof fetchAgentHosts>>,
  now: number
): {
  agents: Map<string, AgentHost>;
  agentsAsOf: Map<string, number>;
  nodeErrors: Map<string, string>;
  errors: string[];
  memory: AgentMemory;
} {
  const next: AgentMemory = {
    backendNodes: new Map(memory.backendNodes),
    last: new Map(memory.last),
    failures: new Map(memory.failures),
  };
  const agents = new Map<string, AgentHost>();
  const agentsAsOf = new Map<string, number>();
  for (const h of result.hosts) {
    next.failures.delete(h.backend);
    if (!h.node) continue;
    agents.set(h.node, h);
    next.backendNodes.set(h.backend, h.node);
    next.last.set(h.backend, { host: h, at: now });
  }
  const nodeErrors = new Map<string, string>();
  const errors: string[] = [];
  for (const e of result.errors) {
    const msg = `${e.backend}: ${e.message}`;
    const failures = (next.failures.get(e.backend) ?? 0) + 1;
    next.failures.set(e.backend, failures);
    const last = next.last.get(e.backend);
    if (last && failures < MAX_AGENT_FAILURES) {
      if (!agents.has(last.host.node)) {
        agents.set(last.host.node, last.host);
        agentsAsOf.set(last.host.node, last.at);
      }
    } else {
      next.last.delete(e.backend);
    }
    const node = next.backendNodes.get(e.backend);
    if (node) nodeErrors.set(node, msg);
    else errors.push(msg);
  }
  return { agents, agentsAsOf, nodeErrors, errors, memory: next };
}

const message = (e: unknown) => String((e as Error)?.message ?? e) || 'Request failed';

export function useNodesData(): NodesData {
  const backends = useNodesSettings().agentBackends;
  const [data, setData] = React.useState<NodesData>({
    metrics: [],
    agents: new Map(),
    errors: [],
    nodeErrors: new Map(),
    agentsAsOf: new Map(),
    metricsError: null,
    stale: false,
    loading: true,
  });
  const memory = React.useRef(emptyAgentMemory());
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
        // fetchAgentHosts settles every backend itself; a throw counts as all of them failing.
        const agentHosts =
          agentResult.status === 'fulfilled'
            ? agentResult.value
            : {
                hosts: [],
                errors: list.map(backend => ({ backend, message: message(agentResult.reason) })),
              };
        const merged = mergeAgents(memory.current, agentHosts, Date.now());
        memory.current = merged.memory;
        setData(prev => {
          const ok = metrics.status === 'fulfilled';
          const kept = ok ? metrics.value : prev.metrics;
          return {
            metrics: kept,
            agents: merged.agents,
            errors: merged.errors,
            nodeErrors: merged.nodeErrors,
            agentsAsOf: merged.agentsAsOf,
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
