/*
 * Sunburst geometry: pure functions, no React. Two rings. The inner ring has one arc per
 * category and the outer ring one arc per child. The full circle is the capacity, so an arc's
 * angle is its share of capacity and the unused part stays empty. A parent may be larger than
 * its children together: that gap stays empty too. Every group is its own arc at its real
 * size: there is no "Other" arc and no top-N cut. The ring proportions follow the Usage
 * plugin sunburst (the dashboard copies use a larger centre hole of 50 % of the radius, so the centre text fits).
 */

export interface SunburstChild {
  key: string;
  label: string;
  value: number;
  /** An optional note for the tooltip of the arc, for example where the data came from. */
  detail?: string;
}

export interface SunburstCategory {
  key: string;
  label: string;
  value: number;
  /** An optional note for the tooltip of the arc. */
  detail?: string;
  children?: SunburstChild[];
}

/** What the first ring of a sunburst is: the categories, or the nodes with the categories inside each. */
export type SunburstGroupBy = 'category' | 'node';

/** One node of a node-first sunburst: its capacity, its use and the categories inside it. */
export interface SunburstNode {
  key: string;
  label: string;
  /** What the node can hold. The free part is `capacity - used`, when that is positive. */
  capacity: number;
  /** What the node uses. */
  used: number;
  categories: SunburstCategory[];
}

export interface SunburstData {
  /** The full circle, in the unit of the values. */
  capacity: number;
  /** The categories of the whole circle. In node-first data this is the sum over the nodes. */
  categories: SunburstCategory[];
  /** Present for node-first data: the first ring is one arc per node and `categories` sit inside it. */
  nodes?: SunburstNode[];
}

export interface ArcShape {
  /** `category` for the inner ring, `child` for the outer ring. */
  level: 1 | 2;
  key: string;
  /** The key of the category this arc belongs to. */
  categoryKey: string;
  categoryIndex: number;
  label: string;
  value: number;
  /** Radians from 12 o'clock, clockwise. */
  start: number;
  end: number;
  inner: number;
  outer: number;
}

export const TAU = 2 * Math.PI;
/** The centre hole, as a share of the radius. Larger than on the Usage pages, so the centre text and the used value are large. */
export const CENTRE = 0.5;
/** The inner ring ends at this share of the radius. The outer ring fills the rest. */
export const INNER_END = 0.7;
/** A small gap between the two rings, in pixels. */
export const RING_GAP = 2;

const positive = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * The arcs for the data, for a chart of the given radius. A category larger than the capacity
 * (an overcommitted node) makes the scale the sum of the categories, so the circle never
 * overflows. Children that are larger together than their category are scaled down to fit it.
 */
export function layoutArcs(data: SunburstData, radius: number): ArcShape[] {
  const cats = data.categories
    .map(c => ({ ...c, value: positive(c.value) }))
    .filter(c => c.value > 0);
  const total = cats.reduce((s, c) => s + c.value, 0);
  const scale = Math.max(positive(data.capacity), total);
  if (scale <= 0) return [];
  const centre = radius * CENTRE;
  const split = radius * INNER_END;
  const arcs: ArcShape[] = [];
  let at = 0;
  cats.forEach((cat, ci) => {
    const start = at;
    const end = start + (cat.value / scale) * TAU;
    arcs.push({
      level: 1,
      key: cat.key,
      categoryKey: cat.key,
      categoryIndex: ci,
      label: cat.label,
      value: cat.value,
      start,
      end,
      inner: centre,
      outer: split - RING_GAP / 2,
    });
    const kids = (cat.children ?? [])
      .map(k => ({ ...k, value: positive(k.value) }))
      .filter(k => k.value > 0);
    const kidTotal = kids.reduce((s, k) => s + k.value, 0);
    const fit = kidTotal > cat.value ? cat.value / kidTotal : 1;
    let kat = start;
    for (const kid of kids) {
      const kend = kat + ((kid.value * fit) / scale) * TAU;
      arcs.push({
        level: 2,
        key: kid.key,
        categoryKey: cat.key,
        categoryIndex: ci,
        label: kid.label,
        value: kid.value,
        start: kat,
        end: kend,
        inner: split + RING_GAP / 2,
        outer: radius,
      });
      kat = kend;
    }
    at = end;
  });
  return arcs;
}

const pt = (r: number, angle: number): [number, number] => [
  r * Math.sin(angle),
  -r * Math.cos(angle),
];
const f = (n: number): string => (Math.abs(n) < 1e-9 ? '0' : n.toFixed(3).replace(/\.?0+$/, ''));

