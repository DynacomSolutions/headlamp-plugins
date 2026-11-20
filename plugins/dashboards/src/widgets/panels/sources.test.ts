import { describe, expect, it } from 'vitest';
import {
  agentSource,
  blankDraft,
  DEFAULT_AGENT,
  draftProblem,
  draftToSource,
  listUrl,
  normalisePrefix,
  panelUrl,
  readDrafts,
  resolveSources,
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
