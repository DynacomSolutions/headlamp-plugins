import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request, clusterRequest } = vi.hoisted(() => ({
  request: vi.fn(),
  clusterRequest: vi.fn(),
}));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request, clusterRequest },
  ConfigStore: class {},
}));

import { parsePanel, safeIconPath } from './model';
import {
  acquireIcon,
  clearIconCache,
  FAILURE_RETRY_MS,
  ICON_MAX_BYTES,
  loadIcon,
  mediaType,
  releaseIcon,
} from './rowIcons';
import { agentSource, blankDraft, draftToSource, iconUrl } from './sources';

const agent = agentSource(undefined);
const hoard = draftToSource({
  ...blankDraft('hoard'),
  kind: 'service',
  namespace: 'hoarddb',
  service: 'hoarddb-widgets',
  port: '80',
});
const app = draftToSource({
  ...blankDraft('my-app'),
  kind: 'url',
  baseUrl: 'https://my-app.example.com/',
});

const iconResponse = (
  type: string | null,
  bytes: number | Uint8Array = 10,
  extra: Record<string, string> = {}
): Response => {
  const body = typeof bytes === 'number' ? new Uint8Array(bytes) : bytes;
  const headers = new Map<string, string>(Object.entries(extra));
  if (type !== null) headers.set('content-type', type);
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: () => Promise.resolve(body.buffer.slice(0)),
  } as unknown as Response;
};

describe('safeIconPath', () => {
  it.each(['icons/postgresql.svg', 'icons/a-b_c.v2.png', 'x.SVG', 'a/b/c.svg'])('accepts %s', p => {
    expect(safeIconPath(p)).toBe(p);
  });
  it.each([
    'https://x/a.svg',
    'http://x/a.svg',
    'data:image/svg+xml,<svg/>',
    '//x/a.svg',
    '/abs.svg',
    '../a.svg',
    'icons/../a.svg',
    './a.svg',
    'icons//a.svg',
    'a.svg?x',
    'a.svg#x',
    'a.js',
    'a.svg.js',
    'icons\\a.svg',
    'icons/a%2e%2e.svg',
    'icons/a b.svg',
    '',
    '.svg/',
    `${'a'.repeat(200)}.svg`,
    42,
    null,
    { src: 'a.svg' },
  ])('drops %j', p => {
    expect(safeIconPath(p)).toBeUndefined();
  });
});

describe('icon in a panel row', () => {
  const rows = (icon: unknown) =>
    parsePanel({ version: 1, id: 'p', rows: [{ label: 'Main', value: '1', icon }] }).rows;
  it('keeps a good icon and defaults alt to the row label', () => {
    expect(rows({ src: 'icons/postgresql.svg', alt: 'PostgreSQL' })[0].icon).toEqual({
      src: 'icons/postgresql.svg',
      alt: 'PostgreSQL',
    });
    expect(rows({ src: 'icons/postgresql.svg' })[0].icon?.alt).toBe('Main');
    expect(rows({ src: 'icons/postgresql.svg', alt: '  ' })[0].icon?.alt).toBe('Main');
  });
  it('drops a bad icon and keeps the row', () => {
    for (const bad of [
      { src: 'https://x/a.svg' },
      { src: '/abs.svg' },
      { src: '../a.svg' },
      { src: 'a.svg?x' },
      { src: 'a.js' },
      'icons/a.svg',
      7,
      null,
    ]) {
      const r = rows(bad);
      expect(r).toHaveLength(1);
      expect(r[0].label).toBe('Main');
      expect(r[0].icon).toBeUndefined();
    }
  });
  it('caps a long alt text', () => {
    expect(rows({ src: 'a.svg', alt: 'x'.repeat(500) })[0].icon?.alt).toHaveLength(80);
  });
});

describe('iconUrl', () => {
  it('gives the service proxy path under /api/widgets/', () => {
    expect(iconUrl(hoard, 'icons/postgresql.svg')).toBe(
      '/api/v1/namespaces/hoarddb/services/hoarddb-widgets:80/proxy/api/widgets/icons/postgresql.svg'
    );
  });
  it('keeps the path prefix of a service source', () => {
    expect(iconUrl({ ...agent, pathPrefix: '/my-app' }, 'icons/a.png')).toBe(
      '/api/v1/namespaces/headlamp-agent/services/headlamp-agent:80/proxy/my-app/api/widgets/icons/a.png'
    );
  });
  it('is relative to the base of a URL source', () => {
    expect(iconUrl(app, 'icons/postgresql.svg')).toBe(
      'https://my-app.example.com/api/widgets/icons/postgresql.svg'
    );
  });
});

