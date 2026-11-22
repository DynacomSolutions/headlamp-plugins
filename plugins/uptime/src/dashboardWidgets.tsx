/*
 * The widget that the Uptime plugin adds to the Dashboards plugin, through the cross-plugin
 * `window.headlampDashboards` contract (see dashboardsContract.ts):
 *   uptime.targets  Every check grouped by one key (app and namespace come from the cluster routes). A group header shows the icon of the app,
 *                   the worst status, the counts and the worst history line of its checks. A group starts collapsed and expands
 *                   (click or Enter) to every check line, each with its own
 *                   history line. Every group is listed, failing groups first: no group folds into one summary row, and
 *                   a check that no route serves groups under its own host, never under "Other".
 *                   The stat tiles and the summary line stay fixed. Only the list of groups scrolls.
 * The lines are the history strip of the Uptime page, with the same colours. The widget fetches when
 * the time range or the dashboard refresh signal changes, never on its own timer or on a layout drag.
 * Dashboard filters: the time range (when the widget range is "dashboard") and the namespaces (for
 * checks that a route or a label places in a namespace). The nodes and the label selector do not apply to probes.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { alpha, useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import React from 'react';
import { createPortal } from 'react-dom';
import { fetchClusterInfo } from './clusterApi';
import {
  registerDashboardWidget,
  WidgetCache,
  WidgetDefinition,
  WidgetProps,
} from './dashboardsContract';
import { GroupIcon, type GroupIconInfo, useGroupIcons } from './GroupIcon';
import {
  buildGroups,
  gridFor,
  gridLabel,
  GROUP_BY_VALUES,
  GroupBy,
  meanAvailability,
  NodeAddresses,
  RANGE_VALUES,
  UptimeGroup,
  WidgetRange,
} from './groups';
import { HistoryStrip } from './HistoryStrip';
import { PROBE_JOB, queryMetrics, queryRange } from './metrics';
import {
  buildChecks,
  Check,
  formatPercent,
  historyEnd,
  HistoryGrid,
  historyStart,
  queries,
  Raw,
  Status,
} from './model';
import { fetchRouteLists } from './routeApi';
import { buildRoutes, placeChecks, Route } from './routes';
import { ScrollArea } from './ScrollArea';

export interface UptimeWidgetConfig {
  groupBy: GroupBy;
  /** Whether the groups start expanded (default: no, one row per group, a click opens its checks). */
  expanded: boolean;
  range: WidgetRange;
  /** Show only the groups that are down or degraded. */
  onlyFailing: boolean;
}

const DEFAULT_CONFIG: UptimeWidgetConfig = {
  groupBy: 'auto',
  expanded: false,
  range: '24h',
  onlyFailing: false,
};

/** Saved settings can be stale or hand-edited: fall back to the default for any bad value. */
export function normaliseConfig(raw: Partial<UptimeWidgetConfig> | undefined): UptimeWidgetConfig {
  const c = raw ?? {};
  return {
    groupBy: GROUP_BY_VALUES.includes(c.groupBy as GroupBy)
      ? (c.groupBy as GroupBy)
      : DEFAULT_CONFIG.groupBy,
    expanded: typeof c.expanded === 'boolean' ? c.expanded : DEFAULT_CONFIG.expanded,
    range: RANGE_VALUES.includes(c.range as WidgetRange)
      ? (c.range as WidgetRange)
      : DEFAULT_CONFIG.range,
    onlyFailing: typeof c.onlyFailing === 'boolean' ? c.onlyFailing : DEFAULT_CONFIG.onlyFailing,
  };
}

const STATUS_LABEL: Record<Status, string> = {
  up: 'Up',
  down: 'Down',
  degraded: 'Degraded',
  unknown: 'No data',
};

/**
 * One column layout for the group header and the check lines, so the lines of a group and of its
 * checks start and end at the same place: marker, status, name, history line, availability.
 */
const ROW_COLUMNS = '16px 92px minmax(0, 38%) minmax(64px, 1fr) 56px';

/**
 * A narrow widget (3 grid columns on a small screen) has no room for five columns in one line. The
 * container query folds each line into two: the name and the availability, then the history line
 * under the name. The name wraps, so it stays readable, and the history line ends before the
 * availability column with a gap. The status chip becomes a dot before the name.
 */
