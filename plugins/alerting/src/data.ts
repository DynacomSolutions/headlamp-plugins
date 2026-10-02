import { ApiProxy, ConfigStore, K8s } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import {
  CONFIG_KEY,
  parseStatePayload,
  resolveEndpoint,
  resolveSettings,
  Settings,
  StatePayload,
  testRequestPatch,
} from './model';

export const configStore = new ConfigStore<Partial<Settings>>(CONFIG_KEY);

export function useSettings(): Settings {
  const stored = configStore.useConfig()() as Partial<Settings> | undefined;
  return React.useMemo(() => resolveSettings(stored), [stored]);
}

type Kind = 'NotificationChannel' | 'AlertRoute';

const PLURAL: Record<Kind, string> = {
  NotificationChannel: 'notificationchannels',
  AlertRoute: 'alertroutes',
};

/** Custom resource class for the configured group and version. */
export function useResourceClass(kind: Kind, s: Settings): any {
  return React.useMemo(
    () =>
      K8s.crd.makeCustomResourceClass({
        apiInfo: [{ group: s.group, version: s.version }],
        kind,
        pluralName: PLURAL[kind],
        singularName: kind.toLowerCase(),
        isNamespaced: true,
      }),
    [kind, s.group, s.version]
  );
}

export interface ListState {
  items: any[];
  loading: boolean;
  absent: boolean;
  error: string | null;
}

export function useResources(kind: Kind, s: Settings): ListState {
  const cls = useResourceClass(kind, s);
  const [items, err] = cls.useList({ namespace: s.namespace });
  const status = (err as any)?.status;
  return {
    items: (items || []).map((i: any) => i.jsonData),
    loading: items === null && !err,
    absent: status === 404,
    error: err && status !== 404 ? String((err as any).message || err) : null,
  };
}

/** Names of Secrets in the configured namespace (names only; values are never read). */
export function useSecretNames(s: Settings): string[] {
  const [items] = (K8s.ResourceClasses as any).Secret.useList({ namespace: s.namespace });
  return React.useMemo(
    () =>
      ((items || []) as any[])
        .map(i => i.metadata?.name as string)
        .filter(Boolean)
        .sort(),
    [items]
  );
}

/** Keys of one Secret in the configured namespace (key names only). */
export function useSecretKeys(s: Settings, name: string): string[] {
  const [keys, setKeys] = React.useState<string[]>([]);
  React.useEffect(() => {
    let alive = true;
    if (!name) {
      setKeys([]);
      return;
    }
    ApiProxy.request(`/api/v1/namespaces/${s.namespace}/secrets/${name}`)
      .then((r: any) => alive && setKeys(Object.keys(r?.data || {}).sort()))
      .catch(() => alive && setKeys([]));
    return () => {
      alive = false;
    };
  }, [s.namespace, name]);
  return keys;
}

const collectionPath = (s: Settings, kind: Kind) =>
  `/apis/${s.group}/${s.version}/namespaces/${s.namespace}/${PLURAL[kind]}`;

/** Ephemeral test-send request; always applied live, never part of the Git-managed config. */
export function requestTestSend(s: Settings, name: string): Promise<any> {
  return ApiProxy.request(`${collectionPath(s, 'NotificationChannel')}/${name}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/merge-patch+json' },
    body: JSON.stringify(testRequestPatch(s)),
  });
}

/** Create or replace the live resource. */
export async function applyLive(
  s: Settings,
  kind: Kind,
  resource: any,
  existing: any | null
): Promise<void> {
  const name = resource.metadata.name;
  if (existing) {
    const body = {
      ...resource,
      metadata: { ...resource.metadata, resourceVersion: existing.metadata?.resourceVersion },
    };
    await ApiProxy.request(`${collectionPath(s, kind)}/${name}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  } else {
    await ApiProxy.request(collectionPath(s, kind), {
      method: 'POST',
      body: JSON.stringify(resource),
    });
  }
}

export function deleteLive(s: Settings, kind: Kind, name: string): Promise<any> {
  return ApiProxy.request(`${collectionPath(s, kind)}/${name}`, { method: 'DELETE' });
}

export interface StateResult extends StatePayload {
  loading: boolean;
  error: string | null;
}

/** Polls the state API every 15 seconds while the page is mounted. */
export function useStateApi(url: string): StateResult {
  const [res, setRes] = React.useState<StateResult>({
    channels: [],
    targets: [],
    loading: true,
    error: null,
  });
  React.useEffect(() => {
    if (!url) return;
    let alive = true;
    const target = resolveEndpoint(url);
    const load = async () => {
      try {
        const json = target.proxied
          ? await ApiProxy.request(target.url)
          : await fetch(target.url).then(r => {
              if (!r.ok) throw new Error(`State API returned HTTP ${r.status}`);
              return r.json();
            });
        if (alive) setRes({ ...parseStatePayload(json), loading: false, error: null });
      } catch (e: any) {
        if (alive) setRes(r => ({ ...r, loading: false, error: String(e?.message || e) }));
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [url]);
  return res;
}
