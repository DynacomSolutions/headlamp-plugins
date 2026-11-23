/*
 * The widget that the Workflows plugin adds to the Dashboards plugin, through the cross-plugin
 * `window.headlampDashboards` contract (see dashboardsContract.ts):
 *   workflows.status  Every workflow and CronJob in groups, worst first: status, last success and next due.
 * Settings: `onlyFailing` (show only failing or overdue rows) and `groupBy` (`auto`, `namespace`, `prefix`).
 * Dashboard filters: the namespaces (rows with a namespace). The widget fetches when the dashboard
 * refreshes (`refreshSignal`) or a filter changes, never on its own timer.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import React from 'react';
import { createPortal } from 'react-dom';
import { StatusChip, SummaryBar, TimeCell, WorkloadStatusChip } from './cells';
import { registerDashboardWidget, WidgetDefinition, WidgetProps } from './dashboardsContract';
import { Loaded, loadRaw, useSettings } from './data';
import {
  buildAll,
  DEFAULT_WIDGET_CONFIG,
  formatExit,
  formatNextDue,
  groupRows,
  healthSummary,
  isProblem,
  isUnhealthy,
  normaliseConfig,
  Row,
  summarise,
  WidgetConfig,
  WorkloadRow,
} from './model';

export { normaliseConfig };

/** The rows that the dashboard namespace filter and `onlyFailing` leave. */
/** The unhealthy workloads that the dashboard namespace filter leaves. */
export function visibleWorkloads(workloads: WorkloadRow[], namespaces: string[]): WorkloadRow[] {
  return workloads.filter(w => isUnhealthy(w) && (namespaces.length === 0 || namespaces.includes(w.namespace)));
}

export function visibleRows(rows: Row[], namespaces: string[], onlyFailing: boolean): Row[] {
  return rows.filter(r => {
    if (namespaces.length > 0 && r.namespace && !namespaces.includes(r.namespace)) return false;
    return !onlyFailing || isProblem(r);
  });
}

