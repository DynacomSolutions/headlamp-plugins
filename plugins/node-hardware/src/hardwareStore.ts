/*
 * Module-level cache of node temperatures and power, shared by the Nodes list
 * columns and the Node details section. Same pattern as disk-health's
 * capacityStore: the columns processor is not a component and cannot call
 * hooks, so it reads this snapshot; cells subscribe via useHardware. One
 * polling loop serves everything, refreshing every 60 s.
 */
import React from 'react';
import { fetchHardware, Hardware } from './hardware';

export const REFRESH_INTERVAL_MS = 60_000;

export interface HardwareSnapshot extends Hardware {
  loading: boolean;
  error: string | null;
}

const empty = (): HardwareSnapshot => ({ sensors: [], power: new Map(), batteries: new Map(), loading: true, error: null });

let snapshot: HardwareSnapshot = empty();
const listeners = new Set<() => void>();
let pollingStarted = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function set(next: HardwareSnapshot): void {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function refresh(): void {
  fetchHardware()
    .then(hw => set({ ...hw, loading: false, error: null }))
    // Keep the last-known-good data on error.
    .catch((err: Error) => set({ ...snapshot, loading: false, error: err.message || 'Failed to query metrics service' }));
}

export function startHardwarePolling(): void {
  if (pollingStarted) {
    return;
  }
  pollingStarted = true;
  refresh();
  refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
}

export function getHardwareSnapshot(): HardwareSnapshot {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  startHardwarePolling();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribes to the shared, polled snapshot. */
export function useHardware(): HardwareSnapshot {
  return React.useSyncExternalStore(subscribe, getHardwareSnapshot);
}

/** Test-only: resets the module singleton. */
export function resetHardwareStoreForTests(): void {
  pollingStarted = false;
  snapshot = empty();
  listeners.clear();
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}