/**
 * The SVG path of a ring sector around (0, 0). A full circle is drawn as two halves, because
 * one arc command cannot draw a circle.
 */
export function arcPath(inner: number, outer: number, start: number, end: number): string {
  const span = end - start;
  if (!(span > 0) || !(outer > inner)) return '';
  if (span >= TAU - 1e-6) {
    const ring = (r: number, sweep: 0 | 1) =>
      `M 0 ${f(-r)} A ${f(r)} ${f(r)} 0 1 ${sweep} 0 ${f(r)} A ${f(r)} ${f(r)} 0 1 ${sweep} 0 ${f(
        -r
      )} Z`;
    return `${ring(outer, 1)} ${inner > 0 ? ring(inner, 0) : ''}`.trim();
  }
  const large = span > Math.PI ? 1 : 0;
  const [ox0, oy0] = pt(outer, start);
  const [ox1, oy1] = pt(outer, end);
  const [ix1, iy1] = pt(inner, end);
  const [ix0, iy0] = pt(inner, start);
  return (
    `M ${f(ox0)} ${f(oy0)} A ${f(outer)} ${f(outer)} 0 ${large} 1 ${f(ox1)} ${f(oy1)} ` +
    `L ${f(ix1)} ${f(iy1)} A ${f(inner)} ${f(inner)} 0 ${large} 0 ${f(ix0)} ${f(iy0)} Z`
  );
}

/** The path of the whole empty track behind the arcs (the capacity circle). */
export function trackPath(radius: number): string {
  return arcPath(radius * CENTRE, radius, 0, TAU);
}

/** Share of the capacity that is used, between 0 and 1 (more than one is capped). */
export function usedShare(data: SunburstData): number {
  const used = data.categories.reduce((s, c) => s + positive(c.value), 0);
  return data.capacity > 0 ? Math.min(1, used / data.capacity) : used > 0 ? 1 : 0;
}

/** Average glyph width as a share of the font size, for the sans fonts of Headlamp. */
const GLYPH = 0.56;
/** Bold digits with tabular figures are wider. */
const GLYPH_BOLD = 0.62;

/**
 * The font size that makes `text` fit the centre hole. `base` is the size for short text, `lineY` is the
 * distance of the line centre from the middle of the hole and `radius` is the radius of the whole chart.
 * The width is the chord of the hole at that height, with a small margin. It never goes above `base`.
 */
export function fitCentreText(
  text: string,
  base: number,
  lineY: number,
  radius: number,
  bold = false
): number {
  const hole = radius * CENTRE;
  const half = Math.sqrt(Math.max(0, hole * hole - lineY * lineY));
  const width = half * 2 * 0.9;
  const glyph = bold ? GLYPH_BOLD : GLYPH;
  const chars = Math.max(1, text.length);
  return Math.min(base, Math.max(3, width / (chars * glyph)));
}

/** The rings of a node-first sunburst: the node ring, the category ring and the child ring. */
export const NODE_RING_END = 0.66;
export const CATEGORY_RING_END = 0.83;

export type NodeArcKind = 'node' | 'category' | 'child' | 'free';

export interface NodeArcShape {
  kind: NodeArcKind;
  /** The key of the arc. A free arc has the key `<node key>/~free`. */
  key: string;
  label: string;
  value: number;
  nodeKey: string;
  nodeLabel: string;
  /** The key of the category, for a category or a child arc. Empty otherwise. */
  categoryKey: string;
  categoryLabel: string;
  /** The note of the category or child, for the tooltip. */
  detail?: string;
  start: number;
  end: number;
  inner: number;
  outer: number;
}

/** The key of the free slice of a node. */
export const freeKey = (nodeKey: string): string => `${nodeKey}/~free`;

/** The size of a node wedge: its capacity, or its use when that is larger (an overcommitted node). */
export const nodeSpan = (n: Pick<SunburstNode, 'capacity' | 'used'>): number =>
  Math.max(positive(n.capacity), positive(n.used));

/** The smallest angle of a node arc, in radians (about 19 degrees): room for a short node name. */
export const MIN_NODE_ANGLE = 0.34;

/**
 * The angle of each node: its share of the circle, but never less than `MIN_NODE_ANGLE`, so a small
 * node stays visible and can hold its label. The larger nodes shrink by the same factor to make room.
 * With very many nodes the minimum shrinks to a quarter of an even share.
 */
