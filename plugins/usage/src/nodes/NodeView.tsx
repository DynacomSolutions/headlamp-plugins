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
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import React from 'react';
import { formatBytes, formatCores, formatPercent } from '../units';
import { childRows, detailFor, selectionFor, valueAt } from './detail';
import { DetailPanel } from './DetailPanel';
import { MAX_RINGS, MIN_RINGS } from './nodesUrl';
import { Sunburst } from './Sunburst';
import { capacityZoom, NodeTree, Resource } from './tree';

/** Hidden on screen, still read by screen readers. */
const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

const rootCrumb = (tree: NodeTree) => (tree.nodeRing ? 'All nodes' : tree.root.label);

const RING_OPTIONS = Array.from({ length: MAX_RINGS - MIN_RINGS + 1 }, (_, i) => MIN_RINGS + i);
const GAP = 16;
const MIN_CHART = 200;
/** Room the heading and the used text above a chart need. */
const CHART_HEAD = 64;

/**
 * The line under a chart heading. At the root: used against capacity. Zoomed in (`focus` not
 * empty): the total of the focus node in this tree, with no share of capacity. Zoomed into one
 * node of a node ring it reads like a single-node root: used against that node's capacity.
 */
export function usedText(
  tree: NodeTree,
  resource: Resource,
  focus: string[] = [],
  focusName = ''
): string {
  const fmt = resource === 'cpu' ? formatCores : formatBytes;
  // CPU is measured against the allocatable cores, so the line says so; memory keeps plain capacity.
  const suffix = resource === 'cpu' ? ' allocatable' : '';
  if (focus.length > 0 && capacityZoom(tree, focus) === null) {
    const v = valueAt(tree, focus);
    if (v === null) return `no ${resource === 'cpu' ? 'CPU' : 'memory'} data`;
    return `${fmt(v)} in ${focusName}`;
  }
  const cap = capacityZoom(tree, focus);
  if (cap !== null) {
    // One node of a node ring reads like a single-node root.
    const v = valueAt(tree, focus) ?? 0;
    return `${fmt(v)} of ${fmt(cap)}${suffix} (${formatPercent(v, cap)})`;
  }
  if (tree.used === null) {
    return `${fmt(tree.root.value)} attributed of ${fmt(tree.capacity)}${suffix}`;
  }
  return `${fmt(tree.used)} of ${fmt(tree.capacity)}${suffix} (${formatPercent(
    tree.used,
    tree.capacity
  )})`;
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
 * The size of an element, kept current with a ResizeObserver. When it fits its box the element fills the
 * rest of the screen, so its own height is the room. Otherwise the room is what is left of the
 * window below the element.
 */
function useBox(
  ref: React.RefObject<HTMLElement>,
  fit: boolean
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
        height: fit
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
  }, [ref, fit]);
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
 * `largest` (a dashboard widget) ignores those rules and takes the layout with the bigger charts.
 */
