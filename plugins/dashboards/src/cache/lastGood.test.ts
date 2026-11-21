import { beforeEach, describe, expect, it } from 'vitest';
import {
  CACHE_FORMAT,
  createLastGoodStore,
  isOldData,
  KEY_PREFIX,
  LastGoodStore,
  MAX_ENTRY_CHARS,
  MAX_TOTAL_CHARS,
  STALE_AFTER_MS,
  StorageLike,
  widgetCache,
} from './lastGood';

/** A storage in memory that behaves like localStorage, with an optional limit on its size. */
class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  constructor(private limit = Infinity) {}
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    const others = [...this.map.entries()].filter(([key]) => key !== k);
    const used = others.reduce((n, [key, val]) => n + key.length + val.length, 0);
    if (used + k.length + v.length > this.limit) throw new Error('QuotaExceededError');
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

let storage: MemoryStorage;
let store: LastGoodStore;
beforeEach(() => {
  storage = new MemoryStorage();
  store = createLastGoodStore(storage, () => 1_000);
});

describe('last good store: hit and miss', () => {
  it('returns what was written, with its time', () => {
    expect(store.write('ns/ops', 'w-1', { a: [1, 2, 3] }, 5_000)).toBe(true);
    expect(store.read('ns/ops', 'w-1')).toEqual({ value: { a: [1, 2, 3] }, at: 5_000 });
    expect(store.timeOf('ns/ops', 'w-1')).toBe(5_000);
  });

  it('uses the clock when no time is given', () => {
    store.write('ns/ops', 'w-1', 'x');
    expect(store.read('ns/ops', 'w-1')?.at).toBe(1_000);
  });

  it('misses for another widget, another dashboard and an empty store', () => {
    store.write('ns/ops', 'w-1', 1, 1);
    expect(store.read('ns/ops', 'w-2')).toBeUndefined();
    expect(store.read('ns/other', 'w-1')).toBeUndefined();
    expect(store.timeOf('ns/ops', 'w-2')).toBeUndefined();
  });

  it('replaces an entry on a new write', () => {
    store.write('s', 'w', 'old', 1);
    store.write('s', 'w', 'new', 2);
    expect(store.read('s', 'w')).toEqual({ value: 'new', at: 2 });
  });

  it('survives a new store on the same storage, as after a reload', () => {
    store.write('s', 'w', { k: 'v' }, 7);
    const after = createLastGoodStore(storage);
    expect(after.read('s', 'w')).toEqual({ value: { k: 'v' }, at: 7 });
  });

  it('is empty and quiet without a storage', () => {
    const none = createLastGoodStore(undefined);
    expect(none.write('s', 'w', 1)).toBe(false);
    expect(none.read('s', 'w')).toBeUndefined();
    expect(none.size()).toBe(0);
  });

  it('does not keep a value that is not JSON', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(store.write('s', 'w', loop)).toBe(false);
    expect(store.write('s', 'w', undefined)).toBe(false);
    expect(store.read('s', 'w')).toBeUndefined();
  });

  it('removes a damaged entry instead of failing again', () => {
    store.write('s', 'w', 'ok', 3);
    const key = storage.keys()[0];
    storage.setItem(key, '3|{not json');
    expect(store.read('s', 'w')).toBeUndefined();
    expect(storage.getItem(key)).toBeNull();
  });
});

describe('last good store: stale threshold', () => {
  it('marks data as old only after the stale limit', () => {
    const now = 10_000_000;
    expect(isOldData(now - STALE_AFTER_MS + 1, now)).toBe(false);
    expect(isOldData(now - STALE_AFTER_MS - 1, now)).toBe(true);
  });
});

