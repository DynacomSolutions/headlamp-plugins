/*
 * The Usage dashboard as a dashboard widget (`usage.dashboard-rings`): the same CPU and memory
 * sunbursts as the Usage > Dashboard page, drawn by the same code (NodeView, useNodeTrees,
 * useNodesData). The page keeps its view in the URL. The widget keeps it in local state and never
 * touches the URL: zoom path, selected arc, node and category filters and the ring count.
 * It fills the widget (side by side, or stacked when narrow), fetches once and then only when the
 * dashboard refresh signal changes, and never on a layout drag. In the kiosk it uses the kiosk
 * look (black surfaces, touch filters, no hover) and, as the page does, returns to the overview
 * after the idle time.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { ThemeProvider } from '@mui/material/styles';
import React from 'react';
import { useNodesSettings } from '../settings';
import { Filters } from './Filters';
import { kioskQuietSx, useKioskTheme } from './Kiosk';
import { DEFAULT_RINGS, MAX_RINGS, MIN_RINGS } from './nodesUrl';
import { NodeView } from './NodeView';
import { useIdle } from './useIdle';
import { NodesData, useNodesData } from './useNodesData';
import { useNodeTrees } from './useNodeTrees';

/** The widget settings. */
export interface UsageRingsConfig {
  /** Rings drawn in both charts at the start, 2 to 6. The ring toggle in the widget changes it. */
  rings: number;
  /** Show the node and category filters in the top bar. */
  filters: boolean;
}

export const DEFAULT_RINGS_CONFIG: UsageRingsConfig = { rings: DEFAULT_RINGS, filters: true };

/** A usable ring count: a whole number from 2 to 6, the default for anything else. */
export function ringsOf(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) ? Math.min(MAX_RINGS, Math.max(MIN_RINGS, n)) : DEFAULT_RINGS;
}

interface ViewProps {
  data: NodesData;
  config: UsageRingsConfig;
  kiosk: boolean;
}

/** The view state is local. A new initial ring count (a settings change) restarts it, via `key`. */
function RingsView({ data, config, kiosk }: ViewProps): JSX.Element {
  const settings = useNodesSettings();
  const [nodes, setNodes] = React.useState<string[]>([]);
  const [cats, setCats] = React.useState<string[]>([]);
  const [path, setPath] = React.useState<string[]>([]);
  const [sel, setSel] = React.useState<string[]>([]);
  const [rings, setRings] = React.useState(ringsOf(config.rings));
  const { cpu, mem, alerts } = useNodeTrees(data, nodes, cats);
  // A filter change resets the zoom: its keys may not exist in the new selection.
  const reset = React.useCallback(() => {
    setPath([]);
    setSel([]);
  }, []);
  useIdle(kiosk && (path.length > 0 || sel.length > 0), settings.idleSeconds, reset);
  const toolbar = config.filters ? (
    <Filters
      nodeOptions={data.metrics.map(m => m.node)}
      nodes={nodes}
      cats={cats}
      onNodes={n => {
        setNodes(n);
        reset();
      }}
      onCats={c => {
        setCats(c);
        reset();
      }}
      touch={kiosk}
    />
  ) : undefined;
  return (
    <NodeView
      cpu={cpu}
      mem={mem}
      alerts={alerts}
      path={path}
      sel={sel}
      onSelect={setSel}
      kiosk={kiosk}
      fit
      widget
      rings={rings}
      onRings={setRings}
      // A zoom change clears the selection, as it does on the page.
      onPath={p => {
        setPath(p);
        setSel([]);
      }}
      toolbar={toolbar}
    />
  );
}

export function UsageRings(props: {
  config: UsageRingsConfig;
  refreshSignal: number;
  reportRefreshed: (at?: number) => void;
  kiosk: boolean;
}): JSX.Element {
  const { config, refreshSignal, reportRefreshed, kiosk } = props;
  const manual = React.useMemo(
    () => ({ signal: refreshSignal, onLoaded: reportRefreshed }),
    [refreshSignal, reportRefreshed]
  );
  const data = useNodesData(manual);
  const kioskTheme = useKioskTheme();

  let body: React.ReactNode;
  if (data.loading) {
    body = (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
        <CircularProgress size={24} aria-label="Loading usage" />
      </Box>
    );
  } else if (data.metrics.length === 0) {
    body = data.metricsError ? (
      <Alert severity="error">Could not query the metrics service: {data.metricsError}</Alert>
    ) : (
      <Alert severity="info">
        No node metrics found. Check that node-exporter and cAdvisor metrics are scraped by the
        metrics service.
      </Alert>
    );
  } else {
    body = (
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
        <RingsView key={ringsOf(config.rings)} data={data} config={config} kiosk={kiosk} />
      </>
    );
  }

  const box = (
    <Box
      data-usage-rings
      sx={{
        height: '100%',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        // A widget smaller than its content scrolls. In the kiosk it scrolls by touch, with no scrollbar.
        overflowY: 'auto',
        ...(kiosk
          ? { scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' }, ...kioskQuietSx }
          : {}),
      }}
    >
      {body}
    </Box>
  );
  return kiosk ? <ThemeProvider theme={kioskTheme}>{box}</ThemeProvider> : box;
}
