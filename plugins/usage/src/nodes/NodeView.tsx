/*
 * The dashboard charts: one CPU and one memory sunburst side by side (stacked in portrait), sized
 * from the space they have, both zoomed to the same focus path, with a breadcrumb and, for a T3
 * thread, a link to open it. The details of the focus are in the centre of each chart.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import React from 'react';
import { formatBytes, formatCores, formatPercent } from '../units';
import { childRows, detailFor, selectionFor } from './detail';
import { DetailPanel, PANEL_HEIGHT } from './DetailPanel';
import { Sunburst } from './Sunburst';
import { NodeTree, Resource } from './tree';

const GAP = 16;
const MIN_CHART = 200;
const MAX_CHART = 1200;
const MIN_TWO_UP = 260;
/** Room the heading and the used text above a chart need. */
const CHART_HEAD = 64;

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

/**
 * The size of an element, kept current with a ResizeObserver. In kiosk the element fills the
 * rest of the screen, so its own height is the room. Otherwise the room is what is left of the
 * window below the element.
 */
function useBox(
  ref: React.RefObject<HTMLElement>,
  kiosk: boolean
): { width: number; height: number } {
  const [box, setBox] = React.useState({ width: 0, height: window.innerHeight });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () =>
      setBox({
        width: el.clientWidth,
        height: kiosk
          ? el.clientHeight
          : Math.max(0, window.innerHeight - el.getBoundingClientRect().top - PANEL_HEIGHT - 16),
      });
    update();
    window.addEventListener('resize', update);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, [ref, kiosk]);
  return box;
}

/** Chart size and layout from the room the charts have (width and height, in px). */
export function chartLayout(width: number, height: number): { size: number; twoUp: boolean } {
  const portrait = height > width;
  const twoUp = !portrait && width >= 2 * MIN_TWO_UP + GAP;
  let size = twoUp ? (width - GAP) / 2 : width;
  // Both charts should fit without scrolling: side by side, or stacked sharing the height.
  size = Math.min(
    size,
    twoUp ? height - CHART_HEAD : (height - 2 * CHART_HEAD - GAP) / 2
  );
  size = Math.max(MIN_CHART, Math.min(MAX_CHART, size));
  return { size: Math.floor(size), twoUp };
}

/** A thread link, only for http(s) URLs. */
export function threadHref(href: string | undefined): string | undefined {
  return href && /^https?:\/\//i.test(href) ? href : undefined;
}

export function NodeView(props: {
  cpu: NodeTree;
  mem: NodeTree;
  /** Agent alerts of the selected nodes, as ready text. */
  alerts: string[];
  /** Zoom path. */
  path: string[];
  /** Selected path ([] for none). */
  sel: string[];
  kiosk: boolean;
  /** Zoom to a path; this clears the selection. */
  onPath: (path: string[]) => void;
  onSelect: (sel: string[]) => void;
}) {
  const { cpu, mem, alerts, path, sel, kiosk, onPath, onSelect } = props;
  const detail = React.useMemo(() => detailFor(cpu, mem, path), [cpu, mem, path]);
  const selection = React.useMemo(() => selectionFor(cpu, mem, detail.path, sel), [cpu, mem, detail.path, sel]);
  const chosen = sel.length > 0 && selection !== null;
  const base = chosen ? sel : detail.path;
  const subject = React.useMemo(
    () => (chosen ? selection : selectionFor(cpu, mem, detail.path, detail.path)),
    [chosen, selection, cpu, mem, detail.path]
  );
  const rows = React.useMemo(() => childRows(cpu, mem, base), [cpu, mem, base]);
  const ref = React.useRef<HTMLDivElement>(null);
  const box = useBox(ref, kiosk);
  const { size, twoUp } = chartLayout(box.width, box.height);
  const centreSubject = { label: detail.focus.label, icon: detail.focus.icon };
  const crumb = { minHeight: 48, textTransform: 'none', fontSize: 16 } as const;

  const chart = (resource: Resource, tree: NodeTree) => (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0 }}>
      <Typography variant="h6" component="h3">
        {resource === 'cpu' ? 'CPU' : 'Memory'}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1, fontSize: 14 }}>
        {usedText(tree, resource)}
      </Typography>
      <Sunburst
        tree={tree}
        resource={resource}
        focus={detail.path}
        size={size}
        onFocus={onPath}
        subject={centreSubject}
        selected={chosen ? sel : null}
        onSelect={p => onSelect(p ?? [])}
      />
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: kiosk ? '1 1 0' : undefined, minHeight: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
        <Breadcrumbs aria-label="Focus" sx={{ flex: '1 1 0', minWidth: 0 }}>
          <Button sx={crumb} onClick={() => onPath([])}>
            All nodes
          </Button>
          {detail.trail.slice(1).map((t, i, rest) =>
            i === rest.length - 1 ? (
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
      </Box>
      {alerts.map(a => (
        <Alert key={a} severity="warning" sx={{ mb: 1 }}>
          {a}
        </Alert>
      ))}
      {!(cpu.hostMetrics && mem.hostMetrics) && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1, fontSize: 14 }}>
          {NO_HOST_METRICS}
        </Typography>
      )}
      <Box
        ref={ref}
        onPointerUp={e => {
          // A tap on empty space beside the charts clears the selection.
          if (e.target === e.currentTarget) onSelect([]);
        }}
        sx={{
          flex: kiosk ? '1 1 0' : '0 0 auto',
          minHeight: 0,
          display: 'flex',
          flexWrap: twoUp ? 'nowrap' : 'wrap',
          alignContent: 'flex-start',
          gap: `${GAP}px`,
          justifyContent: 'center',
        }}
      >
        {chart('cpu', cpu)}
        {chart('memory', mem)}
      </Box>
      <DetailPanel
        subject={subject}
        selected={chosen}
        rows={rows}
        canGoUp={detail.path.length > 0}
        onUp={() => onPath(detail.path.slice(0, -1))}
        onOpen={() => onPath(sel)}
        onSelect={key => onSelect([...base, key])}
      />
    </Box>
  );
}
