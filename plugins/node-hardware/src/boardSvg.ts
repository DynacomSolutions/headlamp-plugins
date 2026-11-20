/*
 * Minimal SVG serialiser for a BoardLayout, with a fixed light and dark palette. The UI renders
 * the same layout through React with the MUI theme (BoardDiagram.tsx). This one makes preview
 * files and has no runtime use in the plugin.
 */
import { BoardLayout, ShapeState } from './boardLayout';

export interface SvgPalette {
  background: string;
  text: string;
  muted: string;
  states: Record<ShapeState, { fill: string; stroke: string; strokeWidth: number }>;
}

export const LIGHT: SvgPalette = {
  background: '#ffffff',
  text: '#1f2933',
  muted: '#52606d',
  states: {
    board: { fill: '#f5f7fa', stroke: '#9aa5b1', strokeWidth: 2 },
    panel: { fill: '#ffffff', stroke: '#cbd2d9', strokeWidth: 1 },
    filled: { fill: '#cfe3f8', stroke: '#1f6fbf', strokeWidth: 1.5 },
    empty: { fill: 'none', stroke: '#7b8794', strokeWidth: 1 },
    warn: { fill: '#fde8b8', stroke: '#b26a00', strokeWidth: 2.5 },
    chip: { fill: '#e4e7eb', stroke: '#7b8794', strokeWidth: 1 },
    placeholder: { fill: 'none', stroke: '#9aa5b1', strokeWidth: 1 },
  },
};

export const DARK: SvgPalette = {
  background: '#1b1f24',
  text: '#e6e9ed',
  muted: '#aab3bd',
  states: {
    board: { fill: '#232830', stroke: '#6b7682', strokeWidth: 2 },
    panel: { fill: '#1b1f24', stroke: '#3d4650', strokeWidth: 1 },
    filled: { fill: '#1d3d5f', stroke: '#6cb0f0', strokeWidth: 1.5 },
    empty: { fill: 'none', stroke: '#7b8794', strokeWidth: 1 },
    warn: { fill: '#4d3a10', stroke: '#f0b429', strokeWidth: 2.5 },
    chip: { fill: '#2c333b', stroke: '#7b8794', strokeWidth: 1 },
    placeholder: { fill: 'none', stroke: '#6b7682', strokeWidth: 1 },
  },
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function layoutToSvg(layout: BoardLayout, palette: SvgPalette): string {
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" font-family="sans-serif">`, `<rect width="${layout.width}" height="${layout.height}" fill="${palette.background}"/>`];
  for (const s of layout.shapes) {
    const st = palette.states[s.state];
    out.push(`<g><title>${esc(s.title)}</title><rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="4" fill="${st.fill}" stroke="${st.stroke}" stroke-width="${st.strokeWidth}"${s.dashed ? ' stroke-dasharray="5 3"' : ''}/>`);
    for (const l of s.labels) {
      out.push(`<text x="${l.x}" y="${l.y}" font-size="${l.size ?? 12}" font-weight="${l.weight ?? 'normal'}" text-anchor="${l.anchor ?? 'start'}" fill="${l.tone === 'muted' ? palette.muted : palette.text}">${esc(l.text)}</text>`);
    }
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('\n');
}
