import { readFileSync } from 'node:fs';
import type { Config } from './config.js';

/**
 * A read-only Kubernetes API client. It can only send GET requests, it never
 * reads Secrets (or any resource with "secret" in its name), and it removes
 * managedFields and last-applied annotations, which are large and can repeat
 * values. RBAC is the real boundary (get/list/watch only, no Secrets); this
 * class is the second one, so a wrong ClusterRole still cannot leak a Secret.
 */

export interface ResourceInfo {
  group: string;
  version: string;
  resource: string;
  kind: string;
  namespaced: boolean;
  shortNames: string[];
  singular: string;
  verbs: string[];
}

export interface ListOptions {
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
}

export class ForbiddenResourceError extends Error {}

const DENIED_RESOURCE = /secret/i;
const DISCOVERY_TTL_MS = 10 * 60_000;
const ACCEPT_DISCOVERY =
  'application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json;g=apidiscovery.k8s.io;v=v2beta1;as=APIGroupDiscoveryList,application/json';

export class KubeClient {
  private discovery: { at: number; resources: ResourceInfo[] } | undefined;

  constructor(private readonly config: Pick<Config, 'kubeApi' | 'kubeTokenFile' | 'kubeCaFile'>) {}

  private base(): string {
    if (this.config.kubeApi) return this.config.kubeApi.replace(/\/+$/, '');
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
    if (!host) throw new Error('Not running in a cluster and KUBE_API is not set');
    return `https://${host.includes(':') ? `[${host}]` : host}:${port}`;
  }

  private token(): string | undefined {
    try {
      return readFileSync(this.config.kubeTokenFile, 'utf8').trim();
    } catch {
      return undefined; // kubectl proxy or another unauthenticated local endpoint
    }
  }