const NARROW = '@container uptime (max-width: 459px)';
const NARROW_ROW = {
  [NARROW]: {
    gridTemplateColumns: '16px minmax(0, 1fr) auto',
    gridTemplateAreas: '"lead name pct" "lead strip strip"',
    rowGap: 0.25,
    py: 0.25,
  },
} as const;

const EMPTY_ROUTES: Route[] = [];

interface Loaded {
  key: string;
  checks: Check[];
  /** The routes of this refresh, fetched once with the checks and shared by every check. */
  routes: Route[];
  routeErrors: string[];
  grid: HistoryGrid;
  at: number;
  error: string | null;
  /** True while this is data from the browser cache. */
  cached: boolean;
}

/** What the widget keeps in the browser cache: the raw answers, so a new plugin version builds the checks again. */
interface CachedChecks {
  key: string;
  success: Raw['success'];
  history: Raw['history'];
  routes: Route[];
  routeErrors: string[];
}

/** The cached checks for this grid, built again from the raw answers, or undefined. */
export function checksFromCache(cache: WidgetCache | undefined, grid: HistoryGrid): Loaded | null {
  if (!cache) return null;
  try {
    const hit = cache.read<CachedChecks>();
    const v = hit?.value;
    const key = `${grid.stepSec}x${grid.buckets}`;
    if (!hit || !v || v.key !== key || !Array.isArray(v.success) || !Array.isArray(v.history))
      return null;
    const raw: Raw = {
      success: v.success,
      duration: [],
      httpStatus: [],
      tlsExpiry: [],
      siteUptime24h: [],
      uptime24h: [],
      uptime7d: [],
      history: v.history,
    };
    return {
      key,
      checks: buildChecks(raw, Math.floor(hit.at / 1000), grid).checks,
      routes: Array.isArray(v.routes) ? v.routes : EMPTY_ROUTES,
      routeErrors: Array.isArray(v.routeErrors) ? v.routeErrors : [],
      grid,
      at: hit.at,
      error: null,
      cached: true,
    };
  } catch {
    return null;
  }
}

/**
 * The checks with their history for the grid. Fetches when the grid or the refresh signal changes.
 * The last good data stays on screen when a refresh fails. With a `cache`, the first render shows
 * the last good checks (`cached`), with no spinner, and the fetch runs in the background.
 */
