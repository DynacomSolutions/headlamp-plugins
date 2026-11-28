/*
 * The runner widget (`runners.overview`): the pools, the queue and the running workflow runs of one
 * runner source in one widget. It reads the `pools` and `queue` panels. It reads the `runs` panel
 * and the `repos` panel and the `nodes` panel when the source serves them (see `join.ts`). Each panel is fetched like the
 * panel widget does, never sooner than the panel's own `refreshSeconds`. With the `runs` panel the
 * list is a tree: repository, then branch or pull request, then workflow, then job. A click opens
 * or folds a row in place. The open rows are in the page URL, in the param `w.<instanceId>` (see
 * `RunnersView.tsx`).
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
import { expandOf, RunnersView, VIEW_MODES, viewOf } from './RunnersView';

export interface RunnersConfig {
  /** The id of the runner panel source. */
  source: string;
  /**
   * What to draw: `full` (default: tiles, rings and list), `summary` (tiles and rings in one
   * strip) or `list` (the tree only).
   */
  view?: 'full' | 'summary' | 'list';
  /** `all` opens every repo, branch, workflow and job at first. A missing value keeps the default (repos folded). */
  expand?: 'all';
}

/** The panel ids that the runner source serves. `runs`, `repos` and `nodes` are optional. */
export const RUNNER_PANELS = {
  pools: 'pools',
  queue: 'queue',
  runs: 'runs',
  repos: 'repos',
  nodes: 'nodes',
} as const;

export function RunnersWidget({
  instanceId,
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
  // The `repos` panel is optional too, with the same rule.
  const hasRepos = list.panels.some(p => p.id === RUNNER_PANELS.repos);
  const repos = usePanel(
    source,
    hasRepos ? RUNNER_PANELS.repos : '',
    refreshSignal,
    min(RUNNER_PANELS.repos),
    reportRefreshed,
    sourceId
  );
  // The `nodes` panel (Runwarden's own CPU figure for each node) is optional, with the same rule.
  const hasNodes = list.panels.some(p => p.id === RUNNER_PANELS.nodes);
  const nodes = usePanel(
    source,
    hasNodes ? RUNNER_PANELS.nodes : '',
    refreshSignal,
    min(RUNNER_PANELS.nodes),
    reportRefreshed,
    sourceId
  );
  const states = [
    pools,
    queue,
    ...(hasRuns ? [runs] : []),
    ...(hasRepos ? [repos] : []),
    ...(hasNodes ? [nodes] : []),
  ];
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
        repos: hasRepos ? repos.panel : null,
        nodes: hasNodes ? nodes.panel : null,
      }),
    [pools.panel, queue.panel, runs.panel, repos.panel, nodes.panel, hasRuns, hasRepos, hasNodes]
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
          <RunnersView
            model={model}
            instanceId={instanceId}
            editing={!!editing}
            view={viewOf(config.view)}
            expand={expandOf(config.expand)}
          />
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
        onChange={e => onChange({ ...config, source: e.target.value })}
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
      <TextField
        select
        size="small"
        label="View"
        value={viewOf(config.view)}
        helperText="Full: tiles, rings and list. Summary: tiles and rings in one strip. List: the tree of repos, branches, workflows and jobs only."
        onChange={e => onChange({ ...config, view: e.target.value as RunnersConfig['view'] })}
      >
        {VIEW_MODES.map(v => (
          <MenuItem key={v} value={v}>
            {v === 'full' ? 'Full' : v === 'summary' ? 'Summary' : 'List'}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        size="small"
        label="Open at first"
        value={expandOf(config.expand)}
        helperText="Default: the repos are folded. All: every repo, branch, workflow and job is open."
        onChange={e => {
          const next: RunnersConfig = { ...config };
          if (e.target.value === 'all') next.expand = 'all';
          else delete next.expand;
          onChange(next);
        }}
      >
        <MenuItem value="default">Repos only</MenuItem>
        <MenuItem value="all">Everything</MenuItem>
      </TextField>
    </Box>
  );
}

export const runnersWidget: WidgetDefinition<RunnersConfig> = {
  type: 'runners.overview',
  title: 'Runner pools and queue',
  description:
    'One ring for each runner pool, the totals, and a tree of running and queued jobs by repository, branch or pull request and workflow.',
  icon: 'mdi:server-network',
  category: 'Monitoring',
  defaultSize: { w: 3, h: 8 },
  minSize: { w: 3, h: 6 },
  defaultConfig: { source: 'runners' },
  SettingsComponent: RunnersSettings,
  selfScroll: false,
  Component: RunnersWidget,
};
