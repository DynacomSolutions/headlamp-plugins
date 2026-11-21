import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { edgesOf, FADE, fadeMask, ScrollArea } from './ScrollArea';

afterEach(cleanup);

describe('scroll edges', () => {
  it('has more below at the top, more above at the end, and both in the middle', () => {
    expect(edgesOf({ scrollTop: 0, clientHeight: 100, scrollHeight: 400 })).toEqual({
      top: false,
      bottom: true,
    });
    expect(edgesOf({ scrollTop: 150, clientHeight: 100, scrollHeight: 400 })).toEqual({
      top: true,
      bottom: true,
    });
    expect(edgesOf({ scrollTop: 300, clientHeight: 100, scrollHeight: 400 })).toEqual({
      top: true,
      bottom: false,
    });
  });
  it('has no edge when every row fits', () => {
    expect(edgesOf({ scrollTop: 0, clientHeight: 100, scrollHeight: 100 })).toEqual({
      top: false,
      bottom: false,
    });
  });
  it('fades only the edges that have more rows behind them', () => {
    expect(fadeMask({ top: false, bottom: true })).toContain(`calc(100% - ${FADE}px)`);
    expect(fadeMask({ top: false, bottom: true })).not.toContain(`transparent 0`);
    expect(fadeMask({ top: true, bottom: false })).toContain(`transparent 0, #000 ${FADE}px`);
    expect(fadeMask({ top: true, bottom: false })).not.toContain('transparent 100%');
  });
});

describe('ScrollArea', () => {
  it('scrolls by itself, by touch, and the wheel does not scroll the page', () => {
    const { container } = render(
      <ThemeProvider theme={createTheme()}>
        <ScrollArea label="Rows">
          <div>row</div>
        </ScrollArea>
      </ThemeProvider>
    );
    const area = container.querySelector('[data-scroll-area]') as HTMLElement;
    const style = getComputedStyle(area);
    expect(style.overflowY).toBe('auto');
    expect(style.overscrollBehavior).toBe('contain');
    expect(area.getAttribute('aria-label')).toBe('Rows');
    // A list that fits has no edge to fade. A scroll event keeps the state in step.
    expect(area.getAttribute('data-scroll-top')).toBe('end');
    expect(area.getAttribute('data-scroll-bottom')).toBe('end');
    fireEvent.scroll(area);
    expect(area.getAttribute('data-scroll-bottom')).toBe('end');
  });
});