function WorkflowsStatusWidget(props: WidgetProps<WidgetConfig>): JSX.Element {
  const config = normaliseConfig(props.config);
  const settings = useSettings();
  const [state, setState] = React.useState<Loaded>({ loading: true });
  const { reportRefreshed } = props;
  React.useEffect(() => {
    let alive = true;
    loadRaw(settings)
      .then(({ raw, kubeError }) => {
        if (!alive) return;
        const at = Date.now();
        setState({ raw, kubeError, loading: false, at });
        reportRefreshed(at);
      })
      .catch(e => alive && setState(s => ({ ...s, error: String(e?.message || e), loading: false })));
    return () => {
      alive = false;
    };
  }, [settings, props.refreshSignal, reportRefreshed]);

  const now = Math.floor((state.at ?? Date.now()) / 1000);
  const built = React.useMemo(
    () => (state.raw ? buildAll(state.raw, settings.cronJobNamespaces, now) : undefined),
    [state.raw, settings.cronJobNamespaces, now]
  );
  const rows = built?.rows;
  // The widget lists the workloads that are not healthy, never the healthy ones.
  const workloads = React.useMemo(
    () => (built ? visibleWorkloads(built.workloads, props.filters.namespaces) : []),
    [built, props.filters.namespaces]
  );
  const health = rows ? healthSummary(visibleRows(rows, props.filters.namespaces, false), workloads) : undefined;
  const shown = React.useMemo(
    () => (rows ? visibleRows(rows, props.filters.namespaces, config.onlyFailing) : []),
    [rows, props.filters.namespaces, config.onlyFailing]
  );
  const groups = React.useMemo(() => groupRows(shown, config.groupBy), [shown, config.groupBy]);
  const counts = summarise(shown);

  const summary = rows
    ? `${counts.total} ${counts.total === 1 ? 'workflow' : 'workflows'}, ${counts.failing} failing, ${counts.overdue} overdue, ${counts.neverRun} never run, ${workloads.length} unhealthy workloads`
    : '';
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {state.error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          Could not read workflow series: {state.error}
        </Alert>
      )}
      {state.kubeError && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          CronJobs and workloads are missing: {state.kubeError}
        </Alert>
      )}
      {state.loading && !rows && <CircularProgress size={20} />}
      {health && (
        <Box sx={{ mb: 1 }}>
          <SummaryBar summary={health} />
        </Box>
      )}
      {rows && shown.length === 0 && workloads.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {config.onlyFailing && rows.length > 0 ? 'No failing or overdue workflows.' : 'No workflows.'}
        </Typography>
      )}
      <Box sx={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto' }} role="list" aria-label="Workflows">
        {groups.map(g => (
          <Box key={g.key} role="listitem" sx={{ mb: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, px: 0.5, py: 0.25, bgcolor: 'action.hover' }}>
              <Typography variant="subtitle2" component="span">
                {g.key}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="span">
                {g.rows.length}
              </Typography>
            </Box>
            {g.rows.map(r => (
              <Box
                key={r.id}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '92px minmax(0, 1fr) auto auto',
                  gap: 1,
                  alignItems: 'center',
                  px: 0.5,
                  py: 0.25,
                  borderBottom: 1,
                  borderColor: 'divider',
                }}
              >
                <StatusChip row={r} />
                <Typography variant="body2" noWrap title={r.name}>
                  {r.name}
                </Typography>
                <Typography variant="caption" color="text.secondary" component="span" sx={{ whiteSpace: 'nowrap' }}>
                  <TimeCell ts={r.lastSuccess} now={now} />
                </Typography>
                <Typography variant="caption" color="text.secondary" component="span" sx={{ whiteSpace: 'nowrap', minWidth: 80, textAlign: 'right' }}>
                  {formatNextDue(r, now)}
                </Typography>
              </Box>
            ))}
          </Box>
        ))}
        {workloads.length > 0 && (
          <Box role="listitem" sx={{ mb: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, px: 0.5, py: 0.25, bgcolor: 'action.hover' }}>
              <Typography variant="subtitle2" component="span">
                Workloads
              </Typography>
              <Typography variant="caption" color="text.secondary" component="span">
                {workloads.length}
              </Typography>
            </Box>
            {workloads.map(w => (
              <Box
                key={w.id}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '92px minmax(0, 1fr) auto auto',
                  gap: 1,
                  alignItems: 'center',
                  px: 0.5,
                  py: 0.25,
                  borderBottom: 1,
                  borderColor: 'divider',
                }}
              >
                <WorkloadStatusChip row={w} />
                <Typography variant="body2" noWrap title={`${w.namespace}/${w.name}`}>
                  {w.name}
                </Typography>
                <Typography variant="caption" color="text.secondary" component="span" sx={{ whiteSpace: 'nowrap' }}>
                  {w.ready}/{w.desired} ready
                </Typography>
                <Typography variant="caption" color="text.secondary" component="span" sx={{ whiteSpace: 'nowrap', minWidth: 80, textAlign: 'right' }}>
                  {formatExit(w.lastExit)}
                </Typography>
              </Box>
            ))}
          </Box>
        )}
      </Box>
      {props.footer && summary ? (
        createPortal(<span>{summary}</span>, props.footer)
      ) : summary ? (
        <Typography variant="caption" color="text.secondary">
          {summary}
        </Typography>
      ) : null}
    </Box>
  );
}

export const workflowsStatusWidget: WidgetDefinition<WidgetConfig> = {
  type: 'workflows.status',
  title: 'Workflows',
  description: 'Every recurring job of an app and every CronJob, with status, last success and next due. Failing and overdue first.',
  icon: 'mdi:timer-sync-outline',
  category: 'Monitoring',
  defaultSize: { w: 6, h: 10 },
  minSize: { w: 3, h: 4 },
  defaultConfig: DEFAULT_WIDGET_CONFIG,
  configSchema: [
    { key: 'onlyFailing', label: 'Only failing or overdue workflows', type: 'boolean' },
    {
      key: 'groupBy',
      label: 'Group by',
      type: 'select',
      help: 'Automatic uses the namespace label of the series, else the metric prefix.',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'namespace', label: 'Namespace' },
        { value: 'prefix', label: 'Metric prefix' },
      ],
    },
  ],
  // The widget scrolls only its list. The footer line stays fixed.
  selfScroll: false,
  Component: WorkflowsStatusWidget,
};

/** Registers the widget. Safe in any plugin load order (see dashboardsContract.ts). */
export function registerWorkflowWidgets(): void {
  registerDashboardWidget(workflowsStatusWidget);
}

registerWorkflowWidgets();
