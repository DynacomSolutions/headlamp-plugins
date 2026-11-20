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

/** The colour of one bucket (availability 0..1, undefined = no data). */
export function bucketColour(theme: Theme, v: number | undefined): string {
  const sev = bucketSeverity(v);
  if (sev === 'none') return theme.palette.action.disabledBackground;
  if (sev === 'ok') return theme.palette.success.main;
  if (sev === 'warn') return theme.palette.warning.main;
  return theme.palette.error.main;
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

function cellTitle(startSec: number, stepSec: number, i: number, v: number | undefined): string {
  return `${new Date((startSec + i * stepSec) * 1000).toLocaleString()}: ${v === undefined ? 'no data' : formatPercent(v)}`;
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
    <Box role="img" aria-label={label} sx={{ display: 'flex', gap: '1px', alignItems: 'stretch', height, minWidth }}>
      {history.map((v, i) => {
        const cell = (
          <Box
            key={i}
            title={tooltips === 'native' ? cellTitle(startSec, stepSec, i, v) : undefined}
            sx={{ flex: '1 1 0', minWidth: '1px', bgcolor: bucketColour(theme, v), borderRadius: '1px' }}
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
