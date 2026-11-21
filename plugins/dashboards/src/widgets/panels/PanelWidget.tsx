/*
 * The panel widget (`agent.panel`): shows one panel of a panel source (`GET /api/widgets`). The
 * source is the built-in agent or any source from the Dashboards settings. The user picks the
 * source and the panel in the widget settings. The widget fetches when the dashboard asks for
 * fresh data, never sooner than the panel's own `refreshSeconds`, and calls `reportRefreshed`.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import React from 'react';
import type {
  ConfigField,
  WidgetDefinition,
  WidgetProps,
  WidgetSettingsProps,
} from '../../contract';
import { useReportStale } from '../../resilience/stale';
import { SettingsForm } from '../SettingsForm';
import { usePanel, usePanelList } from './data';
import { sourceOf, SourcePanelConfig, SourcePanelPicker } from './PanelPicker';
import { DEFAULT_DISPLAY, displayOf, PanelView, RowLayout } from './PanelView';
import { AGENT_SOURCE_ID } from './sources';
import { useSourceLookup } from './sourcesConfig';

/** The source and panel, and how the panel draws (see `PanelDisplay`). */
export interface PanelConfig extends SourcePanelConfig {
  /** Missing in a saved widget from before these options: the default (on) applies. */
  showSummary?: boolean;
  showStats?: boolean;
  rowLayout?: RowLayout;
  seriesLimit?: number;
  seriesUnit?: string;
}

export function PanelWidget({
  config,
  refreshSignal,
  reportRefreshed,
  editing,
  kiosk,
}: WidgetProps<PanelConfig>): JSX.Element {
  const sourceId = sourceOf(config);
  const display = React.useMemo(() => displayOf(config), [config]);
  const { source, pending } = useSourceLookup(sourceId);
  const list = usePanelList(source, sourceId);
  const minSeconds = list.panels.find(p => p.id === config.panel)?.refreshSeconds ?? 0;
  const state = usePanel(
    source,
    config.panel,
    refreshSignal,
    minSeconds,
    reportRefreshed,
    sourceId
  );
  // A failed refresh keeps the last panel. The card then says since when the data is old.
  useReportStale(state.staleSince);

  if (!config.panel) {
    return (
      <Box sx={{ p: 1 }}>
        <Typography variant="body2" color="text.secondary">
          Choose a panel in the widget settings.
        </Typography>
      </Box>
    );
  }
  if (state.loading || pending) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
        <CircularProgress size={24} aria-label="Loading the panel" />
      </Box>
    );
  }
  return (
    <Box sx={{ height: '100%', minWidth: 0 }}>
      {state.error && !(kiosk && state.panel) && (
        <Alert severity={state.panel ? 'warning' : 'error'} sx={{ mb: 1 }}>
          {state.panel
            ? `Refresh failed, showing the last data: ${state.error}`
            : `Could not load the panel: ${state.error}`}
        </Alert>
      )}
      {state.panel && (
        <PanelView
          panel={state.panel}
          kiosk={kiosk}
          editing={editing}
          display={display}
          source={source}
        />
      )}
    </Box>
  );
}

const DISPLAY_FIELDS: ConfigField[] = [
  {
    key: 'seriesLimit',
    label: 'Series limit line',
    type: 'number',
    min: 0,
    help: 'A value that a series must stay under, for example 5. The series plot draws it as a labelled dashed line. 0 or empty: no line.',
  },
  {
    key: 'seriesUnit',
    label: 'Series unit',
    type: 'text',
    placeholder: 's',
    help: 'The unit after the numbers of the series plot, for example s.',
  },
  { key: 'showSummary', label: 'Show summary line', type: 'boolean' },
  { key: 'showStats', label: 'Show stat tiles', type: 'boolean' },
  {
    key: 'rowLayout',
    label: 'Row layout',
    type: 'select',
    help: 'List is a table. Grouped bars draws one bar per label, with a segment for each row (by its detail), and a legend. Stacked lanes splits each bar into one lane for each limit that the label has.',
    options: [
      { value: 'list', label: 'List' },
      { value: 'grouped-bars', label: 'Grouped bars' },
      { value: 'stacked-lanes', label: 'Stacked lanes' },
    ],
  },
];

function PanelSettings(props: WidgetSettingsProps<PanelConfig>): JSX.Element {
  const { config, onChange } = props;
  // A saved widget with no display options shows the defaults, so the form shows them too.
  const shown = { ...DEFAULT_DISPLAY, ...displayOf(config), ...config };
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      <SourcePanelPicker {...props} />
      <SettingsForm fields={DISPLAY_FIELDS} config={shown} onChange={onChange} />
    </Box>
  );
}

export const panelWidget: WidgetDefinition<PanelConfig> = {
  type: 'agent.panel',
  title: 'Agent panel',
  description:
    'A status panel from the agent layer or from another panel source: uptime, alerts, disks, runners and more.',
  icon: 'mdi:view-dashboard-outline',
  category: 'Monitoring',
  defaultSize: { w: 4, h: 8 },
  minSize: { w: 3, h: 4 },
  defaultConfig: { source: AGENT_SOURCE_ID, panel: '', ...DEFAULT_DISPLAY },
  SettingsComponent: PanelSettings,
  selfScroll: true,
  Component: PanelWidget,
};
