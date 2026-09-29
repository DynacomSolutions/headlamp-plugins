/*
 * Module-level cache for node disk-capacity figures, shared by the Nodes
 * list "Disk" column and any other consumer that wants a synchronous read
 * without triggering its own fetch. registerResourceTableColumnsProcessor's
 * processor function is called synchronously during NodeList's render
 * (it is not itself a React component), so it cannot call hooks; it reads
 * this store's snapshot instead. The per-row cell component subscribes via
 * useNodeCapacity so it re-renders once new data arrives.
 *
 * One polling loop serves the whole Nodes table (and any other consumer),
 * refreshing every 60s - see REFRESH_INTERVAL_MS.
 */
import { fetchNodeCapacity, NodeCapacity } from './capacity';

export const REFRESH_INTERVAL_MS = 60_000;

export interface CapacitySnapshot {
  capacity: Map<string, NodeCapacity>;
  loading: boolean;
}

let snapshot: CapacitySnapshot = { capacity: new Map(), loading: true };
const listeners = new Set<() => void>();
let pollingStarted = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function refresh(): void {
  fetchNodeCapacity()
    .then(capacity => {
      snapshot = { capacity, loading: false };
      notify();
    })
    .catch(() => {
      // Keep the last-known-good snapshot on error; consumers show "-" for
      // whatever nodes never got a figure.
      if (snapshot.loading) {
        snapshot = { capacity: snapshot.capacity, loading: false };
        notify();
      }
    });
}

function ensurePolling(): void {
  if (pollingStarted) {
    return;
  }
  pollingStarted = true;
  refresh();
  refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
}

/** Current snapshot, without subscribing or starting the polling loop. */
export function getCapacitySnapshot(): CapacitySnapshot {
  return snapshot;
}

/**
 * Starts the shared polling loop if it is not already running. Idempotent
 * and safe to call from a non-component context (for example a table
 * columns processor, which must not call hooks).
 */
export function startCapacityPolling(): void {
  ensurePolling();
}

/** Starts the shared polling loop (idempotent) and subscribes to updates. */
export function subscribeCapacity(listener: () => void): () => void {
  ensurePolling();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: resets the module singleton between test cases. */
export function resetCapacityStoreForTests(): void {
  pollingStarted = false;
  snapshot = { capacity: new Map(), loading: true };
  listeners.clear();
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}
