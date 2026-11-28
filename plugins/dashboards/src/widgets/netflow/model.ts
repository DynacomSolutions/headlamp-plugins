/*
 * The model of the network flow widget. Pure functions, no React.
 *
 * Input: instant query samples. The ping series carry `source`, `target` and `network` (tailnet, lan
 * or public). The byte rate series add `direction` (`tx` or `rx`, seen from `source`). Each node has
 * health series per interface group, keyed by `instance`, and one series that maps `instance` to the
 * node name.
 *
 * Output: one pair for each two nodes (a pair is the two directions together), a view for the
 * selected network, a view of each node, and a summary. A pair or a node with no sample is "no
 * data", never zero.
 */
import type { PanelStatus } from '../panels/model';
import type { Sample } from '../promql/mapping';
import { cellStatus } from '../promql/matrix';
import { formatBytes, formatValue, sig } from '../promql/units';

export type NetworkId = 'tailnet' | 'lan' | 'public';
export type Selection = 'all' | NetworkId;
export type GroupId = 'lan' | 'tailnet' | 'pod';

export const NETWORKS: ReadonlyArray<{ id: NetworkId; label: string }> = [
  { id: 'tailnet', label: 'Tailnet' },
  { id: 'lan', label: 'LAN' },
  { id: 'public', label: 'Public' },
];

export const SELECTIONS: ReadonlyArray<{ id: Selection; label: string }> = [
  { id: 'all', label: 'All' },
  ...NETWORKS,
];

export const GROUPS: ReadonlyArray<{ id: GroupId; label: string }> = [
  { id: 'lan', label: 'LAN NIC' },
  { id: 'tailnet', label: 'Tailnet' },
  { id: 'pod', label: 'Pod net' },
];

export const networkLabel = (id: NetworkId): string => NETWORKS.find(n => n.id === id)?.label ?? id;

export interface FlowInput {
  /** Ping loss ratio with `source`, `target` and `network`. */
  loss: Sample[];
  /** Round trip time in seconds, same labels. */
  rtt: Sample[];
  /** Byte rate with `source`, `target`, `network` and `direction`. */
  bytes: Sample[];
  /** One series for each node exporter: `instance` and `nodename`. */
  nodes: Sample[];
  /** The drop and error share (0 to 1) of each interface group, by `instance`. */
  groups: Record<GroupId, Sample[]>;
  /** The TCP retransmit share (0 to 1), by `instance`. */
  retrans: Sample[];
}

export interface FlowOptions {
  warnAbove: number;
  critAbove: number;
  nodeWarnAbove: number;
  nodeCritAbove: number;
}

/** What one direction of a pair on one network shows. */
export interface DirStat {
  from: string;
  to: string;
  loss: number | null;
  rtt: number | null;
  /** Bytes a second from `from` to `to`. */
  rate: number | null;
}

/** One network of one pair. */
export interface NetPair {
  network: NetworkId;
  ab: DirStat;
  ba: DirStat;
  /** The worse loss of the two directions, null with no data. */
  loss: number | null;
  /** The traffic of the two directions together, null with no data. */
  rate: number | null;
  status: PanelStatus;
}

export interface FlowPair {
  /** The first name in natural order. */
  a: string;
  b: string;
  /** Only the networks that have at least one sample for this pair. */
  nets: NetPair[];
}

export interface NodeHealth {
  name: string;
  /** The share of dropped and failed packets for each interface group, null with no data. */
  groups: Record<GroupId, number | null>;
  /** The share of TCP segments sent again, null with no data. */
  retransmit: number | null;
  /** The worst group share, null with no data. */
  worst: number | null;
  status: PanelStatus;
}

export interface FlowModel {
  nodes: string[];
  pairs: FlowPair[];
  health: NodeHealth[];
  options: FlowOptions;
}