export function chartLayout(
  width: number,
  height: number,
  phone = false,
  portrait = width <= height,
  largest = false
): { size: number; twoUp: boolean } {
  const clamp = (v: number) => Math.floor(Math.max(MIN_CHART, v));
  if (largest) {
    // A dashboard widget: whichever layout gives the bigger charts in the room it has.
    const side = clamp(Math.min((width - GAP) / 2, height - CHART_HEAD));
    const stacked = clamp(Math.min(width, (height - 2 * CHART_HEAD - GAP) / 2));
    return side >= stacked ? { size: side, twoUp: true } : { size: stacked, twoUp: false };
  }
  if (phone) {
    return portrait
      ? { size: clamp(width), twoUp: false }
      : { size: clamp((width - GAP) / 2), twoUp: true };
  }
  const beside = Math.min((width - GAP) / 2, height - CHART_HEAD);
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
  /**
   * The view fills the box it is in (the kiosk page, or a dashboard widget): the charts size from
   * that box, not from the window, and nothing in it pushes the page to scroll. Default: `kiosk`.
   */
  fit?: boolean;
  /** A dashboard widget: the charts take the layout (side by side or stacked) that makes them bigger. */
  widget?: boolean;
  /** Rings drawn in both charts. */
  rings: number;
  onRings: (rings: number) => void;
  /** Filters, left of the breadcrumb in the top bar. */
  toolbar?: React.ReactNode;
  /** Controls at the right end of the top bar (Full screen or Exit full screen). */
  trailing?: React.ReactNode;
  /** Zoom to a path; this clears the selection. */
  onPath: (path: string[]) => void;
  onSelect: (sel: string[]) => void;
}) {
  const {
    cpu,
    mem,
    alerts,
    path,
    sel,
    kiosk,
    fit = kiosk,
    widget = false,
    rings,
    onRings,
    toolbar,
    trailing,
    onPath,
    onSelect,
  } = props;
  const detail = React.useMemo(() => detailFor(cpu, mem, path), [cpu, mem, path]);
  const selection = React.useMemo(
    () => selectionFor(cpu, mem, detail.path, sel),
    [cpu, mem, detail.path, sel]
  );
  // Zoomed into one node of a node ring: it reads like a single-node root, against its capacity.
  const nodeZoom =
    capacityZoom(cpu, detail.path) !== null || capacityZoom(mem, detail.path) !== null;
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
  const rootKind =
    detail.path.length > 0 ? undefined : cpu.nodeRing || mem.nodeRing ? 'Selection' : 'Node';
  const rows = React.useMemo(
    () => childRows(cpu, mem, base, detail.path),
    [cpu, mem, base, detail.path]
  );
  const ref = React.useRef<HTMLDivElement>(null);
  const box = useBox(ref, fit);
  const { size, twoUp } = chartLayout(
    box.width,
    box.height,
    // A fitted view (kiosk, widget) fills its box and does not scroll, so the phone rule is for the page only.
    box.phone && !fit,
    box.portrait,
    fit && widget
  );
  const centreSubject = { label: detail.focus.label, icon: detail.focus.icon };
  const crumb = { minHeight: 48, textTransform: 'none', fontSize: 16 } as const;

  // A double click or double tap opens the arc, as the Open button does, when it has children.
  const openPath = (p: string[]) => {
    if (selectionFor(cpu, mem, detail.path, p)?.canOpen) onPath(p);
  };

  const chart = (resource: Resource, tree: NodeTree) => (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        minWidth: 0,
        flex: '0 0 auto',
      }}
    >
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
        rings={rings}
        onFocus={onPath}
        subject={centreSubject}
        selected={chosen ? sel : null}
        onSelect={p => onSelect(p ?? [])}
        onOpen={openPath}
        quiet={kiosk}
      />
    </Box>
  );

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        flex: fit ? '1 1 0' : '1 1 auto',
        width: '100%',
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          columnGap: 2,
          rowGap: 1,
          mb: 1,
        }}
      >
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
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {kiosk ? (
            <Icon
              icon="mdi:chart-donut"
              width={28}
              height={28}
             
              aria-hidden="true"
            />
          ) : null}
          <Typography id="rings-label" sx={kiosk ? visuallyHidden : { fontSize: 16 }}>
            Rings
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={rings}
            aria-labelledby="rings-label"
            onChange={(_e, v: number | null) => {
              if (v !== null) onRings(v);
            }}
          >
            {RING_OPTIONS.map(n => (
              <ToggleButton
                key={n}
                value={n}
                aria-label={`${n} rings`}
                sx={{ minHeight: 48, minWidth: 48, fontSize: 16 }}
              >
                {n}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>
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
        kiosk={kiosk}
        subject={subject}
        selected={chosen}
        rows={rows}
        zoomed={detail.path.length > 0 && !nodeZoom}
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
          flex: fit ? '1 1 0' : '0 0 auto',
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
