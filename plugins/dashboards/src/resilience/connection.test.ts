import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assetsOfHtml,
  CHANGE_CONFIRMATIONS,
  Connection,
  createConnection,
  isAppAssetUrl,
  isChunkErrorMessage,
  isOwnAppAssetUrl,
  OFFLINE_AFTER,
  ONLINE_INTERVAL_MS,
  ownAssetPaths,
  RELOAD_KEY,
  RELOAD_MAX_IN_WINDOW,
  RELOAD_MIN_GAP_MS,
  RELOAD_WINDOW_MS,
} from './connection';

const HTML = (js: string) =>
  `<html><head><script type="module" src="/assets/${js}"></script></head></html>`;

/** A server whose answers the test controls. */
function fakeServer() {
  const s = {
    up: true,
    version: '1.0.0',
    js: 'index-aaa.js',
    html: undefined as string | undefined,
    calls: 0,
  };
  const fetchImpl = vi.fn(async (url: string) => {
    s.calls += 1;
    if (!s.up) throw new TypeError('Failed to fetch');
    if (url.includes('/plugins/dashboards/package.json'))
      return new Response(JSON.stringify({ version: s.version }), { status: 200 });
    return new Response(s.html ?? HTML(s.js), { status: 200 });
  });
  return Object.assign(s, { fetchImpl });
}

function setup(over: { kiosk?: boolean; storage?: Record<string, string> } = {}) {
  const server = fakeServer();
  let now = 1_000_000;
  const store: Record<string, string> = over.storage ?? {};
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let nextId = 1;
  const reload = vi.fn();
  const loaded = { assets: ['/assets/index-aaa.js'] };
  const conn: Connection = createConnection({
    fetchImpl: server.fetchImpl,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, at: now + ms, id });
      return id;
    },
    clearTimer: id => {
      const i = timers.findIndex(t => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    reload,
    storage: { getItem: k => store[k] ?? null, setItem: (k, v) => void (store[k] = v) },
    isKiosk: () => over.kiosk ?? true,
    baseUrl: () => '',
    pageAssets: () => loaded.assets,
    pluginName: 'dashboards',
    random: () => 0,
  });
  /** Runs the next probe, as the timer would. */
  const tick = async (advanceMs = ONLINE_INTERVAL_MS) => {
    now += advanceMs;
    await conn.probeNow();
  };
  return {
    server,
    conn,
    reload,
    store,
    tick,
    loaded,
    setNow: (n: number) => (now = n),
    now: () => now,
  };
}

describe('assetsOfHtml', () => {
  it('lists the hashed script files of a page, sorted, without query strings', () => {
    const html =
      '<script src="/assets/b-1.js?x=1"></script><script defer src="https://h.example.com/assets/a-2.js"></script><script src="/other.js"></script>';
    expect(assetsOfHtml(html)).toEqual(['/assets/a-2.js', '/assets/b-1.js']);
  });
});

describe('chunk error detection', () => {
  it('knows the messages of a failed dynamic import in the main browsers', () => {
    for (const m of [
      'Failed to fetch dynamically imported module: https://x.example.com/assets/Foo-abc.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
      'Loading chunk 12 failed.',
      'Loading CSS chunk 3 failed',
      'ChunkLoadError',
    ])
      expect(isChunkErrorMessage(m)).toBe(true);
    expect(isChunkErrorMessage(new Error('Failed to fetch dynamically imported module: x'))).toBe(
      true
    );
    expect(isChunkErrorMessage('Cannot read properties of undefined')).toBe(false);
    expect(isChunkErrorMessage(undefined)).toBe(false);
  });

  it('knows an app file by its folder', () => {
    expect(isAppAssetUrl('https://h.example.com/assets/x.js')).toBe(true);
    expect(isAppAssetUrl('/plugins/uptime/main.js')).toBe(true);
    expect(isAppAssetUrl('https://cdn.example.com/lib.js')).toBe(false);
  });
});

