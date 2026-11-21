/*
 * The last good data of every widget, kept in the browser so that a reload or a first load shows
 * data at once and refreshes in the background. An entry belongs to one dashboard and one widget
 * (`scope` is `<namespace>/<dashboard>`, `id` is the widget id). It holds a JSON value and the time
 * of that value.
 *
 * The store is localStorage, so a read is synchronous: a widget can render the cached value in its
 * first render, with no spinner. A write that fails (quota, a blocked store, a value that is not
 * JSON) is ignored: the cache is never required.
 *
 * Limits: one entry may not be bigger than `MAX_ENTRY_CHARS`, and all entries together may not be
 * bigger than `MAX_TOTAL_CHARS`. When the total is over, the entries with the oldest time go first.
 * Entries written by another format version (`CACHE_FORMAT`) are removed, never read. A new plugin
 * version keeps its entries, so a self reload into a new version still shows the old data.
 */

/** Change this number when the shape of a stored entry changes. Old entries then go. */
export const CACHE_FORMAT = 1;
export const KEY_PREFIX = 'dashboards.lastgood';
const CURRENT = `${KEY_PREFIX}.v${CACHE_FORMAT}:`;

/** The biggest single entry, in characters of its text. */
export const MAX_ENTRY_CHARS = 600_000;
/** The biggest total of all entries, in characters. localStorage allows about 5 million. */
export const MAX_TOTAL_CHARS = 3_000_000;
/** Data older than this shows a small "stale" mark until the first fresh answer comes. */
export const STALE_AFTER_MS = 15 * 60_000;

export interface LastGood<T> {
  value: T;
  /** Epoch ms of the value. */
  at: number;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key'> & {
  readonly length: number;
};

export interface LastGoodStore {
  /** The cached value of a widget, or undefined when there is none or it cannot be read. */
  read<T = unknown>(scope: string, id: string): LastGood<T> | undefined;
  /** Only the time of the cached value. Cheap: it does not parse the value. */
  timeOf(scope: string, id: string): number | undefined;
  /** Stores a value. Returns false when it was not kept (too big, not JSON, no storage). */
  write(scope: string, id: string, value: unknown, at?: number): boolean;
  /** Removes the entries of one scope, or all entries. */
  clear(scope?: string): void;
  /** The characters that all entries use now. */
  size(): number;
}

interface Meta {
  at: number;
  chars: number;
}

const keyOf = (scope: string, id: string): string => `${CURRENT}${scope}/${id}`;

/** An entry is the time, a bar and the JSON, so the time can be read without parsing the JSON. */
const encode = (at: number, json: string): string => `${Math.round(at)}|${json}`;
function decodeAt(text: string): number | undefined {
  const bar = text.indexOf('|');
  if (bar < 1 || bar > 16) return undefined;
  const at = Number(text.slice(0, bar));
  return Number.isFinite(at) ? at : undefined;
}