describe('last good store: size cap', () => {
  it('refuses an entry bigger than the entry cap, and drops the old entry of that widget', () => {
    store.write('s', 'w', 'small', 1);
    const big = 'x'.repeat(MAX_ENTRY_CHARS);
    expect(store.write('s', 'w', big, 2)).toBe(false);
    expect(store.read('s', 'w')).toBeUndefined();
  });

  it('keeps the total under the cap by removing the oldest entries first', () => {
    const piece = 'y'.repeat(MAX_ENTRY_CHARS - 100);
    // Each entry is almost 600 000 characters, so five fit and the sixth makes the total go over.
    for (let i = 0; i < 6; i += 1) store.write('s', `w-${i}`, piece, 100 + i);
    expect(store.size()).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
    expect(store.read('s', 'w-0')).toBeUndefined();
    expect(store.read('s', 'w-5')).toBeDefined();
    expect(store.read('s', 'w-4')).toBeDefined();
  });

  it('never removes the entry that it just wrote', () => {
    const piece = 'z'.repeat(MAX_ENTRY_CHARS - 100);
    for (let i = 0; i < 8; i += 1) {
      store.write('s', `w-${i}`, piece, 10 + i);
      expect(store.read('s', `w-${i}`)).toBeDefined();
    }
  });

  it('frees the oldest entry when the browser quota is full, and retries', () => {
    const small = new MemoryStorage(2_000);
    const s = createLastGoodStore(small);
    s.write('s', 'a', 'a'.repeat(700), 1);
    s.write('s', 'b', 'b'.repeat(700), 2);
    expect(s.write('s', 'c', 'c'.repeat(700), 3)).toBe(true);
    expect(s.read('s', 'a')).toBeUndefined();
    expect(s.read('s', 'c')).toBeDefined();
  });

  it('gives up cleanly when one entry never fits the quota', () => {
    const tiny = new MemoryStorage(50);
    const s = createLastGoodStore(tiny);
    expect(s.write('s', 'a', 'a'.repeat(500), 1)).toBe(false);
    expect(s.read('s', 'a')).toBeUndefined();
  });

  it('counts a rewrite of the same widget once', () => {
    store.write('s', 'w', 'a'.repeat(1_000), 1);
    const before = store.size();
    store.write('s', 'w', 'a'.repeat(1_000), 2);
    expect(store.size()).toBe(before);
  });
});

describe('last good store: format version', () => {
  it('removes entries of another format and never reads them', () => {
    storage.setItem(`${KEY_PREFIX}.v${CACHE_FORMAT + 1}:s/w`, '5|"future"');
    storage.setItem(`${KEY_PREFIX}.v0:s/w`, '5|"past"');
    storage.setItem('other.app.key', 'keep me');
    const fresh = createLastGoodStore(storage);
    expect(fresh.read('s', 'w')).toBeUndefined();
    fresh.write('s', 'w', 'now', 9);
    expect(
      storage.keys().filter(k => k.includes('.v0:') || k.includes(`.v${CACHE_FORMAT + 1}:`))
    ).toEqual([]);
    expect(storage.getItem('other.app.key')).toBe('keep me');
  });

  it('keeps current entries when the plugin version changes: the cache has no plugin version in it', () => {
    store.write('s', 'w', { shown: 'by 0.49' }, 4);
    // A new bundle starts: a new store object on the same storage reads the same entries.
    expect(createLastGoodStore(storage).read('s', 'w')?.value).toEqual({ shown: 'by 0.49' });
  });

  it('removes an entry with no readable time', () => {
    storage.setItem(`${KEY_PREFIX}.v${CACHE_FORMAT}:s/w`, 'no time here');
    const fresh = createLastGoodStore(storage);
    expect(fresh.read('s', 'w')).toBeUndefined();
    expect(storage.keys()).toEqual([]);
  });
});

describe('last good store: clear and the widget view', () => {
  it('clears one scope and leaves the others', () => {
    store.write('a', 'w', 1, 1);
    store.write('b', 'w', 2, 1);
    store.clear('a');
    expect(store.read('a', 'w')).toBeUndefined();
    expect(store.read('b', 'w')).toBeDefined();
    store.clear();
    expect(store.read('b', 'w')).toBeUndefined();
  });

  it('gives a widget its own entry through the view', () => {
    const view = widgetCache(store, 'ns/ops', 'w-9', () => 42);
    expect(view.read()).toBeUndefined();
    view.write({ ok: true });
    expect(view.read()).toEqual({ value: { ok: true }, at: 42 });
    view.write({ ok: false }, 50);
    expect(store.read('ns/ops', 'w-9')).toEqual({ value: { ok: false }, at: 50 });
  });
});
