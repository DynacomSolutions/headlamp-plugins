/*
 * The usage pair widget (`agent.usage-pair`): two rings of one panel (CPU and memory of
 * `usage-dashboard` on the agent) as two node-first sunbursts side by side with one shared legend.
 * It uses the same source, panel fetch and last-good cache as the other panel widgets.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { WidgetDefinition, WidgetProps } from '../../contract';
import { useReportStale } from '../../resilience/stale';
import { SettingsForm } from '../SettingsForm';
import { UsagePair } from '../sunburst/UsagePair';
import { useListGate, usePanel, usePanelList } from './data';
import { PanelRing, ringToSunburst } from './model';
import { sourceOf, SourcePanelConfig, SourcePanelPicker } from './PanelPicker';
import { ringFormat } from './PanelView';
import { AGENT_SOURCE_ID } from './sources';
import { useSourceLookup } from './sourcesConfig';

export interface UsagePairConfig extends SourcePanelConfig {
  /** The ring id of the first chart. Default `cpu`. */
  first: string;
  /** The ring id of the second chart. Default `memory`. */
  second: string;
}

const RING_OPTIONS = [
  { value: 'cpu', label: 'CPU' },
  { value: 'memory', label: 'Memory' },
];

const prepare = (ring: PanelRing) => ({
  data: ringToSunburst(ring, { groupBy: 'node' }),
  format: ringFormat(ring),
  title: ring.label,
});

function UsagePairWidgetView({
  config,
  refreshSignal,
  reportRefreshed,
  kiosk,
  cache,
}: WidgetProps<UsagePairConfig>): JSX.Element {
  const sourceId = sourceOf(config);
  const { source, pending } = useSourceLookup(sourceId);
  const [listOpen, settleList] = useListGate();
  const list = usePanelList(source, sourceId, listOpen);
  const minSeconds = list.panels.find(p => p.id === config.panel)?.refreshSeconds ?? 0;
  const state = usePanel(
    source,
    config.panel,
    refreshSignal,
    minSeconds,
    reportRefreshed,
    sourceId,
    cache
  );
  React.useEffect(() => settleList(state), [state, settleList]);
  // A failed refresh keeps the last panel. The card then says since when the data is old.
  useReportStale(state.staleSince, !!state.cached && !state.error);
  const rings = state.panel?.rings ?? [];
  const a = rings.find(r => r.id === config.first) ?? rings[0];
  const b = rings.find(r => r.id === config.second) ?? rings.find(r => r !== a);
  const pair = React.useMemo(() => (a && b ? [prepare(a), prepare(b)] : null), [a, b]);
  if (!config.panel) {
    return (
      <Box sx={{ p: 1 }}>
        <Typography variant="body2" color="text.secondary">
          Choose a panel in the widget settings.
        </Typography>
      </Box>
    );
  }
  if (state.loading || (pending && !state.panel)) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
        <CircularProgress size={24} aria-label="Loading the rings" />
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
      {state.panel && !pair && (
        <Typography variant="body2" color="text.secondary">
          This panel needs two rings.
        </Typography>
      )}
      {pair && (
        <Box sx={{ flex: '1 1 0', minHeight: 0 }}>
          <UsagePair first={pair[0]} second={pair[1]} kiosk={kiosk} />
        </Box>
      )}
    </Box>
  );
}

export const usagePairWidget: WidgetDefinition<UsagePairConfig> = {
  type: 'agent.usage-pair',
  title: 'Agent usage pair',
  description:
    'Two rings of a panel (CPU and memory) as node-first sunbursts side by side, with one shared legend.',
  icon: 'mdi:chart-donut-variant',
  category: 'Charts',
  defaultSize: { w: 6, h: 8 },
  minSize: { w: 4, h: 6 },
  defaultConfig: {
    source: AGENT_SOURCE_ID,
    panel: 'usage-dashboard',
    first: 'cpu',
    second: 'memory',
  },
  SettingsComponent: props => (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      <SourcePanelPicker {...props} />
      <SettingsForm
        config={props.config}
        onChange={props.onChange}
        fields={[
          {
            key: 'first',
            label: 'First ring',
            type: 'select',
            help: 'The ring of the left chart.',
            options: RING_OPTIONS,
          },
          {
            key: 'second',
            label: 'Second ring',
            type: 'select',
            help: 'The ring of the right chart.',
            options: RING_OPTIONS,
          },
        ]}
      />
    </Box>
  ),
  Component: UsagePairWidgetView,
};
