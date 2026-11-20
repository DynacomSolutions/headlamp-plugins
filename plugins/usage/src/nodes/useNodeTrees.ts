/*
 * The two sunburst trees (CPU and memory) of the Usage dashboard and the agent alerts, from the
 * polled node data and the node and category filters. The page and the dashboard widget share it,
 * so both draw the same data.
 */
import React from 'react';
import { useNodesSettings } from '../settings';
import { iconUrl } from './agents';
import type { NameContext } from './names';
import { agentAlertText } from './NodeView';
import { buildCombinedTree, NodeTree } from './tree';
import { useNamespaceNames } from './useNamespaceNames';
import type { NodesData } from './useNodesData';

export function useNodeTrees(
  data: NodesData,
  nodes: string[],
  cats: string[]
): { cpu: NodeTree; mem: NodeTree; alerts: string[] } {
  const settings = useNodesSettings();
  // The selection: the chosen nodes that have metrics; none chosen (or none left) means all.
  const selected = React.useMemo(() => {
    const picked = data.metrics.filter(m => nodes.includes(m.node));
    return picked.length ? picked : data.metrics;
  }, [data.metrics, nodes]);
  const nsNames = useNamespaceNames();
  const names = React.useMemo<NameContext>(
    () => ({ overrides: settings.displayNames, namespaces: nsNames }),
    [settings.displayNames, nsNames]
  );
  const trees = React.useMemo(() => {
    const hostOf = (n: string) => data.agents.get(n) ?? null;
    const src = (n: string, id: string) => {
      const h = hostOf(n);
      return h ? iconUrl(h.backend, id) : '';
    };
    return {
      cpu: buildCombinedTree(selected, hostOf, 'cpu', src, cats, names),
      mem: buildCombinedTree(selected, hostOf, 'memory', src, cats, names),
    };
  }, [selected, data.agents, cats, names]);
  const alerts = selected
    .filter(m => data.nodeErrors.has(m.node))
    .map(
      m =>
        `${m.node}: ${agentAlertText(
          data.nodeErrors.get(m.node) ?? '',
          data.agentsAsOf.get(m.node)
        )}`
    );
  return { ...trees, alerts };
}
