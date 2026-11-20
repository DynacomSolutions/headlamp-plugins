import { describe, expect, it } from 'vitest';
import {
  agentSource,
  blankDraft,
  DEFAULT_AGENT,
  draftProblem,
  draftToSource,
  listUrl,
  normalisePrefix,
  overriddenClusterIds,
  panelUrl,
  parseClusterSources,
  readDrafts,
  resolveSources,
  serialiseClusterSources,
  SOURCES_KEY,
  sourceUrl,
} from './sources';

describe('agent source (migrated from the old setting)', () => {
  it('uses the defaults for a blank or missing setting', () => {
    expect(agentSource(undefined)).toEqual({
      id: 'agent',
      title: 'Agent',
      kind: 'service',
      namespace: DEFAULT_AGENT.namespace,
      service: DEFAULT_AGENT.service,
      port: DEFAULT_AGENT.port,
      pathPrefix: '',
    });
  });
  it('keeps the old values, trims them and accepts a numeric port', () => {
    expect(
      agentSource({ agentNamespace: ' ops ', agentService: '', agentPort: 8080 })
    ).toMatchObject({ namespace: 'ops', service: DEFAULT_AGENT.service, port: '8080' });
  });
  it('is always the first source, whatever else is stored', () => {
    const list = resolveSources({
      agentNamespace: 'ops',
      [SOURCES_KEY]: [{ id: 'my-app', kind: 'url', baseUrl: 'https://my-app.example.com' }],
    });
    expect(list.map(s => s.id)).toEqual(['agent', 'my-app']);
    expect(list[0]).toMatchObject({ namespace: 'ops' });
  });
  it('gives only the agent when no source list is stored', () => {
    expect(resolveSources({}).map(s => s.id)).toEqual(['agent']);
    expect(resolveSources({ [SOURCES_KEY]: 'broken' }).map(s => s.id)).toEqual(['agent']);
  });
});

describe('source list', () => {
  const good = {
    id: 'my-app',
    title: 'My app',
    icon: 'mdi:server',
    kind: 'service' as const,
    namespace: 'apps',
    service: 'my-app',
    port: '8080',
    pathPrefix: 'my-app/',
  };
  it('reads drafts and drops entries that are not objects', () => {
    expect(readDrafts({ [SOURCES_KEY]: [good, 3, null, []] })).toHaveLength(1);
    expect(readDrafts({ [SOURCES_KEY]: [{ id: 'a', kind: 'weird', port: 80 }] })[0]).toMatchObject({
      kind: 'service',
      port: '80',
    });
  });
  it('turns a valid draft into a source with a clean prefix and a default title', () => {
    expect(draftToSource({ ...blankDraft('x'), ...good })).toEqual({
      id: 'my-app',
      title: 'My app',
      icon: 'mdi:server',
      kind: 'service' as const,
      namespace: 'apps',
      service: 'my-app',
      port: '8080',
      pathPrefix: '/my-app',
    });
    expect(
      draftToSource({ ...blankDraft('x'), kind: 'url', baseUrl: 'https://my-app.example.com//' })
    ).toMatchObject({ title: 'x', baseUrl: 'https://my-app.example.com', icon: undefined });
  });
  it('skips invalid and repeated entries', () => {
    const list = resolveSources({
      [SOURCES_KEY]: [
        good,
        { ...good },
        { ...good, id: 'agent' },
        { ...good, id: 'Bad Id' },
        { ...good, id: 'no-ns', namespace: '' },
        { id: 'u', kind: 'url', baseUrl: 'ftp://x' },
        { id: 'ok', kind: 'url', baseUrl: 'https://x.example.com' },
      ],
    });
    expect(list.map(s => s.id)).toEqual(['agent', 'my-app', 'ok']);
  });
  it('explains why a draft is not valid', () => {
    expect(draftProblem(blankDraft(''))).toMatch(/id must/);
    expect(draftProblem({ ...blankDraft('agent'), namespace: 'a', service: 'b' })).toMatch(
      /already used/
    );
    expect(draftProblem({ ...blankDraft('a'), service: 'b' })).toMatch(/namespace is required/);
    expect(
      draftProblem({ ...blankDraft('a'), namespace: 'n', service: 's', icon: 'server' })
    ).toMatch(/mdi:/);
    expect(draftProblem({ ...blankDraft('a'), kind: 'url', baseUrl: 'not a url' })).toMatch(
      /full URL/
    );
    expect(draftProblem({ ...blankDraft('a'), namespace: 'n', service: 's' }, ['a'])).toMatch(
      /already used/
    );
    expect(draftProblem({ ...blankDraft('a'), namespace: 'n', service: 's' })).toBeNull();
  });
});

