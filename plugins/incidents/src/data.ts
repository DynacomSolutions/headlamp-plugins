import { ApiProxy, ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import {
  backendUrl,
  CONFIG_KEY,
  DiagnosisDetail,
  DiagnosisSummary,
  isActive,
  parseDetail,
  parseList,
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
}

/** Polls a service-proxy path; `intervalMs` may depend on the last data (0 stops polling). */
function usePolled<T>(
  url: string,
  parse: (json: unknown) => T,
  intervalMs: (data: T | null) => number
): Polled<T> {
  const [state, setState] = React.useState<Polled<T>>({ data: null, loading: true, error: null });
  const dataRef = React.useRef<T | null>(null);
  React.useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    dataRef.current = null;
    setState({ data: null, loading: true, error: null });
    const load = async () => {
      try {
        const data = parse(await ApiProxy.request(url));
        dataRef.current = data;
        if (alive) setState({ data, loading: false, error: null });
      } catch (e: any) {
        if (alive) setState(s => ({ ...s, loading: false, error: String(e?.message || e) }));
      }
      const wait = intervalMs(dataRef.current);
      if (alive && wait > 0) timer = setTimeout(load, wait);
    };
    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return state;
}

export function useDiagnoses(s: Settings): Polled<DiagnosisSummary[]> {
  return usePolled(backendUrl(s, '/api/diagnoses?limit=100'), parseList, () => 15000);
}

export function useDiagnosis(s: Settings, id: string): Polled<DiagnosisDetail> {
  return usePolled(backendUrl(s, `/api/diagnoses/${encodeURIComponent(id)}`), parseDetail, d =>
    !d || isActive(d.status) ? 5000 : 0
  );
}
