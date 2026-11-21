/*
 * The legend model of a pair of node-first sunbursts that share one legend. Pure functions, no
 * React. The legend has one colour key (every category of either chart, then the free capacity)
 * and one line for each node. A node line holds one bar for each chart. A bar is split by category
 * and ends with the free capacity of the node. Every node and every category stays: no "Other"
 * group and no top-N cut.
 */
import { nodeSpan, SunburstData, SunburstNode } from './geometry';
import { categoryArcId, freeArcId, freeOf, nodeArcId } from './NodeRing';

/** The key of the free segment of a bar and of the free chip of the colour key. */
export const FREE_SEGMENT = '~free';

export interface PairSegment {
  /** The category key, or `FREE_SEGMENT`. */
  key: string;
  /** The arc id that this segment highlights in both charts. */
  id: string;
  label: string;
  value: number;
  free: boolean;
}

/** One stacked bar: what a node uses in one chart, by category, then what is free. */
export interface PairBar {
  used: number;
  /** The capacity of the node, or its use when that is larger. */
  total: number;
  segments: PairSegment[];
}

export interface PairLegendNode {
  key: string;
  label: string;
  /** The arc id of the node. */
  id: string;
  /** One bar for each chart, or none when that chart has no such node. */
  bars: [PairBar | undefined, PairBar | undefined];
}

export interface PairKeyEntry {
  key: string;
  label: string;
}