export interface PairView {
  a: string;
  b: string;
  /** The networks that count for the selection, with data or not. */
  nets: NetPair[];
  loss: number | null;
  rate: number | null;
  status: PanelStatus;
  /** The direction that has the worst loss. */
  worst?: { from: string; to: string; loss: number; network: NetworkId };
}

export interface FlowSummary {
  /** The pairs of the graph: every two nodes. */
  pairs: number;
  /** The pairs that have a loss value, for each network. */
  withData: Record<NetworkId, number>;
  /** The pairs above the critical limit, for the selection. */
  above: number;
  noData: number;
  worst?: { from: string; to: string; loss: number; network: NetworkId };
}

export interface FlowView {
  selection: Selection;
  pairs: PairView[];
  /** The largest traffic of any pair in the selection, 0 with none. */
  maxRate: number;
  summary: FlowSummary;
  status: PanelStatus;
}

export const naturalOrder = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const NETWORK_IDS: NetworkId[] = ['tailnet', 'lan', 'public'];

export function asNetwork(v: string | undefined): NetworkId | undefined {
  const s = (v ?? '').trim().toLowerCase();
  return NETWORK_IDS.find(n => n === s);
}

const dirKey = (network: NetworkId, from: string, to: string) =>
  `${network}\u0000${from}\u0000${to}`;

/** The largest value for each key. Two series for one key (two probes) never hide a loss. */
function maxBy(samples: Sample[], key: (s: Sample) => string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of samples) {
    const k = key(s);
    if (k === undefined || s.value === null) continue;
    const old = out.get(k);
    out.set(k, old === undefined ? s.value : Math.max(old, s.value));
  }
  return out;
}

const pingKey = (s: Sample): string | undefined => {
  const n = asNetwork(s.labels.network);
  const from = s.labels.source;
  const to = s.labels.target;
  return n && from && to && from !== to ? dirKey(n, from, to) : undefined;
};

/**
 * The rate from `from` to `to`. The probe on `from` counts what it sent (`tx` on from to). The probe
 * on `to` counts what it received (`rx` on to from). Both are one flow, so the larger one wins: a
 * missing probe never makes the rate zero.
 */
function directedRates(bytes: Sample[]): Map<string, number> {
  const out = new Map<string, number>();
  const put = (k: string, v: number) => out.set(k, Math.max(out.get(k) ?? 0, v));
  for (const s of bytes) {
    const n = asNetwork(s.labels.network);
    const source = s.labels.source;
    const target = s.labels.target;
    const dir = (s.labels.direction ?? '').toLowerCase();
    if (!n || !source || !target || source === target || s.value === null || s.value < 0) continue;
    if (dir === 'tx') put(dirKey(n, source, target), s.value);
    else if (dir === 'rx') put(dirKey(n, target, source), s.value);
  }
  return out;
}

/** The node name of each `instance`. An instance with no mapping keeps its host part as the name. */
export function nodeNames(nodes: Sample[]): (instance: string) => string {
  const map = new Map<string, string>();
  for (const s of nodes) {
    const instance = s.labels.instance;
    const name = s.labels.nodename ?? s.labels.node;
    if (instance && name) map.set(instance, name);
  }
  return instance => map.get(instance) ?? instance.replace(/:\d+$/, '');
}

function byNode(samples: Sample[], nameOf: (instance: string) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of samples) {
    const instance = s.labels.instance;
    if (!instance || s.value === null) continue;
    const name = nameOf(instance);
    out.set(name, Math.max(out.get(name) ?? 0, s.value));
  }
  return out;
}

/** The worse of two losses. A missing value never wins over a real one. */
const worse = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b);

const sumKnown = (a: number | null, b: number | null): number | null =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);

