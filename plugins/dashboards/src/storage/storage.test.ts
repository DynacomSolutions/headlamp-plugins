import { describe, expect, it, vi } from 'vitest';
import { emptySpec } from '../spec/model';
import {
  AccessError,
  ConflictError,
  createStorage,
  DASHBOARD_LABEL,
  DATA_KEY,
  fromConfigMap,
  NotFoundError,
  toConfigMap,
  Transport,
} from './storage';

const err = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function fake(handler: (path: string, params?: any) => any) {
  const request = vi.fn(async (path: string, params?: any) => {
    const r = handler(path, params);
    if (r instanceof Error) throw r;
    return r;
  });
  return { transport: { request } as Transport, request };
}

describe('config map conversion', () => {
  it('writes the label, the data key and the resourceVersion', () => {
    const cm = toConfigMap('ops', 'dash', emptySpec('Ops'), '12');
    expect(cm.metadata).toMatchObject({
      name: 'ops',
      namespace: 'dash',
      resourceVersion: '12',
      labels: { [DASHBOARD_LABEL]: 'true' },
    });
    const spec = JSON.parse(cm.data[DATA_KEY]);
    expect(spec.version).toBe(1);
    expect(spec.modifiedAt).toBeTruthy();
    expect(toConfigMap('ops', 'dash', emptySpec('Ops')).metadata.resourceVersion).toBeUndefined();
  });

  it('reads a good ConfigMap and reports a bad one without throwing', () => {
    const good = fromConfigMap(
      {
        metadata: { name: 'ops', resourceVersion: '5' },
        data: { [DATA_KEY]: JSON.stringify({ title: 'Ops' }) },
      },
      'dash'
    );
    expect(good).toMatchObject({ name: 'ops', resourceVersion: '5', namespace: 'dash' });
    expect(good.spec.title).toBe('Ops');
    expect(good.error).toBeUndefined();
    expect(fromConfigMap({ metadata: { name: 'x' }, data: {} }, 'd').error).toMatch(
      /no "dashboard.json"/
    );
    expect(
      fromConfigMap({ metadata: { name: 'x' }, data: { [DATA_KEY]: '{' } }, 'd').error
    ).toMatch(/not valid JSON/);
    const newer = fromConfigMap(
      { metadata: { name: 'x' }, data: { [DATA_KEY]: JSON.stringify({ version: 99 }) } },
      'd'
    );
    expect(newer.tooNew).toBe(true);
  });
});

describe('storage', () => {
  it('lists by label, sorted by title', async () => {
    const mk = (name: string, title: string) => ({
      metadata: { name, resourceVersion: '1' },
      data: { [DATA_KEY]: JSON.stringify({ title }) },
    });
    const { transport, request } = fake(() => ({ items: [mk('b', 'Beta'), mk('a', 'Alpha')] }));
    const list = await createStorage(transport, 'dash').list();
    expect(list.map(i => i.spec.title)).toEqual(['Alpha', 'Beta']);
    expect(request.mock.calls[0][0]).toContain(
      '/api/v1/namespaces/dash/configmaps?labelSelector=headlamp.dev%2Fdashboard%3Dtrue'
    );
  });

  it('creates with POST and saves with PUT carrying the resourceVersion', async () => {
    const { transport, request } = fake((_p, params) => JSON.parse(params.body));
    const storage = createStorage(transport, 'dash');
    await storage.create('ops', emptySpec('Ops'));
    expect(request.mock.calls[0][1].method).toBe('POST');
    expect(request.mock.calls[0][0]).toBe(
      '/api/v1/namespaces/dash/configmaps?fieldManager=headlamp-dashboards'
    );
    await storage.save({ name: 'ops', resourceVersion: '77' }, emptySpec('Ops 2'));
    const [path, params] = request.mock.calls[1];
    expect(path).toContain('/configmaps/ops?');
    expect(params.method).toBe('PUT');
    expect(JSON.parse(params.body).metadata.resourceVersion).toBe('77');
  });

  it('turns HTTP 409 on a save into a ConflictError and does not retry', async () => {
    const { transport, request } = fake(() => err(409));
    await expect(
      createStorage(transport, 'dash').save({ name: 'ops', resourceVersion: '1' }, emptySpec('x'))
    ).rejects.toBeInstanceOf(ConflictError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('explains a refused read and a refused write differently', async () => {
    const { transport } = fake(() => err(403));
    const storage = createStorage(transport, 'dash');
    const read = await storage.list().catch(e => e);
    expect(read).toBeInstanceOf(AccessError);
    expect(read.message).toMatch(/not allowed to read/);
    const write = await storage.remove('ops').catch(e => e);
    expect(write).toBeInstanceOf(AccessError);
    expect(write.message).toMatch(/read-only access/);
  });

  it('names a missing namespace and passes other errors on', async () => {
    const missing = await createStorage(fake(() => err(404)).transport, 'dash')
      .list()
      .catch(e => e);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(missing.message).toMatch(/namespace "dash"/);
    const other = await createStorage(fake(() => new Error('boom')).transport, 'dash')
      .list()
      .catch(e => e);
    expect(other.message).toBe('boom');
  });

  it('never saves a dashboard it could not read or that a newer plugin wrote', async () => {
    const { transport, request } = fake(() => ({}));
    await expect(
      createStorage(transport, 'dash').save(
        { name: 'x', resourceVersion: '1', tooNew: true, error: 'newer' },
        emptySpec('x')
      )
    ).rejects.toThrow('newer');
    expect(request).not.toHaveBeenCalled();
  });
});
