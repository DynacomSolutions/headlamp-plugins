/*
 * One node full screen: the CPU and memory sunbursts side by side (stacked in portrait), sized
 * from the container, both zoomed to the same focus path, with a breadcrumb and, for a T3
 * thread, a link to open it. The details of the focus are in the centre of each chart.
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
import { Sunburst } from './Sunburst';
import { buildNodeTree, NodeTree, Resource } from './tree';
import type { NodeMetrics } from './types';

const GAP = 16;
const MIN_CHART = 200;
const MAX_CHART = 1200;
const MIN_TWO_UP = 260;
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

/** The per-node agent alert: stale data with its time, or no agent detail at all. */
export function agentAlertText(error: string, asOf?: number): string {
  if (asOf === undefined) return `Agent detail unavailable: ${error}`;
  return `Agent backend failed, showing agent data from ${new Date(
    asOf
  ).toLocaleTimeString()}: ${error}`;
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
export function chartLayout(width: number, height: number): { size: number; twoUp: boolean } {
  const portrait = height > width;
  const twoUp = !portrait && width >= 2 * MIN_TWO_UP + GAP;
  let size = twoUp ? (width - GAP) / 2 : width;
  // Both charts should fit on the screen without scrolling: side by side, or stacked in half.
  size = Math.min(size, twoUp ? height - CHROME_HEIGHT : (height - CHROME_HEIGHT) / 2);
  size = Math.max(MIN_CHART, Math.min(MAX_CHART, size));
  return { size: Math.floor(size), twoUp };
}

/** A thread link, only for http(s) URLs. */
export function threadHref(href: string | undefined): string | undefined {
  return href && /^https?:\/\//i.test(href) ? href : undefined;
}

export function NodeView(props: {
  metrics: NodeMetrics;
  host: AgentHost | null;
  agentError?: string;
  /** When the shown agent data arrived, if it is from an earlier poll. */
  agentAsOf?: number;
  path: string[];
  onPath: (path: string[]) => void;
  onOverview: () => void;
}) {
  const { metrics, host, agentError, agentAsOf, path, onPath, onOverview } = props;
  const trees = React.useMemo(() => buildTrees(metrics, host), [metrics, host]);
  const detail = React.useMemo(() => detailFor(trees.cpu, trees.mem, path), [trees, path]);
  const ref = React.useRef<HTMLDivElement>(null);
  const box = useBox(ref);
  const { size, twoUp } = chartLayout(box.width, box.height);
  const href = threadHref(detail.focus.href);
  const subject = { label: detail.focus.label, icon: detail.focus.icon };
  const crumb = { minHeight: 48, textTransform: 'none', fontSize: 16 } as const;

  const chart = (resource: Resource, tree: NodeTree) => (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0 }}>
      <Typography variant="h6" component="h3">
        {resource === 'cpu' ? 'CPU' : 'Memory'}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {usedText(tree, resource)}
      </Typography>
      <Sunburst
        tree={tree}
        resource={resource}
        focus={detail.path}
        size={size}
        onFocus={onPath}
        subject={subject}
      />
    </Box>
  );

  return (
    <Box ref={ref}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
        <Breadcrumbs aria-label="Focus" sx={{ flex: '1 1 0', minWidth: 0 }}>
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
        {href && (
          <Button
            component="a"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            variant="outlined"
            sx={{ minHeight: 48, fontSize: 16 }}
          >
            Open thread
          </Button>
        )}
      </Box>
      {agentError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {agentAlertText(agentError, agentAsOf)}
        </Alert>
      )}
      {!(trees.cpu.hostMetrics && trees.mem.hostMetrics) && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {NO_HOST_METRICS}
        </Typography>
      )}
      <Box
        sx={{
          display: 'flex',
          flexWrap: twoUp ? 'nowrap' : 'wrap',
          gap: `${GAP}px`,
          justifyContent: 'center',
          minWidth: 0,
        }}
      >
        {chart('cpu', trees.cpu)}
        {chart('memory', trees.mem)}
      </Box>
    </Box>
  );
}
