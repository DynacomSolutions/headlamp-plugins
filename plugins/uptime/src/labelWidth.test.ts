import { describe, expect, it } from 'vitest';
import { estimateTextWidth, LABEL_MAX, LABEL_MIN, labelColumnWidth, textWidth } from './labelWidth';

const regular = { sizePx: 13, weight: 400, family: 'sans-serif' };
const bold = { ...regular, weight: 600 };
/** A fake canvas: every glyph is 7 px wide, whatever the font. */
const canvas = () => {
  const ctx = {
    font: '',
    measureText: (t: string) => ({ width: [...t].length * 7 }),
  };
  return ctx;
};

describe('label column width', () => {
  it('estimates bold text wider than regular text, and counts glyphs, not bytes', () => {
    expect(estimateTextWidth('abcd', bold)).toBeGreaterThan(estimateTextWidth('abcd', regular));
    expect(estimateTextWidth('日本語', regular)).toBe(estimateTextWidth('abc', regular));
  });

  it('measures with the canvas in the font of the widget when there is one', () => {
    const ctx = canvas();
    expect(textWidth('abc', bold, ctx)).toBe(21);
    expect(ctx.font).toBe('600 13px sans-serif');
    expect(textWidth('abc', regular, null)).toBe(estimateTextWidth('abc', regular));
  });

  it('fits the longest label, plus the extra width of an icon', () => {
    const ctx = canvas();
    const w = labelColumnWidth(
      [
        { text: 'plex', font: regular },
        { text: 'static-site-acme', font: bold, extra: 30 },
        { text: 'x'.repeat(12), font: regular },
      ],
      { context: ctx }
    );
    expect(w).toBe(16 * 7 + 30 + 4);
  });

  it('never goes under the minimum or over the maximum', () => {
    const ctx = canvas();
    expect(labelColumnWidth([{ text: 'a', font: regular }], { context: ctx })).toBe(LABEL_MIN);
    expect(labelColumnWidth([], { context: ctx })).toBe(LABEL_MIN);
    expect(labelColumnWidth([{ text: 'x'.repeat(200), font: regular }], { context: ctx })).toBe(
      LABEL_MAX
    );
  });
});
