import { beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request } }));

import {
  clearClusterCache,
  fetchClusterInfo,
  iconMapFrom,
  mapIconFor,
  nodeAddressesFrom,
} from './clusterApi';

const svg = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>';

beforeEach(() => {
  request.mockReset();
  clearClusterCache();
});

describe('nodeAddressesFrom', () => {
  it('maps internal and external addresses to the node name, and ignores host names', () => {
    const items = [
      {
        metadata: { name: 'node-a' },
        status: {
          addresses: [
            { type: 'InternalIP', address: '198.51.100.7' },
            { type: 'ExternalIP', address: '203.0.113.7' },
            { type: 'Hostname', address: 'node-a' },
          ],
        },
      },
      { metadata: {}, status: { addresses: [{ type: 'InternalIP', address: '198.51.100.8' }] } },
    ];
    expect([...nodeAddressesFrom(items)]).toEqual([
      ['198.51.100.7', 'node-a'],
      ['203.0.113.7', 'node-a'],
    ]);
  });

  it('gives an empty map for a bad answer', () => {
    expect(nodeAddressesFrom(undefined).size).toBe(0);
    expect(nodeAddressesFrom({}).size).toBe(0);
  });
});

describe('iconMapFrom and mapIconFor', () => {
  const map = iconMapFrom({
    data: {
      App: svg,
      shop: svg,
      'shop-admin': 'data:image/svg+xml;utf8,<svg/>',
      bad: 'https://example.com/icon.png',
      html: 'data:text/html;base64,AAAA',
      num: 5,
    },
  });

  it('keeps only small data images, with lower-case keys', () => {
    expect([...map.keys()].sort()).toEqual(['app', 'shop', 'shop-admin']);
  });

  it('drops a value that is too large', () => {
    const big = `data:image/png;base64,${'A'.repeat(200 * 1024)}`;
    expect(iconMapFrom({ data: { big } }).size).toBe(0);
  });

  it('finds the exact name, then the longest key that starts the name at a dash or a dot', () => {
    expect(mapIconFor('App', map)).toBe(svg);
    expect(mapIconFor('shop-admin', map)).toBe('data:image/svg+xml;utf8,<svg/>');
    expect(mapIconFor('shop-staging', map)).toBe(svg);
    expect(mapIconFor('shop.example.com', map)).toBe(svg);
    expect(mapIconFor('shopping', map)).toBeUndefined();
    expect(mapIconFor('other', map)).toBeUndefined();
  });
});

describe('fetchClusterInfo', () => {
  it('reads the nodes and the icon map once for a minute', async () => {
    request.mockImplementation(async (url: string) =>
      url === '/api/v1/nodes'
        ? {
            items: [
              {
                metadata: { name: 'node-a' },
                status: { addresses: [{ type: 'InternalIP', address: '198.51.100.7' }] },
              },
            ],
          }
        : { data: { app: svg } }
    );
    const first = fetchClusterInfo(1000);
    expect((await first.nodes).get('198.51.100.7')).toBe('node-a');
    expect((await first.icons).get('app')).toBe(svg);
    fetchClusterInfo(30_000);
    expect(request).toHaveBeenCalledTimes(2);
    fetchClusterInfo(70_000);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('keeps an absent icon map (404) for the minute, but tries again after any other failure', async () => {
    request.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    await (
      await Promise.resolve(fetchClusterInfo(1))
    ).icons;
    fetchClusterInfo(2);
    expect(request).toHaveBeenCalledTimes(2);
    request.mockReset();
    clearClusterCache();
    request.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 }));
    await (
      await Promise.resolve(fetchClusterInfo(1))
    ).icons;
    fetchClusterInfo(2);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('gives empty results when a read fails, so the widget goes on without them', async () => {
    request.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const info = fetchClusterInfo(1);
    expect((await info.nodes).size).toBe(0);
    expect((await info.icons).size).toBe(0);
  });
});

describe('icons of the project groups', () => {
  // The keys of the icon map for these apps: a key also covers the groups that start with it and a dash.
  const icon = (n: string) => `data:image/svg+xml;utf8,<svg id="${n}"/>`;
  const keys = [
    'cloudflare',
    'corp',
    'corp-dev-watcher',
    'acme',
    'console-agent',
    'lidarr',
    'zeta',
    'plex',
    'qui',
    'radarr',
    'gamma',
    'sonarr',
    'beta',
    'delta',
    'orbit',
    'whisparr',
  ];
  const map = iconMapFrom({ data: Object.fromEntries(keys.map(k => [k, icon(k)])) });

  it('finds the icon of every project group by its own key', () => {
    for (const k of keys) expect(mapIconFor(k, map)).toBe(icon(k));
  });

  it('covers the groups that start with the project name', () => {
    expect(mapIconFor('cloudflare-dns', map)).toBe(icon('cloudflare'));
    expect(mapIconFor('gamma-live', map)).toBe(icon('gamma'));
    expect(mapIconFor('beta-cluster', map)).toBe(icon('beta'));
    expect(mapIconFor('acme-lite-hub', map)).toBe(icon('acme'));
  });

  it('takes the longest key, and never an icon for a name that only shares letters', () => {
    expect(mapIconFor('corp-dev-watcher', map)).toBe(icon('corp-dev-watcher'));
    expect(mapIconFor('corp-registry', map)).toBe(icon('corp'));
    expect(mapIconFor('betacode', map)).toBeUndefined();
    expect(mapIconFor('console', map)).toBeUndefined();
    expect(mapIconFor('sigma-tts', map)).toBeUndefined();
  });
});
