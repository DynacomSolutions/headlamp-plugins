/*
 * The two charts of the AIS tab. `ais.agents` is the agents sunburst: swap pool (or "Direct"), then
 * the real identity, then the agent. `ais.gateway` is the gateway usage pie: one slice for each app,
 * at its real size. Both fetch their panels like the AIS widget does, never sooner than the panel's
 * own `refreshSeconds`. See `charts.ts` for the data mapping.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { WidgetDefinition, WidgetProps, WidgetSettingsProps } from '../../contract';
import { useReportStale } from '../../resilience/stale';
import { usePanel, usePanelList } from '../panels/data';
import { sourceOf } from '../panels/PanelPicker';
import { useSourceLookup, useSources } from '../panels/sourcesConfig';
import { PieChart } from '../sunburst/PieChart';
import { SunburstChart } from '../sunburst/SunburstChart';
import { AIS_PANELS, AisConfig } from './AisWidget';
import {
  agentsToSunburst,
  DIRECT,
  gatewaySlices,
  POOL_NOT_REPORTED,
  providerIndex,
} from './charts';
import { labelLogo, poolLabelLogo } from './providerIcon';

const GATEWAY_PANEL = 'gateway-usage';

function Frame(props: {
  loading: boolean;
  error: string | null;
  hasData: boolean;
  kiosk: boolean;
  what: string;
  children: React.ReactNode;
}): JSX.Element {
  if (props.loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
        <CircularProgress size={24} aria-label={`Loading ${props.what}`} />
      </Box>
    );
  }
  return (
    <Box sx={{ height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {props.error && !(props.kiosk && props.hasData) && (
        <Alert severity={props.hasData ? 'warning' : 'error'} sx={{ mb: 1, flex: 'none' }}>
          {props.hasData
            ? `Refresh failed, showing the last data: ${props.error}`
            : `Could not load ${props.what}: ${props.error}`}
        </Alert>
      )}
      {props.hasData && (
        <Box sx={{ flex: '1 1 0', minHeight: 0, minWidth: 0 }}>{props.children}</Box>
      )}
    </Box>
  );
}

function AgentsWidget({
  config,
  refreshSignal,
  reportRefreshed,
  kiosk,
}: WidgetProps<AisConfig>): JSX.Element {
  const sourceId = sourceOf(config);
  const { source, pending } = useSourceLookup(sourceId);
  const list = usePanelList(source, sourceId);
  const min = (id: string): number => list.panels.find(p => p.id === id)?.refreshSeconds ?? 0;
  const agents = usePanel(
    source,
    AIS_PANELS.agents,
    refreshSignal,
    min(AIS_PANELS.agents),
    reportRefreshed,
    sourceId
  );
  const swap = usePanel(
    source,
    AIS_PANELS.swap,
    refreshSignal,
    min(AIS_PANELS.swap),
    reportRefreshed,
    sourceId
  );
  useReportStale(agents.staleSince);
  const data = React.useMemo(
    () => agentsToSunburst(agents.panel, swap.panel),
    [agents.panel, swap.panel]
  );
  const total = data.nodes?.reduce((s, n) => s + n.used, 0) ?? 0;
  const poolLogo = React.useMemo(
    () =>
      poolLabelLogo(
        new Set(
          (data.nodes ?? []).map(n => n.label).filter(l => l !== DIRECT && l !== POOL_NOT_REPORTED)
        )
      ),
    [data.nodes]
  );
  return (
    <Frame
      loading={agents.loading || swap.loading || pending}
      error={agents.error}
      hasData={!!agents.panel}
      kiosk={kiosk}
      what="the agents"
    >
      {total > 0 ? (
        <SunburstChart
          data={data}
          title="Agents"
          unit="agents"
          format={v => String(Math.round(v))}
          kiosk={kiosk}
          labelIcon={poolLogo}
        />
      ) : (
        <Typography variant="body2" color="text.secondary">
          No agents are running.
        </Typography>
      )}
    </Frame>
  );
}

function GatewayWidget({
  config,
  refreshSignal,
  reportRefreshed,
  kiosk,
}: WidgetProps<AisConfig>): JSX.Element {
  const sourceId = sourceOf(config);
  const { source, pending } = useSourceLookup(sourceId);
  const list = usePanelList(source, sourceId);
  const state = usePanel(
    source,
    GATEWAY_PANEL,
    refreshSignal,
    list.panels.find(p => p.id === GATEWAY_PANEL)?.refreshSeconds ?? 0,
    reportRefreshed,
    sourceId
  );
  useReportStale(state.staleSince);
  const slices = React.useMemo(() => gatewaySlices(state.panel), [state.panel]);
  const groups = React.useMemo(() => slices.map(s => s.group), [slices]);
  const groupIndex = React.useCallback((g: string) => providerIndex(g, groups), [groups]);
  const tokens = state.panel?.stats.find(s => s.label.toLowerCase() === 'tokens')?.value;
  return (
    <Frame
      loading={state.loading || pending}
      error={state.error}
      hasData={!!state.panel}
      kiosk={kiosk}
      what="the gateway usage"
    >
      {slices.length > 0 ? (
        <PieChart
          slices={slices}
          groupIndex={groupIndex}
          title="Gateway tokens in 7 days, by app"
          totalText={`${tokens ?? ''} tokens, ${slices.length} apps`.trim()}
          kiosk={kiosk}
          groupIcon={labelLogo}
        />
      ) : (
        <Typography variant="body2" color="text.secondary">
          The gateway has no usage.
        </Typography>
      )}
    </Frame>
  );
}

function SourceSettings(props: WidgetSettingsProps<AisConfig>): JSX.Element {
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
    </Box>
  );
}

export const aisAgentsWidget: WidgetDefinition<AisConfig> = {
  type: 'ais.agents',
  title: 'AIS agents by pool and identity',
  description:
    'A sunburst of the running agents: swap pool or direct, then the logged-in identity, then the agent.',
  icon: 'mdi:chart-donut',
  category: 'Charts',
  defaultSize: { w: 6, h: 10 },
  minSize: { w: 3, h: 6 },
  defaultConfig: { source: 'ais-console' },
  SettingsComponent: SourceSettings,
  selfScroll: false,
  Component: AgentsWidget,
};

export const aisGatewayWidget: WidgetDefinition<AisConfig> = {
  type: 'ais.gateway',
  title: 'AIS gateway usage pie',
  description:
    'A pie of the gateway tokens of the last 7 days: one slice for each app, at its real size.',
  icon: 'mdi:chart-pie',
  category: 'Charts',
  defaultSize: { w: 6, h: 10 },
  minSize: { w: 3, h: 6 },
  defaultConfig: { source: 'ais-console' },
  SettingsComponent: SourceSettings,
  selfScroll: false,
  Component: GatewayWidget,
};
