import { ApiProxy, ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { cleanErrorText } from './chat-model';
import {
  backendUrl,
  CONFIG_KEY,
  DiagnosisDetail,
  DiagnosisSummary,
  isActive,
  parseDetail,
  parseList,
  parseTotal,
  resolveSettings,
  Settings,
} from './model';

export const configStore = new ConfigStore<Partial<Settings>>(CONFIG_KEY);

let defaultsPromise: Promise<Partial<Settings>> | null = null;

/** Deployment-supplied defaults: an optional defaults.json served next to main.js. */
function loadDefaults(): Promise<Partial<Settings>> {
  if (!defaultsPromise) {
    defaultsPromise = fetch(`/plugins/${CONFIG_KEY}/defaults.json`)
      .then(r => (r.ok ? r.json() : {}))
      .then(j => (j && typeof j === 'object' ? (j as Partial<Settings>) : {}))
      .catch(() => ({}));
  }
  return defaultsPromise;
}

export function useSettings(): Settings {
  const stored = configStore.useConfig()() as Partial<Settings> | undefined;
  const [defaults, setDefaults] = React.useState<Partial<Settings>>({});
  React.useEffect(() => {
    let alive = true;
    loadDefaults().then(d => alive && setDefaults(d));
    return () => {
      alive = false;
    };
  }, []);
  return React.useMemo(() => resolveSettings(stored, defaults), [stored, defaults]);
}

export interface Polled<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Fetches again now. Resolves when that fetch is over. A slower fetch that was already running is dropped. */
  refresh: () => Promise<void>;
}

/** Polls a service-proxy path; `intervalMs` may depend on the last data (0 stops polling). */
function usePolled<T>(
  url: string,
  fetchData: () => Promise<T>,
  intervalMs: (data: T | null) => number
): Polled<T> {
  const [state, setState] = React.useState<Omit<Polled<T>, 'refresh'>>({
    data: null,
    loading: true,
    error: null,
  });
  const dataRef = React.useRef<T | null>(null);
  const refreshRef = React.useRef<() => Promise<void>>(async () => {});
  React.useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each fetch has a number. Only the newest one may set the state or start the next timer.
    let latest = 0;
    dataRef.current = null;
    setState({ data: null, loading: true, error: null });
    const load = async () => {
      if (timer) clearTimeout(timer);
      const mine = ++latest;
      try {
        const data = await fetchData();
        if (mine !== latest) return;
        dataRef.current = data;
        if (alive) setState({ data, loading: false, error: null });
      } catch (e: any) {
        if (mine !== latest) return;
        if (alive) setState(s => ({ ...s, loading: false, error: String(e?.message || e) }));
      }
      const wait = intervalMs(dataRef.current);
      if (alive && wait > 0) timer = setTimeout(load, wait);
    };
    refreshRef.current = load;
    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  const refresh = React.useCallback(() => refreshRef.current(), []);
  return { ...state, refresh };
}

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

/**
 * Every diagnosis, read page by page, so the summary counts the real total and not the first page.
 * An agent that does not send `total` or ignore `offset` ends the loop as soon as a page is short
 * or holds nothing new.
 */
export async function fetchAllDiagnoses(settings: Settings): Promise<DiagnosisSummary[]> {
  const rows: DiagnosisSummary[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await ApiProxy.request(
      backendUrl(settings, `/api/diagnoses?limit=${PAGE_SIZE}&offset=${rows.length}`)
    );
    const batch = parseList(json);
    const fresh = batch.filter(d => !seen.has(d.id));
    fresh.forEach(d => seen.add(d.id));
    rows.push(...fresh);
    const total = parseTotal(json);
    const done =
      fresh.length === 0 || (total !== null ? rows.length >= total : batch.length < PAGE_SIZE);
    if (done) break;
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function useDiagnoses(s: Settings): Polled<DiagnosisSummary[]> {
  return usePolled(
    backendUrl(s, '/api/diagnoses'),
    () => fetchAllDiagnoses(s),
    () => 15000
  );
}

export function useDiagnosis(s: Settings, id: string): Polled<DiagnosisDetail> {
  const url = backendUrl(s, `/api/diagnoses/${encodeURIComponent(id)}`);
  return usePolled(
    url,
    async () => parseDetail(await ApiProxy.request(url)),
    d => (!d || isActive(d.status) ? 5000 : 0)
  );
}

/** The `error` field of a JSON error body, when the proxy passes the body on as the message. */
export function rerunErrorText(e: unknown): string {
  const text = cleanErrorText(e);
  try {
    const body = JSON.parse(text);
    if (body && typeof body.error === 'string' && body.error) return body.error;
  } catch {
    /* not JSON: the text is the message */
  }
  return text;
}

/**
 * Runs a failed diagnosis again. The agent answers 202 when it queued the run, 409 when the
 * diagnosis is not failed any more, 429 when the hourly limit is used.
 */
export async function rerunDiagnosis(s: Settings, id: string): Promise<void> {
  try {
    await ApiProxy.request(backendUrl(s, `/api/diagnoses/${encodeURIComponent(id)}/rerun`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch (e) {
    throw new Error(rerunErrorText(e));
  }
}