describe('connection state', () => {
  it('is online after a good probe and offline only after two failures in a row', async () => {
    const t = setup();
    await t.conn.probeNow();
    expect(t.conn.getState()).toMatchObject({ online: true, failures: 0 });
    t.server.up = false;
    await t.tick(1_000);
    expect(t.conn.getState()).toMatchObject({ online: true, failures: 1 });
    await t.tick(1_000);
    expect(t.conn.getState()).toMatchObject({ online: false, failures: OFFLINE_AFTER });
    const since = t.conn.getState().since;
    expect(since).toBe(t.now());
    t.server.up = true;
    await t.tick(5_000);
    expect(t.conn.getState()).toMatchObject({ online: true, failures: 0 });
    expect(t.conn.getState().since).toBe(t.now());
  });

  it('treats an HTTP error from a gateway as down', async () => {
    const t = setup();
    await t.conn.probeNow();
    t.server.fetchImpl.mockImplementation(async () => new Response('bad gateway', { status: 502 }));
    await t.tick(1_000);
    await t.tick(1_000);
    expect(t.conn.getState().online).toBe(false);
  });

  it('tells subscribers about each change', async () => {
    const t = setup();
    const seen = vi.fn();
    t.conn.subscribe(seen);
    await t.conn.probeNow();
    expect(seen).toHaveBeenCalled();
  });
});

describe('reload on a new version', () => {
  it('does not reload when nothing changed', async () => {
    const t = setup();
    await t.conn.probeNow();
    for (let i = 0; i < 5; i += 1) await t.tick();
    expect(t.reload).not.toHaveBeenCalled();
  });

  it('reloads a kiosk after the new plugin version shows twice, and stores the reload', async () => {
    const t = setup();
    await t.conn.probeNow();
    t.server.version = '1.1.0';
    await t.tick();
    expect(t.reload).not.toHaveBeenCalled();
    expect(CHANGE_CONFIRMATIONS).toBe(2);
    await t.tick();
    expect(t.reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(t.store[RELOAD_KEY])).toHaveLength(1);
  });

  it('does not reload when the new version shows for one probe only (two pods during a rollout)', async () => {
    const t = setup();
    await t.conn.probeNow();
    t.server.version = '1.1.0';
    await t.tick();
    t.server.version = '1.0.0';
    await t.tick();
    await t.tick();
    expect(t.reload).not.toHaveBeenCalled();
  });

  it('reloads a page that was loaded from other script files than the server serves now', async () => {
    const t = setup();
    t.server.js = 'index-bbb.js';
    await t.conn.probeNow();
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads a page that is not a kiosk, where someone may be editing', async () => {
    const t = setup({ kiosk: false });
    await t.conn.probeNow();
    t.server.version = '2.0.0';
    await t.tick();
    await t.tick();
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.conn.getState().reloadWanted).toBe('version');
  });

  it('does not reload while the server is down, only after it answers', async () => {
    const t = setup();
    await t.conn.probeNow();
    t.server.version = '1.1.0';
    await t.tick();
    t.server.up = false;
    await t.tick(1_000);
    await t.tick(1_000);
    await t.tick(1_000);
    expect(t.reload).not.toHaveBeenCalled();
    t.server.up = true;
    await t.tick(5_000);
    expect(t.reload).toHaveBeenCalledTimes(1);
  });
});

describe('reload on a failed chunk', () => {
  it('waits for a good answer, then reloads a kiosk', async () => {
    const t = setup();
    await t.conn.probeNow();
    t.server.up = false;
    t.conn.chunkFailed();
    await t.conn.probeNow();
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.conn.getState().reloadWanted).toBe('chunk');
    t.server.up = true;
    await t.tick(5_000);
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads at once when the server already answers (old chunk names gone after a new version)', async () => {
    const t = setup();
    await t.conn.probeNow();
    t.conn.chunkFailed();
    await vi.waitFor(() => expect(t.reload).toHaveBeenCalledTimes(1));
  });
});

