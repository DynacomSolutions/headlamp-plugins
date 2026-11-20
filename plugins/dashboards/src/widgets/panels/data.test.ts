import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request }, ConfigStore: class {} }));

import { clearPanelListCache, fetchPanel, fetchPanelList, shared, statusMessage, testSource } from './data';
import { agentSource, blankDraft, draftToSource } from './sources';

const agent = agentSource(undefined);
const url = draftToSource({ ...blankDraft('my-app'), kind: 'url', baseUrl: 'https://my-app.example.com' });
const LIST = { version: 1, panels: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] };
const PANEL = { version: 1, id: 'a', title: 'A' };

const response = (status: number, body: unknown, json = true): Response =>
  ({ ok: status >= 200 && status < 300, status, json: () => (json ? Promise.resolve(body) : Promise.reject(new SyntaxError('x'))) }) as unknown as Response;

beforeEach(() => {
  request.mockReset();
  clearPanelListCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('shared request cache', () => {
  it('runs one request for ten callers at the same time', async () => {
    const load = vi.fn(() => Promise.resolve(1));
    await Promise.all(Array.from({ length: 10 }, () => shared('k', 0, load)));
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('reuses a finished answer inside the ttl and asks again after it', async () => {
    let now = 1000;
    const load = vi.fn(() => Promise.resolve(1));
    await shared('k', 60_000, load, () => now);
    now += 30_000;
    await shared('k', 60_000, load, () => now);
    expect(load).toHaveBeenCalledTimes(1);
    now += 31_000;
    await shared('k', 60_000, load, () => now);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('does not keep a failure', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('no')).mockResolvedValueOnce(2);
    await expect(shared('k', 60_000, load)).rejects.toThrow('no');
    await expect(shared('k', 60_000, load)).resolves.toBe(2);
  });
  it('keeps sources apart', async () => {
    request.mockResolvedValue(LIST);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, LIST)));
    await Promise.all([fetchPanelList(agent), fetchPanelList(agent), fetchPanelList(url), fetchPanelList(url)]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('fetching from a service source', () => {
  it('lists the panels once for many widgets and validates the shape', async () => {
    request.mockResolvedValue(LIST);
    const lists = await Promise.all(Array.from({ length: 10 }, () => fetchPanelList(agent)));
    expect(request).toHaveBeenCalledTimes(1);
    expect(lists[0].map(p => p.id)).toEqual(['a', 'b']);
  });
  it('shares one panel request and reuses it for the refresh time of the panel', async () => {
    request.mockResolvedValue(PANEL);
    await Promise.all([fetchPanel(agent, 'a', 60), fetchPanel(agent, 'a', 60)]);
    await fetchPanel(agent, 'a', 60);
    expect(request).toHaveBeenCalledTimes(1);
    await fetchPanel(agent, 'a', 0);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('turns a 403 and a 404 into clear messages', async () => {
    request.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    await expect(fetchPanelList(agent)).rejects.toThrow(/Access denied \(403\).*Kubernetes permissions/);
    request.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));
    await expect(fetchPanelList(agent)).rejects.toThrow(/Not found \(404\)/);
  });
  it('rejects a wrong shape', async () => {
    request.mockResolvedValueOnce([{ id: 'a' }]);
    await expect(fetchPanelList(agent)).rejects.toThrow(/not a panel list/);
    request.mockResolvedValueOnce({ version: 9, id: 'a' });
    await expect(fetchPanel(agent, 'a', 0)).rejects.toThrow(/version 9/);
  });
});

describe('fetching from a URL source', () => {
  it('calls the address directly with credentials', async () => {
    const f = vi.fn().mockResolvedValue(response(200, PANEL));
    vi.stubGlobal('fetch', f);
    expect((await fetchPanel(url, 'a', 0)).id).toBe('a');
    expect(f).toHaveBeenCalledWith('https://my-app.example.com/api/widgets/a', expect.objectContaining({ credentials: 'include' }));
    expect(request).not.toHaveBeenCalled();
  });
  it('explains a CORS or network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(fetchPanelList(url)).rejects.toThrow(/CORS/);
  });
  it('explains 403, 404, other statuses and a body that is not JSON', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    f.mockResolvedValueOnce(response(403, null));
    await expect(fetchPanelList(url)).rejects.toThrow(/Access denied \(403\).*Sign in/);
    f.mockResolvedValueOnce(response(404, null));
    await expect(fetchPanelList(url)).rejects.toThrow(/Not found \(404\)/);
    f.mockResolvedValueOnce(response(502, null));
    await expect(fetchPanelList(url)).rejects.toThrow(/HTTP 502/);
    f.mockResolvedValueOnce(response(200, null, false));
    await expect(fetchPanelList(url)).rejects.toThrow(/not send JSON/);
    expect(statusMessage(401, 'url')).toMatch(/401/);
  });
});

describe('testSource', () => {
  it('gives the panel count and skips the cache', async () => {
    request.mockResolvedValue(LIST);
    expect(await testSource(agent)).toBe(2);
    request.mockResolvedValue({ version: 1, panels: [{ id: 'x' }] });
    expect(await testSource(agent)).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('throws the clear message on failure', async () => {
    request.mockRejectedValue(Object.assign(new Error('x'), { status: 404 }));
    await expect(testSource(agent)).rejects.toThrow(/404/);
  });
});
