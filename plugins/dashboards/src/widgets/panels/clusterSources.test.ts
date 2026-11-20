import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearClusterSources,
  CLUSTER_SOURCES_RETRY_MS,
  CLUSTER_SOURCES_TTL_MS,
  ensureClusterSources,
  getClusterSourcesState,
  loadClusterSources,
  saveClusterSources,
  toSourcesConfigMap,
} from './clusterSources';
import { CLUSTER_SOURCES_KEY, CLUSTER_SOURCES_LABEL, PanelSource } from './sources';

const sourcesJson = (ids: string[]) =>
  JSON.stringify({
    version: 1,
    sources: ids.map(id => ({
      id,
      title: id,
      kind: 'service',
      namespace: 'apps',
      service: id,
      port: '80',
    })),
  });

const configMap = (ids: string[], version = '7') => ({
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: {
    name: 'dashboard-sources',
    namespace: 'headlamp-dashboards',
    resourceVersion: version,
    labels: { [CLUSTER_SOURCES_LABEL]: 'true', 'app.kubernetes.io/instance': 'x' },
    annotations: { note: 'keep' },
    managedFields: [{ manager: 'x' }],
  },
  data: { [CLUSTER_SOURCES_KEY]: sourcesJson(ids), other: 'keep' },
});

const NS = 'headlamp-dashboards';
const mine: PanelSource = {
  id: 'new-one',
  title: 'New one',
  kind: 'service',
  namespace: 'apps',
  service: 'new-one',
  port: '80',
  pathPrefix: '',
};

beforeEach(() => clearClusterSources());

describe('loading the cluster sources', () => {
  it('reads the labelled ConfigMap and keeps the version and the object', async () => {
    const request = vi.fn().mockResolvedValue({ items: [configMap(['a', 'b'])] });
    const state = await loadClusterSources({ request }, undefined, NS);
    expect(String(request.mock.calls[0][0])).toBe(
      `/api/v1/namespaces/${NS}/configmaps?labelSelector=headlamp.dev%2Fdashboard-sources%3Dtrue`
    );
    expect(state).toMatchObject({ status: 'ready', exists: true, resourceVersion: '7' });
    expect(state.sources.map(s => s.id)).toEqual(['a', 'b']);
    expect(getClusterSourcesState(undefined, NS)).toBe(state);
  });
  it('treats a missing ConfigMap as no sources, not as an error', async () => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    const state = await loadClusterSources({ request }, undefined, NS);
    expect(state).toMatchObject({ status: 'ready', exists: false, sources: [], problems: [] });
  });
  it('ignores a ConfigMap with another name', async () => {
    const other = { ...configMap(['a']), metadata: { name: 'other', labels: {} } };
    const request = vi.fn().mockResolvedValue({ items: [other] });
    expect((await loadClusterSources({ request }, undefined, NS)).sources).toEqual([]);
  });
  it('reports the content problems and still gives the good sources', async () => {
    const cm = configMap(['a']);
    cm.data[CLUSTER_SOURCES_KEY] = JSON.stringify({
      version: 1,
      sources: [
        { id: 'a', kind: 'url', baseUrl: 'https://x.example.com' },
        { id: 'b', kind: 'url', baseUrl: 'ftp://x' },
      ],
    });
    const state = await loadClusterSources(
      { request: vi.fn().mockResolvedValue({ items: [cm] }) },
      undefined,
      NS
    );
    expect(state.sources.map(s => s.id)).toEqual(['a']);
    expect(state.problems).toHaveLength(1);
  });
  it('gives a clear error for 403 and keeps no sources', async () => {
    const request = vi.fn().mockRejectedValue({ status: 403 });
    const state = await loadClusterSources({ request }, undefined, NS);
    expect(state.status).toBe('error');
    expect(state.error).toMatch(/not allowed to read the cluster sources/);
    expect(state.sources).toEqual([]);
  });
  it('keeps the last good sources when a refresh fails', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ items: [configMap(['a'])] })
      .mockRejectedValueOnce(new Error('HTTP 502'));
    const first = await loadClusterSources({ request }, undefined, NS);
    const second = await loadClusterSources({ request }, undefined, NS);
    expect(second.status).toBe('error');
    expect(second.error).toBe('HTTP 502');
    expect(second.sources).toBe(first.sources);
  });
  it('keeps the identity of the list when a refresh gives the same content', async () => {
    const request = vi.fn().mockResolvedValue({ items: [configMap(['a'])] });
    const first = await loadClusterSources({ request }, undefined, NS);
    const second = await loadClusterSources({ request }, undefined, NS);
    expect(second.sources).toBe(first.sources);
  });
  it('shares one request between overlapping calls', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    const request = vi.fn().mockReturnValue(new Promise(r => (resolve = r)));
    const a = loadClusterSources({ request }, undefined, NS);
    const b = loadClusterSources({ request }, undefined, NS);
    resolve({ items: [] });
    await Promise.all([a, b]);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('keeps one cache entry per cluster and namespace', async () => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    await loadClusterSources({ request }, 'one', NS);
    await loadClusterSources({ request }, 'two', NS);
    expect(request).toHaveBeenCalledTimes(2);
    expect(getClusterSourcesState('three', NS).status).toBe('idle');
  });
});

