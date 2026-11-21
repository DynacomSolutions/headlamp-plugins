/*
 * The colour tokens of the panel designs, taken from the MUI theme. Fills use the theme status
 * colours at a low alpha, so they follow the dark kiosk and the light view. Status stays a shape
 * and a word: these tokens only add tint.
 */
import { alpha, useTheme } from '@mui/material/styles';
import type { PanelStatus } from './model';

export interface Tokens {
  mode: 'light' | 'dark';
  fg: string;
  fg2: string;
  mut: string;
  line: string;
  line2: string;
  track: string;
  hover: string;
  sel: string;
  status: Record<PanelStatus, string>;
  fill: Record<PanelStatus, string>;
  info: string;
}

/**
 * The status colours of the panels. They are fixed for each mode, not read from the theme: the
 * kiosk theme of Headlamp draws "success" in near white, and a green dot must stay green.
 */
export const STATUS_HUES = {
  dark: { ok: '#66bb6a', warn: '#ffa726', crit: '#f44336', info: '#29b6f6' },
  light: { ok: '#2e7d32', warn: '#c75b00', crit: '#d32f2f', info: '#0277bd' },
} as const;

export function useTokens(): Tokens {
  const t = useTheme();
  const dark = t.palette.mode === 'dark';
  const { ok, warn, crit, info } = STATUS_HUES[dark ? 'dark' : 'light'];
  const fg = t.palette.text.primary;
  return {
    mode: dark ? 'dark' : 'light',
    fg,
    fg2: t.palette.text.secondary,
    mut: alpha(fg, dark ? 0.5 : 0.45),
    line: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)',
    line2: dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.24)',
    track: dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)',
    hover: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
    sel: dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.10)',
    status: { ok, warn, crit, unknown: t.palette.text.secondary },
    fill: {
      ok: alpha(ok, dark ? 0.16 : 0.12),
      warn: alpha(warn, dark ? 0.16 : 0.13),
      crit: alpha(crit, dark ? 0.18 : 0.12),
      unknown: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
    },
    info,
  };
}

/** Rank for the sort: worst first. */
export const SEVERITY: Record<PanelStatus, number> = { crit: 0, warn: 1, unknown: 2, ok: 3 };

/** A stable sort of rows, worst status first. Rows of equal status keep the source order. */
export function bySeverity<T extends { status: PanelStatus }>(rows: T[]): T[] {
  return rows
    .map((r, i) => [r, i] as const)
    .sort((a, b) => SEVERITY[a[0].status] - SEVERITY[b[0].status] || a[1] - b[1])
    .map(x => x[0]);
}
