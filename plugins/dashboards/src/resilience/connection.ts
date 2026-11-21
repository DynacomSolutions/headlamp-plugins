/*
 * The link between this page and the Headlamp server, outside React. A small probe asks the
 * server for the plugin's own package.json. It does three jobs:
 *
 *  1. It tells the header whether the server answers (`online`, and since when).
 *  2. It watches the version. When the server comes back with another plugin version or other
 *     Headlamp script files, a kiosk reloads into it (the same URL, so the tab, kiosk and view stay).
 *  3. It catches a failed lazy chunk or script load (the old file names are gone after a new
 *     version) and reloads a kiosk once the server answers again.
 *
 * A reload happens only in a kiosk (nobody edits there) and never in a loop: at most three reloads
 * in ten minutes and at least 30 seconds apart, counted in sessionStorage, which survives a reload.
 * The page never reloads while the server is down, because the browser would then show its own
 * error page. It waits for a good answer first.
 */
import { backoffDelay } from './backoff';

export interface ConnectionState {
  /** False after two failed probes in a row. */
  online: boolean;
  /** Epoch ms of the last change between online and offline (or of the start). */
  since: number;
  /** Epoch ms of the last good probe, or 0. */
  lastOkAt: number;
  /** Failed probes in a row. */
  failures: number;
  /** Why a reload is waiting, or undefined. */
  reloadWanted?: 'version' | 'chunk';
}

export interface ConnectionDeps {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  reload: () => void;
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  /** True when the page is a kiosk now. Read at each decision, because the kiosk can be toggled. */
  isKiosk: () => boolean;
  /** The Headlamp base URL: '' or something like '/headlamp'. */
  baseUrl: () => string;
  /** The script files (paths) of the page as loaded in this browser tab. */
  pageAssets: () => string[];
  pluginName: string;
  random: () => number;
}

export const PROBE_TIMEOUT_MS = 5_000;
export const ONLINE_INTERVAL_MS = 15_000;
export const OFFLINE_BASE_MS = 2_000;
export const OFFLINE_CAP_MS = 15_000;
/** A probe failure shows as offline after this many in a row, so one lost packet does not flicker. */
export const OFFLINE_AFTER = 2;
/** A new fingerprint must show this many times in a row before a reload (during a rollout two pods can answer). */
export const CHANGE_CONFIRMATIONS = 2;
export const RELOAD_MIN_GAP_MS = 30_000;
export const RELOAD_WINDOW_MS = 10 * 60_000;
export const RELOAD_MAX_IN_WINDOW = 3;
export const RELOAD_KEY = 'dashboards.kiosk.reloads';

/** The `/assets/...` script paths in a page's HTML. */
export function assetsOfHtml(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const path = m[1].split('?')[0].replace(/^https?:\/\/[^/]+/, '');
    if (path.includes('/assets/')) out.add(path);
  }
  return [...out].sort();
}

const CHUNK_MESSAGE =
  /Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Unable to preload CSS/i;

/** True for the message of a failed lazy chunk or dynamic import. */
export function isChunkErrorMessage(text: unknown): boolean {
  const m = typeof text === 'string' ? text : text instanceof Error ? text.message : '';
  return CHUNK_MESSAGE.test(m);
}

/** True for the path of a file that Headlamp serves with a hash in its name or from a plugin folder. */
export function isAppAssetUrl(url: string): boolean {
  return /\/(assets|plugins|static-plugins)\//.test(url);
}

export interface Connection {
  getState(): ConnectionState;
  subscribe(l: () => void): () => void;
  /** Starts the probe loop and the chunk error listeners. Each call needs a `stop`. */
  start(): void;
  stop(): void;
  /** Probes now, outside the schedule. */
  probeNow(): Promise<void>;
  /** A lazy chunk or a script failed to load. A kiosk reloads once the server answers. */
  chunkFailed(): void;
}