export function buildFlow(input: FlowInput, options: FlowOptions): FlowModel {
  const loss = maxBy(input.loss, pingKey);
  const rtt = maxBy(input.rtt, pingKey);
  const rate = directedRates(input.bytes);
  const memberSet = new Set<string>();
  for (const samples of [input.loss, input.rtt, input.bytes]) {
    for (const s of samples) {
      const from = s.labels.source;
      const to = s.labels.target;
      if (!asNetwork(s.labels.network) || !from || !to || from === to) continue;
      memberSet.add(from);
      memberSet.add(to);
    }
  }
  const nodes = [...memberSet].sort(naturalOrder);
  const pairs: FlowPair[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const nets: NetPair[] = [];
      for (const network of NETWORK_IDS) {
        const dir = (from: string, to: string): DirStat => ({
          from,
          to,
          loss: loss.get(dirKey(network, from, to)) ?? null,
          rtt: rtt.get(dirKey(network, from, to)) ?? null,
          rate: rate.get(dirKey(network, from, to)) ?? null,
        });
        const ab = dir(a, b);
        const ba = dir(b, a);
        const has = [ab, ba].some(d => d.loss !== null || d.rtt !== null || d.rate !== null);
        if (!has) continue;
        const worst = worse(ab.loss, ba.loss);
        nets.push({
          network,
          ab,
          ba,
          loss: worst,
          rate: sumKnown(ab.rate, ba.rate),
          status: cellStatus(worst, options.warnAbove, options.critAbove),
        });
      }
      pairs.push({ a, b, nets });
    }
  }

  const nameOf = nodeNames(input.nodes);
  const shares = new Map(GROUPS.map(g => [g.id, byNode(input.groups[g.id] ?? [], nameOf)]));
  const retrans = byNode(input.retrans, nameOf);
  const health: NodeHealth[] = nodes.map(name => {
    const groups = Object.fromEntries(
      GROUPS.map(g => [g.id, shares.get(g.id)?.get(name) ?? null])
    ) as Record<GroupId, number | null>;
    const known = Object.values(groups).filter((v): v is number => v !== null);
    const worst = known.length > 0 ? Math.max(...known) : null;
    return {
      name,
      groups,
      retransmit: retrans.get(name) ?? null,
      worst,
      status: cellStatus(worst, options.nodeWarnAbove, options.nodeCritAbove),
    };
  });
  return { nodes, pairs, health, options };
}

/** Worst last: the order in which a graph draws, so the worst line stays on top. */
export const SEVERITY_ORDER: Record<PanelStatus, number> = { unknown: 0, ok: 1, warn: 2, crit: 3 };

export const worseStatus = (a: PanelStatus, b: PanelStatus): PanelStatus =>
  SEVERITY_ORDER[b] > SEVERITY_ORDER[a] ? b : a;

/** The view of the model for a selection: "all" takes the worst loss and all the traffic of every network. */
export function viewFor(model: FlowModel, selection: Selection): FlowView {
  const { warnAbove, critAbove } = model.options;
  const withData: Record<NetworkId, number> = { tailnet: 0, lan: 0, public: 0 };
  for (const p of model.pairs) {
    for (const n of p.nets) if (n.loss !== null) withData[n.network] += 1;
  }
  const summary: FlowSummary = {
    pairs: model.pairs.length,
    withData,
    above: 0,
    noData: 0,
  };
  let maxRate = 0;
  const pairs: PairView[] = model.pairs.map(p => {
    const nets = selection === 'all' ? p.nets : p.nets.filter(n => n.network === selection);
    let loss: number | null = null;
    let rate: number | null = null;
    let worst: PairView['worst'];
    for (const n of nets) {
      loss = worse(loss, n.loss);
      rate = sumKnown(rate, n.rate);
      for (const d of [n.ab, n.ba]) {
        if (d.loss !== null && (!worst || d.loss > worst.loss))
          worst = { from: d.from, to: d.to, loss: d.loss, network: n.network }; // dashboard-links: allow a host pair (from, to), not a link
      }
    }
    const status = cellStatus(loss, warnAbove, critAbove);
    if (status === 'crit') summary.above += 1;
    if (status === 'unknown') summary.noData += 1;
    if (rate !== null) maxRate = Math.max(maxRate, rate);
    if (worst && worst.loss > 0 && (!summary.worst || worst.loss > summary.worst.loss))
      summary.worst = worst;
    return { a: p.a, b: p.b, nets, loss, rate, status, worst };
  });
  const status: PanelStatus =
    summary.above > 0
      ? 'crit'
      : pairs.some(p => p.status === 'warn')
      ? 'warn'
      : summary.noData > 0
      ? 'unknown'
      : 'ok';
  return { selection, pairs, maxRate, summary, status };
}

