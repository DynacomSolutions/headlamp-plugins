/*
 * A shade of a category colour for its children in the dashboard sunburst. The hue stays the
 * same. The shade moves away from the background (darker in light mode, lighter in dark mode)
 * and alternates a little between siblings, so neighbours stay apart. The base colours come
 * from the Usage palette. This is a copy of the shade function in the Dashboards plugin.
 */
import type { Mode } from '../palette';

export function childShade(base: string, index: number, mode: Mode): string {
  const amount = [0, 14, 26][index % 3];
  if (amount === 0) return base;
  return `color-mix(in srgb, ${base}, ${mode === 'dark' ? 'white' : 'black'} ${amount}%)`;
}
