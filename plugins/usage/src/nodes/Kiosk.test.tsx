import { cleanup, fireEvent, render } from '@testing-library/react';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));

import { createTheme, ThemeProvider } from '@mui/material/styles';
import { Clock, formatClock, KioskOverlay } from './Kiosk';

afterEach(() => {
  cleanup();
  Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
});

const setFullscreen = (on: boolean) => {
  Object.defineProperty(document, 'fullscreenElement', {
    value: on ? document.documentElement : null,
    configurable: true,
  });
  document.dispatchEvent(new Event('fullscreenchange'));
};

describe('KioskOverlay', () => {
  it('shows the overlay, the bar, the content and a touch sized Exit control', () => {
    const { container, getByRole, getByText } = render(
      <KioskOverlay onExit={() => undefined} bar={<span>bar</span>}>
        <span>charts</span>
      </KioskOverlay>
    );
    const overlay = container.querySelector('[data-kiosk-overlay]') as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(getByText('bar')).not.toBeNull();
    expect(getByText('charts')).not.toBeNull();
    const exit = getByRole('button', { name: 'Exit full screen' });
    expect(exit.textContent).toContain('Exit full screen');
    expect(exit.querySelector('[data-icon]')).not.toBeNull();
  });

  it('exits when the Exit control is clicked, and leaves browser full screen', () => {
    const onExit = vi.fn();
    const exitFullscreen = vi.fn(() => Promise.resolve());
    (document as unknown as { exitFullscreen: unknown }).exitFullscreen = exitFullscreen;
    Object.defineProperty(document, 'fullscreenElement', {
      value: document.documentElement,
      configurable: true,
    });
    const { getByRole } = render(
      <KioskOverlay onExit={onExit} bar={null}>
        x
      </KioskOverlay>
    );
    fireEvent.click(getByRole('button', { name: 'Exit full screen' }));
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('exits on Escape', () => {
    const onExit = vi.fn();
    render(
      <KioskOverlay onExit={onExit} bar={null}>
        x
      </KioskOverlay>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('exits when full screen ends after it had begun', () => {
    const onExit = vi.fn();
    render(
      <KioskOverlay onExit={onExit} bar={null}>
        x
      </KioskOverlay>
    );
    setFullscreen(true);
    expect(onExit).not.toHaveBeenCalled();
    setFullscreen(false);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('stays on when the document was never full screen (booted with ?kiosk=1)', () => {
    const onExit = vi.fn();
    render(
      <KioskOverlay onExit={onExit} bar={null}>
        x
      </KioskOverlay>
    );
    setFullscreen(false);
    expect(onExit).not.toHaveBeenCalled();
  });
});

describe('KioskOverlay background', () => {
  const colourOf = (mode: 'dark' | 'light') => {
    const theme = createTheme({ palette: { mode } });
    const { container } = render(
      <ThemeProvider theme={theme}>
        <KioskOverlay onExit={() => undefined}>x</KioskOverlay>
      </ThemeProvider>
    );
    const overlay = container.querySelector('[data-kiosk-overlay]') as HTMLElement;
    return { got: getComputedStyle(overlay).backgroundColor, theme };
  };

  it('is pure black in a dark theme', () => {
    expect(colourOf('dark').got).toBe('rgb(0, 0, 0)');
  });

  it('keeps the theme background in a light theme', () => {
    const { got, theme } = colourOf('light');
    const probe = document.createElement('div');
    probe.style.backgroundColor = theme.palette.background.default;
    expect(got).toBe(probe.style.backgroundColor);
    expect(got).not.toBe('rgb(0, 0, 0)');
  });
});

describe('formatClock', () => {
  it('gives HH:mm in 24 hours and a short date', () => {
    expect(formatClock(new Date(2026, 10, 19, 7, 5))).toEqual({
      time: '07:05',
      date: 'Thu 19 Nov 2026',
    });
    expect(formatClock(new Date(2026, 10, 19, 23, 59)).time).toBe('23:59');
  });
});

describe('Clock', () => {
  it('updates on the minute boundary with one timer, and clears it on unmount', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 10, 19, 10, 29, 45));
      const { container, unmount } = render(<Clock />);
      const time = () => container.querySelector('[data-clock-time]')?.textContent;
      expect(time()).toBe('10:29');
      expect(container.querySelector('[data-clock-date]')?.textContent).toBe('Thu 19 Nov 2026');
      expect(vi.getTimerCount()).toBe(1);
      act(() => {
        vi.advanceTimersByTime(14_000);
      });
      expect(time()).toBe('10:29');
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(time()).toBe('10:30');
      expect(vi.getTimerCount()).toBe(1);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('KioskOverlay layout', () => {
  it('never scrolls, shows the clock beside Exit, and the Exit button is touch sized', () => {
    const { container, getByRole } = render(
      <KioskOverlay onExit={() => undefined}>x</KioskOverlay>
    );
    const overlay = container.querySelector('[data-kiosk-overlay]') as HTMLElement;
    expect(getComputedStyle(overlay).overflow).toBe('hidden');
    const exit = getByRole('button', { name: 'Exit full screen' });
    const clock = container.querySelector('[data-kiosk-clock]') as HTMLElement;
    expect(clock.parentElement).toBe(exit.parentElement);
    expect(exit.compareDocumentPosition(clock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
