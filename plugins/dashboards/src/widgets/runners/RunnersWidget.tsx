/*
 * The runner widget (`runners.overview`): the pools, the queue and the running workflow runs of one
 * runner source in one widget. It reads the `pools` and `queue` panels, and the `runs` panel when
 * the source serves it (see `join.ts`). Each panel is fetched like the panel widget does, never
 * sooner than the panel's own `refreshSeconds`.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import React from 'react';
import type { WidgetDefinition, WidgetProps, WidgetSettingsProps } from '../../contract';
import { useReportStale } from '../../resilience/stale';
import { usePanel, usePanelList } from '../panels/data';
import { sourceOf } from '../panels/PanelPicker';
import { useSourceLookup, useSources } from '../panels/sourcesConfig';
import { joinRunners } from './join';
import { RunnersView } from './RunnersView';

export interface RunnersConfig {
  /** The id of the runner panel source. */
  source: string;
}

/** The panel ids that the runner source serves. `runs` is optional. */
export const RUNNER_PANELS = { pools: 'pools', queue: 'queue', runs: 'runs' } as const;

export function RunnersWidget({
  config,
  refreshSignal,
  reportRefreshed,
  editing,
  kiosk,
}: WidgetProps<RunnersConfig>): JSX.Element {
  const sourceId = sourceOf(config);
  const { source, pending } = useSourceLookup(sourceId);
  const list = usePanelList(source, sourceId);
  const min = (id: string): number => list.panels.find(p => p.id === id)?.refreshSeconds ?? 0;
  // The `runs` panel is optional: ask for it only when the source lists it, so a source with no
  // such panel never gets a request that fails.
  const hasRuns = list.panels.some(p => p.id === RUNNER_PANELS.runs);
  const pools = usePanel(
    source,
    RUNNER_PANELS.pools,
    refreshSignal,
    min(RUNNER_PANELS.pools),
    reportRefreshed,
    sourceId
  );
  const queue = usePanel(
    source,
    RUNNER_PANELS.queue,
    refreshSignal,
    min(RUNNER_PANELS.queue),
    reportRefreshed,
    sourceId
  );
  const runs = usePanel(
    source,
    hasRuns ? RUNNER_PANELS.runs : '',
    refreshSignal,
    min(RUNNER_PANELS.runs),
    reportRefreshed,
    sourceId
  );
  const states = [pools, queue, ...(hasRuns ? [runs] : [])];
  useReportStale(
    states.reduce<number | undefined>(
      (a, s) =>
        s.staleSince === undefined ? a : a === undefined ? s.staleSince : Math.min(a, s.staleSince),
      undefined
    )
  );
  const model = React.useMemo(
    () =>
      joinRunners({
        pools: pools.panel,
        queue: queue.panel,
        runs: hasRuns ? runs.panel : null,
      }),
    [pools.panel, queue.panel, runs.panel, hasRuns]
  );
  if (states.some(s => s.loading) || list.loading || pending) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
        <CircularProgress size={24} aria-label="Loading the runner data" />
      </Box>
    );
  }
  const failed = states.find(s => s.error);
  const none = states.every(s => !s.panel);
  return (
    <Box sx={{ height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {failed && !(kiosk && !none) && (
        <Alert severity={none ? 'error' : 'warning'} sx={{ mb: 1, flex: 'none' }}>
          {none
            ? `Could not load the runner data: ${failed.error}`
            : `Refresh failed, showing the last data: ${failed.error}`}
        </Alert>
      )}
      {!none && (
        <Box sx={{ flex: '1 1 0', minHeight: 0, minWidth: 0 }}>
          <RunnersView model={model} sourceId={sourceId} editing={!!editing} />
        </Box>
      )}
    </Box>
  );
}

function RunnersSettings(props: WidgetSettingsProps<RunnersConfig>): JSX.Element {
  // Only the source is a setting. The panels are fixed, so there is no panel choice.
  const { config, onChange } = props;
  const sources = useSources();
  const sourceId = sourceOf(config);
  const { source, pending } = useSourceLookup(sourceId);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      <TextField
        select
        size="small"
        label="Source"
        value={sourceId}
        helperText="The panel source that serves the pools and queue panels, and the optional runs panel."
        onChange={e => onChange({ source: e.target.value })}
      >
        {!source && (
          <MenuItem value={sourceId}>
            {sourceId} ({pending ? 'loading' : 'not configured'})
          </MenuItem>
        )}
        {sources.map(s => (
          <MenuItem key={s.id} value={s.id}>
            {s.title}
          </MenuItem>
        ))}
      </TextField>
    </Box>
  );
}

export const runnersWidget: WidgetDefinition<RunnersConfig> = {
  type: 'runners.overview',
  title: 'Runner pools and queue',
  description:
    'One ring for each runner pool, the totals, and a tree of running and queued workflow runs with their jobs and steps.',
  icon: 'mdi:server-network',
  category: 'Monitoring',
  defaultSize: { w: 3, h: 8 },
  minSize: { w: 3, h: 6 },
  defaultConfig: { source: 'runners' },
  SettingsComponent: RunnersSettings,
  selfScroll: false,
  Component: RunnersWidget,
};
