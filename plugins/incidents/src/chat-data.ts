import { ApiProxy, ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import {
  ChatDetail,
  ChatSummary,
  cleanErrorText,
  ModelList,
  parseChat,
  parseChats,
  parseModels,
} from './chat-model';
import { backendUrl, Settings } from './model';

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/* ---------- Calls ---------- */

export async function createChat(
  s: Settings,
  body: { model?: string; diagnosisId?: string }
): Promise<string> {
  const res = await ApiProxy.request(backendUrl(s, '/api/chats'), json('POST', body));
  const id = res && typeof res.id === 'string' ? res.id : '';
  if (!id) throw new Error('The agent did not return a chat id.');
  return id;
}

export async function sendMessage(
  s: Settings,
  chatId: string,
  text: string,
  model?: string
): Promise<void> {
  await ApiProxy.request(
    backendUrl(s, `/api/chats/${encodeURIComponent(chatId)}/messages`),
    json('POST', model ? { text, model } : { text })
  );
}

export async function cancelChat(s: Settings, chatId: string): Promise<void> {
  await ApiProxy.request(
    backendUrl(s, `/api/chats/${encodeURIComponent(chatId)}/cancel`),
    json('POST', {})
  );
}

export async function deleteChat(s: Settings, chatId: string): Promise<void> {
  await ApiProxy.request(backendUrl(s, `/api/chats/${encodeURIComponent(chatId)}`), json('DELETE'));
}

/* ---------- Hooks ---------- */

export interface Loaded<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Fetches again now and restarts the polling timer. */
  refresh: () => void;
}

/**
 * Polls a service-proxy path. `intervalMs` may depend on the last data (0 stops polling).
 * A change of `url` resets the state; `refresh()` does not.
 */
function useLoaded<T>(
  url: string,
  parse: (json: unknown) => T,
  intervalMs: (data: T | null) => number
): Loaded<T> {
  const [state, setState] = React.useState<Omit<Loaded<T>, 'refresh'>>({
    data: null,
    loading: true,
    error: null,
  });
  const [nonce, setNonce] = React.useState(0);
  const [seenUrl, setSeenUrl] = React.useState(url);
  if (seenUrl !== url) {
    setSeenUrl(url);
    setState({ data: null, loading: true, error: null });
  }
  const dataRef = React.useRef<T | null>(null);
  React.useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const data = parse(await ApiProxy.request(url));
        dataRef.current = data;
        if (alive) setState({ data, loading: false, error: null });
      } catch (e: any) {
        if (alive) setState(s => ({ ...s, loading: false, error: cleanErrorText(e) }));
      }
      const wait = intervalMs(dataRef.current);
      if (alive && wait > 0) timer = setTimeout(load, wait);
    };
    dataRef.current = null;
    if (!url) {
      setState({ data: null, loading: false, error: null });
      return undefined;
    }
    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, nonce]);
  const refresh = React.useCallback(() => setNonce(n => n + 1), []);
  return { ...state, refresh };
}

export function useModels(s: Settings): Loaded<ModelList> {
  return useLoaded(backendUrl(s, '/api/models'), parseModels, () => 0);
}

export function useChats(s: Settings): Loaded<ChatSummary[]> {
  return useLoaded(backendUrl(s, '/api/chats?limit=50'), parseChats, () => 5000);
}

/** One chat; polls every second while a turn runs. An empty id loads nothing. */
export function useChat(s: Settings, id: string | undefined): Loaded<ChatDetail> {
  const url = id ? backendUrl(s, `/api/chats/${encodeURIComponent(id)}`) : '';
  return useLoaded(url, parseChat, d => (d && d.running ? 1000 : 0));
}

/* ---------- Favourites ---------- */

export const favouritesStore = new ConfigStore<{ favourites?: string[] }>('incidents-chat');

export function useFavourites(): [string[], (id: string) => void] {
  const stored = favouritesStore.useConfig()() as { favourites?: string[] } | undefined;
  const favourites = React.useMemo(
    () =>
      Array.isArray(stored?.favourites)
        ? stored!.favourites!.filter(f => typeof f === 'string')
        : [],
    [stored]
  );
  const toggle = React.useCallback(
    (id: string) => {
      const next = favourites.includes(id) ? favourites.filter(f => f !== id) : [...favourites, id];
      favouritesStore.set({ favourites: next });
    },
    [favourites]
  );
  return [favourites, toggle];
}
