import { describe, expect, it } from 'vitest';
import {
  buildGroups,
  gridFor,
  gridLabel,
  groupBackends,
  groupKeyOf,
  meanAvailability,
  namePrefix,
  ownName,
  Placements,
  resolveGroupBy,
  worstHistory,
  worstStatus,
} from './groups';
import { Check, DEFAULT_GRID, Status } from './model';

const check = (
  name: string,
  status: Status,
  history: (number | undefined)[] = [1, 1, 1],
  labels: Record<string, string> = {},
  type = 'http'
): Check => ({
  name,
  type,
  instance: `https://${name}/`,
  policy: 'all',
  sites: new Map(),
  status,
  labels,
  history,
});
const placed = (m: Record<string, [string, string]>): Placements =>
  new Map(
    Object.entries(m).map(([name, [namespace, app]]) => [
      name,
      {
        namespace,
        app,
        route: {
          kind: 'httproute',
          namespace,
          name: 'r',
          host: 'h',
          path: '/',
          exact: false,
          labels: {},
        },
      },
    ])
  );
const grid3 = { stepSec: 60, buckets: 3 };

describe('grouping keys', () => {
  it('uses the first word of the check name', () => {
    expect(namePrefix('t3.hq.example.com')).toBe('t3');
    expect(namePrefix('api-edge-probe-2')).toBe('api');
    expect(namePrefix('github')).toBe('github');
  });
  it('auto prefers the app, then the namespace, then the name', () => {
    const plain = [check('a-1', 'up')];
    expect(resolveGroupBy('auto', plain)).toBe('name');
    // A group label alone is not an auto choice: pick it by hand.
    expect(resolveGroupBy('auto', [check('b', 'up', [], { group: 'edge' })])).toBe('name');
    expect(resolveGroupBy('auto', [check('b', 'up', [], { app: 'web' })])).toBe('app');
    expect(resolveGroupBy('auto', [check('b', 'up', [], { namespace: 'shop' })])).toBe('namespace');
    expect(
      resolveGroupBy('auto', [
        check('b', 'up', [], { app: 'web' }),
        check('c', 'up', [], { namespace: 'shop' }),
      ])
    ).toBe('app');
    // An app that the cluster routes give (its route label, else the namespace of the route).
    expect(resolveGroupBy('auto', plain, placed({ 'a-1': ['shop', 'web'] }))).toBe('app');
    expect(resolveGroupBy('type', plain)).toBe('type');
  });
  it('reads a label, falls back to the namespace or to its own host, and upper-cases the type', () => {
    const c = check('a', 'up', [], { namespace: 'shop' }, 'tcp');
    expect(groupKeyOf(c, 'namespace')).toBe('shop');
    expect(groupKeyOf(c, 'app')).toBe('shop');
    expect(groupKeyOf(check('b', 'up', [], {}, 'tcp'), 'app')).toBe('b');
    expect(groupKeyOf(c, 'type')).toBe('TCP');
    expect(groupKeyOf(check('a', 'up', [], { app_kubernetes_io_name: 'web' }), 'app')).toBe('web');
  });
});