/** The line width for a traffic rate: a thin minimum, then the square root of the share of the largest rate. */
export function lineWidth(rate: number | null, maxRate: number, min = 1, max = 5): number {
  if (rate === null || !(rate > 0) || !(maxRate > 0)) return min;
  return min + (max - min) * Math.sqrt(Math.min(1, rate / maxRate));
}

/** The summary line: "15 pairs, tailnet 15 lan 0 public 0 with data, 1 above 2%, worst a to b 2.4%". */
export function summaryText(view: FlowView, critAbove: number): string {
  const s = view.summary;
  const parts = [
    `${s.pairs} ${s.pairs === 1 ? 'pair' : 'pairs'}`,
    `with data: ${NETWORKS.map(n => `${n.label} ${s.withData[n.id]}`).join(', ')}`,
    `${s.above} above ${formatValue(critAbove, 'ratio')}`,
  ];
  if (s.worst)
    parts.push(`worst ${s.worst.from} to ${s.worst.to} ${formatValue(s.worst.loss, 'ratio')}`);
  return parts.join(', ');
}

/** A share of packets as a percent. A tiny share reads "<0.001%", never an exponent and never zero. */
export function formatShare(v: number | null): string {
  if (v === null) return 'no data';
  if (v === 0) return '0%';
  const pct = v * 100;
  return pct < 0.001 ? '<0.001%' : `${sig(pct)}%`;
}

export const formatRate = (r: number | null): string =>
  r === null ? 'no data' : `${formatBytes(r)}/s`;

/** The lines of a pair tooltip: for each network the loss, the round trip time and the rate of each direction. */
export function pairLines(p: PairView): string[] {
  const lines = [`${p.a} and ${p.b}`];
  if (p.nets.length === 0) return [...lines, 'no data'];
  for (const n of p.nets) {
    lines.push(
      `${networkLabel(n.network)}: loss ${
        n.loss === null ? 'no data' : formatValue(n.loss, 'ratio')
      }`
    );
    for (const d of [n.ab, n.ba]) {
      const parts = [
        `${d.from} to ${d.to}`,
        d.loss === null ? 'loss no data' : `loss ${formatValue(d.loss, 'ratio')}`,
        d.rtt === null ? 'round trip no data' : `round trip ${formatValue(d.rtt, 'seconds')}`,
        d.rate === null ? 'traffic no data' : `traffic ${formatRate(d.rate)}`,
      ];
      lines.push(parts.join(', '));
    }
  }
  return lines;
}

export interface Point {
  x: number;
  y: number;
}

/** Fixed positions on an ellipse, the first node at the top, clockwise. The same names give the same places. */
export function ringLayout(count: number, cx: number, cy: number, rx: number, ry: number): Point[] {
  if (count === 1) return [{ x: cx, y: cy }];
  return Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
  });
}

/**
 * The height of the graph. It takes about 58% of the room that the chips leave, never more than the
 * width allows, never less than the minimum, and it leaves room for at least two list rows.
 */
export function graphHeight(width: number, height: number, chipsHeight = 30): number {
  const room = Math.max(0, height - chipsHeight);
  const wanted = Math.min(room * 0.58, width * 0.75);
  const leaveList = room - 56;
  return Math.round(Math.max(110, Math.min(wanted, Math.max(110, leaveList))));
}