export function useUptimeChecks(
  grid: HistoryGrid,
  refreshSignal: number,
  reportRefreshed: (at?: number) => void,
  cache?: WidgetCache
): {
  loading: boolean;
  error: string | null;
  checks: Check[];
  routes: Route[];
  routeErrors: string[];
  at: number | null;
  /** True while the checks on screen come from the browser cache and no fresh answer has come. */
  cached: boolean;
} {
  const [loaded, setLoaded] = React.useState<Loaded | null>(() => checksFromCache(cache, grid));
  const key = `${grid.stepSec}x${grid.buckets}`;
  React.useEffect(() => {
    let live = true;
    const q = queries(PROBE_JOB, grid.stepSec);
    const nowSec = Math.floor(Date.now() / 1000);
    Promise.all([
      queryMetrics(q.success),
      queryRange(q.history, historyStart(nowSec, grid), historyEnd(nowSec, grid), grid.stepSec),
      // One list per route kind for the whole cluster, never one request per check.
      fetchRouteLists(),
    ]).then(
      ([success, history, lists]) => {
        if (!live) return;
        const raw: Raw = {
          success,
          duration: [],
          httpStatus: [],
          tlsExpiry: [],
          siteUptime24h: [],
          uptime24h: [],
          uptime7d: [],
          history,
        };
        const at = Date.now();
        const routes = buildRoutes(lists.routes);
        setLoaded({
          key,
          checks: buildChecks(raw, nowSec, grid).checks,
          routes,
          routeErrors: lists.errors,
          grid,
          at,
          error: null,
          cached: false,
        });
        cache?.write(
          { key, success, history, routes, routeErrors: lists.errors } satisfies CachedChecks,
          at
        );
        reportRefreshed(at);
      },
      (e: unknown) =>
        live &&
        setLoaded(prev => ({
          key,
          checks: prev?.key === key ? prev.checks : [],
          routes: prev?.key === key ? prev.routes : [],
          routeErrors: prev?.key === key ? prev.routeErrors : [],
          grid,
          at: prev?.key === key ? prev.at : 0,
          error: String((e as Error)?.message || e),
          cached: prev?.key === key ? prev.cached : false,
        }))
    );
    return () => {
      live = false;
    };
    // `key` covers the grid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshSignal, reportRefreshed]);
  const current = loaded?.key === key ? loaded : null;
  return {
    loading: current === null,
    error: current?.error ?? null,
    checks: current?.checks ?? [],
    routes: current?.routes ?? EMPTY_ROUTES,
    routeErrors: current?.routeErrors ?? [],
    at: current?.at || null,
    cached: !!current?.cached,
  };
}

/** The status shape of a check line (see `Mark`). */
function Dot({ status }: { status: Status }): JSX.Element {
  return <Mark status={status} size={10} />;
}

/**
 * Fixed status hues for each mode, like the other dashboard panels: the kiosk theme draws the theme
 * success colour in near white, and a green mark must stay green.
 */
const HUES = {
  dark: { up: '#66bb6a', degraded: '#ffa726', down: '#f44336', unknown: 'rgba(255,255,255,0.7)' },
  light: { up: '#2e7d32', degraded: '#c75b00', down: '#d32f2f', unknown: 'rgba(0,0,0,0.6)' },
} as const;

function useHues() {
  const dark = useTheme().palette.mode === 'dark';
  const hue = HUES[dark ? 'dark' : 'light'];
  const fill = (status: Status): string =>
    status === 'unknown'
      ? dark
        ? 'rgba(255,255,255,0.08)'
        : 'rgba(0,0,0,0.05)'
      : alpha(
          hue[status],
          dark ? (status === 'down' ? 0.18 : 0.16) : status === 'down' ? 0.12 : 0.13
        );
  // The thin divider under a row: the same line as the row lists of the Dashboards plugin (`tokens.line`).
  const line = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';
  return { hue, fill, dark, line };
}

/** The status shape: circle up, triangle degraded, square down, ring no data. Never colour alone. */
function Mark({ status, size = 12 }: { status: Status; size?: number }): JSX.Element {
  const { hue } = useHues();
  const c = hue[status];
  return (
    <svg
      role="img"
      aria-label={STATUS_LABEL[status]}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      style={{ flex: 'none' }}
    >
      {status === 'up' && <circle cx="6" cy="6" r="5" fill={c} />}
      {status === 'degraded' && <path d="M6 1 L11 11 L1 11 Z" fill={c} />}
      {status === 'down' && <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill={c} />}
      {status === 'unknown' && (
        <circle cx="6" cy="6" r="4" fill="none" stroke={c} strokeWidth="2" />
      )}
    </svg>
  );
}

/**
 * The stat tiles above the rows: a large number over a small tinted chip with the status shape and
 * the word. A zero count fades out, and the worst non-zero count takes its status colour.
 */
function UptimeTiles({ counts }: { counts: Record<Status, number> }): JSX.Element {
  const { hue, fill, dark } = useHues();
  const order: Status[] = ['up', 'degraded', 'down', 'unknown'];
  const worst = (['down', 'degraded'] as Status[]).find(s => counts[s] > 0);
  const faint = dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)';
  return (
    <Box data-uptime-tiles sx={{ display: 'flex', gap: '10px', pt: '2px', pb: 1.25 }}>
      {order.map(s => {
        const zero = counts[s] === 0;
        return (
          <Box key={s} data-uptime-tile={s} sx={{ flex: '1 1 0', minWidth: 0 }}>
            <Box
              sx={{
                fontSize: 'clamp(22px, 7cqw, 34px)',
                lineHeight: 1.05,
                fontVariantNumeric: 'tabular-nums',
                color: zero ? faint : s === worst ? hue[s] : 'text.primary',
              }}
            >
              {counts[s]}
            </Box>
            <Box
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                mt: '6px',
                px: '7px',
                py: '2px',
                borderRadius: '10px',
                fontSize: 12.5,
                lineHeight: 1.3,
                color: zero ? faint : 'text.primary',
                bgcolor: zero ? 'transparent' : fill(s),
                boxShadow: zero
                  ? `inset 0 0 0 1px ${dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}`
                  : 'none',
                maxWidth: '100%',
              }}
            >
              <Mark status={s} size={11} />
              <span>{STATUS_LABEL[s]}</span>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** The summary line in the footer of the widget frame, or in place when there is no frame. */
function FooterLine(props: {
  footer?: HTMLElement | null;
  status: Status;
  children: React.ReactNode;
}): JSX.Element {
  const line = (
    <Box
      data-widget-summary=""
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        minWidth: 0,
        fontSize: 13,
        pt: props.footer ? 0 : 0.75,
      }}
    >
      <Mark status={props.status} size={13} />
      <Box
        component="span"
        sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {props.children}
      </Box>
    </Box>
  );
  return props.footer ? createPortal(line, props.footer) : line;
}

function CheckLine(props: { check: Check; grid: HistoryGrid; startSec: number; kiosk: boolean }) {
  const { check, grid, startSec, kiosk } = props;
  const mean = formatPercent(meanAvailability(check.history));
  const { line } = useHues();
  return (
    <Box
      data-uptime-row="check"
      sx={{
        boxShadow: `inset 0 -1px 0 ${line}`,
        display: 'grid',
        gridTemplateColumns: ROW_COLUMNS,
        alignItems: 'center',
        columnGap: 1,
        px: 1,
        minHeight: kiosk ? 32 : 26,
        minWidth: 0,
        ...NARROW_ROW,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          gridColumn: '2',
          [NARROW]: { gridColumn: 'auto', gridArea: 'lead' },
        }}
      >
        <Dot status={check.status} />
      </Box>
      <Typography
        variant="body2"
        title={check.instance ? `${check.name}: ${check.instance}` : check.name}
        sx={{
          gridColumn: '3',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          [NARROW]: {
            gridColumn: 'auto',
            gridArea: 'name',
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
          },
        }}
      >
        {check.name}
      </Typography>
      <Box
        sx={{
          gridColumn: '4',
          minWidth: 0,
          [NARROW]: { gridColumn: 'auto', gridArea: 'strip', pr: 1 },
        }}
      >
        <HistoryStrip
          history={check.history}
          startSec={startSec}
          stepSec={grid.stepSec}
          label={`${check.name}: ${
            STATUS_LABEL[check.status]
          }, availability ${mean} over ${gridLabel(grid)}`}
          height={kiosk ? 10 : 9}
          minWidth={64}
          tooltips="native"
        />
      </Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          gridColumn: '5',
          textAlign: 'right',
          pl: 1,
          [NARROW]: { gridColumn: 'auto', gridArea: 'pct' },
        }}
      >
        {mean}
      </Typography>
    </Box>
  );
}

function countsText(group: UptimeGroup): string {
  const parts: string[] = [];
  if (group.counts.down) parts.push(`${group.counts.down} down`);
  if (group.counts.degraded) parts.push(`${group.counts.degraded} degraded`);
  if (group.counts.unknown) parts.push(`${group.counts.unknown} no data`);
  parts.push(`${group.counts.up} up`);
  return `${group.checks.length} · ${parts.join(' · ')}`;
}

/** The status word with its shape in a small tinted chip. It folds away in a narrow widget (see NARROW). */
function StatusChip({ status }: { status: Status }): JSX.Element {
  const { fill } = useHues();
  return (
    <Box
      data-uptime-chip
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        px: '8px',
        py: '2px',
        borderRadius: '10px',
        fontSize: 12.5,
        lineHeight: 1.3,
        bgcolor: fill(status),
        [NARROW]: { display: 'none' },
      }}
    >
      <Mark status={status} size={11} />
      <span>{STATUS_LABEL[status]}</span>
    </Box>
  );
}