export function nodeAngles(spans: number[]): number[] {
  const total = spans.reduce((s, v) => s + v, 0);
  if (spans.length === 0 || total <= 0) return spans.map(() => 0);
  const floor = Math.min(MIN_NODE_ANGLE, TAU / (2 * spans.length));
  const small = new Set<number>();
  let angles = spans.map(v => (v / total) * TAU);
  for (let pass = 0; pass <= spans.length; pass++) {
    const room = TAU - small.size * floor;
    const big = spans.reduce((s, v, i) => (small.has(i) ? s : s + v), 0);
    angles = spans.map((v, i) => (small.has(i) ? floor : big > 0 ? (v / big) * room : 0));
    const next = angles.findIndex((a, i) => !small.has(i) && a < floor);
    if (next < 0) break;
    small.add(next);
  }
  return angles;
}

/**
 * The arcs of a node-first sunburst, for a chart of the given radius. The first ring is one arc
 * per node, sized by its capacity (or its use, when that is larger). Inside each node the second
 * ring is one arc per category and the third ring one arc per child, each at its real size. The
 * capacity that the node does not use is a free arc at the end of the node, over the second and
 * third ring. Every group is its own arc: no "Other" arc and no top-N cut.
 */
export function layoutNodeArcs(nodes: SunburstNode[], radius: number): NodeArcShape[] {
  const all = nodes.map(n => ({ ...n, span: nodeSpan(n) }));
  const scale = all.reduce((s, n) => s + n.span, 0);
  if (scale <= 0) return [];
  // A node that has no capacity and no use among others still gets its minimum arc, so every node
  // of a legend has an arc.
  const list = all;
  const angles = nodeAngles(list.map(n => n.span));
  const centre = radius * CENTRE;
  const nodeEnd = radius * NODE_RING_END;
  const catEnd = radius * CATEGORY_RING_END;
  const arcs: NodeArcShape[] = [];
  let at = 0;
  for (const [ni, node] of list.entries()) {
    const start = at;
    const end = start + angles[ni];
    // The angle of one unit inside this node. A small node is widened to its minimum arc, and its
    // categories, children and free slice widen with it, so they still fill the node exactly.
    const unit = node.span > 0 ? angles[ni] / node.span : 0;
    arcs.push({
      kind: 'node',
      key: node.key,
      label: node.label,
      value: positive(node.used),
      nodeKey: node.key,
      nodeLabel: node.label,
      categoryKey: '',
      categoryLabel: '',
      start,
      end,
      inner: centre,
      outer: nodeEnd - RING_GAP / 2,
    });
    const cats = node.categories
      .map(c => ({ ...c, value: positive(c.value) }))
      .filter(c => c.value > 0);
    const catTotal = cats.reduce((s, c) => s + c.value, 0);
    // Categories that sum to more than the node (sampling skew) are scaled down to fit it.
    const free = Math.max(0, node.span - positive(node.used));
    const room = node.span - free;
    const fitCats = catTotal > room && catTotal > 0 ? room / catTotal : 1;
    let cat = start;
    for (const c of cats) {
      const cend = cat + c.value * fitCats * unit;
      arcs.push({
        kind: 'category',
        key: c.key,
        label: c.label,
        value: c.value,
        nodeKey: node.key,
        nodeLabel: node.label,
        categoryKey: c.key,
        categoryLabel: c.label,
        detail: c.detail,
        start: cat,
        end: cend,
        inner: nodeEnd + RING_GAP / 2,
        outer: catEnd - RING_GAP / 2,
      });
      const kids = (c.children ?? [])
        .map(k => ({ ...k, value: positive(k.value) }))
        .filter(k => k.value > 0);
      const kidTotal = kids.reduce((s, k) => s + k.value, 0);
      const fitKids = kidTotal > c.value ? c.value / kidTotal : 1;
      let kat = cat;
      for (const k of kids) {
        const kend = kat + k.value * fitCats * fitKids * unit;
        arcs.push({
          kind: 'child',
          key: k.key,
          label: k.label,
          value: k.value,
          nodeKey: node.key,
          nodeLabel: node.label,
          categoryKey: c.key,
          categoryLabel: c.label,
          detail: k.detail,
          start: kat,
          end: kend,
          inner: catEnd + RING_GAP / 2,
          outer: radius,
        });
        kat = kend;
      }
      cat = cend;
    }
    if (free > 0) {
      arcs.push({
        kind: 'free',
        key: freeKey(node.key),
        label: 'Free',
        value: free,
        nodeKey: node.key,
        nodeLabel: node.label,
        categoryKey: '',
        categoryLabel: '',
        start: end - free * unit,
        end,
        inner: nodeEnd + RING_GAP / 2,
        outer: radius,
      });
    }
    at = end;
  }
  return arcs;
}
