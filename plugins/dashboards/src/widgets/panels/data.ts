/* Fetching from the agent layer through the Kubernetes API service proxy. */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { AgentSettings, agentUrl, mayFetch, PanelInfo, PanelModel, parsePanel, parsePanelList } from './model';

export const listUrl = (s: AgentSettings): string => agentUrl(s, '/api/widgets');
export const panelUrl = (s: AgentSettings, id: string): string => agentUrl(s, `/api/widgets/${encodeURIComponent(id)}`);

/** A short, safe reason for a failed request. */
export function reason(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return m.trim() === '' ? 'The agent did not answer.' : m.slice(0, 200);
}

const CACHE_MS = 60_000;
const lists = new Map<string, { at: number; promise: Promise<PanelInfo[]> }>();

/** The panel list. One request per minute per agent, shared by every widget and the settings form. */
export function fetchPanelList(s: AgentSettings): Promise<PanelInfo[]> {
  const url = listUrl(s);
  const hit = lists.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = ApiProxy.request(url).then(parsePanelList);
  lists.set(url, { at: Date.now(), promise });
  // A failed request is not kept, so the next call tries again.
  promise.catch(() => {
    if (lists.get(url)?.promise === promise) lists.delete(url);
  });
  return promise;
}

export function clearPanelListCache(): void {
  lists.clear();
}

export interface PanelListState {
  loading: boolean;
  error: string | null;
  panels: PanelInfo[];
}

export function usePanelList(s: AgentSettings): PanelListState {
  const [state, setState] = React.useState<{ key: string; error: string | null; panels: PanelInfo[] } | null>(null);
  const key = listUrl(s);
  React.useEffect(() => {
    let live = true;
    fetchPanelList(s).then(
      panels => live && setState({ key, error: null, panels }),
      e => live && setState({ key, error: reason(e), panels: [] })
    );
    return () => {
      live = false;
    };
    // `s` is rebuilt only when its fields change (see useAgentSettings), and `key` covers them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
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
export function usePanel(s: AgentSettings, id: string, refreshSignal: number, minSeconds: number, reportRefreshed: (at?: number) => void): PanelState {
  const url = id ? panelUrl(s, id) : '';
  const [state, setState] = React.useState<{ url: string; panel: PanelModel | null; error: string | null } | null>(null);
  const last = React.useRef<{ url: string; at: number } | null>(null);
  const minRef = React.useRef(minSeconds);
  minRef.current = minSeconds;
  React.useEffect(() => {
    if (!url) return undefined;
    const now = Date.now();
    const sameUrl = last.current?.url === url;
    if (sameUrl && !mayFetch(last.current ? last.current.at : null, now, minRef.current)) return undefined;
    let live = true;
    ApiProxy.request(url).then(
      json => {
        if (!live) return;
        try {
          setState({ url, panel: parsePanel(json), error: null });
          // Only a finished fetch starts the minimum wait, so a cancelled run does not block the next.
          last.current = { url, at: Date.now() };
          reportRefreshed(Date.now());
        } catch (e) {
          setState(prev => ({ url, panel: prev?.url === url ? prev.panel : null, error: reason(e) }));
        }
      },
      e => live && setState(prev => ({ url, panel: prev?.url === url ? prev.panel : null, error: reason(e) }))
    );
    return () => {
      live = false;
    };
  }, [url, refreshSignal, reportRefreshed]);
  const current = state?.url === url ? state : null;
  return { loading: url !== '' && current === null, error: current?.error ?? null, panel: current?.panel ?? null };
}
