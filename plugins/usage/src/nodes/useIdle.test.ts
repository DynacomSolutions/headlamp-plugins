import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIdle } from './useIdle';

describe('useIdle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once after the idle time with no pointerdown', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdle(true, 30, onIdle));
    vi.advanceTimersByTime(29_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('restarts the wait on every pointerdown', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdle(true, 30, onIdle));
    vi.advanceTimersByTime(20_000);
    document.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(20_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('does nothing while inactive, and stops on unmount', () => {
    const onIdle = vi.fn();
    const { rerender, unmount } = renderHook(({ active }) => useIdle(active, 30, onIdle), {
      initialProps: { active: false },
    });
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
    rerender({ active: true });
    unmount();
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('does not restart the wait when only the callback identity changes', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useIdle(true, 30, cb), {
      initialProps: { cb: first },
    });
    vi.advanceTimersByTime(20_000);
    rerender({ cb: second });
    vi.advanceTimersByTime(10_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