function GroupBlock(props: {
  group: UptimeGroup;
  grid: HistoryGrid;
  startSec: number;
  expanded: boolean;
  onToggle: () => void;
  kiosk: boolean;
  icon?: GroupIconInfo;
}): JSX.Element {
  const { group, grid, startSec, expanded, onToggle, kiosk, icon } = props;
  const bodyId = React.useId();
  const { fill, line, dark } = useHues();
  // A group that needs attention is a tinted band with square corners. A group that is up has none.
  const band = group.status !== 'up';
  return (
    <Box component="section" aria-label={group.key} data-uptime-group={group.status}>
      <Box
        component="button"
        type="button"
        data-uptime-row="group"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={bodyId}
        sx={{
          display: 'grid',
          gridTemplateColumns: ROW_COLUMNS,
          alignItems: 'center',
          columnGap: 1,
          width: '100%',
          minHeight: kiosk ? 40 : 32,
          px: 1,
          ...NARROW_ROW,
          border: 0,
          borderRadius: 0,
          background: band ? fill(group.status) : 'transparent',
          // The same divider as the other row lists: none under a tinted band, whose tint ends the row.
          boxShadow: band ? 'none' : `inset 0 -1px 0 ${line}`,
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          touchAction: 'manipulation',
          WebkitTapHighlightColor: 'transparent',
          // A touch screen has no hover and the kiosk shows no focus ring (see its quiet styles).
          ...(kiosk
            ? {}
            : {
                '&:hover': { bgcolor: 'action.hover' },
                '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
              }),
        }}
      >
        <Box
          component="span"
          aria-hidden
          sx={{
            display: 'inline-block',
            textAlign: 'center',
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms',
            [NARROW]: { gridArea: 'lead', alignSelf: 'start', pt: 0.25 },
          }}
        >
          ›
        </Box>
        <StatusChip status={group.status} />
        <Box
          sx={{
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            [NARROW]: { gridArea: 'name' },
          }}
        >
          <GroupIcon name={group.key} info={icon} dark={dark} />
          <Box sx={{ minWidth: 0, flex: '1 1 0' }}>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, minWidth: 0 }}>
              <Box
                sx={{ display: 'none', [NARROW]: { display: 'inline-flex' }, alignSelf: 'center' }}
              >
                <Dot status={group.status} />
              </Box>
              <Typography
                variant="body2"
                title={group.key}
                sx={{
                  fontWeight: 600,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  [NARROW]: { whiteSpace: 'normal', overflowWrap: 'anywhere' },
                }}
              >
                {group.key}
              </Typography>
            </Box>
            <Typography
              variant="caption"
              color="text.secondary"
              component="div"
              sx={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                [NARROW]: { whiteSpace: 'normal' },
              }}
            >
              {countsText(group)}
            </Typography>
          </Box>
        </Box>
        <Box sx={{ minWidth: 0, [NARROW]: { gridArea: 'strip', pr: 1 } }}>
          <HistoryStrip
            history={group.history}
            startSec={startSec}
            stepSec={grid.stepSec}
            label={`${group.key}: ${STATUS_LABEL[group.status]}, the worst of ${
              group.checks.length
            } checks per period over ${gridLabel(grid)}`}
            height={kiosk ? 14 : 12}
            minWidth={64}
            tooltips="native"
          />
        </Box>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ textAlign: 'right', pl: 1, [NARROW]: { gridArea: 'pct', alignSelf: 'start' } }}
        >
          {formatPercent(meanAvailability(group.history))}
        </Typography>
      </Box>
      {expanded && (
        <Box id={bodyId} sx={{ pb: 0.5 }}>
          {group.checks.map(c => (
            <CheckLine key={c.name} check={c} grid={grid} startSec={startSec} kiosk={kiosk} />
          ))}
        </Box>
      )}
    </Box>
  );
}

