/*
 * The agent panel widget (`agent.panel`): shows one panel of the agent layer (`GET /api/widgets`).
 * The user picks the panel in the widget settings. The widget fetches when the dashboard asks for
 * fresh data, never sooner than the panel's own `refreshSeconds`, and calls `reportRefreshed`.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { WidgetDefinition, WidgetProps, WidgetSettingsProps } from '../../contract';
import { useAgentSettings } from './agentConfig';
import { usePanel, usePanelList } from './data';
import { PanelView } from './PanelView';

export interface PanelConfig {
  /** The panel id, for example `uptime`. Empty until the user picks one. */
  panel: string;
}

export function PanelWidget({ config, refreshSignal, reportRefreshed, editing, kiosk }: WidgetProps<PanelConfig>): JSX.Element {
  const agent = useAgentSettings();
  const list = usePanelList(agent);
  const minSeconds = list.panels.find(p => p.id === config.panel)?.refreshSeconds ?? 0;
  const state = usePanel(agent, config.panel, refreshSignal, minSeconds, reportRefreshed);

  if (!config.panel) {
    return (
      <Box sx={{ p: 1 }}>
        <Typography variant="body2" color="text.secondary">
          Choose a panel in the widget settings.
        </Typography>
      </Box>
    );
  }
  if (state.loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
        <CircularProgress size={24} aria-label="Loading the panel" />
      </Box>
    );
  }
  return (
    <Box sx={{ height: '100%', minWidth: 0 }}>
      {state.error && (
        <Alert severity={state.panel ? 'warning' : 'error'} sx={{ mb: 1 }}>
          {state.panel ? `Refresh failed, showing the last data: ${state.error}` : `Could not load the panel: ${state.error}`}
        </Alert>
      )}
      {state.panel && <PanelView panel={state.panel} kiosk={kiosk} editing={editing} />}
    </Box>
  );
}

function PanelSettings({ config, onChange }: WidgetSettingsProps<PanelConfig>): JSX.Element {
  const agent = useAgentSettings();
  const list = usePanelList(agent);
  // A panel the agent no longer lists stays selectable, so the saved choice is never lost.
  const known = list.panels.some(p => p.id === config.panel);
  const description = list.panels.find(p => p.id === config.panel)?.description;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      {list.error && <Alert severity="error">Could not list the panels: {list.error}</Alert>}
      <TextField
        select
        size="small"
        label="Panel"
        value={config.panel}
        disabled={list.loading}
        helperText={description || (list.loading ? 'Loading the panels.' : 'The agent layer supplies the panels.')}
        onChange={e => onChange({ ...config, panel: e.target.value })}
      >
        {!known && config.panel !== '' && <MenuItem value={config.panel}>{config.panel}</MenuItem>}
        {list.panels.map(p => (
          <MenuItem key={p.id} value={p.id}>
            {p.title}
          </MenuItem>
        ))}
      </TextField>
    </Box>
  );
}

export const panelWidget: WidgetDefinition<PanelConfig> = {
  type: 'agent.panel',
  title: 'Agent panel',
  description: 'A status panel from the agent layer: uptime, alerts, disks, runners and more.',
  icon: 'mdi:view-dashboard-outline',
  category: 'Monitoring',
  defaultSize: { w: 4, h: 8 },
  minSize: { w: 3, h: 4 },
  defaultConfig: { panel: '' },
  SettingsComponent: PanelSettings,
  selfScroll: true,
  Component: PanelWidget,
};
