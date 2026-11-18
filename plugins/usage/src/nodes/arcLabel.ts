/*
 * Text inside the sunburst: where an arc label goes (radial or tangential, whichever fits more
 * characters), whether a project icon fits before it, and which lines of the focus summary fit
 * in the centre disc. Character widths are estimated, so every limit keeps some slack.
 */

/** Average glyph width as a share of the font size. */
export const CHAR_WIDTH = 0.6;
/** Room kept at each end of a label and between the label and the arc edges. */
const PAD = 4;
/** A clipped label keeps at least this many characters, else it is not drawn. */
const MIN_CLIPPED = 6;
/** The centre title is clipped to at least this many characters, or the line is dropped. */
const MIN_CHARS = 4;
/** An icon needs at least this many label characters beside it. */
const MIN_CHARS_WITH_ICON = 3;
export const ARC_ICON = 20;
/** An arc icon is as large as fits, between these sizes (px). */
export const ICON_MIN = 16;
export const ICON_MAX = 40;
export const ARC_ICON_GAP = 4;

export interface ArcGeometry {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface ArcLabel {
  text: string;
  /** Centre of the label (and icon) group, in chart coordinates. */
  x: number;
  y: number;
  /** Rotation in degrees for the text baseline, so it never reads upside down. */
  rotate: number;
  orientation: 'radial' | 'tangential';
  icon: boolean;
  /** Estimated width of the whole group (icon, gap and text). */
  width: number;
  /** Size of the icon inside the group, when `icon` is set. */
  iconSize: number;
}

function chars(length: number, fontSize: number): number {
  return Math.max(0, Math.floor(length / (fontSize * CHAR_WIDTH)));
}

export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return max < 1 ? '' : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Where the label (and icon, when `wantIcon`) of an arc goes, or null when not even a few
 * characters fit. Angles are d3 angles: 0 at the top, clockwise.
 */
export function arcLabel(
  a: ArcGeometry,
  label: string,
  fontSize: number,
  wantIcon = false,
  iconSize = ARC_ICON
): ArcLabel | null {
  const rm = (a.y0 + a.y1) / 2;
  const thickness = a.y1 - a.y0;
  const width = (a.x1 - a.x0) * rm;

  // Radial: across the arc there must be room for one line; along the radius, the ring.
  const radial = { cross: width, along: thickness - 2 * PAD };
  // Tangential: a straight line through the middle of the ring, kept inside the arc's angle and
  // inside the outer edge (the ends of a straight line move outwards).
  const outer = a.y1 - PAD;
  const inner = rm + fontSize / 2;
  const chord = outer > inner ? 2 * Math.sqrt(outer * outer - inner * inner) : 0;
  const tangential = { cross: thickness, along: Math.min(width - 2 * PAD, chord) };

  const option = (o: { cross: number; along: number }) => {
    if (o.cross < fontSize + PAD) return null;
    const plain = chars(o.along, fontSize);
    const iconFits = wantIcon && o.cross >= iconSize + PAD;
    const withIcon = iconFits ? chars(o.along - iconSize - ARC_ICON_GAP, fontSize) : 0;
    const icon = iconFits && withIcon >= Math.min(label.length, MIN_CHARS_WITH_ICON);
    const n = icon ? withIcon : plain;
    // A clipped name needs more than a stub: 5 characters and an ellipsis, or nothing.
    if (n < label.length && n < MIN_CLIPPED) return null;
    if (n < 1) return null;
    return { n, icon };
  };
  const r = option(radial);
  const t = option(tangential);
  if (!r && !t) return null;
  const useRadial = !!r && (!t || r.n > t.n);
  const pick = (useRadial ? r : t) as { n: number; icon: boolean };

  const mid = (a.x0 + a.x1) / 2;
  const deg = (mid * 180) / Math.PI;
  let rotate: number;
  if (useRadial) {
    // Along the radius, reading outwards on the right half and inwards on the left half.
    rotate = mid > Math.PI ? deg + 90 : deg - 90;
  } else {
    // Across the radius, upright on the top half and turned round on the bottom half.
    rotate = mid > Math.PI / 2 && mid < (3 * Math.PI) / 2 ? deg - 180 : deg;
  }
  const text = clipText(label, pick.n);
  return {
    text,
    x: rm * Math.sin(mid),
    y: -rm * Math.cos(mid),
    rotate,
    orientation: useRadial ? 'radial' : 'tangential',
    icon: pick.icon,
    width: (pick.icon ? iconSize + ARC_ICON_GAP : 0) + text.length * fontSize * CHAR_WIDTH,
    iconSize,
  };
}

export interface CentreLine {
  kind: 'icon' | 'title' | 'value' | 'node' | 'parent';
  text: string;
  /** Baseline centre for text, top for the icon. */
  y: number;
  fontSize: number;
}

/**
 * The lines of the centre disc that fit inside a circle of radius `r`, top to bottom, most
 * important first when room is short: title, value, % of node, % of parent, icon. The title is
 * clipped to the chord of the disc at its height; the numbers show in full or not at all.
 */
export function centreLines(
  r: number,
  fontSize: number,
  lines: { title: string; value: string; node?: string; parent?: string; icon: boolean }
): CentreLine[] {
  const lineH = fontSize * 1.25;
  const valueFont = fontSize * 1.3;
  const valueH = valueFont * 1.2;
  const iconH = ARC_ICON + 4;
  const wanted: { kind: CentreLine['kind']; text: string; h: number; font: number }[] = [
    { kind: 'title', text: lines.title, h: lineH, font: fontSize },
    { kind: 'value', text: lines.value, h: valueH, font: valueFont },
  ];
  if (lines.node) wanted.push({ kind: 'node', text: lines.node, h: lineH, font: fontSize });
  if (lines.parent) wanted.push({ kind: 'parent', text: lines.parent, h: lineH, font: fontSize });
  if (lines.icon) wanted.push({ kind: 'icon', text: '', h: iconH, font: fontSize });
  const order: CentreLine['kind'][] = ['icon', 'title', 'value', 'node', 'parent'];

  // Drop the least important lines until the stack fits, each clipped to its chord.
  for (let count = wanted.length; count > 0; count--) {
    const chosen = wanted
      .slice(0, count)
      .sort((p, q) => order.indexOf(p.kind) - order.indexOf(q.kind));
    const total = chosen.reduce((s, l) => s + l.h, 0);
    let top = -total / 2;
    const out: CentreLine[] = [];
    let ok = true;
    for (const l of chosen) {
      const far = Math.max(Math.abs(top), Math.abs(top + l.h));
      const half = r * r - far * far;
      const room = half > 0 ? 2 * Math.sqrt(half) - 2 * PAD : 0;
      if (l.kind === 'icon') {
        if (room < ARC_ICON) ok = false;
        out.push({ kind: 'icon', text: '', y: top + 2, fontSize: l.font });
      } else {
        const max = chars(room, l.font);
        // Only the name may be clipped: a clipped number would mislead.
        const keep = l.kind === 'title' ? Math.min(l.text.length, MIN_CHARS) : l.text.length;
        if (max < keep) ok = false;
        // Baseline: middle of the line box, shifted down by about a third of the font size.
        out.push({
          kind: l.kind,
          text: clipText(l.text, max),
          y: top + l.h / 2 + l.font * 0.35,
          fontSize: l.font,
        });
      }
      top += l.h;
      if (!ok) break;
    }
    if (ok) return out;
  }
  return [];
}

/**
 * The size of the icon that fits an arc, centred on its centroid: limited by the ring thickness
 * and by the arc length at mid radius. Null when even the smallest icon (16 px) does not fit.
 */
export function arcIconSize(a: ArcGeometry): number | null {
  const rm = (a.y0 + a.y1) / 2;
  const room = Math.min(a.y1 - a.y0, (a.x1 - a.x0) * rm) - 2 * PAD;
  const size = Math.min(ICON_MAX, Math.floor(room));
  return size >= ICON_MIN ? size : null;
}

/** The centroid of an arc, in chart coordinates (angle 0 at the top, clockwise). */
export function arcCentroid(a: ArcGeometry): { x: number; y: number } {
  const rm = (a.y0 + a.y1) / 2;
  const mid = (a.x0 + a.x1) / 2;
  return { x: rm * Math.sin(mid), y: -rm * Math.cos(mid) };
}