const NO_NODES: NodeAddresses = new Map();
const NO_ICON_MAP: ReadonlyMap<string, string> = new Map();

/** The node addresses and the icon map, read again with each refresh (the reads are cached for a minute). */
function useClusterInfo(refreshSignal: number): {
  nodes: NodeAddresses;
  icons: ReadonlyMap<string, string>;
} {
  const [info, setInfo] = React.useState({ nodes: NO_NODES, icons: NO_ICON_MAP });
  React.useEffect(() => {
    let live = true;
    const { nodes, icons } = fetchClusterInfo();
    Promise.all([nodes, icons]).then(([n, i]) => {
      if (!live) return;
      // Keep the same objects when the content is the same, so the groups are not built again.
      setInfo(prev => ({
        nodes: sameMap(prev.nodes, n) ? prev.nodes : n,
        icons: sameMap(prev.icons, i) ? prev.icons : i,
      }));
    });
    return () => {
      live = false;
    };
  }, [refreshSignal]);
  return info;
}

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function UptimeTargetsWidget({
  config,
  filters,
  refreshSignal,
  reportRefreshed,
  kiosk,
  footer,
  cache,
}: WidgetProps<UptimeWidgetConfig>): JSX.Element {
  const settings = normaliseConfig(config);
  const grid = React.useMemo(
    () => gridFor(settings.range, filters.range),
    [settings.range, filters.range]
  );
  const state = useUptimeChecks(grid, refreshSignal, reportRefreshed, cache);
  // The cluster placement is derived from the routes of the last refresh, so a settings change reuses them.
  const placements = React.useMemo(
    () => placeChecks(state.checks, state.routes),
    [state.checks, state.routes]
  );
  const namespaces = filters.namespaces;
  const visible = React.useMemo(() => {
    if (namespaces.length === 0) return state.checks;
    // A check with no namespace (not in the cluster) has nothing to filter on, so it stays.
    return state.checks.filter(c => {
      const ns = c.labels.namespace ?? placements.get(c.name)?.namespace;
      return !ns || namespaces.includes(ns);
    });
  }, [state.checks, placements, namespaces]);
  const cluster = useClusterInfo(refreshSignal);
  const { groups, resolved } = React.useMemo(
    () =>
      buildGroups(visible, settings.groupBy, grid, settings.onlyFailing, placements, cluster.nodes),
    [visible, settings.groupBy, grid, settings.onlyFailing, placements, cluster.nodes]
  );
  const icons = useGroupIcons(groups, placements, cluster.icons);
  // `key` resets the toggles when the default changes, so no effect syncs them.
  return (
    <Scroller kiosk={kiosk}>
      {state.loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
          <CircularProgress size={24} aria-label="Loading uptime" />
        </Box>
      ) : (
        <TargetGroups
          key={`${settings.expanded}`}
          groups={groups}
          icons={icons}
          resolved={resolved}
          total={visible.length}
          grid={grid}
          at={state.at}
          error={state.error}
          routeErrors={state.routeErrors}
          failed={state.error !== null && state.checks.length === 0}
          expandedByDefault={settings.expanded}
          onlyFailing={settings.onlyFailing}
          kiosk={kiosk}
          footer={footer}
          checks={visible}
        />
      )}
    </Scroller>
  );
}

