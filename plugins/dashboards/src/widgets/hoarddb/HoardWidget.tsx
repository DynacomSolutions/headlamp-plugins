/*
 * The HoardDB widget (`hoarddb.engines`): one widget for the engines and the nodes that run them.
 * It reads four panels of a HoardDB source (`engines`, `clusters`, `replication` and `failback`) and
 * joins them in the browser (see `join.ts`). Each panel is fetched like the panel widget does,
 * never sooner than the panel's own `refreshSeconds`.
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
import { HoardView } from './HoardView';
import { joinHoard } from './join';

export interface HoardConfig {
  /** The id of the HoardDB panel source. */
  source: string;
}

/** The panel ids that the HoardDB source serves for this widget. */
export const HOARD_PANELS = {
  engines: 'engines',
  clusters: 'clusters',
  replication: 'replication',
  failback: 'failback',
} as const;

export function HoardWidget({
  config,
  refreshSignal,
  reportRefreshed,
  editing,
}: WidgetProps<HoardConfig>): JSX.Element {
  const sourceId = sourceOf(config);
  const { source, pending } = useSourceLookup(sourceId);
  const list = usePanelList(source, sourceId);
  const min = (id: string): number => list.panels.find(p => p.id === id)?.refreshSeconds ?? 0;
  const engines = usePanel(
    source,
    HOARD_PANELS.engines,
    refreshSignal,
    min(HOARD_PANELS.engines),
    reportRefreshed,
    sourceId
  );
  const clusters = usePanel(
    source,
    HOARD_PANELS.clusters,
    refreshSignal,
    min(HOARD_PANELS.clusters),
    reportRefreshed,
    sourceId
  );
  const replication = usePanel(
    source,
    HOARD_PANELS.replication,
    refreshSignal,
    min(HOARD_PANELS.replication),
    reportRefreshed,
    sourceId
  );
  const failback = usePanel(
    source,
    HOARD_PANELS.failback,
    refreshSignal,
    min(HOARD_PANELS.failback),
    reportRefreshed,
    sourceId
  );
  const states = [engines, clusters, replication, failback];
  useReportStale(
    states.reduce<number | undefined>(
      (a, s) =>
        s.staleSince === undefined ? a : a === undefined ? s.staleSince : Math.min(a, s.staleSince),
      undefined
    )
  );
  const model = React.useMemo(
    () =>
      joinHoard({
        engines: engines.panel,
        clusters: clusters.panel,
        replication: replication.panel,
        failback: failback.panel,
      }),
    [engines.panel, clusters.panel, replication.panel, failback.panel]
  );
  if (states.some(s => s.loading) || pending) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
        <CircularProgress size={24} aria-label="Loading the HoardDB data" />
      </Box>
    );
  }
  const failed = states.find(s => s.error);
  const none = states.every(s => !s.panel);
  return (
    <Box sx={{ height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {failed && (
        <Alert severity={none ? 'error' : 'warning'} sx={{ mb: 1, flex: 'none' }}>
          {none
            ? `Could not load the HoardDB data: ${failed.error}`
            : `Refresh failed, showing the last data: ${failed.error}`}
        </Alert>
      )}
      {!none && (
        <Box sx={{ flex: '1 1 0', minHeight: 0, minWidth: 0 }}>
          <HoardView model={model} source={source} sourceId={sourceId} editing={editing} />
        </Box>
      )}
    </Box>
  );
}

function HoardSettings(props: WidgetSettingsProps<HoardConfig>): JSX.Element {
  // Only the source is a setting. The four panels are fixed, so there is no panel choice.
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
        helperText="The panel source that serves the engines, clusters, replication and failback panels."
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

export const hoardWidget: WidgetDefinition<HoardConfig> = {
  type: 'hoarddb.engines',
  title: 'HoardDB engines and nodes',
  description:
    'One tile for each database engine: its icon, a ring with one section for each node that runs it, and its database count.',
  icon: 'mdi:database',
  category: 'Monitoring',
  defaultSize: { w: 3, h: 8 },
  minSize: { w: 2, h: 4 },
  defaultConfig: { source: 'hoarddb' },
  SettingsComponent: HoardSettings,
  selfScroll: false,
  Component: HoardWidget,
};
