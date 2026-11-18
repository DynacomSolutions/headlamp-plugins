/*
 * Arc geometry and colour for the node sunburst. Angles are computed by hand: a parent may be
 * larger than its children together, and that gap must stay empty. At the root the circle is
 * sized against node capacity, so the unused share is empty too.
 */
import { colourAt, Mode } from '../palette';
import { nameOf } from './names';
import { capacityZoom, findPath, gapNodes, NodeTree, SunNode, UNUSED } from './tree';

export interface ArcDatum {
  key: string;
  node: SunNode;
  depth: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  fill: string;
  /** Empty space (unused capacity or unattributed): drawn without fill, but still selectable. */
  gap?: boolean;
}

const TAU = 2 * Math.PI;
/** Radius of the centre disc as a share of the chart radius. */
export const CENTRE = 0.24;

/** Hue and saturation of a `#rrggbb` or `hsl(h, s%, l%)` colour, plus its lightness. */
function toHsl(c: string): { h: number; s: number; l: number } {
  const m = c.match(/^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/);
  if (m) return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
  const r = parseInt(c.slice(1, 3), 16) / 255;
  const g = parseInt(c.slice(3, 5), 16) / 255;
  const b = parseInt(c.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 };
}

/**
 * A shade of `base` for a node at `depth` (1 = category) and sibling `index`. The hue never
 * changes; lightness moves away from the base with depth and alternates a little between
 * siblings. It stays inside 28..76 % so it is never near white or black.
 */
export function shade(base: string, depth: number, index: number): string {
  const { h, s, l } = toHsl(base);
  const dir = l < 50 ? 1 : -1;
  const lightness = Math.min(76, Math.max(28, l + dir * ((depth - 1) * 7 + (index % 3) * 4)));
  return `hsl(${h.toFixed(2)}, ${Math.round(s)}%, ${lightness.toFixed(1)}%)`;
}

const NODE_BASE: Record<Mode, string> = { light: '#8a919a', dark: '#6b7280' };

/** Fixed palette slots, so a category keeps its colour whichever other categories are present. */
const CATEGORY_SLOT: Record<string, number> = { k8s: 0, t3: 1, herdr: 2, other: 3, system: 5 };
const FREE_SLOTS = [4, 6, 7, 8, 9, 10, 11, 12];

/** The colour of a top-level category, from its key alone (unknown keys hash to a free slot). */
export function categoryColour(key: string, mode: Mode): string {
  const slot = CATEGORY_SLOT[key];
  if (slot !== undefined) return colourAt(slot, mode);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return colourAt(FREE_SLOTS[h % FREE_SLOTS.length], mode);
}

