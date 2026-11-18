/*
 * The Nodes page (/usage/nodes), for a server-cabinet touch screen: an overview of every node as
 * a card with compact CPU and memory sunbursts, and one node full screen (?node=&path=). The URL
 * holds the whole view and is replaced, not pushed, as /usage does. With no touch for the idle
 * time the page goes back to the overview.
 */
import { Loader, SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { useNodesSettings } from '../settings';
import { formatPercent } from '../units';
import type { AgentHost } from './agents';
import { NodesUrlState, parseNodesUrl, serialiseNodesUrl } from './nodesUrl';
import { agentAlertText, buildTrees, NO_HOST_METRICS, NodeView, usedText } from './NodeView';
import { Sunburst } from './Sunburst';
import { NodeTree, Resource } from './tree';
import type { NodeMetrics } from './types';
import { useIdle } from './useIdle';
import { useNodesData } from './useNodesData';

const CARD_CHART = 140;

function FullscreenButton() {
  const [on, setOn] = React.useState(() => !!document.fullscreenElement);
  React.useEffect(() => {
    const update = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  if (!document.documentElement.requestFullscreen) return null;
  const toggle = () => {
    const p = on ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    p.catch(() => undefined);
  };
  return (
    <Button variant="outlined" onClick={toggle} sx={{ minHeight: 48, fontSize: 16 }}>
      {on ? 'Exit full screen' : 'Full screen'}
    </Button>
  );
}

function share(tree: NodeTree): string {
  return tree.used === null ? 'n/a' : formatPercent(tree.used, tree.capacity);
}

function NodeCard(props: {
  metrics: NodeMetrics;
  host: AgentHost | null;
  error?: string;
  asOf?: number;
  onOpen: () => void;
}) {
  const { metrics, host, error, asOf, onOpen } = props;
  const trees = React.useMemo(() => buildTrees(metrics, host), [metrics, host]);
  const chart = (resource: Resource, tree: NodeTree) => (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0 }}>
      <Sunburst tree={tree} resource={resource} focus={[]} size={CARD_CHART} compact />
      <Typography variant="body1" sx={{ fontWeight: 600, mt: 0.5 }}>
        {resource === 'cpu' ? 'CPU' : 'Memory'} {share(tree)}
      </Typography>
      <Typography variant="body2" color="text.secondary" align="center">
        {usedText(tree, resource)}
      </Typography>
    </Box>
  );
  return (
    <Card variant="outlined">
      <CardActionArea onClick={onOpen} aria-label={`Open node ${metrics.node}`} sx={{ p: 2 }}>
        <Typography variant="h6" component="h2" sx={{ mb: 1, overflowWrap: 'anywhere' }}>
          {metrics.node}
        </Typography>
        <Box sx={{ display: 'flex', justifyContent: 'space-around', gap: 2, flexWrap: 'wrap' }}>
          {chart('cpu', trees.cpu)}
          {chart('memory', trees.mem)}
        </Box>
        {!(trees.cpu.hostMetrics && trees.mem.hostMetrics) && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {NO_HOST_METRICS}
          </Typography>
        )}
      </CardActionArea>
      {error && (
        <Alert severity="warning" sx={{ m: 2, mt: 0 }}>
          {agentAlertText(error, asOf)}
        </Alert>
      )}
    </Card>
  );
}

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
  const overview = React.useCallback(() => go({ node: null, path: [] }), [go]);
  useIdle(state.node !== null, settings.idleSeconds, overview);

  let body: React.ReactNode;
  if (data.loading) {
    body = <Loader title="Loading nodes" />;
  } else if (data.metrics.length === 0 && data.metricsError) {
    body = <Alert severity="error">Could not query the metrics service: {data.metricsError}</Alert>;
  } else if (data.metrics.length === 0) {
    body = (
      <Alert severity="info">
        No node metrics found. Check that node-exporter and cAdvisor metrics are scraped by the
        metrics service.
      </Alert>
    );
  } else if (state.node !== null) {
    const m = data.metrics.find(x => x.node === state.node);
    body = m ? (
      <NodeView
        metrics={m}
        host={data.agents.get(m.node) ?? null}
        agentError={data.nodeErrors.get(m.node)}
        agentAsOf={data.agentsAsOf.get(m.node)}
        path={state.path}
        onPath={path => go({ node: m.node, path })}
        onOverview={overview}
      />
    ) : (
      <Alert
        severity="info"
        action={
          <Button onClick={overview} sx={{ minHeight: 48 }}>
            All nodes
          </Button>
        }
      >
        Node {state.node} has no metrics.
      </Alert>
    );
  } else {
    body = (
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
          gap: 2,
        }}
      >
        {data.metrics.map(m => (
          <NodeCard
            key={m.node}
            metrics={m}
            host={data.agents.get(m.node) ?? null}
            error={data.nodeErrors.get(m.node)}
            asOf={data.agentsAsOf.get(m.node)}
            onOpen={() => go({ node: m.node, path: [] })}
          />
        ))}
      </Box>
    );
  }

  return (
    <SectionBox title="Nodes" headerProps={{ actions: [<FullscreenButton key="fullscreen" />] }}>
      {data.stale && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Refresh failed, showing the last data received: {data.metricsError}
        </Alert>
      )}
      {data.errors.map((e, i) => (
        <Alert key={`${i}:${e}`} severity="warning" sx={{ mb: 2 }}>
          Agent backend unavailable: {e}
        </Alert>
      ))}
      {body}
    </SectionBox>
  );
}