/**
 * The widget frame inside the card: a column that fills the height. The tiles and the summary stay
 * fixed, and only the list of groups scrolls (see `ScrollArea`).
 */
function Scroller(props: { kiosk: boolean; children: React.ReactNode }): JSX.Element {
  return (
    <Box
      data-uptime-root
      sx={{
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        // The rows fold into two lines when the widget is narrow (see NARROW).
        containerType: 'inline-size',
        containerName: 'uptime',
      }}
    >
      {props.children}
    </Box>
  );
}

function TargetGroups(props: {
  groups: UptimeGroup[];
  icons: ReadonlyMap<string, GroupIconInfo>;
  resolved: string;
  total: number;
  grid: HistoryGrid;
  at: number | null;
  error: string | null;
  routeErrors: string[];
  failed: boolean;
  expandedByDefault: boolean;
  onlyFailing: boolean;
  kiosk: boolean;
  footer?: HTMLElement | null;
  checks: Check[];
}): JSX.Element {
  const { groups, grid, expandedByDefault, kiosk } = props;
  // The groups the user flipped away from the default.
  const [flipped, setFlipped] = React.useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setFlipped(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const startSec = historyStart(props.at ? props.at / 1000 : Date.now() / 1000, grid);
  const failingGroups = groups.filter(g => g.status === 'down' || g.status === 'degraded').length;
  const counts = React.useMemo(() => {
    const c: Record<Status, number> = { up: 0, degraded: 0, down: 0, unknown: 0 };
    for (const ch of props.checks) c[ch.status] += 1;
    return c;
  }, [props.checks]);
  // Every group is listed. The groups that need attention come first (see `buildGroups`).
  const renderGroup = (g: UptimeGroup) => (
    <GroupBlock
      key={g.key}
      group={g}
      grid={grid}
      startSec={startSec}
      expanded={expandedByDefault !== flipped.has(g.key)}
      onToggle={() => toggle(g.key)}
      kiosk={kiosk}
      icon={props.icons.get(g.key)}
    />
  );
  const summaryStatus: Status =
    counts.down > 0 ? 'down' : counts.degraded > 0 ? 'degraded' : counts.up > 0 ? 'up' : 'unknown';
  const showList = !props.failed && props.total > 0;
  return (
    <>
      <Box sx={{ flex: 'none' }}>
        {props.error && (
          <Alert severity={props.failed ? 'error' : 'warning'} sx={{ mb: 1 }}>
            {props.failed
              ? `Could not read probe results: ${props.error}`
              : `Refresh failed, showing the last data: ${props.error}`}
          </Alert>
        )}
        {props.routeErrors.length > 0 && !props.failed && (
          <Alert severity="warning" sx={{ mb: 1 }}>
            Could not list routes, so some checks may show under their own host name:{' '}
            {props.routeErrors.join('; ')}
          </Alert>
        )}
        {!props.failed && props.total === 0 && (
          <Alert severity="info">
            No probe results. The scrape job "{PROBE_JOB}" has no probe_success series yet.
          </Alert>
        )}
        {showList && <UptimeTiles counts={counts} />}
      </Box>
      {showList && (
        <>
          {groups.length === 0 && props.onlyFailing && (
            <Alert severity="success">No group is failing.</Alert>
          )}
          <ScrollArea label="Uptime groups">{groups.map(renderGroup)}</ScrollArea>
          <FooterLine footer={props.footer} status={summaryStatus}>
            {counts.up} up, {counts.degraded} degraded, {counts.down} down, {counts.unknown} no
            data. {groups.length} groups by {props.resolved}, {failingGroups} failing, last{' '}
            {gridLabel(grid)}
          </FooterLine>
        </>
      )}
    </>
  );
}

export const uptimeTargetsWidget: WidgetDefinition<UptimeWidgetConfig> = {
  type: 'uptime.targets',
  title: 'Uptime targets',
  description:
    'Every uptime check in groups, with the status, the counts and the history line of each group. A group expands to every check.',
  icon: 'mdi:heart-pulse',
  category: 'Monitoring',
  defaultSize: { w: 6, h: 12 },
  minSize: { w: 3, h: 5 },
  defaultConfig: DEFAULT_CONFIG,
  configSchema: [
    {
      key: 'groupBy',
      label: 'Group by',
      type: 'select',
      help: 'Namespace and app come from the cluster: the host of a check is matched with the HTTPRoutes, Ingresses and Mappings. The app is the app label of the route, else its namespace. A check that no route serves groups under its own host name, never under "Other". Automatic uses the app, then the namespace, then the first word of the check name.',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'namespace', label: 'Namespace' },
        { value: 'app', label: 'App (route label, else namespace)' },
        { value: 'group', label: 'Group label' },
        { value: 'name', label: 'First word of the check name' },
        { value: 'type', label: 'Check type' },
      ],
    },
    {
      key: 'expanded',
      label: 'Groups expanded by default (off: one row per group)',
      type: 'boolean',
    },
    {
      key: 'range',
      label: 'Time range',
      type: 'select',
      options: [
        { value: 'dashboard', label: 'Follow the dashboard' },
        { value: '1h', label: 'Last hour' },
        { value: '6h', label: 'Last 6 hours' },
        { value: '24h', label: 'Last 24 hours (as on the page)' },
        { value: '7d', label: 'Last 7 days' },
        { value: '30d', label: 'Last 30 days' },
      ],
    },
    { key: 'onlyFailing', label: 'Only failing groups', type: 'boolean' },
  ],
  // The tiles and the summary stay fixed, and the widget scrolls only its list of groups.
  selfScroll: false,
  Component: UptimeTargetsWidget,
};

/** Registers the widget. Safe in any plugin load order (see dashboardsContract.ts). */
export function registerUptimeWidgets(): void {
  registerDashboardWidget(uptimeTargetsWidget);
}

registerUptimeWidgets();
