/*
 * Dashboard storage: one ConfigMap per dashboard.
 *
 *   metadata.name        a DNS label made from the first title, never changed (URLs use it)
 *   metadata.labels      headlamp.dev/dashboard=true
 *   data["dashboard.json"]  the JSON spec (see spec/model.ts)
 *
 * Writes use the ConfigMap's resourceVersion: a replace with an old version fails with HTTP
 * 409 and becomes a `ConflictError`, so nobody overwrites another person's save unseen.
 * Everything goes through a `Transport` (in the app: Headlamp's ApiProxy), so it is testable.
 */
import { DashboardSpec, migrateSpec, parseSpec, serialiseSpec, SpecError, SpecVersionError } from '../spec/model';

export const DASHBOARD_LABEL = 'headlamp.dev/dashboard';
export const DATA_KEY = 'dashboard.json';
export const DEFAULT_NAMESPACE = 'headlamp-dashboards';
export const FIELD_MANAGER = 'headlamp-dashboards';

export interface Transport {
  request(path: string, params?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<any>;
}

/** The user may not read or write here (HTTP 401 or 403). */
export class AccessError extends Error {
  constructor(public readonly verb: 'read' | 'write', public readonly namespace: string) {
    super(
      verb === 'read'
        ? `You are not allowed to read dashboards in the namespace "${namespace}". Ask a cluster admin for list and get on ConfigMaps there, or change the namespace in the plugin settings.`
        : `You have read-only access to dashboards in the namespace "${namespace}". Ask a cluster admin for create, update and delete on ConfigMaps there to save changes.`
    );
  }
}

/** Someone else saved this dashboard since it was loaded. */
export class ConflictError extends Error {
  constructor() {
    super('Someone else saved this dashboard since you opened it. Reload it to see their changes. Your edits stay on screen until you reload.');
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(what);
  }
}

export interface StoredDashboard {
  /** The ConfigMap name. */
  name: string;
  namespace: string;
  resourceVersion: string;
  spec: DashboardSpec;
  /** True when the stored JSON was older than the current spec version. */
  migrated: boolean;
  /** Set when the stored JSON could not be used. The spec is then an empty placeholder. */
  error?: string;
  /** True when the spec was saved by a newer plugin: it must not be overwritten. */
  tooNew?: boolean;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const base = (ns: string) => `/api/v1/namespaces/${encodeURIComponent(ns)}/configmaps`;
const withManager = (path: string, extra = '') => `${path}?fieldManager=${FIELD_MANAGER}${extra}`;

function statusOf(e: unknown): number | undefined {
  return (e as { status?: number } | null)?.status;
}

export function describeError(e: unknown, ns: string, verb: 'read' | 'write'): Error {
  if (e instanceof AccessError || e instanceof ConflictError || e instanceof NotFoundError) return e;
  const s = statusOf(e);
  if (s === 401 || s === 403) return new AccessError(verb, ns);
  if (s === 409) return new ConflictError();
  if (s === 404) return new NotFoundError(`The namespace "${ns}" or the dashboard was not found. Create the namespace, or change it in the plugin settings.`);
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(msg || 'The request failed.');
}

export function fromConfigMap(cm: any, namespace: string): StoredDashboard {
  const name: string = cm?.metadata?.name ?? '';
  const resourceVersion: string = cm?.metadata?.resourceVersion ?? '';
  const text: string | undefined = cm?.data?.[DATA_KEY];
  const empty = (): DashboardSpec => migrateSpec({ title: name }).spec;
  if (typeof text !== 'string') {
    return { name, namespace, resourceVersion, spec: empty(), migrated: false, error: `The ConfigMap has no "${DATA_KEY}" key.` };
  }
  try {
    const { spec, migrated } = parseSpec(text);
    return { name, namespace, resourceVersion, spec, migrated };
  } catch (e) {
    return {
      name,
      namespace,
      resourceVersion,
      spec: empty(),
      migrated: false,
      error: e instanceof Error ? e.message : String(e),
      tooNew: e instanceof SpecVersionError,
    };
  }
}

export function toConfigMap(name: string, namespace: string, spec: DashboardSpec, resourceVersion?: string): any {
  const stamped: DashboardSpec = { ...spec, modifiedAt: new Date().toISOString() };
  const cm: any = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name, namespace, labels: { [DASHBOARD_LABEL]: 'true' } },
    data: { [DATA_KEY]: serialiseSpec(stamped) },
  };
  if (resourceVersion) cm.metadata.resourceVersion = resourceVersion;
  return cm;
}

export function createStorage(transport: Transport, namespace: string) {
  const guard = async <T>(verb: 'read' | 'write', fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw describeError(e, namespace, verb);
    }
  };

  return {
    namespace,

    list(): Promise<StoredDashboard[]> {
      return guard('read', async () => {
        const res = await transport.request(`${base(namespace)}?labelSelector=${encodeURIComponent(`${DASHBOARD_LABEL}=true`)}`);
        const items: any[] = Array.isArray(res?.items) ? res.items : [];
        return items
          .map(cm => fromConfigMap(cm, namespace))
          .sort((a, b) => a.spec.title.localeCompare(b.spec.title));
      });
    },

    get(name: string): Promise<StoredDashboard> {
      return guard('read', async () => {
        const cm = await transport.request(`${base(namespace)}/${encodeURIComponent(name)}`);
        return fromConfigMap(cm, namespace);
      });
    },

    /** Create a new ConfigMap. A taken name (HTTP 409) is a `ConflictError`. */
    create(name: string, spec: DashboardSpec): Promise<StoredDashboard> {
      return guard('write', async () => {
        const cm = await transport.request(withManager(base(namespace)), {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(toConfigMap(name, namespace, spec)),
        });
        return fromConfigMap(cm, namespace);
      });
    },

    /**
     * Replace a dashboard. The request carries `resourceVersion`, so the API server refuses it
     * (HTTP 409, `ConflictError`) when the ConfigMap changed since it was read.
     */
    save(stored: Pick<StoredDashboard, 'name' | 'resourceVersion' | 'tooNew' | 'error'>, spec: DashboardSpec): Promise<StoredDashboard> {
      if (stored.tooNew || stored.error) {
        return Promise.reject(new SpecError(stored.error ?? 'This dashboard cannot be saved by this plugin version.'));
      }
      return guard('write', async () => {
        const cm = await transport.request(withManager(`${base(namespace)}/${encodeURIComponent(stored.name)}`), {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify(toConfigMap(stored.name, namespace, spec, stored.resourceVersion)),
        });
        return fromConfigMap(cm, namespace);
      });
    },

    remove(name: string): Promise<void> {
      return guard('write', async () => {
        await transport.request(`${base(namespace)}/${encodeURIComponent(name)}`, { method: 'DELETE' });
      });
    },
  };
}

export type DashboardStorage = ReturnType<typeof createStorage>;
