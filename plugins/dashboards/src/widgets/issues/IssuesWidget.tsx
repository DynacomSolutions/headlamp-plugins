/*
 * The alerts and incidents widget (`agent.issues`): one widget for the alerts and the incidents of
 * an agent source. It reads two panels of the source (`alerts` and `incidents`) and joins them in
 * the browser (see `join.ts`). Each panel is fetched like the panel widget does, never sooner than
 * the panel's own `refreshSeconds`. It replaces the separate Alerts and Incidents panels.
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
import { AGENT_SOURCE_ID } from '../panels/sources';
import { useSourceLookup, useSources } from '../panels/sourcesConfig';
import { IssuesView } from './IssuesView';
import { joinIssues } from './join';

export interface IssuesConfig {
  /** The id of the panel source that serves the `alerts` and `incidents` panels. */
  source: string;
}

/** The panel ids that the source serves. */
export const ISSUE_PANELS = { alerts: 'alerts', incidents: 'incidents' } as const;

export function IssuesWidget({
  config,
  refreshSignal,
  reportRefreshed,
  editing,
  kiosk,
}: WidgetProps<IssuesConfig>): JSX.Element {
  const sourceId = sourceOf(config);
  const { source, pending } = useSourceLookup(sourceId);
  const list = usePanelList(source, sourceId);
  const min = (id: string): number => list.panels.find(p => p.id === id)?.refreshSeconds ?? 0;
  const alerts = usePanel(
    source,
    ISSUE_PANELS.alerts,
    refreshSignal,
    min(ISSUE_PANELS.alerts),
    reportRefreshed,
    sourceId
  );
  const incidents = usePanel(
    source,
    ISSUE_PANELS.incidents,
    refreshSignal,
    min(ISSUE_PANELS.incidents),
    reportRefreshed,
    sourceId
  );
  const states = [alerts, incidents];
  useReportStale(
    states.reduce<number | undefined>(
      (a, s) =>
        s.staleSince === undefined ? a : a === undefined ? s.staleSince : Math.min(a, s.staleSince),
      undefined
    )
  );
  const model = React.useMemo(
    () => joinIssues({ alerts: alerts.panel, incidents: incidents.panel }),
    [alerts.panel, incidents.panel]
  );
  if (states.some(s => s.loading) || pending) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
        <CircularProgress size={24} aria-label="Loading the alerts and incidents" />
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
            ? `Could not load the alerts and incidents: ${failed.error}`
            : `Refresh failed, showing the last data: ${failed.error}`}
        </Alert>
      )}
      {!none && (
        <Box sx={{ flex: '1 1 0', minHeight: 0, minWidth: 0 }}>
          <IssuesView model={model} sourceId={sourceId} editing={editing} />
        </Box>
      )}
    </Box>
  );
}

function IssuesSettings(props: WidgetSettingsProps<IssuesConfig>): JSX.Element {
  // Only the source is a setting. The two panels are fixed, so there is no panel choice.
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
        helperText="The panel source that serves the alerts and incidents panels."
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

export const issuesWidget: WidgetDefinition<IssuesConfig> = {
  type: 'agent.issues',
  title: 'Alerts and incidents',
  description:
    'Alerts and incidents in one list. The same alert on the same target is one group with a count, a state and the agent status.',
  icon: 'mdi:alert-circle-outline',
  category: 'Monitoring',
  defaultSize: { w: 3, h: 23 },
  minSize: { w: 3, h: 8 },
  defaultConfig: { source: AGENT_SOURCE_ID },
  SettingsComponent: IssuesSettings,
  selfScroll: false,
  Component: IssuesWidget,
};
