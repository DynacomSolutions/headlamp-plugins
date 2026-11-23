/*
 * The history strip of the Uptime page: one cell per time bucket, green is no failures, amber is some,
 * red is all, grey is no data. The Uptime page and the Dashboards widget both render this component, so
 * the line style and the colours are the same.
 */
import Box from '@mui/material/Box';
import { Theme, useTheme } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { bucketSeverity, formatPercent } from './model';
import { bucketSpan, formatSpan } from './timeAxis';

/**
 * The bucket colours for each mode. They are fixed, not read from the theme: the kiosk theme draws
 * the theme success colour in near white, and a green bucket must stay green.
 */
export const BUCKET_HUES = {
  dark: { ok: '#66bb6a', warn: '#ffa726', crit: '#f44336' },
  light: { ok: '#2e7d32', warn: '#c75b00', crit: '#d32f2f' },
} as const;

/** The colour of one bucket (availability 0..1, undefined = no data). */
export function bucketColour(theme: Theme, v: number | undefined): string {
  const sev = bucketSeverity(v);
  if (sev === 'none') return theme.palette.action.disabledBackground;
  const hues = BUCKET_HUES[theme.palette.mode === 'dark' ? 'dark' : 'light'];
  return sev === 'ok' ? hues.ok : sev === 'warn' ? hues.warn : hues.crit;
}

export interface HistoryStripProps {
  history: (number | undefined)[];
  /** Epoch seconds of bucket 0. */
  startSec: number;
  stepSec: number;
  /** The accessible name. */
  label: string;
  height?: number;
  /** The width the strip needs at least. Default 192, as on the page. */
  minWidth?: number | string;
  /**
   * `rich` (default): one MUI tooltip per cell, as on the page. `native`: a title attribute per cell,
   * for strips that repeat by the hundred.
   */
  tooltips?: 'rich' | 'native';
}

const BUCKET_WORD = { ok: 'Up', warn: 'Degraded', crit: 'Down', none: 'No data' } as const;

/**
 * The tooltip of a cell: its exact start and end in the browser time zone, its status and its availability.
 * Cell `i` covers the step that ends at its point, as the range query averages it (see timeAxis.ts).
 */
export function cellTitle(
  startSec: number,
  stepSec: number,
  i: number,
  v: number | undefined
): string {
  const { fromSec, toSec } = bucketSpan({ startSec, stepSec }, i);
  const status = BUCKET_WORD[bucketSeverity(v)];
  return `${formatSpan(fromSec, toSec)}: ${status}${
    v === undefined ? '' : `, ${formatPercent(v)}`
  }`;
}

export function HistoryStrip({
  history,
  startSec,
  stepSec,
  label,
  height = 18,
  minWidth = 192,
  tooltips = 'rich',
}: HistoryStripProps): JSX.Element {
  const theme = useTheme();
  return (
    <Box
      role="img"
      aria-label={label}
      sx={{ display: 'flex', gap: '1px', alignItems: 'stretch', height, minWidth }}
    >
      {history.map((v, i) => {
        const cell = (
          <Box
            key={i}
            title={tooltips === 'native' ? cellTitle(startSec, stepSec, i, v) : undefined}
            sx={{
              flex: '1 1 0',
              minWidth: '1px',
              bgcolor: bucketColour(theme, v),
              borderRadius: '1px',
            }}
          />
        );
        return tooltips === 'native' ? (
          cell
        ) : (
          <Tooltip key={i} title={cellTitle(startSec, stepSec, i, v)}>
            {cell}
          </Tooltip>
        );
      })}
    </Box>
  );
}
