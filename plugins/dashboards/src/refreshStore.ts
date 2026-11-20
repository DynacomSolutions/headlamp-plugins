/*
 * The refresh state of one dashboard, outside React so that the header clock updates without
 * rerendering the grid. `signal` goes up on each refresh request. Widgets report the time they
 * fetched, and the header shows the latest one.
 */
export interface RefreshState {
  signal: number;
  /** Epoch ms of the last refresh request. */
  triggeredAt: number;
  /** Epoch ms of the latest widget report, or 0. */
  reportedAt: number;
}

export interface RefreshStore {
  getState(): RefreshState;
  subscribe(listener: () => void): () => void;
  trigger(now?: number): void;
  report(at?: number): void;
}

export function createRefreshStore(now: () => number = Date.now): RefreshStore {
  let state: RefreshState = { signal: 0, triggeredAt: now(), reportedAt: 0 };
  const listeners = new Set<() => void>();
  const set = (next: RefreshState) => {
    state = next;
    listeners.forEach(l => l());
  };
  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    trigger(at = now()) {
      set({ ...state, signal: state.signal + 1, triggeredAt: at });
    },
    report(at = now()) {
      if (at > state.reportedAt) set({ ...state, reportedAt: at });
    },
  };
}

/** The time to show: the latest report, else the last request. */
export const lastRefreshedAt = (s: RefreshState): number => Math.max(s.reportedAt, s.triggeredAt);

/** "just now", "12 s ago", "3 min ago", "2 h ago". Never negative. */
export function relativeTime(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

export function clockTime(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
