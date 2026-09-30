/// <reference types="@kinvolk/headlamp-plugin" />
import { describe, expect, it } from 'vitest';
import {
  aliasesOf,
  appName,
  buildSites,
  DEFAULT_FILTERS,
  filtersDirty,
  joinUrl,
  kindOf,
  Mapping,
  mappingFrom,
  matchesSite,
  namespaceCounts,
  pathUrl,
  schemeOf,
  suffixesFrom,
} from './model';

const m = (namespace: string, name: string, host: string, prefix: string, service: string): Mapping => ({
  namespace,
  name,
  host,
  prefix,
  service,
});

const labelled = (
  namespace: string,
  name: string,
  host: string,
  prefix: string,
  service: string,
  app: string
): Mapping => ({ ...m(namespace, name, host, prefix, service), labels: { 'app.kubernetes.io/name': app } });

describe('buildSites', () => {
  it('prefers the tailnet name over local and LAN aliases', () => {
    const sites = buildSites([
      m('apps', 'tapo', 'tapo.localhost', '/', 'tapo.dev:80'),
      m('apps', 'tapo-lan', 'tapo.example.net', '/', 'tapo.dev:80'),
      m('apps', 'tapo-public', 'tapo.example.com', '/', 'tapo.dev:80'),
    ]);
    expect(sites).toHaveLength(1);
    expect(sites[0].id).toBe('tapo');
    expect(sites[0].primaryUrl).toBe('https://tapo.example.com/');
    expect(sites[0].kind).toBe('tailnet');
    expect(sites[0].hosts).toHaveLength(3);
    expect(sites[0].hosts[0]).toBe('tapo.example.com');
    expect(sites[0].mappings).toHaveLength(3);
  });

  it('collects several paths on the primary host, root first', () => {
    const sites = buildSites([
      labelled('apps', 'artifacts-public', 'artifacts.example.com', '/', 'proxy.apps:80', 'artifacts'),
      labelled('apps', 'artifacts-public-downloads', 'artifacts.example.com', '/downloads/', 'proxy.apps:80', 'artifacts'),
      labelled('apps', 'artifacts-vnc', 'artifacts.example.com', '/vnc/', 'proxy.apps:80', 'artifacts'),
      labelled('apps', 'artifacts-websocket', 'artifacts.example.com', '/websockify', 'proxy.apps:80', 'artifacts'),
    ]);
    expect(sites).toHaveLength(1);
    expect(sites[0].primaryUrl).toBe('https://artifacts.example.com/');
    expect(sites[0].app).toBe('artifacts');
    expect(sites[0].paths).toEqual(['/', '/vnc/', '/downloads/', '/websockify']);
  });

  it('keeps distinct hosts split', () => {
    const sites = buildSites([
      m('sync', 'sync-a', 'sync.a.example.com', '/', 'sync-a.sync:8384'),
      m('sync', 'sync-b', 'sync.b.example.com', '/', 'sync-b.sync:8384'),
    ]);
    expect(sites).toHaveLength(2);
    expect(sites[0].id).not.toBe(sites[1].id);
    expect(sites[0].primaryUrl).not.toBe(sites[1].primaryUrl);
  });

  it('keeps a sub-host separate from its parent app', () => {
    const sites = buildSites([
      m('cf', 'cf', 'cf.localhost', '/', 'cf.cf:80'),
      m('cf', 'cf-public', 'cf.example.com', '/', 'cf.cf:80'),
      m('cf', 'cf-li', 'li.cf.localhost', '/', 'cf-li.cf:80'),
      m('cf', 'cf-li-public', 'li.cf.example.com', '/', 'cf-li.cf:80'),
    ]);
    expect(sites).toHaveLength(2);
  });

  it('keeps a nested suffix host as its own site id', () => {
    const sites = buildSites([m('dynacom', 'registry-public-root', 'registry.s.example.com', '/', 'registry.infra:5000')]);
    expect(sites[0].id).toBe('registry.s');
    expect(sites[0].primaryUrl).toBe('https://registry.s.example.com/');
  });

  it('ignores host_rewrite: the URL stays the Mapping host', () => {
    const sites = buildSites([
      { ...m('dev', 'r8-public', 'r8.example.com', '/', 'r8.dev:80'), host: 'r8.example.com' },
    ]);
    expect(sites[0].primaryUrl).toBe('https://r8.example.com/');
  });

  it('returns an empty list for no input', () => {
    expect(buildSites([])).toEqual([]);
  });

  it('drops mappings with an empty host', () => {
    const sites = buildSites([
      m('dev', 'broken', '', '/', 'x:80'),
      m('dev', 'ok-public', 'ok.example.com', '/', 'ok.dev:80'),
    ]);
    expect(sites).toHaveLength(1);
    expect(sites[0].app).toBe('ok');
  });

  it('normalises host case and prefixes', () => {
    const sites = buildSites([m('dev', 'x', ' X.Example.com ', 'api/', 'x:80')]);
    expect(sites[0].primaryUrl).toBe('https://x.example.com/api/');
  });

  it('uses the shortest prefix on the primary host for the URL', () => {
    const sites = buildSites([
      m('dev', 'a', 'a.example.com', '/deep/path/', 'a:80'),
      m('dev', 'b', 'a.example.com', '/x/', 'a:80'),
    ]);
    expect(sites[0].primaryUrl).toBe('https://a.example.com/x/');
  });

  it('sorts sites by primary URL', () => {
    const sites = buildSites([
      m('dev', 'z', 'z.example.com', '/', 'z:80'),
      m('dev', 'a', 'a.example.com', '/', 'a:80'),
    ]);
    expect(sites.map(s => s.id)).toEqual(['a', 'z']);
  });

  it('honours configured suffixes', () => {
    const sufs = suffixesFrom({ tailnetSuffixes: 'corp.test, .other.test', lanSuffixes: 'site.test' });
    const sites = buildSites(
      [m('a', 'app-lan', 'app.site.test', '/', 's:80'), m('a', 'app-public', 'app.corp.test', '/', 's:80')],
      sufs
    );
    expect(sites).toHaveLength(1);
    expect(sites[0].primaryUrl).toBe('https://app.corp.test/');
    expect(sites[0].hosts).toEqual(['app.corp.test', 'app.site.test']);
  });
});

