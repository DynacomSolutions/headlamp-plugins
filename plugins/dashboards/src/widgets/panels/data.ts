/*
 * Fetching from a panel source: the Kubernetes API service proxy for a `service` source and
 * `fetch` with the browser cookies for a `url` source. Requests are shared per address, so ten
 * widgets on one source cause one list call and one call per panel, not ten.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { isOldData } from '../../cache/lastGood';
import type { WidgetCache } from '../../contract';
import { backoffDelay } from '../../resilience/backoff';
import { mayFetch, PanelInfo, PanelModel, parsePanel, parsePanelList } from './model';
import { listUrl, PanelSource, panelUrl, sourceKey } from './sources';

/** A failure with a message that is safe and clear enough to show on a card. */
export class SourceError extends Error {}

/** A short, safe reason for a failed request. */
export function reason(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return m.trim() === '' ? 'The source did not answer.' : m.slice(0, 240);
}

/** The message for an HTTP status. A service source uses RBAC, a URL source uses the app login. */
export function statusMessage(status: number, kind: PanelSource['kind']): string {
  if (status === 403) {
    return kind === 'service'
      ? 'Access denied (403). Your Kubernetes permissions do not allow the service proxy for this service.'
      : 'Access denied (403). The app refused the request. Sign in to the app in this browser, then try again.';
  }
  if (status === 401)
    return 'Not signed in (401). Sign in to the app in this browser, then try again.';
  if (status === 404)
    return 'Not found (404). The source does not serve the panel API at this address. Check the source settings.';
  return `The source answered with HTTP ${status}.`;
}

const statusOf = (e: unknown): number | undefined => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};

/** How long a request may run before it fails with a clear message. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Runs a request with a timeout. The signal aborts the request, and the race makes sure the
 * answer ends on time even when the call does not honour the signal.
 */
export function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number = REQUEST_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SourceError(`The source did not answer within ${Math.round(ms / 1000)} s.`));
    }, ms);
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

/**
 * `cluster` is only set on the settings page, whose URL has no /c/<cluster> part. There a plain request
 * would reach Headlamp's own web page, so the request names the cluster.
 */
async function requestJson(source: PanelSource, url: string, cluster?: string): Promise<unknown> {
  return withTimeout(signal => requestJsonOnce(source, url, signal, cluster));
}

async function requestJsonOnce(
  source: PanelSource,
  url: string,
  signal: AbortSignal,
  cluster?: string
): Promise<unknown> {
  if (source.kind === 'service') {
    try {
      return await (cluster
        ? ApiProxy.clusterRequest(url, { cluster, signal })
        : ApiProxy.request(url, { signal }));
    } catch (e) {
      const status = statusOf(e);
      throw new SourceError(
        status !== undefined && status >= 400 ? statusMessage(status, 'service') : reason(e)
      );
    }
  }
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch {
    // The browser hides the real cause. A blocked cross-origin call is the usual one.
    throw new SourceError(
      'The browser could not reach the source. The app must allow this origin with credentials (CORS), and the address must be correct.'
    );
  }
  if (!res.ok) throw new SourceError(statusMessage(res.status, 'url'));
  try {
    return await res.json();
  } catch {
    throw new SourceError(
      'The source did not send JSON. Check that the address serves the panel API.'
    );
  }
}

// ---------- the shared cache ----------

interface Entry {
  at: number;
  promise: Promise<unknown>;
  pending: boolean;
}
const entries = new Map<string, Entry>();

/** A request that is still pending after this long is not shared any more: the next call starts a new one. */
export const PENDING_MAX_AGE_MS = 2 * REQUEST_TIMEOUT_MS;

/**
 * One request per key. A request that is still running is shared, for at most `PENDING_MAX_AGE_MS`.
 * A finished answer is reused while it is younger than `ttlMs`. A failed request is not kept, so the
 * next call tries again.
 */
export function shared<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  now: () => number = Date.now
): Promise<T> {
  const hit = entries.get(key);
  if (hit && now() - hit.at < (hit.pending ? PENDING_MAX_AGE_MS : ttlMs))
    return hit.promise as Promise<T>;
  const entry: Entry = {
    at: now(),
    pending: true,
    promise: undefined as unknown as Promise<unknown>,
  };
  entry.promise = load().then(
    v => {
      entry.pending = false;
      return v;
    },
    e => {
      entry.pending = false;
      if (entries.get(key) === entry) entries.delete(key);
      throw e;
    }
  );
  entries.set(key, entry);
  return entry.promise as Promise<T>;
}

