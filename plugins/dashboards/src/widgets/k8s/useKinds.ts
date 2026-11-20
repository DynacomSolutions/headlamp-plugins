/* Loads the list of listable kinds from API discovery, once per page load, and shares it. */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { fetchKinds, KindEntry } from './discovery';

let cached: Promise<KindEntry[]> | null = null;

export function loadKinds(): Promise<KindEntry[]> {
  if (!cached) {
    cached = fetchKinds(path => ApiProxy.request(path)).catch(err => {
      cached = null; // try again next time
      throw err;
    });
  }
  return cached;
}

export function useKinds(): { kinds: KindEntry[]; loading: boolean; error: string | null } {
  const [state, setState] = React.useState<{ kinds: KindEntry[]; loading: boolean; error: string | null }>({ kinds: [], loading: true, error: null });
  React.useEffect(() => {
    let live = true;
    loadKinds().then(
      kinds => live && setState({ kinds, loading: false, error: null }),
      (e: Error) => live && setState({ kinds: [], loading: false, error: e?.message ?? 'Could not load the kinds.' })
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}
