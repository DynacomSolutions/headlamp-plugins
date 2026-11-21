/*
 * Widgets that the Usage plugin adds to the Dashboards plugin, through the cross-plugin
 * `window.headlampDashboards` contract (see dashboardsContract.ts):
 *   usage.sunburst  CPU or memory as a two-level sunburst: full circle = cluster capacity,
 *                   filled = used. Grouped by namespace, workload, node or a pod label.
 *   usage.donut     One donut for a resource, grouped the same way, with a legend of every group.
 *   usage.dashboard-rings  The Usage > Dashboard page itself, as a widget: both sunbursts with the
 *                   same zoom, selection, filters and data (see nodes/UsageRings.tsx).
 * They use the same data code as the Usage page (fetchUsage and the model). They fetch when the
 * dashboard filters, their settings or the dashboard refresh signal change, never on their own timer.
 * Dashboard filters: the namespaces, the nodes and the time range. The label selector is not used,
 * because the usage data carries one pod label only.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { useTheme } from '@mui/material/styles';
import React from 'react';
import { describeError } from './dashboard/describeError';
import { SunburstChart } from './dashboard/SunburstChart';
import {
  buildSunburst,
  capacityQuery,
  groupingOf,
  SunburstGroup,
  SunburstResource,
  usageRange,
} from './dashboard/widgetModel';
import {
  DashboardFilters,
  registerDashboardWidget,
  WidgetCache,
  WidgetDefinition,
  WidgetProps,
} from './dashboardsContract';
import { fetchUsage } from './data';
import { DonutCard } from './DonutCard';
import { numberFromValue, queryMetrics } from './metrics';
import {
  aggregate,
  buildContext,
  displayKey,
  filterRows,
  planFor,
  slicesFor,
  totalOf,
  UsageRow,
} from './model';
import { MAX_RINGS, MIN_RINGS } from './nodes/nodesUrl';
import { DEFAULT_RINGS_CONFIG, ringsOf, UsageRings, UsageRingsConfig } from './nodes/UsageRings';
import { assignColours } from './palette';
import { rangeSeconds, RESOURCES } from './resources';
import { formatBytes, formatCores } from './units';

export interface UsageWidgetConfig {
  resource: string;
  groupBy: SunburstGroup;
  /** The pod label key, when grouping by label. */
  labelKey: string;
}

const GROUP_OPTIONS = [
  { value: 'namespace', label: 'Namespace' },
  { value: 'workload', label: 'Workload' },
  { value: 'node', label: 'Node' },
  { value: 'label', label: 'Pod label' },
] as const;

const LABEL_FIELD = {
  key: 'labelKey',
  label: 'Label key',
  type: 'text',
  help: 'Used when grouping by pod label, for example app.kubernetes.io/name.',
} as const;

interface Loaded {
  key: string;
  rows: UsageRow[];
  windowSeconds: number;
  capacity: number;
  error: string | null;
}

/** The cached usage for this request key, or null. A value of another shape is no value. */
export function usageFromCache(cache: WidgetCache | undefined, key: string): Loaded | null {
  try {
    const v = cache?.read<Loaded>()?.value;
    if (!v || v.key !== key || !Array.isArray(v.rows)) return null;
    return {
      key,
      rows: v.rows,
      windowSeconds: Number(v.windowSeconds) || 0,
      capacity: Number(v.capacity) || 0,
      error: null,
    };
  } catch {
    return null;
  }
}

/**
 * The usage rows (and, for the sunburst, the cluster capacity) for the widget. Fetches when the
 * range, the grouping, the capacity request or the refresh signal changes. The last good data stays
 * on screen when a refresh fails. With a `cache`, the first render shows the last good data at once.
 */
