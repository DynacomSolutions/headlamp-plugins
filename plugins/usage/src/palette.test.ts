import { describe, expect, it } from 'vitest';
import { assignColours, colourAt } from './palette';

describe('assignColours', () => {
  const keys = Array.from({ length: 700 }, (_, i) => `group-${i}`);
  for (const mode of ['light', 'dark'] as const) {
    it(`gives every group its own colour (${mode})`, () => {
      const colourOf = assignColours(keys, mode);
      expect(new Set(keys.map(colourOf)).size).toBe(keys.length);
    });
  }
  it('starts with the 8-colour base palette, then generated hues', () => {
    expect(colourAt(0, 'light')).toBe('#0072B2');
    expect(colourAt(8, 'light')).toMatch(/^hsl\(/);
  });
  it('keeps a group colour across pies and ignores repeated keys', () => {
    const colourOf = assignColours(['a', 'b', 'a', 'c'], 'light');
    expect(colourOf('b')).toBe(colourAt(1, 'light'));
    expect(colourOf('c')).toBe(colourAt(2, 'light'));
  });
});