describe('the loop guard', () => {
  it('allows at most three reloads in ten minutes and keeps 30 s between two', async () => {
    const t = setup();
    await t.conn.probeNow();
    let reloads = 0;
    // The server keeps another version, so every probe wants a reload.
    t.server.js = 'index-zzz.js';
    for (let i = 0; i < 12; i += 1) {
      await t.tick(RELOAD_MIN_GAP_MS + 1_000);
      reloads = t.reload.mock.calls.length;
    }
    expect(RELOAD_MAX_IN_WINDOW).toBe(3);
    expect(reloads).toBe(3);
  });

  it('keeps the minimum gap', async () => {
    const t = setup();
    t.server.js = 'index-zzz.js';
    await t.conn.probeNow();
    expect(t.reload).toHaveBeenCalledTimes(1);
    await t.tick(5_000);
    await t.tick(5_000);
    expect(t.reload).toHaveBeenCalledTimes(1);
    await t.tick(RELOAD_MIN_GAP_MS);
    expect(t.reload).toHaveBeenCalledTimes(2);
  });

  it('allows a reload again when the old ones are outside the window', async () => {
    const old = Date.now() - RELOAD_WINDOW_MS - 1_000;
    const t = setup({ storage: { [RELOAD_KEY]: JSON.stringify([old, old, old]) } });
    t.setNow(Date.now());
    t.server.js = 'index-zzz.js';
    await t.conn.probeNow();
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('survives broken stored data', async () => {
    const t = setup({ storage: { [RELOAD_KEY]: 'not json' } });
    t.server.js = 'index-zzz.js';
    await t.conn.probeNow();
    expect(t.reload).toHaveBeenCalledTimes(1);
  });
});

describe('the probe loop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts once for several users and stops with the last one', async () => {
    const t = setup();
    t.conn.start();
    t.conn.start();
    await Promise.resolve();
    const calls = t.server.calls;
    expect(calls).toBeGreaterThan(0);
    t.conn.stop();
    t.conn.stop();
    expect(t.conn.getState().online).toBe(true);
  });

  it('catches a failed lazy chunk through the window listener', async () => {
    const t = setup();
    await t.conn.probeNow();
    t.conn.start();
    const e = new Event('unhandledrejection') as Event & { reason?: unknown };
    e.reason = new Error('Failed to fetch dynamically imported module: /assets/x.js');
    window.dispatchEvent(e);
    expect(t.conn.getState().reloadWanted).toBe('chunk');
    t.conn.stop();
    const e2 = new Event('unhandledrejection') as Event & { reason?: unknown };
    e2.reason = new Error('Importing a module script failed.');
    const before = t.server.calls;
    window.dispatchEvent(e2);
    expect(t.server.calls).toBe(before);
  });

  it('catches a script that fails to load from the app folder', async () => {
    const t = setup();
    t.conn.start();
    const s = document.createElement('script');
    s.src = '/plugins/uptime/main.js';
    document.head.appendChild(s);
    s.dispatchEvent(new Event('error'));
    expect(t.conn.getState().reloadWanted).toBe('chunk');
    t.conn.stop();
    s.remove();
  });
});

describe('scripts of this server only', () => {
  const page = 'https://k8s.example.com/c/dynacom/dashboards/operations?kiosk=1';

  it('keeps the /assets/ scripts of the same origin and drops the ones an extension adds', () => {
    expect(
      ownAssetPaths(
        [
          'https://k8s.example.com/assets/index-a1.js',
          'chrome-extension://abcdefgh/assets/content.js',
          'https://cdn.example.com/assets/lib.js',
          'https://k8s.example.com/other/x.js',
          '/assets/b2.js',
        ],
        page
      )
    ).toEqual(['/assets/b2.js', '/assets/index-a1.js']);
  });

  it('ignores a source that is not a URL', () => {
    expect(ownAssetPaths(['http://[bad'], page)).toEqual([]);
  });

  it('counts a failed file only when this server serves it', () => {
    expect(isOwnAppAssetUrl('https://k8s.example.com/assets/x.js', page)).toBe(true);
    expect(isOwnAppAssetUrl('/plugins/uptime/main.js', page)).toBe(true);
    expect(isOwnAppAssetUrl('chrome-extension://abcdefgh/assets/content.js', page)).toBe(false);
    expect(isOwnAppAssetUrl('https://cdn.example.com/assets/lib.js', page)).toBe(false);
  });
});
