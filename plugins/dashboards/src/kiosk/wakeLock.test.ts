import { describe, expect, it, vi } from 'vitest';
import { holdScreenAwake, WAKE_LOCK_RETRY_MS, WakeLockHost } from './wakeLock';

function makeHost(opts: { visible?: boolean; rejectFirst?: boolean; noApi?: boolean } = {}) {
  let visibility: DocumentVisibilityState = opts.visible === false ? 'hidden' : 'visible';
  const docListeners = new Set<() => void>();
  const sentinels: { released: boolean; onRelease?: () => void }[] = [];
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let rejectNext = !!opts.rejectFirst;
  const request = vi.fn(() => {
    if (rejectNext) {
      rejectNext = false;
      return Promise.reject(new Error('NotAllowedError'));
    }
    const s = {
      released: false,
      onRelease: undefined as (() => void) | undefined,
      release: () => {
        s.released = true;
        return Promise.resolve();
      },
      addEventListener: (_t: 'release', l: () => void) => {
        s.onRelease = l;
      },
    };
    sentinels.push(s);
    return Promise.resolve(s);
  });
  const host: WakeLockHost = {
    navigator: opts.noApi ? {} : { wakeLock: { request } },
    document: {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (_t: string, l: () => void) => docListeners.add(l),
      removeEventListener: (_t: string, l: () => void) => docListeners.delete(l),
    } as unknown as WakeLockHost['document'],
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: timers.length + 1 };
      timers.push(t);
      return t.id;
    },
    clearTimer: id => {
      const i = timers.findIndex(t => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return {
    host,
    request,
    sentinels,
    timers,
    docListeners,
    setVisibility: (v: DocumentVisibilityState) => {
      visibility = v;
      docListeners.forEach(l => l());
    },
  };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('holdScreenAwake', () => {
  it('asks for a screen lock when the page is visible', async () => {
    const h = makeHost();
    holdScreenAwake(h.host);
    await flush();
    expect(h.request).toHaveBeenCalledWith('screen');
    expect(h.sentinels).toHaveLength(1);
  });

  it('does nothing where the browser has no wake lock', () => {
    const h = makeHost({ noApi: true });
    const stop = holdScreenAwake(h.host);
    expect(h.docListeners.size).toBe(0);
    expect(() => stop()).not.toThrow();
  });

  it('waits while the page is hidden and asks when it shows', async () => {
    const h = makeHost({ visible: false });
    holdScreenAwake(h.host);
    await flush();
    expect(h.request).not.toHaveBeenCalled();
    h.setVisibility('visible');
    await flush();
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('asks again after the system releases the lock', async () => {
    const h = makeHost();
    holdScreenAwake(h.host);
    await flush();
    h.sentinels[0].onRelease?.();
    await flush();
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('does not ask twice while it holds a lock', async () => {
    const h = makeHost();
    holdScreenAwake(h.host);
    await flush();
    h.setVisibility('visible');
    h.setVisibility('visible');
    await flush();
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('retries once a minute after a refusal', async () => {
    const h = makeHost({ rejectFirst: true });
    holdScreenAwake(h.host);
    await flush();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(WAKE_LOCK_RETRY_MS);
    h.timers[0].fn();
    await flush();
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.sentinels).toHaveLength(1);
  });

  it('releases the lock and stops listening on stop', async () => {
    const h = makeHost();
    const stop = holdScreenAwake(h.host);
    await flush();
    stop();
    await flush();
    expect(h.sentinels[0].released).toBe(true);
    expect(h.docListeners.size).toBe(0);
    h.setVisibility('visible');
    await flush();
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('releases a lock that arrives after stop', async () => {
    const h = makeHost();
    const stop = holdScreenAwake(h.host);
    stop();
    await flush();
    expect(h.sentinels[0].released).toBe(true);
  });

  it('cancels a pending retry on stop', async () => {
    const h = makeHost({ rejectFirst: true });
    const stop = holdScreenAwake(h.host);
    await flush();
    stop();
    expect(h.timers).toHaveLength(0);
  });
});
