/*
 * Live data for the report: one Headlamp stream per namespace (or one for the cluster). A stream
 * lists, then watches, and calls back with the whole list. Updates are coalesced, so a burst of
 * events renders once. The streams restart only when the source, the namespaces, the label
 * selector or the refresh signal changes. A layout drag changes none of these.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import type { DashboardFilters } from '../../contract';
import type { SourceRef } from './config';
import { listPath } from './discovery';

export interface ResourceState {
  items: any[];
  loading: boolean;
  error: string | null;
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
  const { group, version, plural, namespaced } = source;

  React.useEffect(() => {
    const src = { group, version, plural, namespaced, kind: '' } as SourceRef;
    const namespaces = namespaced && nsKey !== '' ? nsKey.split('\u0000') : [''];
    const lists = new Map<string, any[]>();
    const errors = new Map<string, string>();
    const cancels: Array<() => void> = [];
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loaded = 0;

    const publish = () => {
      timer = undefined;
      if (cancelled) return;
      const items = namespaces.flatMap(ns => lists.get(ns) ?? []);
      const error = errors.size > 0 ? [...new Set(errors.values())].join(' ') : null;
      setState({ items, loading: loaded < namespaces.length && errors.size === 0, error });
      if (loaded > 0) reportRefreshed();
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
    setState(s => ({ ...s, loading: true, error: null }));

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
      cancels.forEach(c => c());
    };
  }, [group, version, plural, namespaced, nsKey, selector, refreshSignal, reportRefreshed]);

  return state;
}
