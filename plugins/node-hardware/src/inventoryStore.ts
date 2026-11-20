/*
 * Module-level cache of the per-node hardware profile, shared by the Nodes
 * list columns and the Node details section. Same pattern as hardwareStore.ts,
 * but hardware changes rarely, so it refreshes every 5 minutes.
 */
import React from 'react';
import { HardwareProfile } from './inventory';
import { fetchInventory } from './inventoryFetch';

export const INVENTORY_REFRESH_INTERVAL_MS = 300_000;

export interface InventorySnapshot {
  profiles: Map<string, HardwareProfile>;
  loading: boolean;
  error: string | null;
}

const empty = (): InventorySnapshot => ({ profiles: new Map(), loading: true, error: null });

let snapshot: InventorySnapshot = empty();
const listeners = new Set<() => void>();
let pollingStarted = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function set(next: InventorySnapshot): void {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function refresh(): void {
  fetchInventory()
    .then(profiles => set({ profiles, loading: false, error: null }))
    // Keep the last-known-good data on error.
    .catch((err: Error) => set({ ...snapshot, loading: false, error: err.message || 'Failed to query metrics service' }));
}

export function startInventoryPolling(): void {
  if (pollingStarted) {
    return;
  }
  pollingStarted = true;
  refresh();
  refreshTimer = setInterval(refresh, INVENTORY_REFRESH_INTERVAL_MS);
}

export function getInventorySnapshot(): InventorySnapshot {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  startInventoryPolling();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribes to the shared, polled snapshot. */
export function useInventory(): InventorySnapshot {
  return React.useSyncExternalStore(subscribe, getInventorySnapshot);
}

/** Test-only: resets the module singleton. */
export function resetInventoryStoreForTests(): void {
  pollingStarted = false;
  snapshot = empty();
  listeners.clear();
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}
