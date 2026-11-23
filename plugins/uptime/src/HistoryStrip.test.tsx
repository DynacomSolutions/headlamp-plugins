import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { BUCKET_HUES, bucketColour, cellTitle, HistoryStrip } from './HistoryStrip';

afterEach(cleanup);
const theme = createTheme({ palette: { mode: 'dark' } });

describe('history strip colours', () => {
  it('green is no failures, amber some, red all, grey no data', () => {
    expect(bucketColour(theme, 1)).toBe(BUCKET_HUES.dark.ok);
    expect(bucketColour(theme, 0.5)).toBe(BUCKET_HUES.dark.warn);
    expect(bucketColour(theme, 0)).toBe(BUCKET_HUES.dark.crit);
    const light = createTheme({ palette: { mode: 'light' } });
    expect(bucketColour(light, 1)).toBe(BUCKET_HUES.light.ok);
    expect(bucketColour(theme, undefined)).toBe(theme.palette.action.disabledBackground);
  });
  it('draws one cell per bucket and titles them in native mode', () => {
    render(
      <ThemeProvider theme={theme}>
        <HistoryStrip
          history={[1, 0, undefined]}
          startSec={1_800_000_000}
          stepSec={60}
          label="x"
          tooltips="native"
        />
      </ThemeProvider>
    );
    const strip = screen.getByLabelText('x');
    expect(strip.children.length).toBe(3);
    expect(strip.children[1].getAttribute('title')).toContain('Down, 0.0%');
    expect(strip.children[2].getAttribute('title')).toContain('No data');
  });
  it('titles a cell with its exact start, end and status in the zone of the browser', () => {
    // Bucket 1 ends at point 1_800_000_060 and starts a step before it.
    const t = cellTitle(1_800_000_000, 60, 1, 1);
    const from = new Date((1_800_000_060 - 60) * 1000);
    const hh = (d: Date) =>
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(t).toContain(`${hh(from)} to ${hh(new Date(1_800_000_060 * 1000))}`);
    expect(t.endsWith(': Up, 100%')).toBe(true);
    expect(cellTitle(1_800_000_000, 60, 1, 0.5)).toContain(': Degraded, 50.0%');
    expect(cellTitle(1_800_000_000, 60, 1, undefined).endsWith(': No data')).toBe(true);
  });
});
