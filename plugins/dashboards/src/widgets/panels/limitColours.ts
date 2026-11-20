/*
 * Colours for the limit names of the grouped bars. They are the eight validated categorical hues
 * of the data visualisation palette, in fixed order, light and dark. A colour follows the limit
 * name by its first sight in the panel, never by value or rank. There is no "Other" bucket, so a
 * ninth name and later reuse the eight hues at lower opacity (the legend names every one). Status
 * colours are not in this list: they are reserved for the status markers.
 */
import { CATEGORICAL, Mode } from '../promql/palette';

export interface LimitColour {
  colour: string;
  opacity: number;
}

/** Opacity of the fill when a hue is used a second time. */
export const REUSED_OPACITY = 0.55;

export function limitColour(index: number, mode: Mode): LimitColour {
  const hues = CATEGORICAL[mode];
  return { colour: hues[index % hues.length], opacity: index < hues.length ? 1 : REUSED_OPACITY };
}

/** The colour of each limit name, by its place in `limits` (the order of first sight). */
export function limitColours(limits: ReadonlyArray<string>, mode: Mode): Map<string, LimitColour> {
  return new Map(limits.map((name, i) => [name, limitColour(i, mode)]));
}