describe('URL building', () => {
  it('builds the service proxy path, with and without a prefix', () => {
    const a = agentSource(undefined);
    expect(listUrl(a)).toBe(
      '/api/v1/namespaces/headlamp-agent/services/headlamp-agent:80/proxy/api/widgets'
    );
    const s = draftToSource({
      ...blankDraft('my-app'),
      namespace: 'apps',
      service: 'my-app',
      port: 'http',
      pathPrefix: '/my-app/',
    });
    expect(listUrl(s)).toBe(
      '/api/v1/namespaces/apps/services/my-app:http/proxy/my-app/api/widgets'
    );
    expect(panelUrl(s, 'a b')).toBe(
      '/api/v1/namespaces/apps/services/my-app:http/proxy/my-app/api/widgets/a%20b'
    );
  });
  it('leaves the port out when it is blank and escapes odd names', () => {
    expect(
      sourceUrl(
        {
          id: 'x',
          title: 'x',
          kind: 'service',
          namespace: 'a b',
          service: 's',
          port: '',
          pathPrefix: '',
        },
        'x'
      )
    ).toBe('/api/v1/namespaces/a%20b/services/s/proxy/x');
  });
  it('builds a direct URL from the base URL', () => {
    const u = draftToSource({
      ...blankDraft('my-app'),
      kind: 'url',
      baseUrl: 'https://my-app.example.com/base/',
    });
    expect(listUrl(u)).toBe('https://my-app.example.com/base/api/widgets');
    expect(panelUrl(u, 'uptime')).toBe('https://my-app.example.com/base/api/widgets/uptime');
  });
  it('normalises a path prefix', () => {
    expect(normalisePrefix('')).toBe('');
    expect(normalisePrefix('/')).toBe('');
    expect(normalisePrefix('a/b/')).toBe('/a/b');
  });
});

describe('draft rules that keep a source safe in a URL path', () => {
  const ok = { ...blankDraft('a'), namespace: 'n', service: 's' };
  it('accepts names, ports and prefixes that Kubernetes allows', () => {
    expect(draftProblem({ ...ok, port: 'widgets', pathPrefix: '/my-app/v1.2' })).toBeNull();
    expect(draftProblem({ ...ok, port: '65535' })).toBeNull();
  });
  it('rejects names that are not Kubernetes names', () => {
    expect(draftProblem({ ...ok, namespace: '..' })).toMatch(/namespace must/);
    expect(draftProblem({ ...ok, namespace: 'A/b' })).toMatch(/namespace must/);
    expect(draftProblem({ ...ok, service: 'x/../y' })).toMatch(/service must/);
    expect(draftProblem({ ...ok, service: 'a:80' })).toMatch(/service must/);
  });
  it('rejects a bad port', () => {
    expect(draftProblem({ ...ok, port: '0' })).toMatch(/port must/);
    expect(draftProblem({ ...ok, port: '70000' })).toMatch(/port must/);
    expect(draftProblem({ ...ok, port: '80/x' })).toMatch(/port must/);
  });
  it('rejects a prefix that climbs out of the proxy path', () => {
    expect(draftProblem({ ...ok, pathPrefix: '/../api' })).toMatch(/path prefix/);
    expect(draftProblem({ ...ok, pathPrefix: '/a/./b' })).toMatch(/path prefix/);
    expect(draftProblem({ ...ok, pathPrefix: '/a b' })).toMatch(/path prefix/);
    expect(draftProblem({ ...ok, pathPrefix: '/a?x=1' })).toMatch(/path prefix/);
  });
  it('rejects a URL with a password, and a long title', () => {
    expect(
      draftProblem({
        ...blankDraft('u'),
        kind: 'url',
        baseUrl: ['https://me:pw', 'x.example.com'].join('@'),
      })
    ).toMatch(/user name/);
    expect(draftProblem({ ...ok, title: 'x'.repeat(81) })).toMatch(/title/);
  });
});

