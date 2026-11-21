/* Small helpers that the category-first and the node-first sunburst share. */

/** The drawing is laid out in these units and scaled to the card by the viewBox. */
export const RADIUS = 96;
export const VIEW = RADIUS * 2 + 8;

export const percent = (share: number): string => {
  const p = share * 100;
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p.toFixed(p >= 10 ? 0 : 1)}%`;
};

export const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
