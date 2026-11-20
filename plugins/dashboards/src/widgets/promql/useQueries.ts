/*
 * Run PromQL queries for a widget. It fetches when a filter, the queries, the endpoint or the
 * refresh signal changes, and at no other time: a resize or a layout drag never fetches. The
 * chart width is read from a ref at fetch time to choose the step. The in-flight request is
 * aborted when anything changes and on unmount, and the previous result stays on screen
 * (dimmed by `loading`) until the new one arrives.
 */
import React from 'react';
import type { DashboardFilters } from '../../contract';
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
  const { mode, queries, filters, enabled = true, refreshSignal, reportRefreshed, widthRef } = args;
  const endpoint = useMetricsEndpoint();
  const queriesKey = JSON.stringify(queries);
  const [state, setState] = React.useState<QueriesState>(EMPTY);

  React.useEffect(() => {
    const texts: string[] = JSON.parse(queriesKey);
    if (!enabled) return undefined;
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
        setState({
          results,
          error: undefined,
          loading: false,
          step: mode === 'range' ? win.step : undefined,
          start: mode === 'range' ? win.start : undefined,
          end: mode === 'range' ? win.end : undefined,
        });
        reportRefreshed(now);
      },
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ ...EMPTY, error: e instanceof Error ? e.message : String(e) });
      }
    );
    return () => ctrl.abort();
    // `widthRef` is a ref, and `filters` is a new object only when a filter changes.
  }, [mode, queriesKey, filters, enabled, refreshSignal, reportRefreshed, endpoint, widthRef]);

  return state;
}
