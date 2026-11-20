/*
 * Categorical colours for the sunburst. The first eight are Okabe-Ito hues, which stay
 * distinguishable under common colour-vision deficiencies, with lighter variants for dark
 * mode and the black kiosk. Beyond eight, hues are spaced by the golden angle with
 * alternating lightness. The same palette and rules as the Usage plugin donuts. Colour is
 * never the only encoding: the legend and the hover text name every arc.
 */
export const LIGHT = [
  '#0072B2',
  '#E69F00',
  '#009E73',
  '#CC79A7',
  '#56B4E9',
  '#D55E00',
  '#6A51A3',
  '#8A6D3B',
];
export const DARK = [
  '#56B4E9',
  '#F5B841',
  '#2FBF9B',
  '#E59BC4',
  '#8FD0F5',
  '#F07F3C',
  '#B39DDB',
  '#C9A66B',
];

export type Mode = 'light' | 'dark';

const GOLDEN_ANGLE = 137.508;

export function colourAt(index: number, mode: Mode): string {
  const base = mode === 'dark' ? DARK : LIGHT;
  if (index < base.length) return base[index];
  const n = index - base.length;
  const hue = ((n * GOLDEN_ANGLE + 20) % 360).toFixed(2);
  const lightness = mode === 'dark' ? [66, 78, 56][n % 3] : [42, 56, 34][n % 3];
  return `hsl(${hue}, 62%, ${lightness}%)`;
}

/**
 * A shade of a category colour for its children. The hue stays the same. The shade moves away
 * from the background (darker in light mode, lighter in dark mode) and alternates a little
 * between siblings, so neighbours stay apart and every arc keeps its contrast.
 */
export function childShade(base: string, index: number, mode: Mode): string {
  const amount = [0, 14, 26][index % 3];
  if (amount === 0) return base;
  return `color-mix(in srgb, ${base}, ${mode === 'dark' ? 'white' : 'black'} ${amount}%)`;
}