export function layoutSunburst(
  tree: NodeTree,
  focus: string[],
  opts: { radius: number; rings: number; mode: Mode }
): {
  arcs: ArcDatum[];
  focusNode: SunNode;
  /** The focus path this tree has: the deepest existing prefix of `focus`. */
  path: string[];
  /** The focus node's value, its share of capacity and of its parent (null at the root). */
  centre: { title: string; value: number; share: number; parentShare: number | null };
} {
  const { radius, rings, mode } = opts;
  const path = findPath(tree.root, focus);
  const focusNode = path[path.length - 1];
  const atRoot = path.length === 1;
  // The category ring is the second ring when the first is one arc per node.
  const catDepth = tree.nodeRing ? 2 : 1;
  const categoryOf = path[catDepth];
  const arcs: ArcDatum[] = [];
  const thickness = (radius * (1 - CENTRE)) / rings;
  const parent = atRoot ? null : path[path.length - 2];
  // Zoomed into one node of a node ring: its capacity is the base, as at a single-node root.
  const capScope = capacityZoom(
    tree,
    path.slice(1).map(n => n.key)
  );

  const walk = (
    parent: SunNode,
    x0: number,
    x1: number,
    depth: number,
    absDepth: number,
    base: string | null
  ) => {
    // At the root of a node ring each node wedge is sized by its span (capacity), not its use.
    const ringRoot = tree.nodeRing === true && parent === tree.root;
    const denom = ringRoot
      ? parent.children.reduce((s, c) => s + (c.span ?? c.value), 0)
      : parent.value;
    if (depth > rings || !(denom > 0)) return;
    const y0 = radius * (CENTRE + (1 - CENTRE) * ((depth - 1) / rings));
    const y1 = y0 + thickness;
    let acc = 0;
    parent.children.forEach((child, i) => {
      const c0 = x0 + (acc / denom) * (x1 - x0);
      acc += ringRoot ? child.span ?? child.value : child.value;
      const c1 = x0 + (acc / denom) * (x1 - x0);
      let colour = base;
      let fill: string;
      if (absDepth < catDepth) {
        // A node arc: grey, so the category colours below it stay the only hues.
        colour = null;
        fill = shade(NODE_BASE[mode], 1, i);
      } else if (absDepth === catDepth) {
        colour = categoryColour(child.key, mode);
        fill = colour;
      } else {
        fill = shade(base as string, absDepth, i);
      }
      arcs.push({
        key: child.key,
        node: child,
        depth,
        x0: c0,
        x1: c1,
        y0,
        y1,
        fill,
      });
      if (ringRoot && child.span !== undefined && child.span > 0) {
        // The children fill the used part of the wedge. The rest is empty, out to the rim.
        const usedEnd = c0 + (child.value / child.span) * (c1 - c0);
        walk(child, c0, usedEnd, depth + 1, absDepth + 1, colour);
        const free = gapNodes(tree, child, false).find(g => g.key === `${child.key}/${UNUSED}`);
        if (free && depth + 1 <= rings) {
          const gy0 = radius * (CENTRE + (1 - CENTRE) * (depth / rings));
          arcs.push({
            key: free.key,
            node: free,
            depth: depth + 1,
            x0: usedEnd,
            x1: c1,
            y0: gy0,
            y1: radius,
            fill: 'none',
            gap: true,
          });
        }
      } else {
        walk(child, c0, c1, depth + 1, absDepth + 1, colour);
      }
    });
    if (ringRoot) return;
    // The empty space: what the children leave inside the parent, then (at the root) the
    // capacity nothing uses, up to the full circle. A node ring fills the circle by node capacity
    // instead, and each node wedge holds its own unused gap.
    let at = x0 + (acc / parent.value) * (x1 - x0);
    for (const g of gapNodes(tree, parent, parent === tree.root && atRoot)) {
      // A node wedge's unused gap is drawn by its caller, and only at the root.
      if (parent.span !== undefined && g.key.endsWith(`/${UNUSED}`)) continue;
      const end = g.key.endsWith(`/${UNUSED}`)
        ? TAU
        : Math.min(x1, at + (g.value / parent.value) * (x1 - x0));
      // Nothing is drawn below an empty arc, so it runs through every deeper ring to the rim.
      arcs.push({
        key: g.key,
        node: g,
        depth,
        x0: at,
        x1: end,
        y0,
        y1: radius,
        fill: 'none',
        gap: true,
      });
      at = end;
    }
  };

  if (atRoot && tree.nodeRing) {
    walk(tree.root, 0, TAU, 1, 1, null);
  } else if (atRoot) {
    const total = tree.used ?? tree.root.value;
    const end = tree.capacity > 0 ? Math.min(TAU, (TAU * total) / tree.capacity) : 0;
    walk(tree.root, 0, end, 1, 1, null);
  } else if (capScope !== null && focusNode.span !== undefined && focusNode.span > 0) {
    // One node of a node ring reads like a single-node root: its use, then its unused gap.
    const usedEnd = (TAU * focusNode.value) / focusNode.span;
    walk(focusNode, 0, usedEnd, 1, path.length, null);
    const free = gapNodes(tree, focusNode, false).find(g => g.key === `${focusNode.key}/${UNUSED}`);
    if (free) {
      arcs.push({
        key: free.key,
        node: free,
        depth: 1,
        x0: usedEnd,
        x1: TAU,
        y0: radius * CENTRE,
        y1: radius,
        fill: 'none',
        gap: true,
      });
    }
  } else {
    walk(
      focusNode,
      0,
      TAU,
      1,
      path.length,
      categoryOf ? categoryColour(categoryOf.key, mode) : null
    );
  }

  return {
    arcs,
    focusNode,
    path: path.slice(1).map(n => n.key),
    centre: {
      title: nameOf(focusNode),
      value: focusNode.value,
      share: (capScope ?? tree.capacity) > 0 ? focusNode.value / (capScope ?? tree.capacity) : 0,
      parentShare: parent && parent.value > 0 ? focusNode.value / parent.value : parent ? 0 : null,
    },
  };
}
