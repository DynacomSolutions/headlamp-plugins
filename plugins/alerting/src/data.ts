import { ApiProxy, ConfigStore, K8s } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import {
  CONFIG_KEY,
  parseStatePayload,
  resolveEndpoint,
  resolveSettings,
  secretListingFailed,
  Settings,
  StatePayload,
  testRequestPatch,
} from './model';

export const configStore = new ConfigStore<Partial<Settings>>(CONFIG_KEY);

let defaultsPromise: Promise<Partial<Settings>> | null = null;

/**
 * Deployment-supplied defaults: an optional defaults.json shipped next to
 * main.js in the plugin directory (Headlamp serves it as a static file).
 */
function loadDefaults(): Promise<Partial<Settings>> {
  if (!defaultsPromise) {
    defaultsPromise = fetch(`/plugins/${CONFIG_KEY}/defaults.json`)
      .then(r => (r.ok ? r.json() : {}))
      .then(j => (j && typeof j === 'object' ? (j as Partial<Settings>) : {}))
      .catch(() => ({}));
  }
  return defaultsPromise;
}

/** Browser-local overrides layered over the deployment defaults and built-ins. */
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

type Kind = 'NotificationChannel' | 'AlertRoute' | 'PushSubscription';

const PLURAL: Record<Kind, string> = {
  NotificationChannel: 'notificationchannels',
  AlertRoute: 'alertroutes',
  PushSubscription: 'pushsubscriptions',
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

export interface SecretNames {
  names: string[];
  /** false when listing Secrets failed or was forbidden: use free-text inputs */
  available: boolean;
}

/** Names of Secrets in the configured namespace (names only; values are never read). */
export function useSecretNames(s: Settings): SecretNames {
  const [items, err] = (K8s.ResourceClasses as any).Secret.useList({ namespace: s.namespace });
  return React.useMemo(
    () => ({
      names: ((items || []) as any[])
        .map(i => i.metadata?.name as string)
        .filter(Boolean)
        .sort(),
      available: !secretListingFailed(err),
    }),
    [items, err]
  );
}

/** Keys of one Secret in the configured namespace (key names only; values are discarded). */
export function useSecretKeys(
  s: Settings,
  name: string,
  enabled = true
): { keys: string[]; available: boolean } {
  const [state, setState] = React.useState<{ keys: string[]; available: boolean }>({
    keys: [],
    available: true,
  });
  React.useEffect(() => {
    let alive = true;
    if (!name || !enabled) {
      setState({ keys: [], available: true });
      return;
    }
    ApiProxy.request(`/api/v1/namespaces/${s.namespace}/secrets/${name}`)
      .then(
        (r: any) => alive && setState({ keys: Object.keys(r?.data || {}).sort(), available: true })
      )
      .catch(() => alive && setState({ keys: [], available: false }));
    return () => {
      alive = false;
    };
  }, [s.namespace, name, enabled]);
  return state;
}

const collectionPath = (s: Settings, kind: Kind) =>
  `/apis/${s.group}/${s.version}/namespaces/${s.namespace}/${PLURAL[kind]}`;

/** Headlamp's proxy forwards no default content type; the API server rejects bodies without one. */
export const JSON_HEADERS = { 'Content-Type': 'application/json' };

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
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  } else {
    await ApiProxy.request(collectionPath(s, kind), {
      method: 'POST',
      headers: JSON_HEADERS,
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

/** Create a PushSubscription; an existing one with the same name (same endpoint) is replaced. */
export async function createSubscription(s: Settings, resource: any): Promise<void> {
  try {
    await ApiProxy.request(collectionPath(s, 'PushSubscription'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(resource),
    });
  } catch (e: any) {
    if ((e as any)?.status !== 409) throw e;
    await deleteLive(s, 'PushSubscription', resource.metadata.name);
    await ApiProxy.request(collectionPath(s, 'PushSubscription'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(resource),
    });
  }
}