export function createConnection(deps: ConnectionDeps): Connection {
  let state: ConnectionState = { online: true, since: deps.now(), lastOkAt: 0, failures: 0 };
  const listeners = new Set<() => void>();
  let users = 0;
  let timer: unknown;
  let probing: Promise<void> | undefined;
  let baseline: string | undefined;
  let candidate: { fingerprint: string; seen: number } | undefined;
  let removeListeners: (() => void) | undefined;

  const set = (next: ConnectionState) => {
    state = next;
    listeners.forEach(l => l());
  };

  const probeOnce = async (): Promise<string> => {
    const base = deps.baseUrl();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : undefined;
    const t = deps.setTimer(() => ctrl?.abort(), PROBE_TIMEOUT_MS);
    try {
      const init: RequestInit = { cache: 'no-store', signal: ctrl?.signal };
      const q = `?t=${deps.now()}`;
      const [pkg, page] = await Promise.all([
        deps.fetchImpl(`${base}/plugins/${deps.pluginName}/package.json${q}`, init),
        deps.fetchImpl(`${base}/${q}`, init),
      ]);
      if (!pkg.ok || !page.ok) throw new Error(`HTTP ${pkg.ok ? page.status : pkg.status}`);
      // A server that answers with a page, not JSON, still counts as up. Its version is then unknown.
      const version = String((await pkg.json().catch(() => undefined))?.version ?? '');
      const assets = assetsOfHtml(await page.text());
      const loaded = deps.pageAssets();
      // The page in this tab was loaded from other script files than the server serves now.
      const staleDom = assets.length > 0 && loaded.length > 0 && assets.join() !== loaded.join();
      return `${version}|${staleDom ? `stale:${assets.join()}` : ''}`;
    } finally {
      deps.clearTimer(t);
    }
  };

  const reloadAllowed = (): boolean => {
    const now = deps.now();
    let times: number[] = [];
    try {
      times = JSON.parse(deps.storage?.getItem(RELOAD_KEY) ?? '[]');
    } catch {
      times = [];
    }
    const recent = times.filter(t => typeof t === 'number' && now - t < RELOAD_WINDOW_MS);
    if (recent.length >= RELOAD_MAX_IN_WINDOW) return false;
    if (recent.some(t => now - t < RELOAD_MIN_GAP_MS)) return false;
    return true;
  };

  const doReload = () => {
    const now = deps.now();
    let times: number[] = [];
    try {
      times = JSON.parse(deps.storage?.getItem(RELOAD_KEY) ?? '[]');
    } catch {
      times = [];
    }
    times = times.filter(t => typeof t === 'number' && now - t < RELOAD_WINDOW_MS);
    times.push(now);
    try {
      deps.storage?.setItem(RELOAD_KEY, JSON.stringify(times));
    } catch {
      // Storage is blocked: the reload still happens, but the loop guard cannot count it.
    }
    deps.reload();
  };

  const run = async (): Promise<void> => {
    try {
      const fingerprint = await probeOnce();
      const wasOffline = !state.online;
      let reloadWanted = state.reloadWanted;
      if (baseline === undefined) {
        baseline = fingerprint;
      } else if (fingerprint !== baseline) {
        if (candidate?.fingerprint === fingerprint) candidate.seen += 1;
        else candidate = { fingerprint, seen: 1 };
        if (candidate.seen >= CHANGE_CONFIRMATIONS) reloadWanted = reloadWanted ?? 'version';
      } else {
        candidate = undefined;
      }
      // A page that loaded from old files (the `stale:` mark) needs a reload at once.
      if (fingerprint.includes('|stale:')) reloadWanted = reloadWanted ?? 'version';
      set({
        online: true,
        since: wasOffline ? deps.now() : state.since,
        lastOkAt: deps.now(),
        failures: 0,
        reloadWanted,
      });
      if (reloadWanted && deps.isKiosk() && reloadAllowed()) doReload();
    } catch {
      const failures = state.failures + 1;
      set({
        ...state,
        failures,
        online: failures < OFFLINE_AFTER ? state.online : false,
        since: state.online && failures >= OFFLINE_AFTER ? deps.now() : state.since,
      });
    }
  };

  const probeNow = (): Promise<void> => {
    if (!probing) {
      probing = run().finally(() => {
        probing = undefined;
      });
    }
    return probing;
  };

  const schedule = () => {
    if (users === 0) return;
    const delay = state.failures
      ? backoffDelay(state.failures, OFFLINE_BASE_MS, OFFLINE_CAP_MS, 0.2, deps.random)
      : Math.round(ONLINE_INTERVAL_MS * (1 - 0.2 * deps.random()));
    timer = deps.setTimer(() => {
      void probeNow().finally(schedule);
    }, delay);
  };

  const chunkFailed = () => {
    set({ ...state, reloadWanted: state.reloadWanted ?? 'chunk' });
    // Ask the server at once. The reload follows only after a good answer.
    void probeNow();
  };

  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    start() {
      users += 1;
      if (users > 1) return;
      removeListeners = installChunkListeners(chunkFailed);
      void probeNow().finally(schedule);
    },
    stop() {
      users = Math.max(0, users - 1);
      if (users > 0) return;
      if (timer !== undefined) deps.clearTimer(timer);
      timer = undefined;
      removeListeners?.();
      removeListeners = undefined;
    },
    probeNow,
    chunkFailed,
  };
}

/** Catches a script or style file that fails to load, a failed dynamic import and Vite's preload error. */
export function installChunkListeners(onFailure: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onError = (e: Event) => {
    const t = e.target as (HTMLElement & { src?: string; href?: string }) | null;
    if (t && t !== (window as unknown) && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
      if (isAppAssetUrl(String(t.src ?? t.href ?? ''))) onFailure();
      return;
    }
    if (isChunkErrorMessage((e as ErrorEvent).message)) onFailure();
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    if (isChunkErrorMessage(e.reason)) onFailure();
  };
  const onPreload = () => onFailure();
  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('vite:preloadError', onPreload);
  return () => {
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('vite:preloadError', onPreload);
  };
}

/** The connection of this page, created on first use. */
let shared: Connection | undefined;
export function getConnection(): Connection {
  if (!shared) {
    shared = createConnection({
      fetchImpl: (url, init) => fetch(url, init),
      now: Date.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: id => clearTimeout(id as ReturnType<typeof setTimeout>),
      reload: () => window.location.reload(),
      storage: (() => {
        try {
          return window.sessionStorage;
        } catch {
          return undefined;
        }
      })(),
      isKiosk: () => new URLSearchParams(window.location.search).get('kiosk') === '1',
      baseUrl: () => {
        const b = (window as unknown as { headlampBaseUrl?: string }).headlampBaseUrl ?? '';
        return b === '/' ? '' : b.replace(/\/$/, '');
      },
      pageAssets: () =>
        [...document.querySelectorAll('script[src]')]
          .map(s => new URL((s as HTMLScriptElement).src, window.location.href).pathname)
          .filter(p => p.includes('/assets/'))
          .sort(),
      pluginName: 'dashboards',
      random: Math.random,
    });
  }
  return shared;
}
