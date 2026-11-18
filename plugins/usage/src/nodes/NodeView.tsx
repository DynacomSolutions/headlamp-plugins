/*
 * The dashboard charts: one CPU and one memory sunburst side by side (stacked in portrait), sized
 * from the space they have, both zoomed to the same focus path, with a breadcrumb and, for a T3
 * thread, a link to open it. The details of the focus are in the centre of each chart.
 */
import { Icon } from '@iconify/react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import React from 'react';
import { formatBytes, formatCores, formatPercent } from '../units';
import { childRows, detailFor, selectionFor, valueAt } from './detail';
import { DetailPanel } from './DetailPanel';
import { Sunburst } from './Sunburst';
import { NodeTree, Resource } from './tree';

const rootCrumb = (tree: NodeTree) => (tree.nodeRing ? 'All nodes' : tree.root.label);

const GAP = 16;
const MIN_CHART = 200;
/** Room the heading and the used text above a chart need. */
const CHART_HEAD = 64;

/**
 * The line under a chart heading. At the root: used against capacity. Zoomed in (`focus` not
 * empty): the total of the focus node in this tree, with no share of capacity.
 */
export function usedText(
  tree: NodeTree,
  resource: Resource,
  focus: string[] = [],
  focusName = ''
): string {
  const fmt = resource === 'cpu' ? formatCores : formatBytes;
  if (focus.length > 0) {
    const v = valueAt(tree, focus);
    if (v === null) return `no ${resource === 'cpu' ? 'CPU' : 'memory'} data`;
    return `${fmt(v)} in ${focusName}`;
  }
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

/** A phone is a viewport whose short side is under 600 px. Portrait is not wider than tall. */
function viewportKind(): { phone: boolean; portrait: boolean } {
  return {
    phone: Math.min(window.innerWidth, window.innerHeight) < 600,
    portrait: window.innerWidth <= window.innerHeight,
  };
}

/**
 * The size of an element, kept current with a ResizeObserver. In kiosk the element fills the
 * rest of the screen, so its own height is the room. Otherwise the room is what is left of the
 * window below the element.
 */
function useBox(
  ref: React.RefObject<HTMLElement>,
  kiosk: boolean
): { width: number; height: number; phone: boolean; portrait: boolean } {
  const [box, setBox] = React.useState({
    width: 0,
    height: window.innerHeight,
    ...viewportKind(),
  });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () =>
      setBox({
        ...viewportKind(),
        width: el.clientWidth,
        height: kiosk
          ? el.clientHeight
          : Math.max(0, window.innerHeight - el.getBoundingClientRect().top - 8),
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

/**
 * Chart size and layout from the room the charts have, with no upper limit on the diameter.
 * Landscape (wider than tall): CPU and Memory side by side, each as wide as half the width and
 * as tall as the room under its heading allows. Portrait: side by side when each is then at
 * least 45% of the width, else one above the other.
 * On a phone the page scrolls, so the height does not limit the charts: in portrait they are
 * stacked, each as wide as the room; in landscape they are side by side, half the width each.
 * `portrait` is the viewport's, and defaults to the room being no wider than tall.
 */
export function chartLayout(
  width: number,
  height: number,
  phone = false,
  portrait = width <= height
): { size: number; twoUp: boolean } {
  const clamp = (v: number) => Math.floor(Math.max(MIN_CHART, v));
  if (phone) {
    return portrait
      ? { size: clamp(width), twoUp: false }
      : { size: clamp((width - GAP) / 2), twoUp: true };
  }  const beside = Math.min((width - GAP) / 2, height - CHART_HEAD);
  if (width > height || beside >= 0.45 * width) return { size: clamp(beside), twoUp: true };
  return { size: clamp(Math.min(width, (height - 2 * CHART_HEAD - GAP) / 2)), twoUp: false };
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
  /** Filters, left of the breadcrumb in the top bar. */
  toolbar?: React.ReactNode;
  /** Controls at the right end of the top bar (Full screen or Exit full screen). */
  trailing?: React.ReactNode;
  /** Zoom to a path; this clears the selection. */
  onPath: (path: string[]) => void;
  onSelect: (sel: string[]) => void;
}) {
  const { cpu, mem, alerts, path, sel, kiosk, toolbar, trailing, onPath, onSelect } = props;
  const detail = React.useMemo(() => detailFor(cpu, mem, path), [cpu, mem, path]);
  const selection = React.useMemo(() => selectionFor(cpu, mem, detail.path, sel), [cpu, mem, detail.path, sel]);
  const chosen = sel.length > 0 && selection !== null;
  const base = chosen ? sel : detail.path;
  const subject = React.useMemo(() => {
    if (chosen) return selection;
    const root = selectionFor(cpu, mem, detail.path, detail.path);
    if (!root || detail.path.length > 0) return root;
    // The whole selection: all selected nodes, or the one node, with the server icon.
    return { ...root, kind: 'node' as const, icon: { kind: 'mdi' as const, name: 'server' } };
  }, [chosen, selection, cpu, mem, detail.path]);
  // The kind line names the node or the selection only at the root. A zoomed section keeps its own kind.
  const rootKind = detail.path.length > 0 ? undefined : cpu.nodeRing || mem.nodeRing ? 'Selection' : 'Node';
  const rows = React.useMemo(() => childRows(cpu, mem, base, detail.path), [
    cpu,
    mem,
    base,
    detail.path,
  ]);
  const ref = React.useRef<HTMLDivElement>(null);
  const box = useBox(ref, kiosk);
  const { size, twoUp } = chartLayout(
    box.width,
    box.height,
    // In kiosk the charts fill the screen and do not scroll, so the phone rule is for the page only.
    box.phone && !kiosk,
    box.portrait
  );
  const centreSubject = { label: detail.focus.label, icon: detail.focus.icon };
  const crumb = { minHeight: 48, textTransform: 'none', fontSize: 16 } as const;

  const chart = (resource: Resource, tree: NodeTree) => (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0, flex: '0 0 auto' }}>
      <Typography variant="h6" component="h3">
        {resource === 'cpu' ? 'CPU' : 'Memory'}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1, fontSize: 14 }}>
        {usedText(tree, resource, detail.path, detail.focus.label)}
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
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        flex: kiosk ? '1 1 0' : '1 1 auto',
        width: '100%',
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 2, rowGap: 1, mb: 1 }}>
        {toolbar}
        <Breadcrumbs aria-label="Focus" sx={{ flex: '1 1 240px', minWidth: 0 }}>
          <Button sx={crumb} onClick={() => onPath([])}>
            {rootCrumb(cpu)}
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
        <Button
          variant="outlined"
          onClick={() => onPath(detail.path.slice(0, -1))}
          disabled={detail.path.length === 0}
          aria-label="Up one level"
          startIcon={<Icon icon="mdi:arrow-up" width={24} height={24} />}
          sx={{ minHeight: 48, minWidth: 48, fontSize: 16 }}
        >
          Up
        </Button>
        <Button
          variant="contained"
          onClick={() => onPath(sel)}
          disabled={!chosen || !subject?.canOpen}
          aria-label="Open the selected segment"
          startIcon={<Icon icon="mdi:magnify-plus" width={24} height={24} />}
          sx={{ minHeight: 48, minWidth: 48, fontSize: 16 }}
        >
          Open
        </Button>
        {trailing}
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
      <DetailPanel
        rootKind={rootKind}
        subject={subject}
        selected={chosen}
        rows={rows}
        zoomed={detail.path.length > 0}
        section={detail.focus.label}
        onSelect={key => onSelect([...base, key])}
      />
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
          justifyContent: 'center',
          alignItems: 'flex-start',
          gap: `${GAP}px`,
        }}
      >
        {chart('cpu', cpu)}
        {chart('memory', mem)}
      </Box>
    </Box>
  );
}
