/*
 * Fetching from a panel source: the Kubernetes API service proxy for a `service` source and
 * `fetch` with the browser cookies for a `url` source. Requests are shared per address, so ten
 * widgets on one source cause one list call and one call per panel, not ten.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
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
  if (status === 401) return 'Not signed in (401). Sign in to the app in this browser, then try again.';
  if (status === 404) return 'Not found (404). The source does not serve the panel API at this address. Check the source settings.';
  return `The source answered with HTTP ${status}.`;
}

const statusOf = (e: unknown): number | undefined => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};

/**
 * `cluster` is only set on the settings page, whose URL has no /c/<cluster> part. There a plain request
 * would reach Headlamp's own web page, so the request names the cluster.
 */
async function requestJson(source: PanelSource, url: string, cluster?: string): Promise<unknown> {
  if (source.kind === 'service') {
    try {
      return await (cluster ? ApiProxy.clusterRequest(url, { cluster }) : ApiProxy.request(url));
    } catch (e) {
      const status = statusOf(e);
      throw new SourceError(status !== undefined && status >= 400 ? statusMessage(status, 'service') : reason(e));
    }
  }
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
  } catch {
    // The browser hides the real cause. A blocked cross-origin call is the usual one.
    throw new SourceError('The browser could not reach the source. The app must allow this origin with credentials (CORS), and the address must be correct.');
  }
  if (!res.ok) throw new SourceError(statusMessage(res.status, 'url'));
  try {
    return await res.json();
  } catch {
    throw new SourceError('The source did not send JSON. Check that the address serves the panel API.');
  }
}

// ---------- the shared cache ----------

interface Entry {
  at: number;
  promise: Promise<unknown>;
  pending: boolean;
}
const entries = new Map<string, Entry>();

/**
 * One request per key. A request that is still running is shared. A finished answer is reused while it is
 * younger than `ttlMs`. A failed request is not kept, so the next call tries again.
 */
export function shared<T>(key: string, ttlMs: number, load: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const hit = entries.get(key);
  if (hit && (hit.pending || now() - hit.at < ttlMs)) return hit.promise as Promise<T>;
  const entry: Entry = { at: now(), pending: true, promise: undefined as unknown as Promise<unknown> };
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
  return shared(`list ${listUrl(source)}`, LIST_TTL_MS, async () => parsePanelList(await requestJson(source, listUrl(source))));
}

/** One panel. A request is shared while it runs, and an answer is reused for `ttlSeconds` (the panel's `refreshSeconds`). */
export function fetchPanel(source: PanelSource, id: string, ttlSeconds: number): Promise<PanelModel> {
  const url = panelUrl(source, id);
  return shared(`panel ${url}`, Math.max(0, ttlSeconds) * 1000, async () => parsePanel(await requestJson(source, url)));
}

/** The Test button: asks the source for its list without the cache, and gives the panel count. Throws a clear message. */
export async function testSource(source: PanelSource, cluster?: string): Promise<number> {
  const url = listUrl(source);
  entries.delete(`list ${url}`);
  return parsePanelList(await requestJson(source, url, cluster)).length;
}

const missing = (id: string): string => `The source "${id}" is not configured. Choose another source in the widget settings, or add it on the Dashboards settings page.`;

export interface PanelListState {
  loading: boolean;
  error: string | null;
  panels: PanelInfo[];
}

export function usePanelList(source: PanelSource | undefined, sourceId = ''): PanelListState {
  const [state, setState] = React.useState<{ key: string; error: string | null; panels: PanelInfo[] } | null>(null);
  const key = source ? sourceKey(source) : '';
  React.useEffect(() => {
    if (!source) return undefined;
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
  }, [key]);
  if (!source) return { loading: false, error: missing(sourceId), panels: [] };
  const current = state?.key === key ? state : null;
  return { loading: current === null, error: current?.error ?? null, panels: current?.panels ?? [] };
}

export interface PanelState {
  loading: boolean;
  error: string | null;
  panel: PanelModel | null;
}

/**
 * Fetches one panel when its address or the dashboard's refresh signal changes. A refresh signal
 * that comes sooner than `minSeconds` after the last fetch is ignored. The last good panel stays
 * on screen while a refresh runs and when a refresh fails.
 */
export function usePanel(
  source: PanelSource | undefined,
  id: string,
  refreshSignal: number,
  minSeconds: number,
  reportRefreshed: (at?: number) => void,
  sourceId = ''
): PanelState {
  const url = source && id ? panelUrl(source, id) : '';
  const [state, setState] = React.useState<{ url: string; panel: PanelModel | null; error: string | null } | null>(null);
  const last = React.useRef<{ url: string; at: number } | null>(null);
  const minRef = React.useRef(minSeconds);
  minRef.current = minSeconds;
  React.useEffect(() => {
    if (!url || !source) return undefined;
    const now = Date.now();
    const sameUrl = last.current?.url === url;
    if (sameUrl && !mayFetch(last.current ? last.current.at : null, now, minRef.current)) return undefined;
    let live = true;
    fetchPanel(source, id, minRef.current).then(
      panel => {
        if (!live) return;
        setState({ url, panel, error: null });
        // Only a finished fetch starts the minimum wait, so a cancelled run does not block the next.
        last.current = { url, at: Date.now() };
        reportRefreshed(Date.now());
      },
      e => live && setState(prev => ({ url, panel: prev?.url === url ? prev.panel : null, error: reason(e) }))
    );
    return () => {
      live = false;
    };
    // `source` is covered by `url`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, refreshSignal, reportRefreshed]);
  if (!source && id) return { loading: false, error: missing(sourceId), panel: null };
  const current = state?.url === url ? state : null;
  return { loading: url !== '' && current === null, error: current?.error ?? null, panel: current?.panel ?? null };
}