export function clearPanelListCache(): void {
  entries.clear();
}

const LIST_TTL_MS = 60_000;

/** The panel list. One request per minute per source, shared by every widget and the settings form. */
export function fetchPanelList(source: PanelSource): Promise<PanelInfo[]> {
  return shared(`list ${listUrl(source)}`, LIST_TTL_MS, async () =>
    parsePanelList(await requestJson(source, listUrl(source)))
  );
}

/**
 * The answer of the source that each parsed panel came from. The browser cache keeps this raw JSON,
 * and parses it again on the next load, so a new plugin version never reads an old parsed shape.
 */
const rawOf = new WeakMap<PanelModel, unknown>();

/** One panel. A request is shared while it runs, and an answer is reused for `ttlSeconds` (the panel's `refreshSeconds`). */
export function fetchPanel(
  source: PanelSource,
  id: string,
  ttlSeconds: number
): Promise<PanelModel> {
  const url = panelUrl(source, id);
  return shared(`panel ${url}`, Math.max(0, ttlSeconds) * 1000, async () => {
    const raw = await requestJson(source, url);
    const panel = parsePanel(raw);
    rawOf.set(panel, raw);
    return panel;
  });
}

/** What a widget keeps in the browser cache for a panel: the address, so another panel never shows. */
interface CachedPanel {
  url: string;
  raw: unknown;
}

/** The cached panel for `url`, parsed again, or undefined. A value that does not parse is no value. */
export function panelFromCache(
  cache: WidgetCache | undefined,
  url: string
): { panel: PanelModel; at: number } | undefined {
  if (!cache || url === '') return undefined;
  try {
    const hit = cache.read<CachedPanel>();
    if (!hit || hit.value?.url !== url) return undefined;
    return { panel: parsePanel(hit.value.raw), at: hit.at };
  } catch {
    return undefined;
  }
}

/** The Test button: asks the source for its list without the cache, and gives the panel count. Throws a clear message. */
export async function testSource(source: PanelSource, cluster?: string): Promise<number> {
  const url = listUrl(source);
  entries.delete(`list ${url}`);
  return parsePanelList(await requestJson(source, url, cluster)).length;
}

const missing = (id: string): string =>
  `The source "${id}" is not configured. Choose another source in the widget settings, or add it on the Dashboards settings page. A cluster source needs read access to the ConfigMap dashboard-sources in the dashboards namespace.`;

export interface PanelListState {
  loading: boolean;
  error: string | null;
  panels: PanelInfo[];
}

/**
 * The panel list of a source. With `enabled` false it waits: a widget needs the list only for the
 * `refreshSeconds` of its panel, so it asks after its panel answered and the first requests of a
 * load go to the panels.
 */
