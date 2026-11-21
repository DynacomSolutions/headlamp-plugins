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
import { isOldData } from '../../cache/lastGood';
import type { DashboardFilters, WidgetCache } from '../../contract';
import { backoffDelay } from '../../resilience/backoff';
import type { SourceRef } from './config';
import { listPath } from './discovery';
import { redactSecrets } from './fields';
import { isDnsLabel, isSafeSource } from './names';

export interface ResourceState {
  items: any[];
  loading: boolean;
  error: string | null;
  /**
   * Epoch ms of the last good list, set while a stream fails and the old rows stay, and while the
   * rows on screen are cached and older than the stale limit.
   */
  staleSince?: number;
  /** True while the rows on screen come from the browser cache and no live list has arrived. */
  cached?: boolean;
  /** The time of the cached rows, while `cached` is true. */
  cachedAt?: number;
}

const PUBLISH_DELAY_MS = 250;
/** A live stream changes often. The cache keeps the list at most this often. */
const CACHE_WRITE_EVERY_MS = 10_000;

interface CachedList {
  key: string;
  items: any[];
}

export function useResources(
  source: SourceRef,
  filters: DashboardFilters,
  refreshSignal: number,
  reportRefreshed: (at?: number) => void,
  /** The browser cache of the widget: the first render shows the last good list at once. */
  cache?: WidgetCache
): ResourceState {
  // Primitive keys keep the effect from running again when only an object identity changes.
  const nsKey = filters.namespaces.join('\u0000');
  const selector = filters.labelSelector;
  const { group, version, plural, namespaced, kind } = source;
  const [state, setState] = React.useState<ResourceState>(() => {
    try {
      const hit = cache?.read<CachedList>();
      const key = `${group}/${version}/${plural}|${nsKey}|${selector}`;
      if (hit && hit.value?.key === key && Array.isArray(hit.value.items)) {
        return {
          items: hit.value.items,
          loading: false,
          error: null,
          cached: true,
          cachedAt: hit.at,
          staleSince: isOldData(hit.at) ? hit.at : undefined,
        };
      }
    } catch {
      // A value that cannot be read is no value.
    }
    return { items: [], loading: true, error: null };
  });
  const lastWrite = React.useRef(0);
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
      setState(prev => {
        // Rows from the browser cache stay until a live list arrives. A failure marks them as old.
        const onCache = prev.cached === true && loaded === 0;
        return {
          items: keep ? good.items : onCache ? prev.items : fresh,
          loading: loaded < namespaces.length && errors.size === 0,
          error,
          // The rows on screen are old, and the card says since when.
          staleSince:
            error !== null && good !== null && (keep || loaded > 0)
              ? good.at
              : onCache
              ? error !== null
                ? prev.cachedAt
                : prev.staleSince
              : undefined,
          cached: onCache ? true : undefined,
          cachedAt: onCache ? prev.cachedAt : undefined,
        };
      });
      if (
        error === null &&
        loaded === namespaces.length &&
        Date.now() - lastWrite.current > CACHE_WRITE_EVERY_MS
      ) {
        lastWrite.current = Date.now();
        cache?.write({ key: sourceKey, items: fresh } satisfies CachedList);
      }
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
    setState(s => ({
      ...s,
      loading: !s.cached,
      error: null,
      staleSince: s.cached ? s.staleSince : undefined,
    }));

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
