import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { BUCKET_HUES, bucketColour, HistoryStrip } from './HistoryStrip';

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
    expect(strip.children[1].getAttribute('title')).toContain('0.0%');
    expect(strip.children[2].getAttribute('title')).toContain('no data');
  });
});