export interface PairLegend {
  /** Every category of either chart, by name, for the colour key. */
  categories: PairKeyEntry[];
  /** True when a node has free capacity, so the key shows the free chip. */
  hasFree: boolean;
  nodes: PairLegendNode[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The one node order of a pair: every node of either chart, by name in natural order. The order does
 * not depend on the size of a node or on the chart, so the same node sits at the same place in both
 * rings and in the legend, and a refresh never moves it.
 */
export function pairOrder(a: SunburstData, b: SunburstData): Array<{ key: string; label: string }> {
  const seen = new Map<string, string>();
  for (const n of [...(a.nodes ?? []), ...(b.nodes ?? [])])
    if (!seen.has(n.key)) seen.set(n.key, n.label);
  return [...seen]
    .map(([key, label]) => ({ key, label }))
    .sort((x, y) => collator.compare(x.label, y.label) || x.key.localeCompare(y.key));
}

/**
 * The data of one ring with its nodes in the given order. A node that the ring has not gets an empty
 * node, so every node of the legend has an arc in both rings.
 */
export function inOrder(
  data: SunburstData,
  order: ReadonlyArray<{ key: string; label: string }>
): SunburstData {
  const have = new Map((data.nodes ?? []).map(n => [n.key, n]));
  return {
    ...data,
    nodes: order.map(
      o => have.get(o.key) ?? { key: o.key, label: o.label, capacity: 0, used: 0, categories: [] }
    ),
  };
}

const barOf = (
  n: SunburstNode | undefined,
  nodeKey: string,
  rank: Map<string, number>
): PairBar | undefined => {
  if (!n) return undefined;
  const segments: PairSegment[] = n.categories
    .filter(c => c.value > 0)
    .sort((x, y) => (rank.get(x.key) ?? 0) - (rank.get(y.key) ?? 0) || x.key.localeCompare(y.key))
    .map(c => ({
      key: c.key,
      id: categoryArcId(nodeKey, c.key),
      label: c.label,
      value: c.value,
      free: false,
    }));
  const free = freeOf(n);
  if (free > 0)
    segments.push({
      key: FREE_SEGMENT,
      id: freeArcId(nodeKey),
      label: 'Free',
      value: free,
      free: true,
    });
  return { used: Math.max(0, n.used), total: nodeSpan(n), segments };
};

/**
 * The compact legend of both charts: the colour key and one line for each node, in the order of
 * `pairOrder`. The categories of a bar follow the order of the colour key, so a category sits at the
 * same place on every line.
 */
export function pairLegend(a: SunburstData, b: SunburstData): PairLegend {
  const an = a.nodes ?? [];
  const bn = b.nodes ?? [];
  const names = new Map<string, string>();
  for (const n of [...an, ...bn])
    for (const c of n.categories) if (c.value > 0 && !names.has(c.key)) names.set(c.key, c.label);
  const categories = [...names]
    .map(([key, label]) => ({ key, label }))
    .sort((x, y) => collator.compare(x.label, y.label) || x.key.localeCompare(y.key));
  const rank = new Map(categories.map((c, i) => [c.key, i]));
  const nodes = pairOrder(a, b).map(({ key, label }) => ({
    key,
    label,
    id: nodeArcId(key),
    bars: [
      barOf(
        an.find(n => n.key === key),
        key,
        rank
      ),
      barOf(
        bn.find(n => n.key === key),
        key,
        rank
      ),
    ] as [PairBar | undefined, PairBar | undefined],
  }));
  const hasFree = nodes.some(n => n.bars.some(bar => bar?.segments.some(s => s.free)));
  return { categories, hasFree, nodes };
}

/**
 * The short value of a bar: the used part and the total, with the unit once. When the two parts
 * have different units (for example MiB and GiB) each keeps its own.
 */
export function shortUsage(used: number, total: number, format: (value: number) => string): string {
  const u = format(used);
  const t = format(total);
  const split = (s: string) => {
    const at = s.indexOf(' ');
    return at < 0 ? [s, ''] : [s.slice(0, at), s.slice(at + 1)];
  };
  const [un, uu] = split(u);
  const [, tu] = split(t);
  return uu === tu ? `${un} / ${t}` : `${u} / ${t}`;
}

export type PairMode = 'right' | 'below-side' | 'below-stack';

export interface PairLayout {
  /**
   * `right`: the rings side by side, the legend on their right. `below-side`: the rings side by
   * side, the legend below. `below-stack`: one ring above the other, the legend below.
   */
  mode: PairMode;
  /** The side of one ring in px. 0 when the box has no size yet, so a ring fills its box. */
  ring: number;
}

const GAP = 8;
/** Below this width the widget is narrow: the rings stack, CPU above memory, and never sit side by side. */
export const NARROW_WIDTH = 560;
/** The width that the legend needs when it sits beside the rings. */
export const LEGEND_MIN_WIDTH = 300;
/** The height of the colour key and the head of the legend. */
const LEGEND_FIXED = 62;
/** The height of one node line. */
export const NODE_LINE = 30;
/**
 * The side of a ring in a narrow box, as a share of its width. The circle fills 96 % of its square,
 * so the diameter is about 90 % of the width and a small padding stays at each side.
 */
export const NARROW_RING_SHARE = 0.94;
/** The least height of the legend in a narrow box: the key, the head and about two nodes. */
const NARROW_LEGEND_MIN = 120;

/**
 * Where the rings and the legend go in a box, and how big a ring is.
 *
 * A narrow box (under `NARROW_WIDTH`) always stacks the rings, CPU above memory, each nearly as wide
 * as the box. The legend goes below and scrolls. The ring gives way only when the box is too short
 * for the least legend.
 *
 * A wide box tries three layouts and takes the one with the biggest ring: the legend on the right,
 * the legend below two rings side by side, or the legend below two stacked rings. When the legend goes
 * below, it keeps the height that its nodes need, but not more than about half of the box.
 */
export function pairLayout(width: number, height: number, nodeCount: number): PairLayout {
  if (width <= 0 || height <= 0) return { mode: 'right', ring: 0 };
  const floor = (n: number) => Math.max(0, Math.floor(n));
  if (width < NARROW_WIDTH) {
    const ring = Math.min(width * NARROW_RING_SHARE, (height - NARROW_LEGEND_MIN - 2 * GAP) / 2);
    return { mode: 'below-stack', ring: floor(ring) };
  }
  const need = LEGEND_FIXED + nodeCount * NODE_LINE;
  const legend = Math.min(need, Math.max(160, height * 0.45));
  const options: PairLayout[] = [
    { mode: 'right', ring: Math.min(height, (width - LEGEND_MIN_WIDTH - GAP) / 2) },
    { mode: 'below-side', ring: Math.min((width - GAP) / 2, height - legend - GAP) },
    { mode: 'below-stack', ring: Math.min(width, (height - legend - 2 * GAP) / 2) },
  ].map(o => ({ ...o, ring: floor(o.ring) })) as PairLayout[];
  return options.reduce((best, o) => (o.ring > best.ring ? o : best));
}
