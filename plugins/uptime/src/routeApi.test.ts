import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request } }));

import { clearRouteCache, fetchRouteLists, ROUTE_CACHE_MS, ROUTE_LISTS } from './routeApi';

beforeEach(() => {
  clearRouteCache();
  request.mockReset();
  request.mockImplementation(async (url: string) => ({ items: [{ metadata: { name: url } }] }));
});
afterEach(clearRouteCache);

describe('route lists', () => {
  it('lists each kind once for the whole cluster', async () => {
    const r = await fetchRouteLists(0);
    expect(request.mock.calls.map(c => c[0]).sort()).toEqual(Object.values(ROUTE_LISTS).sort());
    expect(r.routes.httproutes).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });
  it('shares one set of lists between widgets that refresh together, then lists again', async () => {
    await Promise.all([fetchRouteLists(0), fetchRouteLists(10), fetchRouteLists(ROUTE_CACHE_MS - 1)]);
    expect(request).toHaveBeenCalledTimes(3);
    await fetchRouteLists(ROUTE_CACHE_MS + 1);
    expect(request).toHaveBeenCalledTimes(6);
  });
  it('treats an absent kind as empty and reports a kind that is not allowed', async () => {
    request.mockImplementation(async (url: string) => {
      if (url === ROUTE_LISTS.mappings) throw Object.assign(new Error('nf'), { status: 404 });
      if (url === ROUTE_LISTS.ingresses) throw Object.assign(new Error('no'), { status: 403 });
      return { items: [{}] };
    });
    const r = await fetchRouteLists(0);
    expect(r.routes.mappings).toEqual([]);
    expect(r.routes.ingresses).toEqual([]);
    expect(r.routes.httproutes).toHaveLength(1);
    expect(r.errors).toEqual(['ingresses: not allowed']);
  });
  it('does not keep a set that had an error', async () => {
    request.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    const first = await fetchRouteLists(0);
    expect(first.errors).toHaveLength(1);
    request.mockClear();
    await fetchRouteLists(10);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
