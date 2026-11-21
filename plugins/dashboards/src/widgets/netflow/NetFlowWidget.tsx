/*
 * The network flow widget (`network.flow`): a flow graph of the nodes, chips to choose the network
 * (all, tailnet, LAN or public), a thin list of the health of each node, and a summary line in the
 * footer. The chip choice is state of the widget: it never changes the page URL. The widget reads
 * its own size with a ResizeObserver, so the graph follows the widget and not the window.
 */
import Box from '@mui/material/Box';
import React from 'react';
import type { WidgetDefinition, WidgetProps, WidgetSettingsProps } from '../../contract';
import { useReportStale } from '../../resilience/stale';
import { WidgetFooter } from '../footer';
import { useTokens } from '../panels/tokens';
import { kioskBox, Notice, useInk } from '../promql/common';
import { parseVector, Sample } from '../promql/mapping';
import { QueryEditor } from '../promql/QueryEditor';
import { useElementSize } from '../promql/useElementSize';
import { useQueries } from '../promql/useQueries';
import { SettingsForm } from '../SettingsForm';
import {
  DEFAULT_NET_FLOW,
  flowOptions,
  NetFlowConfig,
  normaliseConfig,
  queriesFor,
  QUERY_ORDER,
} from './config';
import { FlowGraph } from './FlowGraph';
import {
  buildFlow,
  FlowModel,
  graphHeight,
  GROUPS,
  Selection,
  SELECTIONS,
  summaryText,
  viewFor,
} from './model';
import { NodeList } from './NodeList';

const CHIPS_HEIGHT = 30;

function Chips({
  value,
  onChange,
  counts,
  ink,
  line,
  kiosk,
}: {
  value: Selection;
  onChange: (s: Selection) => void;
  counts: Record<Selection, number>;
  ink: ReturnType<typeof useInk>['ink'];
  line: string;
  kiosk: boolean;
}): JSX.Element {
  return (
    <Box
      role="radiogroup"
      aria-label="Network"
      data-flow-chips
      sx={{
        display: 'flex',
        gap: 0.75,
        flex: 'none',
        height: CHIPS_HEIGHT - 6,
        alignItems: 'center',
      }}
    >
      {SELECTIONS.map(s => {
        const on = s.id === value;
        return (
          <Box
            key={s.id}
            component="button"
            type="button"
            role="radio"
            aria-checked={on}
            data-flow-chip={s.id}
            title={`${s.label}: ${counts[s.id]} ${counts[s.id] === 1 ? 'pair' : 'pairs'} with data`}
            onClick={() => onChange(s.id)}
            sx={{
              font: 'inherit',
              fontSize: 12,
              lineHeight: 1,
              height: kiosk ? 24 : 22,
              px: 1.1,
              borderRadius: '12px',
              cursor: 'pointer',
              color: on ? ink.primary : counts[s.id] === 0 ? ink.muted : ink.secondary,
              fontWeight: on ? 700 : 400,
              bgcolor: on ? 'action.selected' : 'transparent',
              border: `1px solid ${on ? ink.secondary : line}`,
            }}
          >
            {s.label}
          </Box>
        );
      })}
    </Box>
  );
}

function modelOf(
  results: Array<{ resultType: string; result: unknown }>,
  config: NetFlowConfig
): FlowModel {
  const [loss, rtt, bytes, nodes, lan, tailnet, pod, retrans]: Sample[][] = results.map(r =>
    parseVector(r.result, undefined, r.resultType)
  );
  return buildFlow(
    {
      loss: loss ?? [],
      rtt: rtt ?? [],
      bytes: bytes ?? [],
      nodes: nodes ?? [],
      groups: { lan: lan ?? [], tailnet: tailnet ?? [], pod: pod ?? [] },
      retrans: retrans ?? [],
    },
    flowOptions(config)
  );
}