describe('cluster groups', () => {
  const checks = [
    check('web', 'up'),
    check('api', 'down', [1, 0, 1]),
    check('dns-a', 'up', [1, 1, 1], {}, 'dns'),
    check('dns-b', 'up', [1, 1, 1], {}, 'dns'),
    check('ssh', 'up', [1, 1, 1], {}, 'tcp'),
    check('stray', 'up'),
  ];
  const placements = placed({ web: ['shop', 'storefront'], api: ['shop', 'storefront'] });
  it('groups by app and gives each check that no route serves its own host', () => {
    const { groups, resolved } = buildGroups(checks, 'auto', grid3, false, placements);
    expect(resolved).toBe('app');
    expect(groups.map(g => g.key).sort()).toEqual(['dns-a', 'dns-b', 'ssh', 'storefront', 'stray']);
    expect(groups.find(g => g.key === 'storefront')?.checks.map(c => c.name)).toEqual([
      'web',
      'api',
    ]);
    expect(groups.flatMap(g => g.checks)).toHaveLength(checks.length);
    expect(groups.some(g => /other|ungrouped|not in cluster/i.test(g.key))).toBe(false);
  });
  it('groups by namespace with the same own-host rule', () => {
    const { groups } = buildGroups(checks, 'namespace', grid3, false, placements);
    expect(groups.map(g => g.key).sort()).toEqual(['dns-a', 'dns-b', 'shop', 'ssh', 'stray']);
  });
  it('names an unplaced check by the host of its address, else by its name', () => {
    const c = check('probe one', 'up');
    c.instance = 'https://edge.example.com:8443/health';
    expect(ownName(c)).toBe('edge.example.com');
    const d = check('plain', 'up');
    d.instance = '';
    expect(ownName(d)).toBe('plain');
    expect(groupKeyOf(c, 'group')).toBe('edge.example.com');
    expect(groupKeyOf(d, 'type')).toBe('HTTP');
    expect(groupKeyOf({ ...d, type: '' }, 'type')).toBe('plain');
  });
  it('groups by app, which falls back to the namespace of the route', () => {
    const p = placed({ web: ['shop', 'storefront'], api: ['shop', 'shop'] });
    const { groups } = buildGroups(checks, 'app', grid3, false, p);
    expect(groups.map(g => g.key)).toContain('storefront');
    expect(groups.map(g => g.key)).toContain('shop');
    expect(groups.find(g => g.key === 'shop')?.checks.map(c => c.name)).toEqual(['api']);
  });
  it('a series label wins over the cluster', () => {
    const c = check('web', 'up', [], { namespace: 'labelled' });
    expect(groupKeyOf(c, 'namespace', placements)).toBe('labelled');
  });
  it('without routes every check groups under its own name, never one Other group', () => {
    const { groups } = buildGroups(checks, 'namespace', grid3, false);
    expect(groups).toHaveLength(checks.length);
    expect(groups.every(g => g.checks.length === 1)).toBe(true);
    expect(groups.some(g => /other|ungrouped|not in cluster/i.test(g.key))).toBe(false);
  });
});

describe('group status and history', () => {
  it('the worst status wins and no data never outranks up', () => {
    expect(worstStatus([check('a', 'up'), check('b', 'down'), check('c', 'degraded')])).toBe(
      'down'
    );
    expect(worstStatus([check('a', 'up'), check('b', 'degraded')])).toBe('degraded');
    expect(worstStatus([check('a', 'up'), check('b', 'unknown')])).toBe('up');
    expect(worstStatus([check('a', 'unknown')])).toBe('unknown');
  });
  it('takes the worst value per bucket and keeps empty buckets empty', () => {
    const a = check('a', 'up', [1, 0.5, undefined]);
    const b = check('b', 'up', [0.8, 1, undefined]);
    expect(worstHistory([a, b], 3)).toEqual([0.8, 0.5, undefined]);
    expect(worstHistory([], 2)).toEqual([undefined, undefined]);
  });
  it('averages the buckets that have data', () => {
    expect(meanAvailability([1, 0, undefined])).toBe(0.5);
    expect(meanAvailability([undefined])).toBeUndefined();
  });
});

describe('buildGroups', () => {
  const checks = [
    check('web-1', 'up'),
    check('web-2', 'down', [1, 0, 1]),
    check('db-1', 'up'),
    check('cache', 'degraded', [1, 0.5, 1]),
    check('solo', 'up'),
  ];
  it('puts every check in one group, with no top-N and no Other group', () => {
    const { groups, resolved } = buildGroups(checks, 'name', grid3, false);
    expect(resolved).toBe('name');
    expect(groups.map(g => g.key)).toEqual(['web', 'cache', 'db', 'solo']);
    expect(groups.flatMap(g => g.checks).length).toBe(checks.length);
    expect(groups.find(g => g.key === 'web')).toMatchObject({
      status: 'down',
      counts: { up: 1, down: 1, degraded: 0, unknown: 0 },
      history: [1, 0, 1],
    });
  });
  it('sorts failing groups first, then by name', () => {
    const { groups } = buildGroups(checks, 'name', grid3, false);
    expect(groups.map(g => g.status)).toEqual(['down', 'degraded', 'up', 'up']);
  });
  it('only failing keeps the down and degraded groups, with all their checks', () => {
    const { groups } = buildGroups(checks, 'name', grid3, true);
    expect(groups.map(g => g.key)).toEqual(['web', 'cache']);
    expect(groups[0].checks.map(c => c.name)).toEqual(['web-1', 'web-2']);
  });
});