  /** The only request method. GET, with a path that must start with /api or /apis. */
  async request(path: string, accept = 'application/json', timeoutMs = 20_000): Promise<Response> {
    if (!/^\/apis?(\/|$)/.test(path)) throw new Error(`Refusing non-API path ${path}`);
    const pathOnly = path.split('?')[0];
    const resource = resourceOfPath(pathOnly);
    if (resource && DENIED_RESOURCE.test(resource)) throw new ForbiddenResourceError('Secrets are never read');
    const token = this.token();
    const res = await fetch(this.base() + path, {
      method: 'GET',
      headers: { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let message = body.slice(0, 300);
      try {
        message = (JSON.parse(body) as { message?: string }).message ?? message;
      } catch {
        /* not JSON */
      }
      throw new KubeError(res.status, `Kubernetes API ${res.status} for ${pathOnly}: ${message}`);
    }
    return res;
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    const res = await this.request(path);
    return (await res.json()) as T;
  }

  async resources(): Promise<ResourceInfo[]> {
    if (this.discovery && Date.now() - this.discovery.at < DISCOVERY_TTL_MS) return this.discovery.resources;
    const resources: ResourceInfo[] = [];
    for (const root of ['/api', '/apis']) {
      const res = await this.request(root, ACCEPT_DISCOVERY);
      const body = (await res.json()) as AggregatedDiscovery;
      if (!Array.isArray(body.items)) throw new Error('The API server did not answer with aggregated discovery');
      for (const group of body.items) {
        const preferred = group.versions?.[0];
        if (!preferred) continue;
        for (const r of preferred.resources ?? []) {
          if (DENIED_RESOURCE.test(r.resource)) continue;
          resources.push({
            group: group.metadata?.name ?? '',
            version: preferred.version,
            resource: r.resource,
            kind: r.responseKind?.kind ?? r.resource,
            namespaced: r.scope === 'Namespaced',
            shortNames: r.shortNames ?? [],
            singular: r.singularResource ?? '',
            verbs: r.verbs ?? [],
          });
        }
      }
    }
    this.discovery = { at: Date.now(), resources };
    return resources;
  }

  /**
   * Finds a resource type by kind (`Deployment`), plural (`deployments`),
   * singular, short name (`deploy`) or `plural.group` (`deployments.apps`).
   */
  async resolve(kind: string): Promise<ResourceInfo> {
    const wanted = kind.trim().toLowerCase();
    if (DENIED_RESOURCE.test(wanted)) throw new ForbiddenResourceError('Secrets are never read');
    const [name, ...groupParts] = wanted.split('.');
    const group = groupParts.join('.');
    const all = await this.resources();
    const matches = all.filter(
      r =>
        (!group || r.group === group) &&
        (r.kind.toLowerCase() === name || r.resource === name || r.singular === name || r.shortNames.includes(name)),
    );
    if (matches.length === 0) throw new Error(`Unknown resource type "${kind}". Use list_api_resources to see the types this cluster serves.`);
    // Prefer the core and well-known groups when a kind exists in several (for example events).
    matches.sort((a, b) => rank(a) - rank(b));
    return matches[0];
  }

  path(info: ResourceInfo, namespace?: string, name?: string): string {
    const prefix = info.group ? `/apis/${info.group}/${info.version}` : `/api/${info.version}`;
    const ns = info.namespaced && namespace ? `/namespaces/${encodeURIComponent(namespace)}` : '';
    return `${prefix}${ns}/${info.resource}${name ? `/${encodeURIComponent(name)}` : ''}`;
  }

  async list(kind: string, options: ListOptions = {}): Promise<{ info: ResourceInfo; items: KubeObject[]; truncated: boolean }> {
    const info = await this.resolve(kind);
    const query = new URLSearchParams();
    if (options.labelSelector) query.set('labelSelector', options.labelSelector);
    if (options.fieldSelector) query.set('fieldSelector', options.fieldSelector);
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 2000);
    query.set('limit', String(limit));
    const body = await this.getJson<{ items?: KubeObject[]; metadata?: { continue?: string } }>(
      `${this.path(info, options.namespace)}?${query}`,
    );
    const items = (body.items ?? []).map(item => clean({ ...item, kind: info.kind }));
    return { info, items, truncated: Boolean(body.metadata?.continue) };
  }

  async get(kind: string, name: string, namespace?: string): Promise<{ info: ResourceInfo; object: KubeObject }> {
    const info = await this.resolve(kind);
    if (info.namespaced && !namespace) throw new Error(`${info.kind} is namespaced; give a namespace`);
    const object = await this.getJson<KubeObject>(this.path(info, namespace, name));
    return { info, object: clean(object) };
  }

  async logs(
    namespace: string,
    pod: string,
    options: { container?: string; tailLines?: number; sinceSeconds?: number; previous?: boolean; limitBytes?: number },
  ): Promise<string> {
    const query = new URLSearchParams();
    if (options.container) query.set('container', options.container);
    query.set('tailLines', String(Math.min(Math.max(options.tailLines ?? 200, 1), 2000)));
    if (options.sinceSeconds) query.set('sinceSeconds', String(options.sinceSeconds));
    if (options.previous) query.set('previous', 'true');
    query.set('limitBytes', String(options.limitBytes ?? 256 * 1024));
    query.set('timestamps', 'true');
    const res = await this.request(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${query}`,
      '*/*',
    );
    return res.text();
  }
}

export class KubeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The resource type a request path addresses: `/api/v1/namespaces/a/pods/b/log`
 * is `pods`, `/apis/apps/v1/deployments` is `deployments`. Namespace and object
 * names are not checked, so a namespace called `sealed-secrets` stays readable.
 */
export function resourceOfPath(path: string): string | undefined {
  const parts = path.split('/').filter(Boolean);
  let rest: string[];
  if (parts[0] === 'api') rest = parts.slice(2);
  else if (parts[0] === 'apis') rest = parts.slice(3);
  else return undefined;
  if (rest.length === 0) return undefined;
  if (rest[0] === 'namespaces' && rest.length >= 3) return rest[2];
  return rest[0];
}

function rank(info: ResourceInfo): number {
  if (info.group === '') return 0;
  if (info.group.endsWith('.k8s.io') || ['apps', 'batch', 'autoscaling', 'policy'].includes(info.group)) return 1;
  return 2;
}

export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
    ownerReferences?: Array<{ kind: string; name: string }>;
    managedFields?: unknown;
    [key: string]: unknown;
  };
  spec?: Record<string, any>;
  status?: Record<string, any>;
  [key: string]: unknown;
}

/** Drops fields that are large and never useful for diagnosis. */
export function clean(object: KubeObject): KubeObject {
  const copy: KubeObject = { ...object };
  if (copy.metadata) {
    const { managedFields: _managed, ...metadata } = copy.metadata;
    if (metadata.annotations) {
      const annotations = { ...metadata.annotations };
      delete annotations['kubectl.kubernetes.io/last-applied-configuration'];
      for (const key of Object.keys(annotations)) if (annotations[key].length > 2000) annotations[key] = `${annotations[key].slice(0, 2000)}…`;
      metadata.annotations = annotations;
    }
    copy.metadata = metadata;
  }
  return copy;
}

interface AggregatedDiscovery {
  items?: Array<{
    metadata?: { name?: string };
    versions?: Array<{
      version: string;
      resources?: Array<{
        resource: string;
        responseKind?: { kind?: string };
        scope?: string;
        shortNames?: string[];
        singularResource?: string;
        verbs?: string[];
      }>;
    }>;
  }>;
}
