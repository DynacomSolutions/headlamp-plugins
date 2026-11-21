/*
 * The widget that the Uptime plugin adds to the Dashboards plugin, through the cross-plugin
 * `window.headlampDashboards` contract (see dashboardsContract.ts):
 *   uptime.targets  Every check grouped by one key (namespace and app come from the cluster routes). A group header shows the worst status, the counts
 *                   and the worst history line of its checks. A group expands to every check line.
 * The lines are the history strip of the Uptime page, with the same colours. The widget fetches when
 * the time range or the dashboard refresh signal changes, never on its own timer or on a layout drag.
 * Dashboard filters: the time range (when the widget range is "dashboard") and the namespaces (for
 * checks that a route or a label places in a namespace). The nodes and the label selector do not apply to probes.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import React from 'react';
import { registerDashboardWidget, WidgetDefinition, WidgetProps } from './dashboardsContract';
import {
  buildGroups,
  gridFor,
  gridLabel,
  GROUP_BY_VALUES,
  GroupBy,
  meanAvailability,
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

export interface UptimeWidgetConfig {
  groupBy: GroupBy;
  /** Whether the groups start expanded. */
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
const STATUS_CHIP: Record<Status, 'success' | 'error' | 'warning' | 'default'> = {
  up: 'success',
  down: 'error',
  degraded: 'warning',
  unknown: 'default',
};
const STATUS_DOT: Record<Status, string> = {
  up: 'success.main',
  down: 'error.main',
  degraded: 'warning.main',
  unknown: 'action.disabled',
};

/**
 * One column layout for the group header and the check lines, so the lines of a group and of its
 * checks start and end at the same place: marker, status, name, history line, availability.
 */
const ROW_COLUMNS = '16px 76px minmax(0, 38%) minmax(64px, 1fr) 56px';

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
    rowGap: 0.5,
    py: 0.5,
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
}

/**
 * The checks with their history for the grid. Fetches when the grid or the refresh signal changes.
 * The last good data stays on screen when a refresh fails.
 */
export function useUptimeChecks(
  grid: HistoryGrid,
  refreshSignal: number,
  reportRefreshed: (at?: number) => void
): {
  loading: boolean;
  error: string | null;
  checks: Check[];
  routes: Route[];
  routeErrors: string[];
  at: number | null;
} {
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
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
        setLoaded({
          key,
          checks: buildChecks(raw, nowSec, grid).checks,
          routes: buildRoutes(lists.routes),
          routeErrors: lists.errors,
          grid,
          at,
          error: null,
        });
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
  };
}

function Dot({ status }: { status: Status }): JSX.Element {
  return (
    <Box
      component="span"
      aria-label={STATUS_LABEL[status]}
      role="img"
      sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: STATUS_DOT[status], flex: 'none' }}
    />
  );
}