describe('time range', () => {
  it('maps a range to a grid of 60 to 96 buckets', () => {
    expect(gridFor('24h', '1h')).toEqual(DEFAULT_GRID);
    expect(gridFor('dashboard', '7d')).toEqual({ stepSec: 7200, buckets: 84 });
    expect(gridFor('dashboard', '5m')).toEqual({ stepSec: 60, buckets: 60 });
    expect(gridFor('6h', '30d')).toEqual({ stepSec: 300, buckets: 72 });
    expect(gridFor('30d', '1h')).toEqual({ stepSec: 28800, buckets: 90 });
  });
  it('labels the window', () => {
    expect(gridLabel(DEFAULT_GRID)).toBe('24 h');
    expect(gridLabel(gridFor('30d', ''))).toBe('30 days');
    expect(gridLabel(gridFor('7d', ''))).toBe('7 days');
  });
});

describe('groupBackends', () => {
  const be = (name: string) => ({ namespace: 'shop', name, port: '80' });
  const place = (name: string, backend?: { namespace: string; name: string; port: string }) =>
    [
      name,
      {
        namespace: 'shop',
        app: 'shop',
        route: {
          kind: 'httproute',
          namespace: 'shop',
          name,
          host: name,
          path: '/',
          exact: false,
          labels: {},
          backend,
        },
      },
    ] as const;
  const chk = (name: string): Check => ({
    name,
    type: 'http',
    instance: '',
    policy: 'all',
    sites: new Map(),
    status: 'up',
    labels: {},
    history: [],
  });
  const names = (key: string, checks: string[], pairs: ReturnType<typeof place>[]) =>
    groupBackends({ key, checks: checks.map(chk) }, new Map(pairs)).map(b => b.name);

  it('uses the one Service of a group, once, and skips a route with no Service', () => {
    expect(
      names('shop', ['a', 'b', 'c'], [place('a', be('web')), place('b', be('web')), place('c')])
    ).toEqual(['web']);
    expect(names('shop', ['zzz'], [place('a', be('web'))])).toEqual([]);
  });
  it('uses only the Services that fit the group name when the group holds several', () => {
    const checks = ['a', 'b', 'c', 'd'];
    const pairs = [
      place('a', be('store-d1')),
      place('b', be('store-kv')),
      place('c', be('store')),
      place('d', be('other')),
    ];
    // The same name first, then the names that start with it. An unrelated Service never gives its icon.
    expect(names('store', checks, pairs)).toEqual(['store', 'store-d1', 'store-kv']);
  });
  it('gives no candidate to a namespace group of unrelated apps, and caps the list', () => {
    expect(names('dev', ['a', 'b'], [place('a', be('blog')), place('b', be('wiki'))])).toEqual([]);
    const many = ['a', 'b', 'c', 'd', 'e'];
    const pairs = many.map(n => place(n, be(`app-${n}`)));
    expect(names('app', many, pairs)).toEqual(['app-a', 'app-b', 'app-c']);
  });
});

describe('failing groups first', () => {
  it('puts down first, then degraded, then no data, then up, with names in order inside each', () => {
    const checks = [
      check('b-up', 'up'),
      check('a-up', 'up'),
      check('d-deg', 'degraded'),
      check('c-deg', 'degraded'),
      check('f-down', 'down'),
      check('e-nodata', 'unknown'),
    ];
    // The name grouping uses the first word, so each check here is its own group by its first word.
    const byKey = buildGroups(
      checks.map(c => ({ ...c, name: c.name.replace('-', '') })),
      'name',
      grid3,
      false
    ).groups.map(g => `${g.key}:${g.status}`);
    expect(byKey).toEqual([
      'fdown:down',
      'cdeg:degraded',
      'ddeg:degraded',
      'enodata:unknown',
      'aup:up',
      'bup:up',
    ]);
  });
});

