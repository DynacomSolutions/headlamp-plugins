/*
 * Categorical colours for the donuts. The first eight are Okabe-Ito hues
 * (distinguishable under common colour-vision deficiencies), with lighter
 * variants for dark mode. Beyond eight, hues are spaced by the golden angle
 * with alternating lightness, so neighbouring indices contrast and every index
 * gets its own colour. Colour is never the only encoding: every slice also has
 * a legend row with its name, value and percentage.
 */
export const LIGHT = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#6A51A3', '#8A6D3B'];
export const DARK = ['#56B4E9', '#F5B841', '#2FBF9B', '#E59BC4', '#8FD0F5', '#F07F3C', '#B39DDB', '#C9A66B'];

export type Mode = 'light' | 'dark';

const GOLDEN_ANGLE = 137.508;

export function colourAt(index: number, mode: Mode): string {
  const base = mode === 'dark' ? DARK : LIGHT;
  if (index < base.length) {
    return base[index];
  }
  const n = index - base.length;
  // Two decimals keep hundreds of generated colours distinct.
  const hue = ((n * GOLDEN_ANGLE + 20) % 360).toFixed(2);
  const lightness = mode === 'dark' ? [66, 78, 56][n % 3] : [42, 56, 34][n % 3];
  return `hsl(${hue}, 62%, ${lightness}%)`;
}

/**
 * Colours keyed by group, in order of first appearance. Each key gets its own
 * index, so no two keys share a colour in any pie and a group keeps its colour
 * across pies.
 */
export function assignColours(keys: string[], mode: Mode): (key: string) => string {
  const index = new Map<string, number>();
  for (const k of keys) {
    if (!index.has(k)) {
      index.set(k, index.size);
    }
  }
  return key => colourAt(index.get(key) ?? 0, mode);
}
