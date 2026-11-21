/*
 * Keeps the screen awake while the kiosk shows. A wall screen gets no touch or key input, so the
 * operating system dims it and then turns it off after its idle time. The screen then looks black
 * at a random time, and the browser stops the page timers, so the data also stops. The Screen Wake
 * Lock API asks the system to keep the screen on. The system drops the lock when the page is hidden,
 * so the lock is asked for again each time the page shows. A refusal is retried once a minute.
 */

export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockHost {
  navigator: { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } };
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
}

/** Time before a refused or failed request is tried again. */
export const WAKE_LOCK_RETRY_MS = 60_000;

/**
 * Holds a screen wake lock until the returned function runs. Does nothing where the browser has no
 * Screen Wake Lock API (it needs a secure page, such as https).
 */
export function holdScreenAwake(host: WakeLockHost): () => void {
  const api = host.navigator.wakeLock;
  if (!api) return () => undefined;
  let stopped = false;
  let sentinel: WakeLockSentinelLike | undefined;
  let pending = false;
  let retry: unknown;

  const clearRetry = () => {
    if (retry !== undefined) host.clearTimer(retry);
    retry = undefined;
  };

  const acquire = () => {
    if (stopped || sentinel || pending || host.document.visibilityState !== 'visible') return;
    pending = true;
    api.request('screen').then(
      s => {
        pending = false;
        if (stopped) {
          void s.release().catch(() => undefined);
          return;
        }
        sentinel = s;
        s.addEventListener('release', () => {
          if (sentinel === s) sentinel = undefined;
          // The system released it (a hidden page, low battery). Ask again when the page is visible.
          acquire();
        });
      },
      () => {
        pending = false;
        if (stopped) return;
        clearRetry();
        retry = host.setTimer(() => {
          retry = undefined;
          acquire();
        }, WAKE_LOCK_RETRY_MS);
      }
    );
  };

  const onVisibility = () => acquire();
  host.document.addEventListener('visibilitychange', onVisibility);
  acquire();

  return () => {
    stopped = true;
    clearRetry();
    host.document.removeEventListener('visibilitychange', onVisibility);
    const s = sentinel;
    sentinel = undefined;
    if (s) void s.release().catch(() => undefined);
  };
}

/** The wake lock for the browser this code runs in. */
export function holdScreenAwakeInBrowser(): () => void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return () => undefined;
  return holdScreenAwake({
    navigator: navigator as unknown as WakeLockHost['navigator'],
    document,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: id => clearTimeout(id as ReturnType<typeof setTimeout>),
  });
}