describe('a raw IP is not a group name', () => {
  const ipCheck = (name: string, instance: string): Check => ({
    ...check(name, 'up'),
    instance,
    type: 'tcp',
  });
  const nodes = new Map([
    ['198.51.100.7', 'node-a'],
    ['2001:db8::7', 'node-a'],
  ]);

  it('groups the address of a node under the node name', () => {
    const c = ipCheck('gateway-connect-a', '198.51.100.7:47132');
    expect(ownName(c, nodes)).toBe('node-a');
    const { groups } = buildGroups([c], 'app', grid3, false, new Map(), nodes);
    expect(groups.map(g => [g.key, g.node])).toEqual([['node-a', true]]);
  });

  it('groups two checks of one node together and marks the group as a node', () => {
    const a = ipCheck('gateway-connect-a', '198.51.100.7:47132');
    const b = ipCheck('ssh-a', '198.51.100.7:22');
    const { groups } = buildGroups([a, b], 'app', grid3, false, new Map(), nodes);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: 'node-a', node: true });
    expect(groups[0].checks).toHaveLength(2);
  });

  it('uses the check name for an address that is not a node', () => {
    const c = ipCheck('public-dns', '203.0.113.9');
    expect(ownName(c, nodes)).toBe('public-dns');
    const { groups } = buildGroups([c], 'app', grid3, false, new Map(), nodes);
    expect(groups.map(g => [g.key, g.node])).toEqual([['public-dns', false]]);
  });

  it('keeps a host name as the group name', () => {
    expect(ownName(check('edge.example.com', 'up'), nodes)).toBe('edge.example.com');
  });

  it('never marks a group as a node when a name collision mixes in another check', () => {
    const a = ipCheck('gateway-connect-a', '198.51.100.7:47132');
    const other = { ...check('node-a', 'up'), instance: 'https://node-a/' };
    const { groups } = buildGroups([a, other], 'app', grid3, false, new Map(), nodes);
    expect(groups).toHaveLength(1);
    expect(groups[0].node).toBe(false);
  });
});

