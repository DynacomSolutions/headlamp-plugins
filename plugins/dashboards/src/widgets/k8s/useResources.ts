/*
 * Live data for the report: one Headlamp stream per namespace (or one for the cluster). A stream
 * lists, then watches, and calls back with the whole list. Updates are coalesced, so a burst of
 * events renders once. The streams restart only when the source, the namespaces or the label
 * selector changes, or when a refresh arrives after a stream error. A live stream already holds
 * current data, so a refresh tick on a healthy stream only reports the time. A layout drag changes
 * none of these.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import type { DashboardFilters } from '../../contract';
import { backoffDelay } from '../../resilience/backoff';
import type { SourceRef } from './config';
import { listPath } from './discovery';
import { redactSecrets } from './fields';
import { isDnsLabel, isSafeSource } from './names';

export interface ResourceState {
  items: any[];
  loading: boolean;
  error: string | null;
  /** Epoch ms of the last good list, set only while a stream fails and the old rows stay. */
  staleSince?: number;
}

const PUBLISH_DELAY_MS = 250;

export function useResources(
  source: SourceRef,
  filters: DashboardFilters,
  refreshSignal: number,
  reportRefreshed: (at?: number) => void
): ResourceState {
  const [state, setState] = React.useState<ResourceState>({
    items: [],
    loading: true,
    error: null,
  });
  // Primitive keys keep the effect from running again when only an object identity changes.
  const nsKey = filters.namespaces.join('\u0000');
  const selector = filters.labelSelector;
  const { group, version, plural, namespaced, kind } = source;
  // `stream` tells the refresh effect what to do: report, restart or wait.
  const stream = React.useRef<'loading' | 'ok' | 'failed'>('loading');
  const [restart, setRestart] = React.useState(0);
  // The last good rows and their time, kept across a restart: a failed restart shows them, not an empty table.
  const lastGood = React.useRef<{ key: string; items: any[]; at: number } | null>(null);
  const failures = React.useRef(0);
  const lastSignal = React.useRef(refreshSignal);

  // A refresh tick keeps a healthy stream. After an error it restarts the streams.
  React.useEffect(() => {
    if (lastSignal.current === refreshSignal) return;
    lastSignal.current = refreshSignal;
    if (stream.current === 'failed') setRestart(n => n + 1);
    else if (stream.current === 'ok') reportRefreshed();
  }, [refreshSignal, reportRefreshed]);

  React.useEffect(() => {
    const src = { group, version, plural, namespaced, kind } as SourceRef;
    stream.current = 'loading';
    // The names go into API paths. A name that is not valid is never requested.
    if (!isSafeSource(src)) {
      setState({ items: [], loading: false, error: `The source ${plural} is not allowed.` });
      return undefined;
    }
    const wanted = nsKey === '' ? [] : nsKey.split('\u0000');
    const valid = wanted.filter(isDnsLabel);
    if (namespaced && wanted.length > 0 && valid.length === 0) {
      setState({ items: [], loading: false, error: 'The namespace filter has no valid name.' });
      return undefined;
    }
    const namespaces = namespaced && valid.length > 0 ? valid : [''];
    const sourceKey = `${group}/${version}/${plural}|${nsKey}|${selector}`;
    const lists = new Map<string, any[]>();
    const errors = new Map<string, string>();
    const cancels: Array<() => void> = [];
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loaded = 0;

    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      timer = undefined;
      if (cancelled) return;
      const error = errors.size > 0 ? [...new Set(errors.values())].join(' ') : null;
      const fresh = namespaces.flatMap(ns => lists.get(ns) ?? []).map(o => redactSecrets(o, kind));
      const good = lastGood.current?.key === sourceKey ? lastGood.current : null;
      if (error === null && loaded > 0)
        lastGood.current = { key: sourceKey, items: fresh, at: Date.now() };
      // A failed restart has nothing new: it keeps the last good rows, not an empty table.
      const keep = error !== null && loaded === 0 && good !== null;
      setState({
        items: keep ? good.items : fresh,
        loading: loaded < namespaces.length && errors.size === 0,
        error,
        // The rows on screen are old, and the card says since when.
        staleSince: error !== null && good !== null && (keep || loaded > 0) ? good.at : undefined,
      });
      if (loaded > 0) reportRefreshed();
      if (error !== null) {
        // Try the streams again: 2 s, 4 s, 8 s and so on up to 60 s.
        failures.current += 1;
        if (!retryTimer)
          retryTimer = setTimeout(
            () => setRestart(n => n + 1),
            backoffDelay(failures.current, 2_000, 60_000, 0.2)
          );
      } else if (loaded > 0 && error === null) {
        failures.current = 0;
      }
    };
    const markStream = () => {
      stream.current = errors.size > 0 ? 'failed' : loaded > 0 ? 'ok' : 'loading';
    };
    const schedule = (immediately: boolean) => {
      if (immediately) {
        if (timer) clearTimeout(timer);
        publish();
      } else if (!timer) {
        timer = setTimeout(publish, PUBLISH_DELAY_MS);
      }
    };

    // Keep the old rows on screen while a refresh loads, but show the loading state.
    setState(s => ({ ...s, loading: true, error: null, staleSince: undefined }));

    for (const ns of namespaces) {
      const url = listPath(src, ns);
      const query = selector.trim() !== '' ? { labelSelector: selector.trim() } : undefined;
      Promise.resolve(
        ApiProxy.streamResults(
          url,
          (items: any) => {
            if (cancelled) return;
            const first = !lists.has(ns);
            // The stream reuses its item objects, so copy the array to make a new identity.
            lists.set(ns, [...items]);
            errors.delete(ns);
            if (first) loaded += 1;
            markStream();
            schedule(first);
          },
          (err: Error & { status?: number }) => {
            if (cancelled) return;
            const message =
              err?.status === 403
                ? `You may not list ${plural}${ns ? ` in ${ns}` : ''}.`
                : err?.status === 404
                ? `The API for ${plural} was not found.`
                : `Could not load ${plural}${ns ? ` in ${ns}` : ''}: ${
                    err?.message ?? 'unknown error'
                  }`;
            errors.set(ns, message);
            if (!lists.has(ns)) lists.set(ns, []);
            markStream();
            schedule(true);
          },
          query
        )
      ).then(
        cancel => {
          if (cancelled) cancel();
          else cancels.push(cancel);
        },
        () => undefined
      );
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
      cancels.forEach(c => c());
    };
  }, [group, version, plural, namespaced, kind, nsKey, selector, restart, reportRefreshed]);

  return state;
}
