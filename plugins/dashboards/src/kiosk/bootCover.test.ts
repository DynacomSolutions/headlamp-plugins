import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COVER_ID,
  COVER_MAX_MS,
  installBootCover,
  isKioskAddress,
  prefersDark,
  removeBootCover,
} from './bootCover';

const win = (path: string, search: string, theme?: string, dark = false) =>
  ({
    location: { pathname: path, search },
    localStorage: { getItem: () => theme ?? null },
    matchMedia: () => ({ matches: dark }),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  } as unknown as Window);

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('kiosk boot cover', () => {
  it('knows a dashboard address in kiosk mode', () => {
    expect(isKioskAddress({ pathname: '/c/main/dashboards/ops/overview', search: '?kiosk=1' })).toBe(true);
    expect(isKioskAddress({ pathname: '/c/main/dashboards/ops', search: '' })).toBe(false);
    expect(isKioskAddress({ pathname: '/c/main/pods', search: '?kiosk=1' })).toBe(false);
  });

  it('reads the saved theme first, then the system', () => {
    const store = (v: string | null) => ({ getItem: () => v });
    expect(prefersDark(store('Dark'), false)).toBe(true);
    expect(prefersDark(store('Light'), true)).toBe(false);
    expect(prefersDark(store(null), true)).toBe(true);
    expect(prefersDark(store(null), false)).toBe(false);
    expect(prefersDark(undefined, false)).toBe(false);
  });

  it('matches the saved theme name without regard to case', () => {
    const store = (v: string | null) => ({ getItem: () => v });
    expect(prefersDark(store('dark'), false)).toBe(true);
    expect(prefersDark(store('DARK'), false)).toBe(true);
    expect(prefersDark(store('Lights Out'), false)).toBe(true);
    expect(prefersDark(store('light'), true)).toBe(false);
  });

  it('treats any other saved theme as light, whatever the system says', () => {
    const store = (v: string | null) => ({ getItem: () => v });
    expect(prefersDark(store('Headlamp Classic'), true)).toBe(false);
    expect(prefersDark(store('Monochrome Light'), true)).toBe(false);
  });

  it('reads the Headlamp storage key', () => {
    const getItem = vi.fn(() => 'Dark');
    prefersDark({ getItem }, false);
    expect(getItem).toHaveBeenCalledWith('headlampThemePreference');
  });

  it('uses the system only when nothing is saved, for a saved Dark and Light theme', () => {
    const run = (theme: string | undefined, dark: boolean) =>
      installBootCover(document, win('/c/main/dashboards/ops', '?kiosk=1', theme, dark));
    expect(run('Dark', false)).toBe(true);
    document.body.innerHTML = '';
    expect(run('Light', true)).toBe(false);
    expect(run(undefined, true)).toBe(true);
    document.body.innerHTML = '';
    expect(run(undefined, false)).toBe(false);
  });

  it('covers the page for a dark kiosk and leaves one cover only', () => {
    const w = win('/c/main/dashboards/ops/overview', '?kiosk=1', 'Dark');
    expect(installBootCover(document, w)).toBe(true);
    expect(installBootCover(document, w)).toBe(true);
    const cover = document.getElementById(COVER_ID) as HTMLElement;
    expect(document.querySelectorAll(`#${COVER_ID}`)).toHaveLength(1);
    expect(cover.style.background).toBe('rgb(0, 0, 0)');
    expect(cover.style.pointerEvents).toBe('none');
  });

  it('does nothing outside a kiosk and in a light theme', () => {
    expect(installBootCover(document, win('/c/main/dashboards/ops', '', 'dark'))).toBe(false);
    expect(installBootCover(document, win('/c/main/dashboards/ops', '?kiosk=1', 'Light'))).toBe(false);
    expect(document.getElementById(COVER_ID)).toBeNull();
  });

  it('is removed by the kiosk, and by the timer when the kiosk never comes', () => {
    installBootCover(document, win('/c/main/dashboards/ops', '?kiosk=1', 'Dark'));
    removeBootCover(document);
    expect(document.getElementById(COVER_ID)).toBeNull();
    installBootCover(document, win('/c/main/dashboards/ops', '?kiosk=1', 'Dark'));
    vi.advanceTimersByTime(COVER_MAX_MS + 1);
    expect(document.getElementById(COVER_ID)).toBeNull();
  });
});
