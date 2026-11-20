/*
 * Colours for the PromQL widgets. The categorical colours are the eight validated hues of the
 * data visualisation palette, in fixed order, light and dark. Colour follows the series (its key),
 * never its rank, so a filter that removes a series does not repaint the others. A ninth series
 * and later get a generated hue (golden angle), because these widgets never fold series into an
 * "Other" group. Identity is never colour alone: every series has a legend row with its name.
 */
export type Mode = 'light' | 'dark';

export const CATEGORICAL: Record<Mode, readonly string[]> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

export interface Ink {
  surface: string;
  primary: string;
  secondary: string;
  muted: string;
  grid: string;
  axis: string;
  /** A hairline around marks that overlap. */
  ring: string;
  /** The track of a gauge or a bar behind its value. */
  track: string;
}

export const INK: Record<Mode, Ink> = {
  light: {
    surface: '#fcfcfb',
    primary: '#0b0b0b',
    secondary: '#52514e',
    muted: '#898781',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    ring: '#fcfcfb',
    track: '#e1e0d9',
  },
  dark: {
    surface: '#1a1a19',
    primary: '#f0efec',
    secondary: '#c3c2b7',
    muted: '#898781',
    grid: '#2c2c2a',
    axis: '#383835',
    ring: '#1a1a19',
    track: '#2c2c2a',
  },
};

/** The kiosk is black, so ink and fills are tuned for that background. */
export const KIOSK_INK: Ink = { ...INK.dark, surface: '#000000', ring: '#000000', grid: '#262625', track: '#262625' };

const GOLDEN_ANGLE = 137.508;

export function colourAt(index: number, mode: Mode): string {
  const base = CATEGORICAL[mode];
  if (index < base.length) return base[index];
  const n = index - base.length;
  const hue = ((n * GOLDEN_ANGLE + 20) % 360).toFixed(2);
  const lightness = mode === 'dark' ? [66, 76, 58][n % 3] : [42, 54, 34][n % 3];
  return `hsl(${hue}, 62%, ${lightness}%)`;
}

/** Keeps one index per key, in order of first sight, so a colour stays with its series. */
export class ColourBook {
  private readonly index = new Map<string, number>();

  colour(key: string, mode: Mode): string {
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.index.size;
      this.index.set(key, i);
    }
    return colourAt(i, mode);
  }
}
