/*
 * The agent sunburst widget (`agent.sunburst`): one ring of an agent panel (for example the CPU
 * ring of `usage-dashboard`) as a full card sunburst. It uses the same panel fetch as the
 * agent panel widget.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { WidgetDefinition, WidgetProps } from '../../contract';
import { SettingsForm } from '../SettingsForm';
import { SunburstChart } from '../sunburst/SunburstChart';
import { useAgentSettings } from './agentConfig';
import { usePanel, usePanelList } from './data';
import { ringToSunburst } from './model';
import { ringFormat } from './PanelView';
import type { PanelConfig } from './PanelWidget';

export interface RingConfig extends PanelConfig {
  /** The ring id: `cpu` or `memory`. */
  ring: string;
}

function RingWidget({ config, refreshSignal, reportRefreshed, kiosk }: WidgetProps<RingConfig>): JSX.Element {
  const agent = useAgentSettings();
  const list = usePanelList(agent);
  const minSeconds = list.panels.find(p => p.id === config.panel)?.refreshSeconds ?? 0;
  const state = usePanel(agent, config.panel, refreshSignal, minSeconds, reportRefreshed);
  const ring = state.panel?.rings.find(r => r.id === config.ring) ?? state.panel?.rings[0];
  const data = React.useMemo(() => (ring ? ringToSunburst(ring) : null), [ring]);
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
        <CircularProgress size={24} aria-label="Loading the ring" />
      </Box>
    );
  }
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {state.error && (
        <Alert severity={state.panel ? 'warning' : 'error'} sx={{ mb: 1 }}>
          {state.panel ? `Refresh failed, showing the last data: ${state.error}` : `Could not load the panel: ${state.error}`}
        </Alert>
      )}
      {state.panel && !ring && (
        <Typography variant="body2" color="text.secondary">
          This panel has no rings.
        </Typography>
      )}
      {ring && data && (
        <Box sx={{ flex: '1 1 0', minHeight: 0 }}>
          <SunburstChart data={data} title={ring.label} format={ringFormat(ring)} kiosk={kiosk} />
        </Box>
      )}
    </Box>
  );
}

export const sunburstPanelWidget: WidgetDefinition<RingConfig> = {
  type: 'agent.sunburst',
  title: 'Agent sunburst',
  description: 'A ring of an agent panel as a sunburst: capacity, use, categories and their children.',
  icon: 'mdi:chart-donut',
  category: 'Charts',
  defaultSize: { w: 4, h: 10 },
  minSize: { w: 3, h: 6 },
  defaultConfig: { panel: 'usage-dashboard', ring: 'cpu' },
  SettingsComponent: ({ config, onChange }) => (
    <SettingsForm
      config={config}
      onChange={onChange}
      fields={[
        { key: 'panel', label: 'Panel id', type: 'text', help: 'A panel that has rings, for example usage-dashboard.' },
        {
          key: 'ring',
          label: 'Ring',
          type: 'select',
          options: [
            { value: 'cpu', label: 'CPU' },
            { value: 'memory', label: 'Memory' },
          ],
        },
      ]}
    />
  ),
  Component: RingWidget,
};
