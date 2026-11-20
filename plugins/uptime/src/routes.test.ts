import { describe, expect, it } from 'vitest';
import type { Check } from './model';
import {
  appLabelOf,
  buildRoutes,
  endpointsOf,
  matchRoute,
  parseEndpoint,
  pathScore,
  placeCheck,
  placeChecks,
  Route,
} from './routes';

const route = (over: Partial<Route> & { host: string }): Route => ({
  kind: 'httproute',
  namespace: 'shop',
  name: 'r',
  path: '/',
  exact: false,
  labels: {},
  ...over,
});
const check = (name: string, instance: string, labels: Record<string, string> = {}): Check => ({
  name,
  type: 'http',
  instance,
  policy: 'all',
  sites: new Map(),
  status: 'up',
  labels,
  history: [],
});

describe('reading the route kinds', () => {
  const raw = {
    httproutes: [
      {
        metadata: { namespace: 'shop', name: 'web', labels: { 'app.kubernetes.io/name': 'storefront' } },
        spec: {
          hostnames: ['Web.Example.COM', '*.apps.example.com'],
          rules: [{ matches: [{ path: { type: 'PathPrefix', value: '/api' } }, { path: { type: 'Exact', value: '/health' } }] }],
        },
      },
      { metadata: { namespace: 'ops', name: 'bare' }, spec: { hostnames: ['ops.example.com'] } },
    ],
    ingresses: [
      {
        metadata: { namespace: 'blog', name: 'ing' },
        spec: { rules: [{ host: 'blog.example.com', http: { paths: [{ path: '/', pathType: 'Prefix' }] } }, { http: { paths: [] } }] },
      },
    ],
    mappings: [
      { metadata: { namespace: 'media', name: 'm' }, spec: { host: 'tv.example.com', prefix: '/live/' } },
      { metadata: { namespace: 'media', name: 'm2' }, spec: { hostname: 'tv2.example.com' } },
      { metadata: { namespace: 'media', name: 'nohost' }, spec: { prefix: '/' } },
    ],
  };
  const routes = buildRoutes(raw);
  it('reads HTTPRoute hostnames and path matches, Ingress rules and Mapping hosts', () => {
    expect(routes.filter(r => r.kind === 'httproute').map(r => `${r.host}${r.path}${r.exact ? '=' : ''}`)).toEqual([
      'web.example.com/api',
      'web.example.com/health=',
      '*.apps.example.com/api',
      '*.apps.example.com/health=',
      'ops.example.com/',
    ]);
    expect(routes.filter(r => r.kind === 'ingress').map(r => `${r.namespace}/${r.host}${r.path}`)).toEqual(['blog/blog.example.com/']);
    expect(routes.filter(r => r.kind === 'mapping').map(r => `${r.host}${r.path}`)).toEqual(['tv.example.com/live/', 'tv2.example.com/']);
  });
  it('reads the app from the name label, then part-of, else nothing', () => {
    expect(appLabelOf({ 'app.kubernetes.io/name': 'a', 'app.kubernetes.io/part-of': 'b' })).toBe('a');
    expect(appLabelOf({ 'app.kubernetes.io/part-of': 'b' })).toBe('b');
    expect(appLabelOf({ other: 'x' })).toBe('');
    expect(appLabelOf(undefined)).toBe('');
  });
});

describe('endpoints of a check', () => {
  it('reads a URL, a host:port address and a bare host', () => {
    expect(parseEndpoint('https://A.example.com:8443/x/y')).toEqual({ host: 'a.example.com', port: '8443', path: '/x/y' });
    expect(parseEndpoint('a.example.com:443')).toEqual({ host: 'a.example.com', port: '443', path: undefined });
    expect(parseEndpoint('a.example.com.')).toEqual({ host: 'a.example.com', port: undefined, path: undefined });
    expect(parseEndpoint('')).toBeUndefined();
  });
  it('tries the host label, then the URL, then a check name that looks like a host', () => {
    const c = check('web.example.com', 'https://url.example.com/legend', { host: 'label.example.com' });
    expect(endpointsOf(c).map(e => e.host)).toEqual(['label.example.com', 'url.example.com', 'web.example.com']);
    expect(endpointsOf(c)[0].path).toBe('/legend');
    expect(endpointsOf(check('plain', '192.0.2.1:22')).map(e => e.host)).toEqual(['192.0.2.1']);
  });
});