function NetFlowWidget({
  config: raw,
  filters,
  refreshSignal,
  reportRefreshed,
  kiosk,
  footer,
  cache,
}: WidgetProps<NetFlowConfig>): JSX.Element {
  const config = React.useMemo(() => normaliseConfig(raw), [raw]);
  const { ref, size, sizeRef } = useElementSize<HTMLDivElement>();
  const { ink } = useInk(kiosk);
  const tokens = useTokens();
  const [selection, setSelection] = React.useState<Selection>('all');
  const queries = React.useMemo(() => queriesFor(config), [config]);
  const state = useQueries({
    mode: 'instant',
    queries,
    filters,
    refreshSignal,
    reportRefreshed,
    widthRef: sizeRef,
    cache,
  });
  useReportStale(state.staleSince, !!state.cached && !state.error);
  const model = React.useMemo(
    () =>
      state.results && state.results.length === QUERY_ORDER.length
        ? modelOf(state.results, config)
        : undefined,
    [state.results, config]
  );
  const view = React.useMemo(
    () => (model ? viewFor(model, selection) : undefined),
    [model, selection]
  );
  const counts = React.useMemo(() => {
    const none: Record<Selection, number> = { all: 0, tailnet: 0, lan: 0, public: 0 };
    if (!model) return none;
    const all = viewFor(model, 'all');
    return {
      all: all.pairs.filter(p => p.loss !== null).length,
      ...all.summary.withData,
    } as Record<Selection, number>;
  }, [model]);

  // The measured element is always rendered: the ResizeObserver attaches once, at mount.
  const frame = (n: JSX.Element) => (
    <Box ref={ref} sx={{ height: '100%', minHeight: 0 }}>
      {n}
    </Box>
  );
  const notice = frame;
  if (state.error && !state.results) return notice(<Notice kind="error">{state.error}</Notice>);
  if (queries[0] === '')
    return notice(<Notice kind="empty">Set a loss query in the widget settings.</Notice>);
  if (!model || !view) return notice(<Notice kind="wait">Loading...</Notice>);
  if (model.nodes.length === 0)
    return notice(<Notice kind="empty">The queries returned no network data.</Notice>);

  const gh = graphHeight(size.width, size.height, CHIPS_HEIGHT);
  return frame(
    <Box
      data-net-flow
      data-status={view.status}
      data-selection={selection}
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        minHeight: 0,
        opacity: state.loading ? 0.6 : 1,
        transition: 'opacity 150ms',
        color: ink.primary,
        ...kioskBox(kiosk),
      }}
    >
      <Chips
        value={selection}
        onChange={setSelection}
        counts={counts}
        ink={ink}
        line={tokens.line2}
        kiosk={kiosk}
      />
      {size.width > 0 && (
        <FlowGraph
          view={view}
          health={model.health}
          nodes={model.nodes}
          width={Math.max(120, size.width)}
          height={gh}
          ink={ink}
          colours={tokens.status}
        />
      )}
      <NodeList
        health={model.health}
        ink={ink}
        line={tokens.line}
        colours={tokens.status}
        nodeWarnAbove={config.nodeWarnAbove}
        nodeCritAbove={config.nodeCritAbove}
      />
      <WidgetFooter status={view.status} footer={footer} wrap>
        <span data-flow-summary>{summaryText(view, config.critAbove)}</span>
      </WidgetFooter>
    </Box>
  );
}

function NetFlowSettings({
  config: raw,
  onChange,
}: WidgetSettingsProps<NetFlowConfig>): JSX.Element {
  const config = normaliseConfig(raw);
  const set = (patch: Partial<NetFlowConfig>) => onChange({ ...config, ...patch });
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      <QueryEditor
        label="Loss query"
        value={config.lossQuery}
        onChange={lossQuery => set({ lossQuery })}
        help="Loss ratio of each direction with the labels source, target and network (tailnet, lan or public)."
      />
      <QueryEditor
        label="Round trip query (optional)"
        value={config.rttQuery}
        onChange={rttQuery => set({ rttQuery })}
        help="Seconds, with the same labels. It shows in the tooltip."
      />
      <QueryEditor
        label="Traffic query (optional)"
        value={config.bytesQuery}
        onChange={bytesQuery => set({ bytesQuery })}
        help="Bytes a second with source, target, network and direction (rx or tx). It sets the line width."
      />
      <QueryEditor
        label="Node name query"
        value={config.nodeQuery}
        onChange={nodeQuery => set({ nodeQuery })}
        help="One series for each node exporter, with the labels instance and nodename."
      />
      <QueryEditor
        label="Retransmit query (optional)"
        value={config.retransQuery}
        onChange={retransQuery => set({ retransQuery })}
        help="The share of TCP segments sent again, by instance."
      />
      <SettingsForm
        config={config}
        onChange={onChange}
        fields={[
          {
            key: 'groupQuery',
            label: 'Interface drop and error query',
            type: 'multiline',
            help: 'The share of dropped and failed packets by instance. {{devices}} is the device regex of the group.',
          },
          ...GROUPS.map(g => ({
            key: `${g.id}Devices`,
            label: `${g.label} devices (regex)`,
            type: 'text' as const,
          })),
          { key: 'warnAbove', label: 'Pair warning above (ratio)', type: 'number', step: 0.001 },
          { key: 'critAbove', label: 'Pair critical above (ratio)', type: 'number', step: 0.001 },
          {
            key: 'nodeWarnAbove',
            label: 'Node warning above (ratio)',
            type: 'number',
            step: 0.001,
          },
          {
            key: 'nodeCritAbove',
            label: 'Node critical above (ratio)',
            type: 'number',
            step: 0.001,
          },
        ]}
      />
    </Box>
  );
}

export const netFlowWidget: WidgetDefinition<NetFlowConfig> = {
  type: 'network.flow',
  title: 'Network loss',
  description:
    'A flow graph of the loss and traffic between nodes on the tailnet, the LAN and the public network, with the drop and error share of each node.',
  icon: 'mdi:graph-outline',
  category: 'Monitoring',
  defaultSize: { w: 4, h: 12 },
  minSize: { w: 3, h: 6 },
  defaultConfig: DEFAULT_NET_FLOW,
  selfScroll: false,
  SettingsComponent: NetFlowSettings,
  Component: NetFlowWidget,
};
