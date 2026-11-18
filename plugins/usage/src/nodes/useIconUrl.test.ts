import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: (...a: unknown[]) => request(...a) },
}));

import { ICON_RETRY_MS, resetIconCache, useIconUrl } from './useIconUrl';

const ok = () => Promise.resolve({ blob: () => Promise.resolve(new Blob(['x'])) });

/** Lets pending promise callbacks run under fake timers. */
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

describe('useIconUrl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetIconCache();
    request.mockReset();
    URL.createObjectURL = vi.fn(() => 'blob:icon');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads an icon once and caches it', async () => {
    request.mockImplementation(ok);
    const { result } = renderHook(() => useIconUrl('/icon/a'));
    expect(result.current).toBeNull();
    await flush();
    expect(result.current).toBe('blob:icon');
    renderHook(() => useIconUrl('/icon/a'));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retries a failed icon after the retry delay', async () => {
    request.mockImplementationOnce(() => Promise.reject(new Error('down')));
    request.mockImplementation(ok);
    const { result } = renderHook(() => useIconUrl('/icon/b'));
    await flush();
    expect(result.current).toBe('failed');
    await act(() => vi.advanceTimersByTimeAsync(ICON_RETRY_MS - 1000));
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current).toBe('failed');
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current).toBe('blob:icon');
  });

  it('keeps retrying while the icon still fails', async () => {
    request.mockImplementation(() => Promise.reject(new Error('down')));
    const { result } = renderHook(() => useIconUrl('/icon/c'));
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(ICON_RETRY_MS));
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(ICON_RETRY_MS));
    await flush();
    expect(request).toHaveBeenCalledTimes(3);
    expect(result.current).toBe('failed');
  });
});