function CheckLine(props: { check: Check; grid: HistoryGrid; startSec: number; kiosk: boolean }) {
  const { check, grid, startSec, kiosk } = props;
  const mean = formatPercent(meanAvailability(check.history));
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: ROW_COLUMNS,
        alignItems: 'center',
        columnGap: 1,
        px: 1,
        minHeight: kiosk ? 36 : 28,
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
          height={kiosk ? 16 : 14}
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

function GroupBlock(props: {
  group: UptimeGroup;
  grid: HistoryGrid;
  startSec: number;
  expanded: boolean;
  onToggle: () => void;
  kiosk: boolean;
}): JSX.Element {
  const { group, grid, startSec, expanded, onToggle, kiosk } = props;
  const bodyId = React.useId();
  return (
    <Box component="section" aria-label={group.key}>
      <Box
        component="button"
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={bodyId}
        sx={{
          display: 'grid',
          gridTemplateColumns: ROW_COLUMNS,
          alignItems: 'center',
          columnGap: 1,
          width: '100%',
          minHeight: kiosk ? 48 : 36,
          px: 1,
          ...NARROW_ROW,
          border: 0,
          borderRadius: 1,
          background: 'transparent',
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
        <Chip
          size="small"
          label={STATUS_LABEL[group.status]}
          color={STATUS_CHIP[group.status]}
          sx={{ width: '100%', [NARROW]: { display: 'none' } }}
        />
        <Box sx={{ minWidth: 0, [NARROW]: { gridArea: 'name' } }}>
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
        <Box sx={{ minWidth: 0, [NARROW]: { gridArea: 'strip', pr: 1 } }}>
          <HistoryStrip
            history={group.history}
            startSec={startSec}
            stepSec={grid.stepSec}
            label={`${group.key}: ${STATUS_LABEL[group.status]}, the worst of ${
              group.checks.length
            } checks per period over ${gridLabel(grid)}`}
            height={kiosk ? 22 : 18}
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

function UptimeTargetsWidget({
  config,
  filters,
  refreshSignal,
  reportRefreshed,
  kiosk,
}: WidgetProps<UptimeWidgetConfig>): JSX.Element {
  const settings = normaliseConfig(config);
  const grid = React.useMemo(
    () => gridFor(settings.range, filters.range),
    [settings.range, filters.range]
  );
  const state = useUptimeChecks(grid, refreshSignal, reportRefreshed);
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
  const { groups, resolved } = React.useMemo(
    () => buildGroups(visible, settings.groupBy, grid, settings.onlyFailing, placements),
    [visible, settings.groupBy, grid, settings.onlyFailing, placements]
  );
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
        />
      )}
    </Scroller>
  );
}

/** The widget scrolls by itself. In the kiosk it scrolls by touch, with no visible scrollbar. */
function Scroller(props: { kiosk: boolean; children: React.ReactNode }): JSX.Element {
  return (
    <Box
      data-uptime-scroll
      sx={{
        height: '100%',
        minWidth: 0,
        // The rows fold into two lines when the widget is narrow (see NARROW).
        containerType: 'inline-size',
        containerName: 'uptime',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        touchAction: 'pan-y',
        WebkitOverflowScrolling: 'touch',
        ...(props.kiosk
          ? { scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }
          : {}),
      }}
    >
      {props.children}
    </Box>
  );
}

function TargetGroups(props: {
  groups: UptimeGroup[];
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
  return (
    <Box>
      {props.error && (
        <Alert severity={props.failed ? 'error' : 'warning'} sx={{ mb: 1 }}>
          {props.failed
            ? `Could not read probe results: ${props.error}`
            : `Refresh failed, showing the last data: ${props.error}`}
        </Alert>
      )}
      {props.routeErrors.length > 0 && !props.failed && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          Could not list routes, so some checks may show as not in the cluster:{' '}
          {props.routeErrors.join('; ')}
        </Alert>
      )}
      {!props.failed && props.total === 0 && (
        <Alert severity="info">
          No probe results. The scrape job "{PROBE_JOB}" has no probe_success series yet.
        </Alert>
      )}
      {!props.failed && props.total > 0 && (
        <>
          <Typography
            variant="caption"
            color="text.secondary"
            component="div"
            sx={{ px: 1, pb: 0.5 }}
          >
            {groups.length} groups by {props.resolved} · {props.total} checks · {failingGroups}{' '}
            failing · last {gridLabel(grid)}
          </Typography>
          {groups.length === 0 && props.onlyFailing && (
            <Alert severity="success">No group is failing.</Alert>
          )}
          {groups.map(g => (
            <GroupBlock
              key={g.key}
              group={g}
              grid={grid}
              startSec={startSec}
              expanded={expandedByDefault !== flipped.has(g.key)}
              onToggle={() => toggle(g.key)}
              kiosk={kiosk}
            />
          ))}
        </>
      )}
    </Box>
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
      help: 'Namespace and app come from the cluster: the host of a check is matched with the HTTPRoutes, Ingresses and Mappings. Checks no route serves show under "Not in cluster", split by type. Automatic uses the namespace, then the app, then the first word of the check name.',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'namespace', label: 'Namespace' },
        { value: 'app', label: 'App (route label, else namespace)' },
        { value: 'group', label: 'Group label' },
        { value: 'name', label: 'First word of the check name' },
        { value: 'type', label: 'Check type' },
      ],
    },
    { key: 'expanded', label: 'Groups expanded by default', type: 'boolean' },
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
  selfScroll: true,
  Component: UptimeTargetsWidget,
};

/** Registers the widget. Safe in any plugin load order (see dashboardsContract.ts). */
export function registerUptimeWidgets(): void {
  registerDashboardWidget(uptimeTargetsWidget);
}

registerUptimeWidgets();
