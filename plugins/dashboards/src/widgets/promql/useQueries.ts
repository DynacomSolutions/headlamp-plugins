/*
 * Run PromQL queries for a widget. It fetches when a filter, the queries, the endpoint or the
 * refresh signal changes, and at no other time: a resize or a layout drag never fetches. The
 * chart width is read from a ref at fetch time to choose the step. The in-flight request is
 * aborted when anything changes and on unmount, and the previous result stays on screen
 * (dimmed by `loading`) until the new one arrives. When a fetch fails, the last good results stay,
 * `staleSince` says when they were fetched, and the fetch tries again after 2 s, 4 s, 8 s and so on
 * up to 60 s.
 */
import React from 'react';
import { isOldData } from '../../cache/lastGood';
import type { DashboardFilters, WidgetCache } from '../../contract';
import { backoffDelay } from '../../resilience/backoff';
import { useMetricsEndpoint } from './endpoint';
import { QueryResult, runInstant, runRange, windowFor } from './prom';

export type QueryMode = 'range' | 'instant';

export interface QueriesState {
  results: QueryResult[] | undefined;
  error: string | undefined;
  loading: boolean;
  /** The step of the last range fetch, in seconds. */
  step: number | undefined;
  /** The window of the last range fetch. */
  start: number | undefined;
  end: number | undefined;
  /**
   * Epoch ms of the last good results, set while a fetch fails and the old results stay, and while
   * the results on screen are cached and older than the stale limit.
   */
  staleSince?: number;
  /** True while the results on screen come from the browser cache and no fresh answer has come. */
  cached?: boolean;
}

export interface UseQueriesArgs {
  mode: QueryMode;
  /** The query texts, with template variables. Blank ones are not run. */
  queries: string[];
  filters: DashboardFilters;
  /** False until the widget has a size (a range query needs the width to choose its step). */
  enabled?: boolean;
  refreshSignal: number;
  reportRefreshed: (at?: number) => void;
  /** The chart width in pixels, read at fetch time. */
  widthRef: React.MutableRefObject<{ width: number; height: number }>;
  /** The browser cache of the widget: the first render shows the last good results at once. */
  cache?: WidgetCache;
}

/** What the widget keeps in the browser cache. `key` ties it to the queries and filters. */
interface CachedResults {
  key: string;
  results: QueryResult[];
  step?: number;
  start?: number;
  end?: number;
}

const cacheKey = (mode: QueryMode, queriesKey: string, filters: DashboardFilters): string =>
  `${mode}|${queriesKey}|${JSON.stringify(filters)}`;

/** The cached state for these queries, with the time of the results, or undefined. */
export function resultsFromCache(
  cache: WidgetCache | undefined,
  key: string
): { state: QueriesState; at: number } | undefined {
  try {
    const hit = cache?.read<CachedResults>();
    const v = hit?.value;
    if (!hit || !v || v.key !== key || !Array.isArray(v.results)) return undefined;
    return {
      at: hit.at,
      state: {
        ...EMPTY,
        results: v.results,
        step: v.step,
        start: v.start,
        end: v.end,
        cached: true,
        staleSince: isOldData(hit.at) ? hit.at : undefined,
      },
    };
  } catch {
    return undefined;
  }
}

const EMPTY: QueriesState = {
  results: undefined,
  error: undefined,
  loading: false,
  step: undefined,
  start: undefined,
  end: undefined,
};

export function useQueries(args: UseQueriesArgs): QueriesState {
  const {
    mode,
    queries,
    filters,
    enabled = true,
    refreshSignal,
    reportRefreshed,
    widthRef,
    cache,
  } = args;
  const endpoint = useMetricsEndpoint();
  const queriesKey = JSON.stringify(queries);
  const seed = React.useRef(resultsFromCache(cache, cacheKey(mode, queriesKey, filters)));
  const [state, setState] = React.useState<QueriesState>(seed.current?.state ?? EMPTY);
  const [retry, setRetry] = React.useState(0);
  const failures = React.useRef(0);
  const okAt = React.useRef(seed.current?.at ?? 0);
  const retryTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(retryTimer.current), []);

  React.useEffect(() => {
    const texts: string[] = JSON.parse(queriesKey);
    if (!enabled) return undefined;
    clearTimeout(retryTimer.current);
    if (texts.every(q => q.trim() === '')) {
      setState(EMPTY);
      return undefined;
    }
    const ctrl = new AbortController();
    const effective = filters;
    const now = Date.now();
    const win = windowFor(effective, widthRef.current.width, now);
    const opts = { endpoint, signal: ctrl.signal };
    setState(prev => ({ ...prev, loading: true, error: undefined }));
    Promise.all(
      texts.map(q =>
        q.trim() === ''
          ? Promise.resolve<QueryResult>({ resultType: 'vector', result: [] })
          : mode === 'range'
          ? runRange(q, effective, win, opts)
          : runInstant(q, effective, now, opts)
      )
    ).then(
      results => {
        if (ctrl.signal.aborted) return;
        failures.current = 0;
        okAt.current = Date.now();
        const step = mode === 'range' ? win.step : undefined;
        const start = mode === 'range' ? win.start : undefined;
        const end = mode === 'range' ? win.end : undefined;
        setState({ results, error: undefined, loading: false, step, start, end });
        cache?.write(
          {
            key: cacheKey(mode, queriesKey, effective),
            results,
            step,
            start,
            end,
          } satisfies CachedResults,
          okAt.current
        );
        reportRefreshed(now);
      },
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        // Keep the last good results on screen, and try again later.
        setState(prev => ({
          ...prev,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
          staleSince: prev.results && okAt.current ? okAt.current : undefined,
        }));
        failures.current += 1;
        retryTimer.current = setTimeout(
          () => setRetry(n => n + 1),
          backoffDelay(failures.current, 2_000, 60_000, 0.2)
        );
      }
    );
    return () => ctrl.abort();
    // `widthRef` is a ref, and `filters` is a new object only when a filter changes.
  }, [
    mode,
    queriesKey,
    filters,
    enabled,
    refreshSignal,
    reportRefreshed,
    endpoint,
    widthRef,
    retry,
  ]);

  return state;
}
