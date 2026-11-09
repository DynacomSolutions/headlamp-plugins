/* The Usage page: controls, one donut per resource, and a table of all groups. */
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import { useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { Controls } from './Controls';
import { ClusterMeta, useClusterMeta, useMetricLabelNames, useUsage } from './data';
import { DonutCard } from './DonutCard';
import {
  aggregate,
  applyDrill,
  buildContext,
  canDrill,
  coverageCaption,
  displayKey,
  effectiveGroupBy,
  filterGroups,
  filterRows,
  groupKeyOf,
  LABEL_PREFIX,
  labelKeys,
  mergeLabelKeys,
  nextGroupBy,
  planFor,
  slicesFor,
  totalOf,
} from './model';
import { assignColours } from './palette';
import { isRecordedLabel, isRecordedRange, rangeSeconds, RECORDED_UNAVAILABLE, refreshIntervalMs, RESOURCES } from './resources';
import { parseState, serialiseState, UsageState } from './urlState';
import { sortGroups, SortKey, SortState, UsageTable } from './UsageTable';

const groupLabel = (g: string) => (g.startsWith(LABEL_PREFIX) ? `label ${g.slice(LABEL_PREFIX.length)}` : g);
const sortedUnique = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort();

export function UsagePage(): JSX.Element {
  const history = useHistory();
  const location = useLocation();
  const theme = useTheme();
  const state = React.useMemo(() => parseState(location.search), [location.search]);
  const plan = planFor(state.groupBy, state.drill);
  const recorded = isRecordedRange(state.range);
  // Recorded data has no per-pod detail and carries only a few pod labels.
  const badLabel = !!plan.labelKey && !isRecordedLabel(plan.labelKey);
  const unavailable = recorded && (plan.live || badLabel);
  const usage = useUsage(state.range, plan, !unavailable);
  const metricLabelNames = useMetricLabelNames();
  const meta: ClusterMeta = useClusterMeta();
  const [sort, setSort] = React.useState<SortState | null>(null);

  // The URL is the single source of truth; every control change replaces it.
  const patch = (p: Partial<UsageState>) => {
    history.replace({ pathname: location.pathname, search: serialiseState({ ...state, ...p }) });
  };

  const ctx = React.useMemo(() => buildContext(meta.pods, meta.services), [meta.pods, meta.services]);
  const defs = RESOURCES.filter(r => state.resources.includes(r.id));
  // Recorded views cover only the part of the window that has recorded data.
  const windowSeconds = usage.coverage?.coveredSeconds ?? rangeSeconds(state.range);

  const scoped = filterRows(usage.rows, state);
  const baseRows = filterGroups(scoped, state.groupBy, ctx, state);
  const drilled = applyDrill(baseRows, state.drill, ctx);
  const groupBy = effectiveGroupBy(state.groupBy, state.drill);
  const groups = aggregate(drilled, groupBy, ctx);

  const slicesByResource = defs.map(d => ({ def: d, slices: slicesFor(groups, d.measure), total: totalOf(groups, d.measure) }));
  // Sorted, so a group keeps its colour when values reorder the slices between refreshes.
  const colourOf = assignColours(
    [...new Set(slicesByResource.flatMap(s => s.slices.map(x => x.key)))].sort(),
    theme.palette.mode === 'dark' ? 'dark' : 'light'
  );
  const fallbackKeys = new Set(groups.filter(g => g.fallback).map(g => g.key));
  const nameOf = (key: string) => displayKey(key, state.drill);

  const sortState: SortState = sort ?? { key: defs[0]?.id ?? 'key', dir: defs.length ? 'desc' : 'asc' };
  const onSort = (key: SortKey) =>
    setSort({ key, dir: sortState.key === key && sortState.dir === 'desc' ? 'asc' : key === 'key' ? 'asc' : 'desc' });

  // Recorded data has no per-pod rows, so a workload cannot be opened.
  const podDetailBlocked = recorded && nextGroupBy(groupBy) === 'pod';
  const select = canDrill(groupBy) && !podDetailBlocked ? (key: string) => patch({ drill: [...state.drill, { groupBy, key }] }) : undefined;

  const groupOptions = sortedUnique(scoped.map(r => groupKeyOf(r, state.groupBy, ctx)));
  const usesJoin = plan.live || (!!plan.labelKey && usage.labelSource === 'client');
  const placeKey = groupBy.startsWith(LABEL_PREFIX) ? `${groupBy.slice(LABEL_PREFIX.length)} label` : groupBy === 'service' ? 'matching Service' : groupBy === 'node' ? 'node' : '';
  // Over a day, pod counts are summed per day: a pod spanning midnight counts once per day.
  const podUnit = recorded ? 'pod-hours' : 'pods';
  const coverage = usage.coverage && !unavailable ? coverageCaption(usage.coverage) : null;
  const fallbackPods = groups.reduce((s, g) => s + g.fallbackPods, 0);

  let body: React.ReactNode;
  if (unavailable) {
    body = (
      <Alert severity="info">
        {plan.live && ['pod', 'service'].includes(state.groupBy) ? 'Service and pod grouping' : plan.live ? 'Pod detail' : 'This label'} is {RECORDED_UNAVAILABLE}. Choose 1h, 6h or 24h, or another grouping.
      </Alert>
    );
  } else if (usage.loading) {
    body = (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <CircularProgress aria-label="Loading usage" />
      </Box>
    );
  } else if (usage.recordedMissing) {
    body = <Alert severity="info">Long ranges need the usage recording rules (vmalert); see README</Alert>;
  } else if (usage.rows.length === 0 && usage.error) {
    body = <Alert severity="error">Could not query the metrics service: {usage.error}</Alert>;
  } else if (usage.rows.length === 0) {
    body = (
      <Alert severity="info">
        No usage metrics found for the last {state.range}. Check that cAdvisor metrics are scraped by the metrics service.
      </Alert>
    );
  } else if (defs.length === 0) {
    body = <Alert severity="info">Select at least one resource to show.</Alert>;
  } else if (groups.length === 0) {
    body = <Alert severity="info">No pods match the current filters.</Alert>;
  } else {
    body = (
      <>
        {usage.error && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Refresh failed, showing the last data received: {usage.error}
          </Alert>
        )}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mb: 3 }}>
          {slicesByResource.map(({ def, slices, total }) => (
            <DonutCard key={def.id} def={def} slices={slices} total={total} windowSeconds={windowSeconds} colourOf={colourOf} nameOf={nameOf} fallbackKeys={fallbackKeys} onSelect={select} />
          ))}
        </Box>
        <UsageTable groups={sortGroups(groups, defs, sortState)} defs={defs} windowSeconds={windowSeconds} sort={sortState} onSort={onSort} onSelect={select} nameOf={nameOf} />
      </>
    );
  }

  return (
    <SectionBox title="Usage">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Resource usage over the last {state.range}, grouped by {groupLabel(groupBy)}
        {state.drill.map((step, i) => ` in ${groupLabel(step.groupBy)} ${displayKey(step.key, state.drill.slice(0, i))}`).join('')}. Click a slice or row to drill down.
        {usage.updatedAt && ` Updated ${usage.updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, refreshing every ${refreshIntervalMs(state.range) / 60000} min.`}
      </Typography>
      <Controls
        recorded={recorded}
        state={state}
        patch={patch}
        namespaceOptions={sortedUnique(usage.rows.map(r => r.namespace))}
        nodeOptions={sortedUnique(usage.rows.map(r => r.node))}
        groupOptions={groupOptions}
        labelKeyOptions={mergeLabelKeys(labelKeys(meta.pods), metricLabelNames)}
      />
      {state.drill.length > 0 && (
        <Breadcrumbs aria-label="Drill-down" sx={{ mb: 2 }}>
          <Link component="button" variant="body2" onClick={() => patch({ drill: [] })}>
            All
          </Link>
          {state.drill.map((step, i) =>
            i === state.drill.length - 1 ? (
              <Typography key={i} variant="body2" color="text.primary">
                {displayKey(step.key, state.drill.slice(0, i))}
              </Typography>
            ) : (
              <Link key={i} component="button" variant="body2" onClick={() => patch({ drill: state.drill.slice(0, i + 1) })}>
                {displayKey(step.key, state.drill.slice(0, i))}
              </Link>
            )
          )}
        </Breadcrumbs>
      )}
      {recorded && canDrill(groupBy) && podDetailBlocked && !unavailable && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 2 }}>
          Opening a workload to see its pods is {RECORDED_UNAVAILABLE}: the recorded data has no per-pod detail.
        </Typography>
      )}
      {coverage && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 2 }}>
          {coverage}
        </Typography>
      )}
      {usesJoin && meta.error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Could not list Pods and Services, so label and Service grouping is unavailable: {meta.error}
        </Alert>
      )}
      {fallbackPods > 0 && placeKey && !usage.loading && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 2 }}>
          {fallbackPods} {podUnit === 'pods' && fallbackPods === 1 ? 'pod' : podUnit} shown under their workload because {podUnit === 'pods' && fallbackPods === 1 ? 'it has' : 'they have'} no {placeKey}
        </Typography>
      )}
      {body}
    </SectionBox>
  );
}
