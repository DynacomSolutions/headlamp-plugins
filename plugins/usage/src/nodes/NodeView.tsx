/*
 * One node full screen: the CPU and memory sunbursts side by side (stacked in portrait), sized
 * from the container, both zoomed to the same focus path, with a breadcrumb and a detail panel.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import React from 'react';
import { formatBytes, formatCores, formatPercent } from '../units';
import { AgentHost, iconUrl } from './agents';
import { detailFor } from './detail';
import { DetailPanel } from './DetailPanel';
import { Sunburst } from './Sunburst';
import { buildNodeTree, NodeTree, Resource } from './tree';
import type { NodeMetrics } from './types';

const GAP = 16;
const MIN_CHART = 200;
const MAX_CHART = 900;
const MIN_TWO_UP = 260;
const DETAIL_WIDTH = 380;
const DETAIL_BESIDE_FROM = 1100;
/** Room kept for the page header, breadcrumb and chart headings above a chart. */
const CHROME_HEIGHT = 220;

export function buildTrees(
  m: NodeMetrics,
  host: AgentHost | null
): { cpu: NodeTree; mem: NodeTree } {
  const src = (projectId: string) => (host ? iconUrl(host.backend, projectId) : '');
  return { cpu: buildNodeTree(m, host, 'cpu', src), mem: buildNodeTree(m, host, 'memory', src) };
}

export function usedText(tree: NodeTree, resource: Resource): string {
  const fmt = resource === 'cpu' ? formatCores : formatBytes;
  if (tree.used === null) return `${fmt(tree.root.value)} attributed of ${fmt(tree.capacity)}`;
  return `${fmt(tree.used)} of ${fmt(tree.capacity)} (${formatPercent(tree.used, tree.capacity)})`;
}

export const NO_HOST_METRICS =
  'No host metrics for this node: the charts show only what Kubernetes and the agents report, against capacity.';

/** Width of an element, kept current with a ResizeObserver, and the window height. */
function useBox(ref: React.RefObject<HTMLElement>): { width: number; height: number } {
  const [box, setBox] = React.useState({ width: 0, height: window.innerHeight });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setBox({ width: el.clientWidth, height: window.innerHeight });
    update();
    window.addEventListener('resize', update);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, [ref]);
  return box;
}

/** Chart size and layout from the container width and the window shape. */
export function chartLayout(
  width: number,
  height: number
): { size: number; detailBeside: boolean } {
  const portrait = height > width;
  const detailBeside = !portrait && width >= DETAIL_BESIDE_FROM;
  const chartsWidth = detailBeside ? width - DETAIL_WIDTH - GAP : width;
  const twoUp = !portrait && chartsWidth >= 2 * MIN_TWO_UP + GAP;
  let size = twoUp ? (chartsWidth - GAP) / 2 : chartsWidth;
  // Side by side, both charts should fit on the screen without scrolling.
  if (twoUp) size = Math.min(size, height - CHROME_HEIGHT);
  size = Math.max(MIN_CHART, Math.min(MAX_CHART, size));
  return { size: Math.floor(size), detailBeside };
}

export function NodeView(props: {
  metrics: NodeMetrics;
  host: AgentHost | null;
  agentError?: string;
  path: string[];
  onPath: (path: string[]) => void;
  onOverview: () => void;
}) {
  const { metrics, host, agentError, path, onPath, onOverview } = props;
  const trees = React.useMemo(() => buildTrees(metrics, host), [metrics, host]);
  const detail = React.useMemo(() => detailFor(trees.cpu, trees.mem, path), [trees, path]);
  const ref = React.useRef<HTMLDivElement>(null);
  const box = useBox(ref);
  const { size, detailBeside } = chartLayout(box.width, box.height);
  const crumb = { minHeight: 48, textTransform: 'none', fontSize: 16 } as const;

  const chart = (resource: Resource, tree: NodeTree) => (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0 }}>
      <Typography variant="h6" component="h3">
        {resource === 'cpu' ? 'CPU' : 'Memory'}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {usedText(tree, resource)}
      </Typography>
      <Sunburst tree={tree} resource={resource} focus={detail.path} size={size} onFocus={onPath} />
    </Box>
  );

  return (
    <Box ref={ref}>
      <Breadcrumbs aria-label="Focus" sx={{ mb: 1 }}>
        <Button sx={crumb} onClick={onOverview}>
          All nodes
        </Button>
        {detail.trail.map((t, i) =>
          i === detail.trail.length - 1 ? (
            <Typography key={t.key} sx={{ fontSize: 16, py: 1.5 }} aria-current="page">
              {t.label}
            </Typography>
          ) : (
            <Button key={t.key} sx={crumb} onClick={() => onPath(t.path)}>
              {t.label}
            </Button>
          )
        )}
      </Breadcrumbs>
      {agentError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Agent detail unavailable for this node: {agentError}
        </Alert>
      )}
      {!(trees.cpu.hostMetrics && trees.mem.hostMetrics) && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {NO_HOST_METRICS}
        </Typography>
      )}
      <Box sx={{ display: 'flex', flexWrap: detailBeside ? 'nowrap' : 'wrap', gap: `${GAP}px` }}>
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: `${GAP}px`,
            justifyContent: 'center',
            flex: detailBeside ? '1 1 auto' : '1 1 100%',
            minWidth: 0,
          }}
        >
          {chart('cpu', trees.cpu)}
          {chart('memory', trees.mem)}
        </Box>
        <Box sx={{ flex: detailBeside ? `0 0 ${DETAIL_WIDTH}px` : '1 1 100%', minWidth: 0 }}>
          <DetailPanel
            detail={detail}
            cpuCapacity={trees.cpu.capacity}
            memCapacity={trees.mem.capacity}
            onFocus={onPath}
          />
        </Box>
      </Box>
    </Box>
  );
}
