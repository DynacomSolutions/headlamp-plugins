/*
 * The sunburst widget (`agent.sunburst`): one ring of a panel (for example the CPU ring of
 * `usage-dashboard` on the agent) as a full card sunburst. It uses the same source and panel
 * fetch as the panel widget.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { WidgetDefinition, WidgetProps } from '../../contract';
import { useReportStale } from '../../resilience/stale';
import { SettingsForm } from '../SettingsForm';
import { SunburstChart } from '../sunburst/SunburstChart';
import { usePanel, usePanelList } from './data';
import { ringToSunburst } from './model';
import { sourceOf, SourcePanelConfig, SourcePanelPicker } from './PanelPicker';
import { ringFormat } from './PanelView';
import { AGENT_SOURCE_ID } from './sources';
import { useSourceLookup } from './sourcesConfig';

export interface RingConfig extends SourcePanelConfig {
  /** The ring id: `cpu` or `memory`. */
  ring: string;
  /**
   * What the first ring is. `node` splits the circle by node first, then category, then the next
   * level, and draws each node's free capacity as a crosshatch. Anything else (the default) keeps
   * the category first. An agent that sends no per-node data is drawn category first.
   */
  groupBy?: 'category' | 'node';
}

function RingWidget({
  config,
  refreshSignal,
  reportRefreshed,
  kiosk,
}: WidgetProps<RingConfig>): JSX.Element {
  const sourceId = sourceOf(config);
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
  const ring = state.panel?.rings.find(r => r.id === config.ring) ?? state.panel?.rings[0];
  const data = React.useMemo(
    () => (ring ? ringToSunburst(ring, { groupBy: config.groupBy }) : null),
    [ring, config.groupBy]
  );
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
        <CircularProgress size={24} aria-label="Loading the ring" />
      </Box>
    );
  }
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {state.error && !(kiosk && state.panel) && (
        <Alert severity={state.panel ? 'warning' : 'error'} sx={{ mb: 1 }}>
          {state.panel
            ? `Refresh failed, showing the last data: ${state.error}`
            : `Could not load the panel: ${state.error}`}
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
  description: 'A ring of a panel as a sunburst: capacity, use, categories and their children.',
  icon: 'mdi:chart-donut',
  category: 'Charts',
  defaultSize: { w: 4, h: 10 },
  minSize: { w: 3, h: 6 },
  defaultConfig: { source: AGENT_SOURCE_ID, panel: 'usage-dashboard', ring: 'cpu' },
  SettingsComponent: props => (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      <SourcePanelPicker {...props} />
      <SettingsForm
        config={props.config}
        onChange={props.onChange}
        fields={[
          {
            key: 'ring',
            label: 'Ring',
            type: 'select',
            help: 'The ring to draw, for a panel that has rings.',
            options: [
              { value: 'cpu', label: 'CPU' },
              { value: 'memory', label: 'Memory' },
            ],
          },
          {
            key: 'groupBy',
            label: 'First ring',
            type: 'select',
            help: "Node first splits the circle by node, with each node's free capacity hatched. It needs an agent that sends the nodes of a ring.",
            options: [
              { value: 'category', label: 'Category' },
              { value: 'node', label: 'Node' },
            ],
          },
        ]}
      />
    </Box>
  ),
  Component: RingWidget,
};