export function createLastGoodStore(
  storage: StorageLike | undefined,
  now: () => number = Date.now
): LastGoodStore {
  let index: Map<string, Meta> | undefined;

  /** One scan of the storage: the entries of this format, and the removal of other formats. */
  const load = (): Map<string, Meta> => {
    if (index) return index;
    index = new Map();
    if (!storage) return index;
    try {
      const old: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const k = storage.key(i);
        if (!k || !k.startsWith(`${KEY_PREFIX}.`)) continue;
        if (!k.startsWith(CURRENT)) {
          old.push(k);
          continue;
        }
        const text = storage.getItem(k);
        const at = text === null ? undefined : decodeAt(text);
        if (text === null || at === undefined) old.push(k);
        else index.set(k, { at, chars: text.length });
      }
      old.forEach(k => storage.removeItem(k));
    } catch {
      // A blocked store gives an empty cache.
    }
    return index;
  };

  const drop = (key: string): void => {
    load().delete(key);
    try {
      storage?.removeItem(key);
    } catch {
      // Nothing to do.
    }
  };

  const total = (): number => {
    let sum = 0;
    load().forEach(m => {
      sum += m.chars;
    });
    return sum;
  };

  /** Removes the oldest entries (never `keep`) until `room` more characters fit under the total cap. */
  const makeRoom = (room: number, keep: string): void => {
    const entries = [...load().entries()]
      .filter(([k]) => k !== keep)
      .sort((a, b) => a[1].at - b[1].at);
    let sum = total();
    for (const [k] of entries) {
      if (sum + room <= MAX_TOTAL_CHARS) break;
      sum -= load().get(k)?.chars ?? 0;
      drop(k);
    }
  };

  return {
    read<T>(scope: string, id: string): LastGood<T> | undefined {
      if (!storage) return undefined;
      const key = keyOf(scope, id);
      try {
        const text = storage.getItem(key);
        if (text === null) return undefined;
        const at = decodeAt(text);
        if (at === undefined) {
          drop(key);
          return undefined;
        }
        return { value: JSON.parse(text.slice(text.indexOf('|') + 1)) as T, at };
      } catch {
        // A damaged entry is removed, so it does not fail again.
        drop(key);
        return undefined;
      }
    },

    timeOf(scope: string, id: string): number | undefined {
      if (!storage) return undefined;
      try {
        const text = storage.getItem(keyOf(scope, id));
        return text === null ? undefined : decodeAt(text);
      } catch {
        return undefined;
      }
    },

    write(scope: string, id: string, value: unknown, at: number = now()): boolean {
      if (!storage) return false;
      const key = keyOf(scope, id);
      let text: string;
      try {
        const json = JSON.stringify(value);
        if (json === undefined) return false;
        text = encode(at, json);
      } catch {
        return false;
      }
      if (text.length > MAX_ENTRY_CHARS) {
        // The old entry of this widget would show data that is older than what the widget has now.
        drop(key);
        return false;
      }
      const previous = load().get(key)?.chars ?? 0;
      makeRoom(text.length - previous, key);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          storage.setItem(key, text);
          load().set(key, { at, chars: text.length });
          return true;
        } catch {
          // The quota is full (other data uses it too): free the oldest entry and try again.
          const oldest = [...load().entries()]
            .filter(([k]) => k !== key)
            .sort((a, b) => a[1].at - b[1].at)[0];
          if (!oldest) break;
          drop(oldest[0]);
        }
      }
      drop(key);
      return false;
    },

    clear(scope?: string): void {
      const prefix = scope === undefined ? CURRENT : `${CURRENT}${scope}/`;
      [...load().keys()].filter(k => k.startsWith(prefix)).forEach(drop);
    },

    size: total,
  };
}

let shared: LastGoodStore | undefined;

/** The store of this browser tab: localStorage when it is allowed, else a store that keeps nothing. */
export function lastGoodStore(): LastGoodStore {
  if (!shared) {
    let storage: StorageLike | undefined;
    try {
      storage = typeof window === 'undefined' ? undefined : window.localStorage;
    } catch {
      storage = undefined;
    }
    shared = createLastGoodStore(storage);
  }
  return shared;
}

/** Test helper: forget the shared store, so the next call reads the storage again. */
export function resetLastGoodStore(): void {
  shared = undefined;
}

/** True when a value of time `at` is older than the stale limit. */
export const isOldData = (at: number, now: number = Date.now()): boolean =>
  now - at > STALE_AFTER_MS;

/**
 * The per widget view of the store. The dashboard gives one to each widget (`WidgetProps.cache`).
 * It is the same shape as `WidgetCache` in the widget contract.
 */
export interface WidgetCacheView {
  read<T = unknown>(): LastGood<T> | undefined;
  write(value: unknown, at?: number): void;
}

export function widgetCache(
  store: LastGoodStore,
  scope: string,
  id: string,
  now: () => number = Date.now
): WidgetCacheView {
  return {
    read: <T>() => store.read<T>(scope, id),
    write: (value, at = now()) => {
      store.write(scope, id, value, at);
    },
  };
}
