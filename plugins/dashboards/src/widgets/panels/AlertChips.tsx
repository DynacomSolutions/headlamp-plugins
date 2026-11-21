/*
 * The alert chips of the dashboard header (`agent.alert-chips`): the first three stats of a panel
 * (for example the critical, warning and pending alerts) as large chips. Each chip has a status
 * shape, a number and a word, never colour alone. The page and the full screen wall both show
 * them. A critical or warning chip has a tint and an edge in its status colour. The widget draws
 * without a card and fits the header row.
 */
import Box from '@mui/material/Box';
import React from 'react';
import type { WidgetDefinition, WidgetProps } from '../../contract';
import { useReportStale } from '../../resilience/stale';
import { useListGate, usePanel, usePanelList } from './data';
import { sourceOf, SourcePanelConfig, SourcePanelPicker } from './PanelPicker';
import { AGENT_SOURCE_ID } from './sources';
import { useSourceLookup } from './sourcesConfig';
import { StatusMark } from './StatusMark';
import { useTokens } from './tokens';

export type AlertChipsConfig = SourcePanelConfig;

/** Zero counts stay quiet: an outline and no tint. */
const isZero = (v: string): boolean => v.trim() === '0';

function AlertChips({
  config,
  refreshSignal,
  reportRefreshed,
  kiosk,
  cache,
}: WidgetProps<AlertChipsConfig>): JSX.Element | null {
  const sourceId = sourceOf(config);
  const { source } = useSourceLookup(sourceId);
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
  useReportStale(state.staleSince, !!state.cached && !state.error);
  const tk = useTokens();
  const stats = state.panel?.stats.slice(0, 3) ?? [];
  if (stats.length === 0) return null;
  return (
    <Box
      data-alert-chips
      sx={{
        display: 'flex',
        gap: kiosk ? 1.25 : 1,
        flex: 'none',
        // A narrow screen gives the room to the other header items. The page bar has the
        // sidebar, so its chips are smaller and give way a little later than the wall's.
        '@media (max-width: 1499.95px)': { display: 'none' },
        ...(kiosk ? {} : { '@media (max-width: 1579.95px)': { display: 'none' } }),
      }}
    >
      {stats.map((s, i) => {
        const zero = isZero(s.value);
        const tinted = !zero && (s.status === 'crit' || s.status === 'warn');
        return (
          <Box
            key={`${s.label}-${i}`}
            data-alert-chip={s.status}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              height: kiosk ? 40 : 32,
              px: kiosk ? 1.75 : 1.25,
              borderRadius: kiosk ? '20px' : '16px',
              whiteSpace: 'nowrap',
              fontSize: kiosk ? 17 : 14,
              border: `1px solid ${tinted ? tk.status[s.status] : tk.line2}`,
              bgcolor: tinted ? tk.fill[s.status] : 'transparent',
              color: zero ? tk.mut : tk.fg,
            }}
          >
            <StatusMark status={s.status} size={kiosk ? 16 : 14} />
            <Box
              component="strong"
              sx={{
                fontWeight: 600,
                fontSize: kiosk ? 21 : 17,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {s.value}
            </Box>
            <span>{s.label.toLowerCase()}</span>
          </Box>
        );
      })}
    </Box>
  );
}

export const alertChipsWidget: WidgetDefinition<AlertChipsConfig> = {
  type: 'agent.alert-chips',
  title: 'Alert chips',
  description:
    'The first three stats of a panel as large chips, for the header: for example the critical, warning and pending alerts.',
  icon: 'mdi:alert-circle-outline',
  category: 'Monitoring',
  card: false,
  defaultSize: { w: 5, h: 2 },
  minSize: { w: 3, h: 2 },
  defaultConfig: { source: AGENT_SOURCE_ID, panel: 'alerts' },
  SettingsComponent: props => <SourcePanelPicker {...props} />,
  Component: AlertChips,
};
