/*
 * The width of the label column of the Uptime widget. The column is as wide as the longest label that is on
 * screen, within a minimum and a maximum, so the history strips get the rest of the width. A label that is
 * longer than the maximum ends in an ellipsis and has a tooltip.
 *
 * The widest text is measured with a canvas in the font of the widget. Where there is no canvas (tests), an
 * estimate of the average glyph width stands in.
 */

/** The narrowest and the widest label column, in px. */
export const LABEL_MIN = 72;
export const LABEL_MAX = 300;

export interface LabelFont {
  sizePx: number;
  weight: number | string;
  family: string;
}

export interface Label {
  text: string;
  font: LabelFont;
  /** Width in px that comes with the text: an icon, a gap, a count. */
  extra?: number;
}

type Context = { font: string; measureText(text: string): { width: number } };

/** The average glyph width of a proportional UI font, as a part of the font size, and the bold figure. */
const GLYPH = 0.56;
const GLYPH_BOLD = 0.6;

/** An estimate of the width of a text, for where nothing can measure it. */
export function estimateTextWidth(text: string, font: LabelFont): number {
  const bold = Number(font.weight) >= 600 || font.weight === 'bold';
  return Math.ceil([...text].length * font.sizePx * (bold ? GLYPH_BOLD : GLYPH));
}

let canvasContext: Context | null | undefined;
function defaultContext(): Context | null {
  if (canvasContext !== undefined) return canvasContext;
  canvasContext = null;
  try {
    // jsdom has a canvas element with no drawing, and logs an error when asked: leave it alone there.
    if (typeof document !== 'undefined' && !/jsdom/i.test(navigator.userAgent)) {
      canvasContext = document.createElement('canvas').getContext('2d');
    }
  } catch {
    canvasContext = null;
  }
  return canvasContext;
}

/** The width of a text in px. Measured with the context when there is one, else estimated. */
export function textWidth(
  text: string,
  font: LabelFont,
  context: Context | null = defaultContext()
): number {
  if (context) {
    context.font = `${font.weight} ${font.sizePx}px ${font.family}`;
    const w = context.measureText(text).width;
    if (Number.isFinite(w) && w > 0) return Math.ceil(w);
  }
  return estimateTextWidth(text, font);
}

/**
 * The width of the label column: the widest label, clamped. `slack` is a few px that stop the last glyph
 * from being cut by a rounding difference.
 */
export function labelColumnWidth(
  labels: readonly Label[],
  options: { min?: number; max?: number; slack?: number; context?: Context | null } = {}
): number {
  const { min = LABEL_MIN, max = LABEL_MAX, slack = 4 } = options;
  let widest = 0;
  for (const l of labels) {
    const w = textWidth(l.text, l.font, options.context) + (l.extra ?? 0);
    if (w > widest) widest = w;
  }
  return Math.min(max, Math.max(min, Math.ceil(widest + slack)));
}