describe('projects: one group for all the apps of a project', () => {
  interface Spec {
    name: string;
    namespace: string;
    /** The app label of the route, empty for a shared namespace. */
    app?: string;
    backend?: string;
    route?: string;
  }
  // A check at a route: the placement app is the app label, else the namespace (see routes.ts).
  const world = (specs: Spec[]) => {
    const checks = specs.map(s => check(s.name, 'up'));
    const placements: Placements = new Map(
      specs.map(s => [
        s.name,
        {
          namespace: s.namespace,
          app: s.app || s.namespace,
          route: {
            kind: 'httproute' as const,
            namespace: s.namespace,
            name: s.route ?? s.backend ?? s.name,
            host: `${s.name}.example.com`,
            path: '/',
            exact: false,
            labels: s.app ? { 'app.kubernetes.io/name': s.app } : {},
            backend: s.backend
              ? { namespace: s.namespace, name: s.backend, port: '80' }
              : undefined,
          },
        },
      ])
    );
    return { checks, placements };
  };
  const groupsOf = (specs: Spec[]) => {
    const { checks, placements } = world(specs);
    const { groups } = buildGroups(checks, 'auto', grid3, false, placements);
    return Object.fromEntries(groups.map(g => [g.key, g.checks.map(c => c.name).sort()]));
  };

  it('puts every ergon, playarr, t3 and walt check under one group', () => {
    const groups = groupsOf([
      { name: 'ergon', namespace: 'ergon', app: 'ergon' },
      { name: 'ergon-cluster', namespace: 'ergon-cluster', app: 'ergon' },
      { name: 'ergon-cross-preview', namespace: 'ergon-cross-preview' },
      { name: 'ergon-lite', namespace: 'ergon-lite', app: 'ergon-lite-hub' },
      { name: 'ergon-lite-push', namespace: 'ergon-lite', app: 'ergon-lite-push' },
      { name: 'ergon-storybook', namespace: 'hoarddb', app: 'static-site-ergon-storybook' },
      { name: 'playarr', namespace: 'playarr', backend: 'shadow-playarr-eu4' },
      { name: 'playarr-eu3', namespace: 'playarr', backend: 'shadow-playarr-eu3' },
      { name: 'playarr-vnc', namespace: 'playarr-vnc', app: 'playarr-vnc' },
      { name: 'playarr-wall', namespace: 'dev', backend: 'playarr-wall-legend' },
      { name: 't3.eu2.example.com', namespace: 't3-cluster', backend: 't3-eu2' },
      { name: 't3.hq.example.com', namespace: 't3-cluster', backend: 't3-hq' },
      { name: 't3-host.hq0.example.com', namespace: 't3code', backend: 't3code-host' },
      { name: 'walt', namespace: 'waltai', app: 'walt' },
      { name: 'walt-browser', namespace: 'walt-browser', app: 'walt-browser' },
      { name: 'runwarden', namespace: 'runwarden' },
      { name: 'runwarden-live', namespace: 'runwarden-live' },
      { name: 'momento', namespace: 'momento' },
    ]);
    expect(Object.keys(groups).sort()).toEqual([
      'ergon',
      'momento',
      'playarr',
      'runwarden',
      't3',
      'walt',
    ]);
    expect(groups.ergon).toHaveLength(6);
    expect(groups.playarr).toEqual(['playarr', 'playarr-eu3', 'playarr-vnc', 'playarr-wall']);
    expect(groups.t3).toHaveLength(3);
    expect(groups.walt).toEqual(['walt', 'walt-browser']);
    expect(groups.runwarden).toEqual(['runwarden', 'runwarden-live']);
  });

  it('splits a shared namespace by the project that two or more of its checks name', () => {
    const groups = groupsOf([
      { name: 'ais.example.com', namespace: 'dev', backend: 'ais' },
      { name: 'ais-gateway.example.com', namespace: 'dev', backend: 'ais-gateway' },
      { name: 'nazare-data', namespace: 'dev', backend: 'nazare-data' },
      { name: 'nazare-data-ui', namespace: 'dev', backend: 'nazare-data-ui' },
      { name: 'storagepod-blog', namespace: 'dev', backend: 'dynacom-solutions-storagepod-blog' },
    ]);
    expect(groups).toEqual({
      ais: ['ais-gateway.example.com', 'ais.example.com'],
      nazare: ['nazare-data', 'nazare-data-ui'],
      dev: ['storagepod-blog'],
    });
  });

  it('keeps an app that its own app label places, even when a Service shares the word', () => {
    // The dashboard check is named `headlamp` and its Service too, but its route says app k8s-dashboard.
    const groups = groupsOf([
      { name: 'headlamp-agent', namespace: 'headlamp-agent', app: 'headlamp-agent' },
      { name: 'headlamp', namespace: 'k8s', app: 'k8s-dashboard', backend: 'headlamp' },
      { name: 'k8s', namespace: 'k8s', app: 'k8s-dashboard' },
    ]);
    expect(groups).toEqual({
      'headlamp-agent': ['headlamp-agent'],
      'k8s-dashboard': ['headlamp', 'k8s'],
    });
  });

  it('keeps a chrome tenant out of the project with the same name', () => {
    const groups = groupsOf([
      { name: 'myriad', namespace: 'myriad', app: 'myriad' },
      { name: 'myriad.chrome.example.com', namespace: 'chrome-mcp', app: 'chrome-mcp' },
      { name: 'swap.chrome.example.com', namespace: 'chrome-mcp', app: 'chrome-mcp' },
    ]);
    expect(groups).toEqual({
      myriad: ['myriad'],
      'chrome-mcp': ['myriad.chrome.example.com', 'swap.chrome.example.com'],
    });
  });

  it('never makes a group of one project with one key and one check, and never an Other group', () => {
    const groups = groupsOf([
      {
        name: 'static-site-check',
        namespace: 'static-sites',
        app: 'static-site-static-site-check',
      },
      { name: 'cluster-artifacts', namespace: 'cluster-artifacts', app: 'cluster-artifacts' },
    ]);
    expect(Object.keys(groups).sort()).toEqual([
      'cluster-artifacts',
      'static-site-static-site-check',
    ]);
    expect(Object.keys(groups).some(k => /other/i.test(k))).toBe(false);
  });

  it('keeps the worst status and the count of the merged group', () => {
    const checks = [check('ergon', 'up'), check('ergon-lite', 'down'), check('ergon-push', 'up')];
    const placements = placed({
      ergon: ['ergon', 'ergon'],
      'ergon-lite': ['ergon-lite', 'ergon-lite'],
      'ergon-push': ['ergon-lite', 'ergon-push'],
    });
    const { groups } = buildGroups(checks, 'auto', grid3, false, placements);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: 'ergon', status: 'down' });
    expect(groups[0].counts).toMatchObject({ up: 2, down: 1 });
  });

  it('does not merge when the user groups by namespace or by name', () => {
    const checks = [check('ergon', 'up'), check('ergon-lite', 'up')];
    const placements = placed({ ergon: ['a', 'ergon'], 'ergon-lite': ['b', 'ergon-lite'] });
    expect(
      buildGroups(checks, 'namespace', grid3, false, placements)
        .groups.map(g => g.key)
        .sort()
    ).toEqual(['a', 'b']);
  });
});
