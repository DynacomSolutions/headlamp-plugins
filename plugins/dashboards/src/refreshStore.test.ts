import { describe, expect, it, vi } from 'vitest';
import { clockTime, createRefreshStore, lastRefreshedAt, relativeTime } from './refreshStore';

describe('refresh store', () => {
  it('counts triggers and keeps the latest report', () => {
    let t = 1000;
    const store = createRefreshStore(() => t);
    const l = vi.fn();
    store.subscribe(l);
    expect(store.getState()).toEqual({
      signal: 0,
      triggeredAt: 1000,
      reportedAt: 0,
      cachedAt: 0,
    });
    t = 2000;
    store.trigger();
    expect(store.getState().signal).toBe(1);
    expect(lastRefreshedAt(store.getState())).toBe(2000);
    store.report(2500);
    store.report(2100);
    expect(store.getState().reportedAt).toBe(2500);
    expect(lastRefreshedAt(store.getState())).toBe(2500);
    expect(l).toHaveBeenCalledTimes(2);
  });

  it('shows the cached time until a widget reports, then the report', () => {
    let t = 10_000;
    const store = createRefreshStore(() => t);
    store.cached(4_000);
    store.cached(2_000);
    expect(store.getState().cachedAt).toBe(4_000);
    // A refresh request alone does not change the time: nothing has fresh data yet.
    t = 11_000;
    store.trigger();
    expect(lastRefreshedAt(store.getState())).toBe(4_000);
    store.report(11_500);
    expect(lastRefreshedAt(store.getState())).toBe(11_500);
  });

  it('shows the request time when nothing is cached and nothing has reported', () => {
    const store = createRefreshStore(() => 7_000);
    expect(lastRefreshedAt(store.getState())).toBe(7_000);
  });

  it('stops notifying after unsubscribe', () => {
    const store = createRefreshStore(() => 1);
    const l = vi.fn();
    const off = store.subscribe(l);
    off();
    store.trigger();
    expect(l).not.toHaveBeenCalled();
  });
});

describe('relativeTime', () => {
  it('words the age', () => {
    expect(relativeTime(10_000, 10_000)).toBe('just now');
    expect(relativeTime(10_000, 22_000)).toBe('12 s ago');
    expect(relativeTime(0, 180_000)).toBe('3 min ago');
    expect(relativeTime(0, 7_300_000)).toBe('2 h ago');
    expect(relativeTime(5000, 1000)).toBe('just now');
  });
  it('formats the exact time as hh:mm:ss', () => {
    expect(clockTime(new Date(2026, 0, 1, 9, 5, 7).getTime())).toBe('09:05:07');
  });
});
