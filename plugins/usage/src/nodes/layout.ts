/*
 * Arc geometry and colour for the node sunburst. Angles are computed by hand: a parent may be
 * larger than its children together, and that gap must stay empty. At the root the circle is
 * sized against node capacity, so the unused share is empty too.
 */
import { colourAt, Mode } from '../palette';
import { findPath, NodeTree, SunNode } from './tree';

export interface ArcDatum {
  key: string;
  node: SunNode;
  depth: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  fill: string;
  label: string | null;
  showIcon: boolean;
}

const TAU = 2 * Math.PI;
const CENTRE = 0.3;
const MIN_LABEL_ARC = 48;
const MIN_LABEL_RING = 20;
const MIN_ICON_ARC = 40;

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

export function layoutSunburst(
  tree: NodeTree,
  focus: string[],
  opts: { radius: number; rings: number; mode: Mode }
): {
  arcs: ArcDatum[];
  focusNode: SunNode;
  centre: { title: string; value: number; share: number };
} {
  const { radius, rings, mode } = opts;
  const path = findPath(tree.root, focus);
  const focusNode = path[path.length - 1];
  const atRoot = path.length === 1;
  const categoryOf = path[1];
  const arcs: ArcDatum[] = [];
  const thickness = (radius * (1 - CENTRE)) / rings;

  const walk = (
    parent: SunNode,
    x0: number,
    x1: number,
    depth: number,
    absDepth: number,
    base: string | null
  ) => {
    if (depth > rings || !(parent.value > 0)) return;
    const y0 = radius * (CENTRE + (1 - CENTRE) * ((depth - 1) / rings));
    const y1 = y0 + thickness;
    let acc = 0;
    parent.children.forEach((child, i) => {
      const c0 = x0 + (acc / parent.value) * (x1 - x0);
      acc += child.value;
      const c1 = x0 + (acc / parent.value) * (x1 - x0);
      let colour = base;
      let fill: string;
      if (absDepth === 1) {
        colour = colourAt(i, mode);
        fill = colour;
      } else {
        fill = shade(base as string, absDepth, i);
      }
      const arc = ((c1 - c0) * (y0 + y1)) / 2;
      const roomy = arc >= MIN_LABEL_ARC && y1 - y0 >= MIN_LABEL_RING;
      arcs.push({
        key: child.key,
        node: child,
        depth,
        x0: c0,
        x1: c1,
        y0,
        y1,
        fill,
        label: roomy ? child.label : null,
        showIcon: child.kind === 'project' && arc >= MIN_ICON_ARC,
      });
      walk(child, c0, c1, depth + 1, absDepth + 1, colour);
    });
  };

  if (atRoot) {
    const total = tree.used ?? tree.root.value;
    const end = tree.capacity > 0 ? Math.min(TAU, (TAU * total) / tree.capacity) : 0;
    walk(tree.root, 0, end, 1, 1, null);
  } else {
    const idx = tree.root.children.indexOf(categoryOf);
    walk(focusNode, 0, TAU, 1, path.length, colourAt(idx, mode));
  }

  return {
    arcs,
    focusNode,
    centre: {
      title: focusNode.label,
      value: focusNode.value,
      share: tree.capacity > 0 ? focusNode.value / tree.capacity : 0,
    },
  };
}
