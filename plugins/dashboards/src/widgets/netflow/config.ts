/*
 * The settings of the network flow widget and the queries that they make. Every query is an instant
 * query. The loss and round trip queries fall back to the older tailnet only series, so the widget
 * works before the multi network series exist: a pair that the new series cover keeps the new value.
 */
import { parseOptionalNumber } from '../promql/units';
import type { FlowOptions, GroupId } from './model';

export interface NetFlowConfig {
  /** Loss ratio of each direction with `source`, `target` and `network`. */
  lossQuery: string;
  /** Round trip time in seconds, same labels. */
  rttQuery: string;
  /** Byte rate with `source`, `target`, `network` and `direction` (`rx` or `tx`). */
  bytesQuery: string;
  /** One series for each node exporter, with `instance` and `nodename`. */
  nodeQuery: string;
  /** The drop and error share of one interface group by `instance`. `{{devices}}` is the group regex. */
  groupQuery: string;
  retransQuery: string;
  lanDevices: string;
  tailnetDevices: string;
  podDevices: string;
  /** A pair loss above this is a warning, above `critAbove` it is critical (a ratio, 0.02 is 2%). */
  warnAbove: number;
  critAbove: number;
  /** The same two limits for the drop and error share of a node. */
  nodeWarnAbove: number;
  nodeCritAbove: number;
}

const LEGACY_LOSS =
  'label_replace(max by (source, target) (avg_over_time(tailnet_ping_loss_ratio[5m])), "network", "tailnet", "", "")';
const LEGACY_RTT =
  'label_replace(max by (source, target) (tailnet_ping_rtt_seconds), "network", "tailnet", "", "")';

const DROPS = (kind: string) => `rate(node_network_${kind}_total{device=~"{{devices}}"}[5m])`;

export const DEFAULT_NET_FLOW: NetFlowConfig = {
  lossQuery: `max by (source, target, network) (avg_over_time(net_ping_loss_ratio[5m]))\nor ${LEGACY_LOSS}`,
  rttQuery: `max by (source, target, network) (net_ping_rtt_seconds)\nor ${LEGACY_RTT}`,
  bytesQuery: 'sum by (source, target, network, direction) (rate(net_peer_bytes_total[5m]))',
  nodeQuery: 'node_uname_info',
  groupQuery: `sum by (instance) (${DROPS('receive_drop')} + ${DROPS('transmit_drop')} + ${DROPS(
    'receive_errs'
  )} + ${DROPS('transmit_errs')})\n/ sum by (instance) (${DROPS('receive_packets')} + ${DROPS(
    'transmit_packets'
  )})`,
  retransQuery: 'rate(node_netstat_Tcp_RetransSegs[5m]) / rate(node_netstat_Tcp_OutSegs[5m])',
  lanDevices: 'eno.*|enp.*|ens.*|eth.*',
  tailnetDevices: 'tailscale.*',
  podDevices: 'flannel.*|cni0|veth.*',
  warnAbove: 0,
  critAbove: 0.02,
  nodeWarnAbove: 0.005,
  nodeCritAbove: 0.02,
};

const text = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim() !== '' ? v : fallback;

const num = (v: unknown, fallback: number): number => parseOptionalNumber(v) ?? fallback;

/** The config with every missing or bad field replaced by its default. */
export function normaliseConfig(c: Partial<NetFlowConfig> | undefined): NetFlowConfig {
  const d = DEFAULT_NET_FLOW;
  const x = c ?? {};
  return {
    lossQuery: text(x.lossQuery, d.lossQuery),
    rttQuery: typeof x.rttQuery === 'string' ? x.rttQuery : d.rttQuery,
    bytesQuery: typeof x.bytesQuery === 'string' ? x.bytesQuery : d.bytesQuery,
    nodeQuery: text(x.nodeQuery, d.nodeQuery),
    groupQuery: text(x.groupQuery, d.groupQuery),
    retransQuery: typeof x.retransQuery === 'string' ? x.retransQuery : d.retransQuery,
    lanDevices: text(x.lanDevices, d.lanDevices),
    tailnetDevices: text(x.tailnetDevices, d.tailnetDevices),
    podDevices: text(x.podDevices, d.podDevices),
    warnAbove: num(x.warnAbove, d.warnAbove),
    critAbove: num(x.critAbove, d.critAbove),
    nodeWarnAbove: num(x.nodeWarnAbove, d.nodeWarnAbove),
    nodeCritAbove: num(x.nodeCritAbove, d.nodeCritAbove),
  };
}

export const flowOptions = (c: NetFlowConfig): FlowOptions => ({
  warnAbove: c.warnAbove,
  critAbove: c.critAbove,
  nodeWarnAbove: c.nodeWarnAbove,
  nodeCritAbove: c.nodeCritAbove,
});

/** The query of one interface group: the group regex goes in place of `{{devices}}`. */
export function groupQueryFor(c: NetFlowConfig, group: GroupId): string {
  const devices = { lan: c.lanDevices, tailnet: c.tailnetDevices, pod: c.podDevices }[group];
  return c.groupQuery.replace(/\{\{\s*devices\s*\}\}/g, devices);
}

/** The queries in the order the widget reads them. */
export const QUERY_ORDER = [
  'loss',
  'rtt',
  'bytes',
  'nodes',
  'lan',
  'tailnet',
  'pod',
  'retrans',
] as const;

export function queriesFor(c: NetFlowConfig): string[] {
  return [
    c.lossQuery,
    c.rttQuery,
    c.bytesQuery,
    c.nodeQuery,
    groupQueryFor(c, 'lan'),
    groupQueryFor(c, 'tailnet'),
    groupQueryFor(c, 'pod'),
    c.retransQuery,
  ].map(q => q.trim());
}
