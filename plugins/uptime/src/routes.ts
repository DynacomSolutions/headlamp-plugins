/*
 * Pure model that places an uptime check in the cluster: the check's host is matched with the hosts of the
 * HTTPRoutes, Ingresses and Emissary Mappings, and the route that serves it gives the namespace and app.
 * No React and no network access here, so it is unit-testable.
 *
 * `appLabelOf` and the Mapping reader (`mappingRoutes`) follow `plugins/sites/src/model.ts` (`appName` and
 * `mappingFrom`). Headlamp plugins are separate bundles and cannot import each other, so the few lines are
 * copied. Keep them in step with the Sites plugin: a Mapping host is `spec.host` or `spec.hostname`, a
 * Mapping path is `spec.prefix`, and the app is `app.kubernetes.io/name` or `app.kubernetes.io/part-of`.
 */
import type { Check } from './model';

export type RouteKind = 'httproute' | 'mapping' | 'ingress';

/** The Service that a route sends traffic to. It is where the app answers, and where its icon is. */
export interface Backend {
  namespace: string;
  name: string;
  /** A port number or a port name. Without it the Service proxy uses the first port. */
  port?: string;
  /** `https` when the Service speaks TLS. */
  scheme?: 'https';
}

export interface Route {
  kind: RouteKind;
  namespace: string;
  name: string;
  /** A lower-case host. A leading `*.` marks a wildcard host. */
  host: string;
  /** The path of the route, always with a leading slash. */
  path: string;
  /** True when the route matches only this exact path, not the path as a prefix. */
  exact: boolean;
  labels: Record<string, string>;
  /** The Service behind the route, when the route names one. */
  backend?: Backend;
}

/** Where a check runs: the namespace of its route, and the app label of the route (or the namespace). */
export interface Placement {
  namespace: string;
  app: string;
  route: Route;
}

/** Raw list items, by kind. A kind that is absent or not readable is an empty list. */
export interface RawRoutes {
  httproutes: unknown[];
  ingresses: unknown[];
  mappings: unknown[];
}

const KIND_RANK: Record<RouteKind, number> = { httproute: 0, mapping: 1, ingress: 2 };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);

export function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

function normalisePath(path: string): string {
  const p = path.trim();
  if (p === '') return '/';
  return p.startsWith('/') ? p : `/${p}`;
}

/** The app of a route: `app.kubernetes.io/name`, then `app.kubernetes.io/part-of`. Empty when neither is set. */
export function appLabelOf(labels: Record<string, string> | undefined): string {
  if (!labels) return '';
  return str(labels['app.kubernetes.io/name']) || str(labels['app.kubernetes.io/part-of']);
}

function labelsOf(o: any): Record<string, string> {
  const l = o?.metadata?.labels;
  return l && typeof l === 'object' ? (l as Record<string, string>) : {};
}

function base(kind: RouteKind, o: any) {
  return {
    kind,
    namespace: str(o?.metadata?.namespace),
    name: str(o?.metadata?.name),
    labels: labelsOf(o),
  };
}

/** The first Service in the backendRefs of an HTTPRoute rule. */
function ruleBackend(rule: any, namespace: string): Backend | undefined {
  for (const ref of asArray(rule?.backendRefs)) {
    const kind = str(ref?.kind);
    const name = str(ref?.name);
    if ((kind !== '' && kind !== 'Service') || !name) continue;
    const port = ref?.port === undefined || ref?.port === null ? '' : String(ref.port);
    return { namespace: str(ref?.namespace) || namespace, name, port: port || undefined };
  }
  return undefined;
}