export function usePanelList(
  source: PanelSource | undefined,
  sourceId = '',
  enabled = true
): PanelListState {
  const [state, setState] = React.useState<{
    key: string;
    error: string | null;
    panels: PanelInfo[];
  } | null>(null);
  const key = source ? sourceKey(source) : '';
  React.useEffect(() => {
    if (!source || !enabled) return undefined;
    let live = true;
    fetchPanelList(source).then(
      panels => live && setState({ key, error: null, panels }),
      e => live && setState({ key, error: reason(e), panels: [] })
    );
    return () => {
      live = false;
    };
    // `key` covers every field of the source that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  if (!source) return { loading: false, error: missing(sourceId), panels: [] };
  const current = state?.key === key ? state : null;
  return {
    loading: current === null,
    error: current?.error ?? null,
    panels: current?.panels ?? [],
  };
}

/** True once the panel has a fresh answer or a failure, so the widget can ask for its panel list. */
export const panelSettled = (s: PanelState): boolean =>
  (s.panel !== null && !s.cached) || s.error !== null;

/**
 * A flag for `usePanelList`'s `enabled`: false until `settle()` is called with a settled panel
 * state, then true for good. The list hook runs before the panel hook (the panel needs the list's
 * `refreshSeconds`), so the widget feeds the flag from an effect after the panel state is known.
 */
export function useListGate(): [boolean, (state: PanelState) => void] {
  const [open, setOpen] = React.useState(false);
  const settle = React.useCallback((state: PanelState) => {
    if (panelSettled(state)) setOpen(true);
  }, []);
  return [open, settle];
}

export interface PanelState {
  loading: boolean;
  error: string | null;
  panel: PanelModel | null;
  /**
   * Epoch ms of the last good answer. Set while a refresh fails and the old panel stays on screen,
   * and while the panel on screen is cached data older than the stale limit with no fresh answer yet.
   */
  staleSince?: number;
  /** True while the panel on screen comes from the browser cache and no fresh answer has come. */
  cached?: boolean;
}

/** The first retry after a failed fetch, and the longest wait between retries. */
export const RETRY_BASE_MS = 2_000;
export const RETRY_CAP_MS = 60_000;

/**
 * Fetches one panel when its address or the dashboard's refresh signal changes. A refresh signal
 * that comes sooner than `minSeconds` after the last fetch is ignored. The last good panel stays
 * on screen while a refresh runs and when a refresh fails. A failed fetch tries again by itself,
 * after 2 s, 4 s, 8 s and so on up to 60 s, so a widget recovers after an outage even when the
 * dashboard has no automatic refresh.
 *
 * With a `cache` (see `WidgetProps.cache`), the first render shows the last good panel of this
 * widget at once, `loading` is false, and the fetch runs in the background. A fresh answer replaces
 * it and is written to the cache. The widget frame tells the header the time of the cached data.
 */
export function usePanel(
  source: PanelSource | undefined,
  id: string,
  refreshSignal: number,
  minSeconds: number,
  reportRefreshed: (at?: number) => void,
  sourceId = '',
  cache?: WidgetCache
): PanelState {
  const url = source && id ? panelUrl(source, id) : '';
  const [state, setState] = React.useState<{
    url: string;
    panel: PanelModel | null;
    error: string | null;
    okAt: number;
    cached: boolean;
  } | null>(() => {
    const hit = panelFromCache(cache, url);
    return hit ? { url, panel: hit.panel, error: null, okAt: hit.at, cached: true } : null;
  });
  const last = React.useRef<{ url: string; at: number } | null>(null);
  const minRef = React.useRef(minSeconds);
  minRef.current = minSeconds;
  const [retry, setRetry] = React.useState(0);
  const failures = React.useRef(0);
  const retryTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(retryTimer.current), []);
  React.useEffect(() => {
    if (!url || !source) return undefined;
    clearTimeout(retryTimer.current);
    const now = Date.now();
    const sameUrl = last.current?.url === url;
    if (sameUrl && !mayFetch(last.current ? last.current.at : null, now, minRef.current))
      return undefined;
    let live = true;
    fetchPanel(source, id, minRef.current).then(
      panel => {
        if (!live) return;
        failures.current = 0;
        const at = Date.now();
        setState({ url, panel, error: null, okAt: at, cached: false });
        // Only a finished fetch starts the minimum wait, so a cancelled run does not block the next.
        last.current = { url, at };
        cache?.write({ url, raw: rawOf.get(panel) } satisfies CachedPanel, at);
        reportRefreshed(at);
      },
      e => {
        if (!live) return;
        setState(prev => ({
          url,
          panel: prev?.url === url ? prev.panel : null,
          error: reason(e),
          okAt: prev?.url === url ? prev.okAt : 0,
          cached: prev?.url === url ? prev.cached : false,
        }));
        failures.current += 1;
        retryTimer.current = setTimeout(
          () => setRetry(n => n + 1),
          backoffDelay(failures.current, RETRY_BASE_MS, RETRY_CAP_MS, 0.2)
        );
      }
    );
    return () => {
      live = false;
    };
    // `source` is covered by `url`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, refreshSignal, reportRefreshed, retry]);
  if (!source && id) return { loading: false, error: missing(sourceId), panel: null };
  const current = state?.url === url ? state : null;
  const failed = !!(current?.error && current.panel && current.okAt);
  const old = !!(current?.cached && current.okAt && isOldData(current.okAt));
  return {
    loading: url !== '' && current === null,
    error: current?.error ?? null,
    panel: current?.panel ?? null,
    staleSince: failed || old ? current?.okAt : undefined,
    cached: current?.cached || undefined,
  };
}