describe('mediaType', () => {
  it('drops the parameters and the case', () => {
    expect(mediaType('Image/SVG+XML; charset=utf-8')).toBe('image/svg+xml');
    expect(mediaType(null)).toBe('');
  });
});

describe('icon fetch', () => {
  let n = 0;
  beforeEach(() => {
    request.mockReset();
    n = 0;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => `blob:test/${++n}`),
      revokeObjectURL: vi.fn(),
    });
    clearIconCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fetches an icon once per source and path, even for many callers', async () => {
    request.mockResolvedValue(iconResponse('image/svg+xml'));
    const all = await Promise.all(
      Array.from({ length: 10 }, () => loadIcon(hoard, 'icons/postgresql.svg'))
    );
    await loadIcon(hoard, 'icons/postgresql.svg');
    expect(all.every(b => b !== null)).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe(iconUrl(hoard, 'icons/postgresql.svg'));
    expect(request.mock.calls[0][1]).toMatchObject({ isJSON: false });
    await loadIcon(hoard, 'icons/other.svg');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('keeps the cache apart per source', async () => {
    request.mockResolvedValue(iconResponse('image/png'));
    await loadIcon(hoard, 'icons/a.png');
    await loadIcon(agent, 'icons/a.png');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('uses fetch with the cookies for a URL source', async () => {
    const f = vi.fn().mockResolvedValue(iconResponse('image/png'));
    vi.stubGlobal('fetch', f);
    expect(await loadIcon(app, 'icons/a.png')).not.toBeNull();
    expect(f.mock.calls[0][0]).toBe('https://my-app.example.com/api/widgets/icons/a.png');
    expect(f.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
    expect(request).not.toHaveBeenCalled();
  });
  it('gives null for a wrong content type, and for no content type', async () => {
    request.mockResolvedValueOnce(iconResponse('text/html'));
    request.mockResolvedValueOnce(iconResponse(null));
    request.mockResolvedValueOnce(iconResponse('application/json'));
    expect(await loadIcon(hoard, 'icons/a.svg')).toBeNull();
    expect(await loadIcon(hoard, 'icons/b.svg')).toBeNull();
    expect(await loadIcon(hoard, 'icons/c.svg')).toBeNull();
  });
  it('accepts a content type with parameters', async () => {
    request.mockResolvedValue(iconResponse('image/svg+xml; charset=utf-8'));
    const blob = await loadIcon(hoard, 'icons/a.svg');
    expect(blob?.type).toBe('image/svg+xml');
  });
  it('gives null for a body that is too large, by header or by size', async () => {
    request.mockResolvedValueOnce(
      iconResponse('image/svg+xml', 10, { 'content-length': String(ICON_MAX_BYTES + 1) })
    );
    request.mockResolvedValueOnce(iconResponse('image/svg+xml', ICON_MAX_BYTES + 1));
    request.mockResolvedValueOnce(iconResponse('image/svg+xml', ICON_MAX_BYTES));
    expect(await loadIcon(hoard, 'icons/a.svg')).toBeNull();
    expect(await loadIcon(hoard, 'icons/b.svg')).toBeNull();
    expect((await loadIcon(hoard, 'icons/c.svg'))?.size).toBe(ICON_MAX_BYTES);
  });
  it('gives null for a failed request, quietly', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    request.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    expect(await loadIcon(hoard, 'icons/a.svg')).toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });
  it('does not retry a failure at once, but retries it after a while', async () => {
    let now = 1000;
    request.mockRejectedValueOnce(new Error('down'));
    request.mockResolvedValueOnce(iconResponse('image/svg+xml'));
    expect(await loadIcon(hoard, 'icons/a.svg', () => now)).toBeNull();
    expect(await loadIcon(hoard, 'icons/a.svg', () => now)).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    now += FAILURE_RETRY_MS + 1;
    expect(await loadIcon(hoard, 'icons/a.svg', () => now)).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('shares one object URL and revokes it with the last use', async () => {
    request.mockResolvedValue(iconResponse('image/svg+xml'));
    const a = await acquireIcon(hoard, 'icons/a.svg');
    const b = await acquireIcon(hoard, 'icons/a.svg');
    expect(a).toBe('blob:test/1');
    expect(b).toBe(a);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    releaseIcon(hoard, 'icons/a.svg');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    releaseIcon(hoard, 'icons/a.svg');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test/1');
    // The bytes stay cached: a later use makes a new object URL and no new request.
    const c = await acquireIcon(hoard, 'icons/a.svg');
    expect(c).toBe('blob:test/2');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('gives no object URL for a failed icon', async () => {
    request.mockResolvedValue(iconResponse('text/html'));
    expect(await acquireIcon(hoard, 'icons/a.svg')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
