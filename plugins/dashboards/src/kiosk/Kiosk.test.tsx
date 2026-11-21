import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));

import { createTheme, ThemeProvider } from '@mui/material/styles';
import { KioskOverlay } from './Kiosk';

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
    // A plain icon: the words are the label and the tooltip, not text on the button.
    expect(exit.textContent).toBe('');
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

describe('KioskOverlay layout', () => {
  it('never scrolls, draws no clock of its own, and the Exit button is touch sized', () => {
    const { container, getByRole } = render(
      <KioskOverlay onExit={() => undefined}>x</KioskOverlay>
    );
    const overlay = container.querySelector('[data-kiosk-overlay]') as HTMLElement;
    expect(getComputedStyle(overlay).overflow).toBe('hidden');
    expect(
      parseInt(getComputedStyle(getByRole('button', { name: 'Exit full screen' })).minHeight, 10)
    ).toBeGreaterThanOrEqual(48);
    expect(container.querySelector('[data-kiosk-clock]')).toBeNull();
    expect(container.querySelector('[data-clock-time]')).toBeNull();
  });
});
