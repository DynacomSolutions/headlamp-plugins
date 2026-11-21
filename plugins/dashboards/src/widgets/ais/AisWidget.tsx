/*
 * The AIS widget (`ais.limits`): one widget for the limits, the pools, the identities and the
 * sessions of an AIS source. It reads four panels of the source (`limits`, `identities`,
 * `claude-swap` and `agents`) and joins them in the browser (see `join.ts`). Each panel is fetched
 * like the panel widget does, never sooner than the panel's own `refreshSeconds`.
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
import { AisView } from './AisView';
import { joinAis } from './join';

export interface AisConfig {
  /** The id of the AIS panel source. */
  source: string;
  /**
   * `overview` (default) is the compact widget with stat tiles. `console` is the AIS tab: every
   * pool open with its members, the pool limits on the pool row, no stat tiles.
   */
  view?: 'overview' | 'console';
}

/** The panel ids that the AIS source serves. */
export const AIS_PANELS = {
  limits: 'limits',
  identities: 'identities',
  swap: 'claude-swap',
  agents: 'agents',
} as const;

export function AisWidget({
  config,
  refreshSignal,
  reportRefreshed,
  editing,
  kiosk,
}: WidgetProps<AisConfig>): JSX.Element {
  const sourceId = sourceOf(config);
  const { source, pending } = useSourceLookup(sourceId);
  const list = usePanelList(source, sourceId);
  const min = (id: string): number => list.panels.find(p => p.id === id)?.refreshSeconds ?? 0;
  const args = [refreshSignal, reportRefreshed] as const;
  const limits = usePanel(
    source,
    AIS_PANELS.limits,
    args[0],
    min(AIS_PANELS.limits),
    args[1],
    sourceId
  );
  const identities = usePanel(
    source,
    AIS_PANELS.identities,
    args[0],
    min(AIS_PANELS.identities),
    args[1],
    sourceId
  );
  const swap = usePanel(source, AIS_PANELS.swap, args[0], min(AIS_PANELS.swap), args[1], sourceId);
  const agents = usePanel(
    source,
    AIS_PANELS.agents,
    args[0],
    min(AIS_PANELS.agents),
    args[1],
    sourceId
  );
  const states = [limits, identities, swap, agents];
  useReportStale(
    states.reduce<number | undefined>(
      (a, s) =>
        s.staleSince === undefined ? a : a === undefined ? s.staleSince : Math.min(a, s.staleSince),
      undefined
    )
  );
  const model = React.useMemo(
    () =>
      joinAis({
        limits: limits.panel,
        identities: identities.panel,
        swap: swap.panel,
        agents: agents.panel,
      }),
    [limits.panel, identities.panel, swap.panel, agents.panel]
  );
  if (states.some(s => s.loading) || pending) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
        <CircularProgress size={24} aria-label="Loading the AIS data" />
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
            ? `Could not load the AIS data: ${failed.error}`
            : `Refresh failed, showing the last data: ${failed.error}`}
        </Alert>
      )}
      {!none && (
        <Box sx={{ flex: '1 1 0', minHeight: 0, minWidth: 0 }}>
          <AisView
            model={model}
            sourceId={sourceId}
            kiosk={kiosk}
            editing={editing}
            view={config.view}
          />
        </Box>
      )}
    </Box>
  );
}

function AisSettings(props: WidgetSettingsProps<AisConfig>): JSX.Element {
  // The source and the view are the settings. The four panels are fixed, so there is no panel choice.
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
        helperText="The panel source that serves the limits, identities, claude-swap and agents panels."
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
        value={config.view ?? 'overview'}
        helperText="The console view opens every pool with its members and shows the pool limits on the pool row."
        onChange={e => onChange({ ...config, view: e.target.value as AisConfig['view'] })}
      >
        <MenuItem value="overview">Overview</MenuItem>
        <MenuItem value="console">Console tab</MenuItem>
      </TextField>
    </Box>
  );
}

export const aisWidget: WidgetDefinition<AisConfig> = {
  type: 'ais.limits',
  title: 'AIS limits and pools',
  description:
    'Limits of every identity, grouped by pool and provider, with login state, sessions and the active pool member.',
  icon: 'mdi:console',
  category: 'Monitoring',
  defaultSize: { w: 6, h: 14 },
  minSize: { w: 4, h: 6 },
  defaultConfig: { source: 'ais-console' },
  SettingsComponent: AisSettings,
  selfScroll: false,
  Component: AisWidget,
};