describe('cluster sources', () => {
  const svc = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: id.toUpperCase(),
    icon: 'mdi:database',
    kind: 'service',
    namespace: 'apps',
    service: id,
    port: '80',
    ...extra,
  });
  const file = (sources: unknown[], version: unknown = 1) => JSON.stringify({ version, sources });

  it('reads a valid file', () => {
    const r = parseClusterSources(file([svc('one'), svc('two', { port: 'widgets' })]));
    expect(r.problems).toEqual([]);
    expect(r.sources.map(s => s.id)).toEqual(['one', 'two']);
    expect(r.sources[0]).toMatchObject({ kind: 'service', pathPrefix: '', title: 'ONE' });
  });
  it('gives a reason and no sources for a file that cannot be used', () => {
    expect(parseClusterSources(undefined).problems[0]).toMatch(/no "sources.json" key/);
    expect(parseClusterSources('{').problems[0]).toMatch(/not valid JSON/);
    expect(parseClusterSources('[]').problems[0]).toMatch(/must be an object/);
    expect(parseClusterSources(file([svc('a')], 2)).problems[0]).toMatch(/unsupported version/);
    expect(parseClusterSources('{"version":1}').problems[0]).toMatch(/no "sources" list/);
    expect(parseClusterSources(' '.repeat(70 * 1024)).problems[0]).toMatch(/larger than/);
    expect(parseClusterSources('{}').sources).toEqual([]);
  });
  it('ignores an unsafe or repeated entry and keeps the rest', () => {
    const r = parseClusterSources(
      file([
        svc('good'),
        svc('good'),
        svc('agent'),
        svc('bad-ns', { namespace: '../x' }),
        svc('bad-prefix', { pathPrefix: '/../../x' }),
        { id: 'ftp', kind: 'url', baseUrl: 'ftp://x.example.com' },
        { id: 'js', kind: 'url', baseUrl: 'javascript:alert(1)' },
        { id: 'cred', kind: 'url', baseUrl: ['https://u:p', 'x.example.com'].join('@') },
        'text',
        null,
        { id: 'ok-url', kind: 'url', baseUrl: 'https://x.example.com/' },
      ])
    );
    expect(r.sources.map(s => s.id)).toEqual(['good', 'ok-url']);
    expect(r.sources[1]).toMatchObject({ baseUrl: 'https://x.example.com' });
    expect(r.problems).toHaveLength(9);
    expect(r.problems.join('\n')).toMatch(/"bad-ns" was ignored/);
  });
  it('limits the number of sources and the length of an id in a message', () => {
    const many = Array.from({ length: 60 }, (_, i) => svc(`s${i}`));
    const r = parseClusterSources(file(many));
    expect(r.sources).toHaveLength(50);
    expect(r.problems.at(-1)).toMatch(/first 50/);
    const long = parseClusterSources(file([{ id: 'Z'.repeat(500) }]));
    expect(long.problems[0].length).toBeLessThan(200);
  });
  it('writes a file that reads back the same', () => {
    const r = parseClusterSources(
      file([svc('one'), { id: 'u', kind: 'url', baseUrl: 'https://x.example.com' }])
    );
    const back = parseClusterSources(serialiseClusterSources(r.sources));
    expect(back.problems).toEqual([]);
    expect(back.sources).toEqual(r.sources);
    expect(JSON.parse(serialiseClusterSources(r.sources)).version).toBe(1);
  });

  it('lists the agent, then the cluster sources, then the browser sources', () => {
    const cluster = parseClusterSources(file([svc('c1'), svc('c2')])).sources;
    const stored = { [SOURCES_KEY]: [svc('mine')] };
    expect(resolveSources(stored, cluster).map(s => s.id)).toEqual(['agent', 'c1', 'c2', 'mine']);
    expect(resolveSources(undefined, cluster).map(s => s.id)).toEqual(['agent', 'c1', 'c2']);
  });
  it('lets a browser source win on an id clash, and reports it', () => {
    const cluster = parseClusterSources(file([svc('c1'), svc('c2')])).sources;
    const stored = { [SOURCES_KEY]: [svc('c2', { namespace: 'mine', title: 'Mine' })] };
    const list = resolveSources(stored, cluster);
    expect(list.map(s => s.id)).toEqual(['agent', 'c1', 'c2']);
    expect(list.find(s => s.id === 'c2')).toMatchObject({ namespace: 'mine', title: 'Mine' });
    expect([...overriddenClusterIds(stored, cluster)]).toEqual(['c2']);
    expect(overriddenClusterIds(undefined, cluster).size).toBe(0);
  });
  it('never lets a cluster source replace the agent', () => {
    const forged = [{ ...svc('agent'), kind: 'service' as const, pathPrefix: '' }];
    expect(resolveSources(undefined, forged).map(s => s.id)).toEqual(['agent']);
    expect(resolveSources(undefined, forged)[0]).toMatchObject({ namespace: 'headlamp-agent' });
  });
});