export function useUsageData(
  range: DashboardFilters['range'],
  groupBy: SunburstGroup,
  labelKey: string,
  capacity: { resource: SunburstResource; nodes: string[] } | null,
  refreshSignal: number,
  reportRefreshed: (at?: number) => void,
  cache?: WidgetCache
): {
  loading: boolean;
  error: string | null;
  rows: UsageRow[];
  windowSeconds: number;
  capacity: number;
} {
  const usage = usageRange(range);
  const plan = planFor(groupingOf(groupBy, labelKey), []);
  const capQuery = capacity ? capacityQuery(capacity.resource, capacity.nodes) : '';
  const key = `${usage}|${plan.live}|${plan.labelKey ?? ''}|${capQuery}`;
  const [loaded, setLoaded] = React.useState<Loaded | null>(() => usageFromCache(cache, key));
  React.useEffect(() => {
    let live = true;
    Promise.all([
      fetchUsage(usage, { live: plan.live, labelKey: plan.labelKey }),
      // The capacity is optional: without it the circle is the used part.
      capQuery
        ? queryMetrics(capQuery).then(
            s => numberFromValue(s[0]) ?? 0,
            () => 0
          )
        : Promise.resolve(0),
    ]).then(
      ([data, cap]) => {
        if (!live) return;
        const fresh: Loaded = {
          key,
          rows: data.rows,
          windowSeconds: data.coverage?.coveredSeconds ?? rangeSeconds(usage),
          capacity: cap,
          error: null,
        };
        setLoaded(fresh);
        cache?.write(fresh);
        reportRefreshed(Date.now());
      },
      (e: unknown) =>
        live &&
        setLoaded(prev => ({
          key,
          rows: prev?.key === key ? prev.rows : [],
          windowSeconds: prev?.key === key ? prev.windowSeconds : rangeSeconds(usage),
          capacity: prev?.key === key ? prev.capacity : 0,
          error: describeError(e),
        }))
    );
    return () => {
      live = false;
    };
    // `key` covers the range, the plan and the capacity query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshSignal, reportRefreshed]);
  const current = loaded?.key === key ? loaded : null;
  return {
    loading: current === null,
    error: current?.error ?? null,
    rows: current?.rows ?? [],
    windowSeconds: current?.windowSeconds ?? rangeSeconds(usage),
    capacity: current?.capacity ?? 0,
  };
}

function Loading(): JSX.Element {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
      <CircularProgress size={24} aria-label="Loading usage" />
    </Box>
  );
}

function Message(props: {
  severity: 'error' | 'warning' | 'info';
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Alert severity={props.severity} sx={{ mb: 1 }}>
      {props.children}
    </Alert>
  );
}

function UsageSunburstWidget({
  config,
  filters,
  refreshSignal,
  reportRefreshed,
  kiosk,
  cache,
}: WidgetProps<UsageWidgetConfig>): JSX.Element {
  const resource: SunburstResource = config.resource === 'memory' ? 'memory' : 'cpu';
  const cap = React.useMemo(() => ({ resource, nodes: filters.nodes }), [resource, filters.nodes]);
  const state = useUsageData(
    filters.range,
    config.groupBy,
    config.labelKey,
    cap,
    refreshSignal,
    reportRefreshed,
    cache
  );
  const data = React.useMemo(
    () =>
      buildSunburst(state.rows, {
        resource,
        group: config.groupBy,
        labelKey: config.labelKey,
        windowSeconds: state.windowSeconds,
        namespaces: filters.namespaces,
        nodes: filters.nodes,
        capacity: state.capacity,
      }),
    [
      state.rows,
      state.windowSeconds,
      state.capacity,
      resource,
      config.groupBy,
      config.labelKey,
      filters.namespaces,
      filters.nodes,
    ]
  );
  if (state.loading) return <Loading />;
  const failed = state.error && state.rows.length === 0;
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {state.error && (
        <Message severity={failed ? 'error' : 'warning'}>
          {failed
            ? `Could not query the metrics service: ${state.error}`
            : `Refresh failed, showing the last data: ${state.error}`}
        </Message>
      )}
      {!failed && data.categories.length === 0 && (
        <Message severity="info">No usage metrics match the current filters.</Message>
      )}
      {!failed && data.categories.length > 0 && (
        <Box sx={{ flex: '1 1 0', minHeight: 0 }}>
          <SunburstChart
            data={data}
            title={resource === 'cpu' ? 'CPU' : 'Memory'}
            format={resource === 'cpu' ? formatCores : formatBytes}
            kiosk={kiosk}
          />
        </Box>
      )}
    </Box>
  );
}

function UsageDonutWidget({
  config,
  filters,
  refreshSignal,
  reportRefreshed,
  kiosk,
  cache,
}: WidgetProps<UsageWidgetConfig>): JSX.Element {
  const theme = useTheme();
  const def = RESOURCES.find(r => r.id === config.resource) ?? RESOURCES[0];
  const state = useUsageData(
    filters.range,
    config.groupBy,
    config.labelKey,
    null,
    refreshSignal,
    reportRefreshed,
    cache
  );
  const view = React.useMemo(() => {
    const ctx = buildContext([], []);
    const rows = filterRows(state.rows, { namespaces: filters.namespaces, nodes: filters.nodes });
    const groups = aggregate(rows, groupingOf(config.groupBy, config.labelKey), ctx);
    const slices = slicesFor(groups, def.measure);
    return {
      slices,
      total: totalOf(groups, def.measure),
      fallback: new Set(groups.filter(g => g.fallback).map(g => g.key)),
    };
  }, [state.rows, filters.namespaces, filters.nodes, config.groupBy, config.labelKey, def.measure]);
  const colourOf = React.useMemo(
    () =>
      assignColours(
        view.slices.map(s => s.key).sort(),
        theme.palette.mode === 'dark' ? 'dark' : 'light'
      ),
    [view.slices, theme.palette.mode]
  );
  if (state.loading) return <Loading />;
  const failed = state.error && state.rows.length === 0;
  return (
    <Box
      data-donut-scroll
      sx={{
        height: '100%',
        // The whole widget scrolls, so every group of the legend is reachable. In the kiosk it scrolls by
        // touch, with no visible scrollbar.
        overflowY: 'auto',
        minWidth: 0,
        ...(kiosk ? { scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } } : {}),
      }}
    >
      {state.error && (
        <Message severity={failed ? 'error' : 'warning'}>
          {failed
            ? `Could not query the metrics service: ${state.error}`
            : `Refresh failed, showing the last data: ${state.error}`}
        </Message>
      )}
      {!failed && (
        // The card already has a border and a width, so the donut card loses its own here.
        <Box
          sx={{
            // The legend list of the donut card has its own height limit. Here the widget scrolls instead.
            '& ul[aria-label$=" groups"]': { maxHeight: 'none', overflowY: 'visible' },
            '& > .MuiPaper-root': {
              minWidth: 0,
              flex: 'none',
              border: 0,
              boxShadow: 'none',
              backgroundColor: 'transparent',
              p: 0,
            },
          }}
        >
          <DonutCard
            def={def}
            slices={view.slices}
            total={view.total}
            windowSeconds={state.windowSeconds}
            colourOf={colourOf}
            nameOf={key => displayKey(key, [])}
            fallbackKeys={view.fallback}
          />
        </Box>
      )}
    </Box>
  );
}

