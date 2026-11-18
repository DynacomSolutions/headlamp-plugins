/*
 * The Usage dashboard (/usage/dashboard), for a server-cabinet touch screen: one big CPU sunburst
 * and one big memory sunburst, with filters on top for the nodes and categories. With more than
 * one node selected the first ring is one arc per node. Tap an arc to select it in both charts, and Open to zoom. The URL
 * holds the whole view (filters, zoom path, selection, kiosk) and is replaced, not pushed, as /usage does.
 * With no touch for the idle time the zoom goes back to the root, keeping filters and kiosk.
 */
import { Loader, SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import React from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { useNodesSettings } from '../settings';
import { iconUrl } from './agents';
import { Filters } from './Filters';
import { enterBrowserFullscreen, KioskOverlay } from './Kiosk';
import { NameContext, useNamespaceNames } from './names';
import { NodesUrlState, parseNodesUrl, serialiseNodesUrl } from './nodesUrl';
import { agentAlertText, NodeView } from './NodeView';
import { buildCombinedTree } from './tree';
import { useIdle } from './useIdle';
import { useNodesData } from './useNodesData';

export function NodesPage(): JSX.Element {
  const history = useHistory();
  const location = useLocation();
  const settings = useNodesSettings();
  const state = React.useMemo(() => parseNodesUrl(location.search), [location.search]);
  const data = useNodesData();

  const go = React.useCallback(
    (s: NodesUrlState) =>
      history.replace({ pathname: location.pathname, search: serialiseNodesUrl(s) }),
    [history, location.pathname]
  );
  // A filter change resets the zoom: its keys may not exist in the new selection.
  const setNodes = (nodes: string[]) => go({ ...state, nodes, path: [], sel: [] });
  const setCats = (cats: string[]) => go({ ...state, cats, path: [], sel: [] });
  const setPath = (path: string[]) => go({ ...state, path, sel: [] });
  const setSel = (sel: string[]) => go({ ...state, sel });
  const setKiosk = (kiosk: boolean) => go({ ...state, kiosk });
  const resetZoom = React.useCallback(() => go({ ...state, path: [], sel: [] }), [go, state]);
  useIdle(state.path.length > 0 || state.sel.length > 0, settings.idleSeconds, resetZoom);

  // The selection: the chosen nodes that have metrics; none chosen (or none left) means all.
  const selected = React.useMemo(() => {
    const picked = data.metrics.filter(m => state.nodes.includes(m.node));
    return picked.length ? picked : data.metrics;
  }, [data.metrics, state.nodes]);
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
      cpu: buildCombinedTree(selected, hostOf, 'cpu', src, state.cats, names),
      mem: buildCombinedTree(selected, hostOf, 'memory', src, state.cats, names),
    };
  }, [selected, data.agents, state.cats, names]);
  const alerts = selected
    .filter(m => data.nodeErrors.has(m.node))
    .map(m => `${m.node}: ${agentAlertText(data.nodeErrors.get(m.node) ?? '', data.agentsAsOf.get(m.node))}`);

  const filters = (
    <Filters
      nodeOptions={data.metrics.map(m => m.node)}
      nodes={state.nodes}
      cats={state.cats}
      onNodes={setNodes}
      onCats={setCats}
    />
  );
  const enter = () => {
    enterBrowserFullscreen();
    setKiosk(true);
  };
  const fullScreen = (
    <Button variant="outlined" onClick={enter} sx={{ minHeight: 48, fontSize: 16 }}>
      Full screen
    </Button>
  );
  const banners = (
    <>
      {data.stale && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          Refresh failed, showing the last data received: {data.metricsError}
        </Alert>
      )}
      {data.errors.map((e, i) => (
        <Alert key={`${i}:${e}`} severity="warning" sx={{ mb: 1 }}>
          Agent backend unavailable: {e}
        </Alert>
      ))}
    </>
  );

  // The top bar (filters, breadcrumb, Up, Open and the full screen control) belongs to the
  // charts view. Without charts (loading, an error) the filters and the full screen control
  // still show, in a bar of their own.
  const render = (trailing: React.ReactNode) => {
    if (data.loading || data.metrics.length === 0) {
      let message: React.ReactNode;
      if (data.loading) message = <Loader title="Loading nodes" />;
      else if (data.metricsError)
        message = <Alert severity="error">Could not query the metrics service: {data.metricsError}</Alert>;
      else
        message = (
          <Alert severity="info">
            No node metrics found. Check that node-exporter and cAdvisor metrics are scraped by the
            metrics service.
          </Alert>
        );
      return (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2, mb: 1 }}>
            {filters}
            {trailing}
          </Box>
          {banners}
          {message}
        </>
      );
    }
    return (
      <>
        {banners}
        <NodeView
          cpu={trees.cpu}
          mem={trees.mem}
          alerts={alerts}
          path={state.path}
          sel={state.sel}
          onSelect={setSel}
          kiosk={state.kiosk}
          onPath={setPath}
          toolbar={filters}
          trailing={trailing}
        />
      </>
    );
  };

  if (state.kiosk) {
    return <KioskOverlay onExit={() => setKiosk(false)}>{exit => render(exit)}</KioskOverlay>;
  }
  return <SectionBox title="Usage dashboard">{render(fullScreen)}</SectionBox>;
}
