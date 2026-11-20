/* Namespace names from the cluster, as a React hook. The pure naming rules live in names.ts. */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { namespaceDataName } from './names';

type NsItem = { metadata?: Parameters<typeof namespaceDataName>[0] & { name?: string } };

/**
 * Namespace names from the cluster's own data (Namespace labels and annotations, read once, read
 * only). A failed read leaves the map empty and the humaniser in charge.
 */
export function useNamespaceNames(): ReadonlyMap<string, string> {
  const [map, setMap] = React.useState<ReadonlyMap<string, string>>(new Map());
  React.useEffect(() => {
    let live = true;
    Promise.resolve(ApiProxy.request('/api/v1/namespaces'))
      .then(res => {
        const out = new Map<string, string>();
        for (const it of (res as { items?: NsItem[] }).items ?? []) {
          const id = it.metadata?.name;
          const name = it.metadata ? namespaceDataName(it.metadata) : undefined;
          if (id && name) out.set(id, name);
        }
        if (live) setMap(out);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return map;
}