export const usageSunburstWidget: WidgetDefinition<UsageWidgetConfig> = {
  type: 'usage.sunburst',
  title: 'Usage sunburst',
  description:
    'CPU or memory use as a sunburst of the whole cluster: every group at its real size.',
  icon: 'mdi:chart-donut',
  category: 'Charts',
  defaultSize: { w: 4, h: 10 },
  minSize: { w: 3, h: 6 },
  defaultConfig: { resource: 'cpu', groupBy: 'namespace', labelKey: '' },
  configSchema: [
    {
      key: 'resource',
      label: 'Resource',
      type: 'select',
      options: [
        { value: 'cpu', label: 'CPU' },
        { value: 'memory', label: 'Memory' },
      ],
    },
    { key: 'groupBy', label: 'Group by', type: 'select', options: GROUP_OPTIONS },
    LABEL_FIELD,
  ],
  Component: UsageSunburstWidget,
};

export const usageDonutWidget: WidgetDefinition<UsageWidgetConfig> = {
  type: 'usage.donut',
  title: 'Usage donut',
  description: 'One donut for a resource, with a legend of every group.',
  icon: 'mdi:chart-donut-variant',
  category: 'Charts',
  defaultSize: { w: 4, h: 10 },
  minSize: { w: 3, h: 6 },
  defaultConfig: { resource: 'cpu', groupBy: 'namespace', labelKey: '' },
  configSchema: [
    {
      key: 'resource',
      label: 'Resource',
      type: 'select',
      options: RESOURCES.map(r => ({ value: r.id, label: r.label })),
    },
    { key: 'groupBy', label: 'Group by', type: 'select', options: GROUP_OPTIONS },
    LABEL_FIELD,
  ],
  selfScroll: true,
  Component: UsageDonutWidget,
};

function UsageDashboardRingsWidget({
  config,
  refreshSignal,
  reportRefreshed,
  kiosk,
}: WidgetProps<UsageRingsConfig>): JSX.Element {
  return (
    <UsageRings
      config={{ ...config, rings: ringsOf(config.rings) }}
      refreshSignal={refreshSignal}
      reportRefreshed={reportRefreshed}
      kiosk={kiosk}
    />
  );
}

/** The Usage > Dashboard page as a widget. It has its own filters, so it ignores the dashboard ones. */
export const usageDashboardRingsWidget: WidgetDefinition<UsageRingsConfig> = {
  type: 'usage.dashboard-rings',
  title: 'Usage dashboard rings',
  description:
    'The Usage dashboard: CPU and memory sunbursts of every node, with tap to zoom, back, details and filters.',
  icon: 'mdi:chart-donut',
  category: 'Charts',
  defaultSize: { w: 12, h: 18 },
  minSize: { w: 4, h: 10 },
  defaultConfig: DEFAULT_RINGS_CONFIG,
  configSchema: [
    {
      key: 'rings',
      label: 'Rings',
      type: 'number',
      min: MIN_RINGS,
      max: MAX_RINGS,
      step: 1,
      help: 'Rings in each chart at the start. The widget has its own ring toggle.',
    },
    {
      key: 'filters',
      label: 'Show node and category filters',
      type: 'boolean',
    },
  ],
  selfScroll: true,
  Component: UsageDashboardRingsWidget,
};

export const USAGE_WIDGETS: Array<WidgetDefinition<any>> = [
  usageSunburstWidget,
  usageDonutWidget,
  usageDashboardRingsWidget,
];

/** Registers the widgets. Safe in any plugin load order (see dashboardsContract.ts). */
export function registerUsageWidgets(): void {
  for (const w of USAGE_WIDGETS) registerDashboardWidget(w);
}

registerUsageWidgets();
