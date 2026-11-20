/*
 * Sunburst geometry: pure functions, no React. Two rings. The inner ring has one arc per
 * category and the outer ring one arc per child. The full circle is the capacity, so an arc's
 * angle is its share of capacity and the unused part stays empty. A parent may be larger than
 * its children together: that gap stays empty too. Every group is its own arc at its real
 * size: there is no "Other" arc and no top-N cut. The ring proportions follow the Usage
 * plugin sunburst (the dashboard copies use a larger centre hole of 36 % of the radius, so the centre text fits).
 */

export interface SunburstChild {
  key: string;
  label: string;
  value: number;
}

export interface SunburstCategory {
  key: string;
  label: string;
  value: number;
  children?: SunburstChild[];
}

export interface SunburstData {
  /** The full circle, in the unit of the values. */
  capacity: number;
  categories: SunburstCategory[];
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
/** The centre hole, as a share of the radius. Larger than on the Usage pages, so the centre text fits. */
export const CENTRE = 0.36;
/** The inner ring ends at this share of the radius. The outer ring fills the rest. */
export const INNER_END = 0.68;
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