describe('kindOf and schemeOf', () => {
  it.each([
    ['files.example.com', 'tailnet', 'https'],
    ['tapo.example.net', 'lan', 'http'],
    ['tapo.localhost', 'local', 'http'],
    ['localhost', 'local', 'http'],
    ['example.org', 'other', 'https'],
  ])('%s', (host, kind, scheme) => {
    expect(kindOf(host)).toBe(kind);
    expect(schemeOf(kindOf(host))).toBe(scheme);
  });
});

describe('joinUrl', () => {
  it('always yields a leading slash', () => {
    expect(joinUrl('https', 'a.example.com', '/')).toBe('https://a.example.com/');
    expect(joinUrl('https', 'a.example.com', '/api/')).toBe('https://a.example.com/api/');
    expect(joinUrl('https', 'a.example.com', 'api/')).toBe('https://a.example.com/api/');
    expect(joinUrl('https', 'a.example.com', '')).toBe('https://a.example.com/');
  });
});

describe('appName', () => {
  it('prefers labels, then the Helm release, then the stripped name', () => {
    expect(appName({ name: 'x-public', labels: { 'app.kubernetes.io/name': 'files' } })).toBe('files');
    expect(appName({ name: 'x-public', labels: { 'app.kubernetes.io/part-of': 'files' } })).toBe('files');
    expect(appName({ name: 'x-public', annotations: { 'meta.helm.sh/release-name': 'files' } })).toBe('files');
    expect(appName({ name: 'tapo-public' })).toBe('tapo');
    expect(appName({ name: 'tapo-lan' })).toBe('tapo');
    expect(appName({ name: 'tapo-localhost' })).toBe('tapo');
    expect(appName({ name: 'tapo-local' })).toBe('tapo');
    expect(appName({ name: 'tapo' })).toBe('tapo');
  });
});

describe('mappingFrom', () => {
  it('reads spec.host, falling back to spec.hostname', () => {
    const meta = { name: 'a', namespace: 'n' };
    expect(mappingFrom({ metadata: meta, spec: { host: 'h.example.com', prefix: '/', service: 's:80' } }).host).toBe(
      'h.example.com'
    );
    expect(mappingFrom({ metadata: meta, spec: { hostname: 'k.example.com', service: 's:80' } }).host).toBe(
      'k.example.com'
    );
    expect(mappingFrom({ metadata: meta, spec: {} }).host).toBe('');
  });
});

describe('filters', () => {
  const sites = buildSites([
    m('apps', 'tapo-public', 'tapo.example.com', '/', 'tapo.apps:80'),
    m('dev', 'dbg-localhost', 'dbg.localhost', '/', 'dbg.dev:80'),
    m('dev', 'lan-only', 'x.example.net', '/', 'x.dev:80'),
    m('dev', 'ext', 'thing.example.org', '/', 'thing.dev:80'),
  ]);
  const ids = (f: Partial<typeof DEFAULT_FILTERS>) =>
    sites.filter(s => matchesSite(s, { ...DEFAULT_FILTERS, ...f })).map(s => s.id);

  it('defaults to tailnet only', () => {
    expect(ids({})).toEqual(['tapo']);
  });
  it('all shows everything, local shows lan and local', () => {
    expect(ids({ kind: 'all' })).toHaveLength(4);
    expect(ids({ kind: 'local' }).sort()).toEqual(['dbg', 'x']);
  });
  it('filters by namespace and free text', () => {
    expect(ids({ kind: 'all', namespaces: ['dev'] })).toHaveLength(3);
    expect(ids({ kind: 'all', q: 'THING' })).toEqual(['thing.example.org']);
    expect(ids({ kind: 'all', q: 'dbg-localhost' })).toEqual(['dbg']);
  });
  it('reports dirty filters and namespace counts', () => {
    expect(filtersDirty(DEFAULT_FILTERS)).toBe(false);
    expect(filtersDirty({ ...DEFAULT_FILTERS, q: 'a' })).toBe(true);
    expect(namespaceCounts(sites)).toEqual([
      ['apps', 1],
      ['dev', 3],
    ]);
  });
});

describe('site helpers', () => {
  it('lists aliases and extra path URLs', () => {
    const [site] = buildSites([
      m('a', 'app-public', 'app.example.com', '/', 's:80'),
      m('a', 'app-lan', 'app.example.net', '/', 's:80'),
      m('a', 'app-api', 'app.example.com', '/api/', 's:80'),
    ]);
    expect(aliasesOf(site)).toEqual(['app.example.net']);
    expect(pathUrl(site, '/api/')).toBe('https://app.example.com/api/');
  });
});
