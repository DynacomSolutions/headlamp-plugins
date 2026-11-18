import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));

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
