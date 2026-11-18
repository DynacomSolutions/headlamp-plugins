import { describe, expect, it } from 'vitest';
import { arcLabel, centreLines, clipText } from './arcLabel';

// A narrow, deep arc: 26 px wide at mid-radius, 120 px thick.
const deep = { x0: 0.1, x1: 0.2, y0: 200, y1: 320 };
// A wide, short arc: about 470 px wide at mid-radius, 30 px thick.
const wide = { x0: 0, x1: 1.5, y0: 300, y1: 330 };

describe('arcLabel clipping', () => {
  it('never draws a stub of a few characters and an ellipsis', () => {
    // Room for about 5 characters at 14 px: a long name is dropped, not clipped to "Kube…".
    const small = { x0: 0, x1: 0.1, y0: 200, y1: 240 };
    for (const name of ['Kubernetes', 'System', 'kube-system']) {
      const l = arcLabel(small, name, 14);
      if (l) expect(l.text === name || l.text.replace('\u2026', '').length >= 6).toBe(true);
    }
  });
});

describe('arcLabel', () => {
  it('runs text along the radius of a narrow, deep arc', () => {
    const l = arcLabel(deep, 'production', 14)!;
    expect(l.orientation).toBe('radial');
    expect(l.text).toBe('production');
    // Middle angle 0.15 rad is on the right half: reads outwards.
    expect(l.rotate).toBeCloseTo((0.15 * 180) / Math.PI - 90);
    expect(l.x).toBeCloseTo(260 * Math.sin(0.15));
    expect(l.y).toBeCloseTo(-260 * Math.cos(0.15));
  });

  it('turns radial text round on the left half so it never reads upside down', () => {
    const left = { ...deep, x0: 1.5 * Math.PI - 0.05, x1: 1.5 * Math.PI + 0.05 };
    const l = arcLabel(left, 'production', 14)!;
    expect(l.orientation).toBe('radial');
    expect(l.rotate).toBeCloseTo(360);
  });

  it('runs text across the radius of a wide, short arc', () => {
    const l = arcLabel(wide, 'kube-system', 14)!;
    expect(l.orientation).toBe('tangential');
    expect(l.text).toBe('kube-system');
    const bottom = arcLabel({ ...wide, x0: Math.PI - 0.75, x1: Math.PI + 0.75 }, 'kube', 14)!;
    expect(bottom.rotate).toBeCloseTo(0);
  });

  it('truncates with an ellipsis and hides labels with fewer than four characters', () => {
    const l = arcLabel(deep, 'a-very-long-namespace-name', 14)!;
    expect(l.text.endsWith('…')).toBe(true);
    // 112 px of ring at 8.4 px per character: 13 characters.
    expect(l.text).toHaveLength(13);
    const tiny = { x0: 0.1, x1: 0.2, y0: 200, y1: 236 };
    expect(arcLabel(tiny, 'production', 14)).toBeNull();
    expect(arcLabel(tiny, 'abc', 14)?.text).toBe('abc');
  });

  it('hides the label when the arc is narrower than the font size plus padding', () => {
    expect(arcLabel({ x0: 0, x1: 0.05, y0: 200, y1: 320 }, 'production', 14)).toBeNull();
  });

  it('puts an icon before the label when it and a few characters fit', () => {
    const roomy = { x0: 0.1, x1: 0.25, y0: 200, y1: 320 };
    const l = arcLabel(roomy, 'project', 14, true)!;
    expect(l.icon).toBe(true);
    expect(l.width).toBeCloseTo(24 + 7 * 14 * 0.6);
    // 22 px across is too narrow for a 20 px icon with padding.
    expect(arcLabel({ ...deep, x1: 0.185 }, 'project', 14, true)!.icon).toBe(false);
    expect(arcLabel(roomy, 'project', 14, false)!.icon).toBe(false);
  });
});

describe('clipText', () => {
  it('keeps text that fits and ellipsises the rest', () => {
    expect(clipText('abc', 3)).toBe('abc');
    expect(clipText('abcdef', 4)).toBe('abc…');
    expect(clipText('abc', 0)).toBe('');
  });
});

describe('centreLines', () => {
  const lines = {
    title: 'T3 Code',
    value: '22.6 GiB',
    node: '9.0% of node',
    parent: '26% of parent',
    icon: true,
  };

  it('stacks icon, title, value and both shares when the disc is large', () => {
    const out = centreLines(110, 14, lines);
    expect(out.map(l => l.kind)).toEqual(['icon', 'title', 'value', 'node', 'parent']);
    expect(out.every(l => l.fontSize >= 14)).toBe(true);
    const ys = out.map(l => l.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(Math.min(...ys)).toBeGreaterThan(-110);
    expect(Math.max(...ys)).toBeLessThan(110);
  });

  it('never drops the value and the share, however small the disc', () => {
    for (const r of [30, 45, 60]) {
      const kinds = centreLines(r, 14, { ...lines, nodeShort: '9%' }).map(l => l.kind);
      expect(kinds).toContain('value');
      expect(kinds).toContain('node');
    }
  });

  it('drops the parent share and the icon before the title, and the title before the numbers', () => {
    const kinds = (r: number) => centreLines(r, 14, lines).map(l => l.kind);
    expect(kinds(70)).not.toContain('parent');
    expect(kinds(45)).not.toContain('title');
  });

  it('uses the bare percentage when the long share does not fit', () => {
    const out = centreLines(38, 14, { ...lines, nodeShort: '9%' });
    expect(out.find(l => l.kind === 'node')!.text).toBe('9%');
  });

  it('clips a long title to the width of the disc', () => {
    const out = centreLines(80, 14, { ...lines, title: 'a-very-long-project-name-here' });
    const title = out.find(l => l.kind === 'title')!;
    expect(title.text.endsWith('…')).toBe(true);
    expect(title.text.length * 14 * 0.6).toBeLessThanOrEqual(160);
  });
});