describe('host matching', () => {
  const routes = [
    route({ host: 'web.example.com', namespace: 'exact' }),
    route({ host: '*.example.com', namespace: 'wild' }),
    route({ host: '*.apps.example.com', namespace: 'deep' }),
  ];
  it('matches an exact host, ignoring case and a trailing dot', () => {
    expect(matchRoute(routes, 'Web.Example.com.')?.namespace).toBe('exact');
  });
  it('matches a wildcard host, and the longest wildcard wins', () => {
    expect(matchRoute(routes, 'other.example.com')?.namespace).toBe('wild');
    expect(matchRoute(routes, 'x.apps.example.com')?.namespace).toBe('deep');
  });
  it('a wildcard never matches the bare domain, another domain or an empty host', () => {
    expect(matchRoute(routes, 'example.com')).toBeUndefined();
    expect(matchRoute(routes, 'web.example.org')).toBeUndefined();
    expect(matchRoute(routes, '')).toBeUndefined();
  });
  it('ignores the port of the probed address', () => {
    const c = check('tls', 'web.example.com:443', {});
    expect(placeCheck(c, routes)?.namespace).toBe('exact');
    expect(placeCheck(check('x', 'https://web.example.com:8443/'), routes)?.namespace).toBe('exact');
  });
  it('uses the longest route path that covers the check path', () => {
    const paths = [
      route({ host: 'a.example.com', namespace: 'root', path: '/' }),
      route({ host: 'a.example.com', namespace: 'api', path: '/api' }),
      route({ host: 'a.example.com', namespace: 'exactly', path: '/api/v1', exact: true }),
    ];
    expect(matchRoute(paths, 'a.example.com', '/api/users')?.namespace).toBe('api');
    expect(matchRoute(paths, 'a.example.com', '/apiary')?.namespace).toBe('root');
    expect(matchRoute(paths, 'a.example.com', '/other')?.namespace).toBe('root');
    expect(matchRoute(paths, 'a.example.com', '/api/v1')?.namespace).toBe('exactly');
    expect(matchRoute(paths, 'a.example.com', '/api/v1/x')?.namespace).toBe('api');
    expect(matchRoute(paths, 'a.example.com')?.namespace).toBe('root');
  });
  it('keeps the host namespace when no route path covers the check path', () => {
    const only = [route({ host: 'a.example.com', namespace: 'api', path: '/api' })];
    expect(matchRoute(only, 'a.example.com', '/')?.namespace).toBe('api');
  });
  it('scores paths', () => {
    expect(pathScore({ path: '/', exact: false }, '/x')).toBe(1);
    expect(pathScore({ path: '/api/', exact: false }, '/api')).toBe(4);
    expect(pathScore({ path: '/a', exact: true }, '/a/')).toBe(-1);
  });
  it('picks the same route every time when kinds and namespaces compete', () => {
    const same = [
      route({ host: 'a.example.com', kind: 'ingress', namespace: 'a-ns' }),
      route({ host: 'a.example.com', kind: 'mapping', namespace: 'z-ns' }),
      route({ host: 'a.example.com', kind: 'httproute', namespace: 'm-ns' }),
    ];
    expect(matchRoute(same, 'a.example.com')?.kind).toBe('httproute');
    expect(matchRoute([...same].reverse(), 'a.example.com')?.kind).toBe('httproute');
  });
});

describe('placing checks', () => {
  const routes = [
    route({ host: 'web.example.com', namespace: 'shop', labels: { 'app.kubernetes.io/name': 'storefront' } }),
    route({ host: 'plain.example.com', namespace: 'ops' }),
  ];
  it('gives the namespace and the app, with the namespace as the app fallback', () => {
    const p = placeChecks(
      [check('web', 'https://web.example.com/'), check('plain', 'https://plain.example.com/'), check('github', 'https://github.com/')],
      routes
    );
    expect(p.get('web')).toMatchObject({ namespace: 'shop', app: 'storefront' });
    expect(p.get('plain')).toMatchObject({ namespace: 'ops', app: 'ops' });
    expect(p.has('github')).toBe(false);
  });
  it('finds a check by its host label when the URL is not a host', () => {
    expect(placeCheck(check('c', '192.0.2.5:9115', { host: 'web.example.com' }), routes)?.namespace).toBe('shop');
  });
  it('places nothing without routes', () => {
    expect(placeChecks([check('web', 'https://web.example.com/')], []).size).toBe(0);
  });
});