describe('ensuring the cache', () => {
  it('loads once for many widgets, and again only when the cache is old', async () => {
    const request = vi.fn().mockResolvedValue({ items: [configMap(['a'])] });
    const t = { request };
    for (let i = 0; i < 10; i += 1) ensureClusterSources(t, undefined, NS);
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    const at = getClusterSourcesState(undefined, NS).at;
    ensureClusterSources(t, undefined, NS, at + CLUSTER_SOURCES_TTL_MS - 1);
    expect(request).toHaveBeenCalledTimes(1);
    ensureClusterSources(t, undefined, NS, at + CLUSTER_SOURCES_TTL_MS);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('retries a failed read only after a pause', async () => {
    const request = vi.fn().mockRejectedValue({ status: 403 });
    const t = { request };
    await loadClusterSources(t, undefined, NS);
    const at = getClusterSourcesState(undefined, NS).at;
    ensureClusterSources(t, undefined, NS, at + 1000);
    expect(request).toHaveBeenCalledTimes(1);
    ensureClusterSources(t, undefined, NS, at + CLUSTER_SOURCES_RETRY_MS);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('saving the cluster sources', () => {
  it('replaces the ConfigMap with its resourceVersion and keeps the other fields', async () => {
    const request = vi.fn().mockResolvedValueOnce({ items: [configMap(['a'])] });
    await loadClusterSources({ request }, undefined, NS);
    request.mockResolvedValueOnce({ ...configMap(['a', 'new-one'], '8') });
    const state = await saveClusterSources({ request }, undefined, NS, [mine]);
    const [url, init] = request.mock.calls[1];
    expect(String(url)).toBe(
      `/api/v1/namespaces/${NS}/configmaps/dashboard-sources?fieldManager=headlamp-dashboards`
    );
    expect(init.method).toBe('PUT');
    const sent = JSON.parse(init.body);
    expect(sent.metadata.resourceVersion).toBe('7');
    expect(sent.metadata.managedFields).toBeUndefined();
    expect(sent.metadata.annotations).toEqual({ note: 'keep' });
    expect(sent.metadata.labels).toMatchObject({
      [CLUSTER_SOURCES_LABEL]: 'true',
      'app.kubernetes.io/instance': 'x',
    });
    expect(sent.data.other).toBe('keep');
    expect(JSON.parse(sent.data[CLUSTER_SOURCES_KEY])).toEqual({ version: 1, sources: [mine] });
    expect(state.resourceVersion).toBe('8');
  });
  it('creates the ConfigMap, with the label, when none exists', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce(configMap(['new-one'], '1'));
    await loadClusterSources({ request }, undefined, NS);
    const state = await saveClusterSources({ request }, undefined, NS, [mine]);
    const [url, init] = request.mock.calls[1];
    expect(String(url)).toBe(
      `/api/v1/namespaces/${NS}/configmaps?fieldManager=headlamp-dashboards`
    );
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body);
    expect(sent.metadata).toMatchObject({
      name: 'dashboard-sources',
      namespace: NS,
      labels: { [CLUSTER_SOURCES_LABEL]: 'true' },
    });
    expect(sent.metadata.resourceVersion).toBeUndefined();
    expect(state.exists).toBe(true);
  });
  it('reports a conflict and reloads the new content', async () => {
    const request = vi.fn().mockResolvedValueOnce({ items: [configMap(['a'], '7')] });
    await loadClusterSources({ request }, undefined, NS);
    request
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce({ items: [configMap(['z'], '9')] });
    await expect(saveClusterSources({ request }, undefined, NS, [mine])).rejects.toThrow(
      /Someone else saved/
    );
    await vi.waitFor(() => expect(getClusterSourcesState(undefined, NS).resourceVersion).toBe('9'));
  });
  it('explains a 409 on create, and a 403', async () => {
    const request = vi.fn().mockResolvedValueOnce({ items: [] });
    await loadClusterSources({ request }, undefined, NS);
    request.mockRejectedValueOnce({ status: 409 }).mockResolvedValueOnce({ items: [] });
    await expect(saveClusterSources({ request }, undefined, NS, [mine])).rejects.toThrow(
      /already exists.*without the label/
    );
    request.mockRejectedValueOnce({ status: 403 });
    await expect(saveClusterSources({ request }, undefined, NS, [mine])).rejects.toThrow(
      /read-only access/
    );
  });
  it('lets a save on one cluster key refresh the others for the namespace', async () => {
    const request = vi.fn().mockResolvedValue({ items: [configMap(['a'])] });
    await loadClusterSources({ request }, undefined, NS);
    await loadClusterSources({ request }, 'main', NS);
    request.mockResolvedValueOnce(configMap(['new-one'], '8'));
    await saveClusterSources({ request }, 'main', NS, [mine]);
    expect(getClusterSourcesState(undefined, NS).at).toBe(0);
  });
});

describe('the ConfigMap to write', () => {
  it('sets the name, namespace and label without a base', () => {
    const cm = toSourcesConfigMap(NS, [mine]);
    expect(cm.metadata).toEqual({
      name: 'dashboard-sources',
      namespace: NS,
      labels: { [CLUSTER_SOURCES_LABEL]: 'true' },
    });
    expect(Object.keys(cm.data)).toEqual([CLUSTER_SOURCES_KEY]);
  });
});