/** One route per host and path match of a Gateway API HTTPRoute (`spec.hostnames`, `rules[].matches[].path`). */
export function httpRouteRoutes(o: any): Route[] {
  const hosts = asArray(o?.spec?.hostnames).map(str).filter(Boolean).map(normaliseHost);
  const paths: { path: string; exact: boolean; backend?: Backend }[] = [];
  const namespace = str(o?.metadata?.namespace);
  for (const rule of asArray(o?.spec?.rules)) {
    const backend = ruleBackend(rule, namespace);
    for (const m of asArray(rule?.matches)) {
      const value = str(m?.path?.value);
      if (value)
        paths.push({ path: normalisePath(value), exact: m?.path?.type === 'Exact', backend });
    }
  }
  if (paths.length === 0) {
    paths.push({
      path: '/',
      exact: false,
      backend: ruleBackend(asArray(o?.spec?.rules)[0], namespace),
    });
  }
  return hosts.flatMap(host => paths.map(p => ({ ...base('httproute', o), host, ...p })));
}

/** One route per host and path of an Ingress (`spec.rules[].host`, `http.paths[].path`). */
export function ingressRoutes(o: any): Route[] {
  const out: Route[] = [];
  for (const rule of asArray(o?.spec?.rules)) {
    const host = normaliseHost(str(rule?.host));
    if (!host) continue;
    const paths = asArray(rule?.http?.paths);
    const namespace = str(o?.metadata?.namespace);
    if (paths.length === 0) out.push({ ...base('ingress', o), host, path: '/', exact: false });
    for (const p of paths) {
      const svc = p?.backend?.service;
      const name = str(svc?.name);
      const port = svc?.port?.number !== undefined ? String(svc.port.number) : str(svc?.port?.name);
      out.push({
        ...base('ingress', o),
        host,
        path: normalisePath(str(p?.path)),
        exact: p?.pathType === 'Exact',
        backend: name ? { namespace, name, port: port || undefined } : undefined,
      });
    }
  }
  return out;
}

/**
 * The Service of an Emissary Mapping (`spec.service`): `name`, `name.namespace`, `name:port`, the same with an
 * `http://` or `https://` prefix, or `name.namespace.svc[.cluster.local]`. Any other address (an external host
 * name, an IP, a redirect target) names no Service in the cluster, so it gives undefined.
 */
export function mappingBackend(service: unknown, namespace: string): Backend | undefined {
  const m = /^(?:(https?):\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d+))?(?:\/.*)?$/i.exec(
    str(service)
  );
  if (!m) return undefined;
  const labels = m[2].toLowerCase().split('.');
  const tail = labels.slice(2).join('.');
  if (labels.length > 2 && tail !== 'svc' && !tail.startsWith('svc.')) return undefined;
  const scheme = m[1]?.toLowerCase() === 'https' ? ('https' as const) : undefined;
  return { namespace: labels[1] || namespace, name: labels[0], port: m[3] || undefined, scheme };
}

/** The route of an Emissary Mapping (`spec.host` or `spec.hostname`, `spec.prefix`). */
export function mappingRoutes(o: any): Route[] {
  const spec = o?.spec ?? {};
  const host = normaliseHost(str(spec.host) || str(spec.hostname));
  if (!host) return [];
  // A redirect Mapping sends the client away, so its `service` is a target host and not a backend.
  const backend = spec.host_redirect
    ? undefined
    : mappingBackend(spec.service, str(o?.metadata?.namespace));
  return [
    { ...base('mapping', o), host, path: normalisePath(str(spec.prefix)), exact: false, backend },
  ];
}

export function buildRoutes(raw: RawRoutes): Route[] {
  return [
    ...raw.httproutes.flatMap(httpRouteRoutes),
    ...raw.mappings.flatMap(mappingRoutes),
    ...raw.ingresses.flatMap(ingressRoutes),
  ];
}

export interface Endpoint {
  host: string;
  port?: string;
  path?: string;
}

/** Read a host, port and path from a URL (`https://a.example.com:8443/x`) or a `host:port` address. */
export function parseEndpoint(value: string): Endpoint | undefined {
  const v = value.trim();
  if (!v) return undefined;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
      const u = new URL(v);
      return {
        host: normaliseHost(u.hostname),
        port: u.port || undefined,
        path: u.pathname || '/',
      };
    }
  } catch {
    return undefined;
  }
  const m = /^([^/:\s]+)(?::(\d+))?(\/.*)?$/.exec(v);
  if (!m) return undefined;
  return { host: normaliseHost(m[1]), port: m[2], path: m[3] };
}

/**
 * The places a check can name its host, best first: the `host` series label, then the probed URL or
 * address, then the check name when it looks like a host name. A port never takes part in the host match.
 */
export function endpointsOf(check: Pick<Check, 'name' | 'instance' | 'labels'>): Endpoint[] {
  const out: Endpoint[] = [];
  const fromInstance = parseEndpoint(check.instance);
  const label = parseEndpoint(check.labels.host ?? '');
  if (label) out.push({ ...label, path: label.path ?? fromInstance?.path });
  if (fromInstance) out.push(fromInstance);
  if (check.name.includes('.')) {
    const fromName = parseEndpoint(check.name);
    if (fromName) out.push({ ...fromName, path: fromInstance?.path });
  }
  return out;
}

/** The suffix of a wildcard host (`*.example.com` gives `.example.com`), or undefined for an exact host. */
function wildcardSuffix(host: string): string | undefined {
  return host.startsWith('*.') ? host.slice(1) : undefined;
}

/** The length of the route path that covers the request path, or -1 when it does not cover it. */
export function pathScore(route: Pick<Route, 'path' | 'exact'>, path: string | undefined): number {
  const p = normalisePath(path ?? '/');
  if (route.exact) return p === route.path ? route.path.length : -1;
  if (route.path === '/') return 1;
  const prefix = route.path.replace(/\/+$/, '');
  if (p === prefix || p.startsWith(`${prefix}/`)) return prefix.length;
  return -1;
}

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The route that serves a host and path. An exact host beats a wildcard host, and a longer wildcard suffix
 * beats a shorter one. Among those, a route whose path covers the request path (longest path first) comes
 * before one that does not, then HTTPRoute before Mapping before Ingress, then the namespace and name.
 * A host with no route gives undefined.
 */
export function matchRoute(routes: Route[], host: string, path?: string): Route | undefined {
  const h = normaliseHost(host);
  if (!h) return undefined;
  let pool = routes.filter(r => r.host === h);
  if (pool.length === 0) {
    let best = 0;
    for (const r of routes) {
      const suffix = wildcardSuffix(r.host);
      // A wildcard covers one or more labels, never the bare domain: `*.example.com` is not `example.com`.
      if (suffix && h.endsWith(suffix) && h.length > suffix.length && suffix.length > best)
        best = suffix.length;
    }
    if (best > 0)
      pool = routes.filter(
        r => wildcardSuffix(r.host)?.length === best && h.endsWith(r.host.slice(1))
      );
  }
  if (pool.length === 0) return undefined;
  return [...pool].sort(
    (a, b) =>
      cmp(pathScore(b, path), pathScore(a, path)) ||
      cmp(KIND_RANK[a.kind], KIND_RANK[b.kind]) ||
      cmp(a.namespace, b.namespace) ||
      cmp(a.name, b.name)
  )[0];
}

/** The placement of one check, from the first of its hosts that a route serves. */
export function placeCheck(
  check: Pick<Check, 'name' | 'instance' | 'labels'>,
  routes: Route[]
): Placement | undefined {
  for (const e of endpointsOf(check)) {
    const route = matchRoute(routes, e.host, e.path);
    if (route && route.namespace) {
      return {
        namespace: route.namespace,
        app: appLabelOf(route.labels) || route.namespace,
        route,
      };
    }
  }
  return undefined;
}

/** The placement of every check that a route serves, by check name. Checks with no route are absent. */
export function placeChecks(checks: Check[], routes: Route[]): Map<string, Placement> {
  const out = new Map<string, Placement>();
  if (routes.length === 0) return out;
  for (const c of checks) {
    const p = placeCheck(c, routes);
    if (p) out.set(c.name, p);
  }
  return out;
}
