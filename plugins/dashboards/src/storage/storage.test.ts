import { describe, expect, it, vi } from 'vitest';
import { emptySpec } from '../spec/model';
import {
  AccessError,
  ConflictError,
  createStorage,
  createWithFreeName,
  DASHBOARD_LABEL,
  DATA_KEY,
  fromConfigMap,
  NameTakenError,
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

describe('saving keeps what other tools added to the ConfigMap', () => {
  const loadedCm = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'ops',
      namespace: 'dash',
      resourceVersion: '9',
      uid: 'abc',
      labels: { [DASHBOARD_LABEL]: 'true', team: 'sre' },
      annotations: { note: 'keep me' },
      ownerReferences: [{ apiVersion: 'v1', kind: 'Thing', name: 't', uid: 'u' }],
      managedFields: [{ manager: 'someone' }],
    },
    data: { [DATA_KEY]: JSON.stringify({ title: 'Ops' }), 'other.txt': 'keep me too' },
    binaryData: { blob: 'AAAA' },
  };

  it('changes only the dashboard data and label', () => {
    const cm = toConfigMap('ops', 'dash', emptySpec('Ops 2'), '9', loadedCm);
    expect(cm.metadata.labels).toEqual({ [DASHBOARD_LABEL]: 'true', team: 'sre' });
    expect(cm.metadata.annotations).toEqual({ note: 'keep me' });
    expect(cm.metadata.ownerReferences).toHaveLength(1);
    expect(cm.metadata.uid).toBe('abc');
    expect(cm.metadata.resourceVersion).toBe('9');
    expect(cm.metadata.managedFields).toBeUndefined();
    expect(cm.data['other.txt']).toBe('keep me too');
    expect(cm.binaryData).toEqual({ blob: 'AAAA' });
    expect(JSON.parse(cm.data[DATA_KEY]).title).toBe('Ops 2');
  });
  it('puts the dashboard label back when it was removed', () => {
    const cm = toConfigMap('ops', 'dash', emptySpec('x'), '9', {
      ...loadedCm,
      metadata: { ...loadedCm.metadata, labels: { team: 'sre' } },
    });
    expect(cm.metadata.labels).toEqual({ team: 'sre', [DASHBOARD_LABEL]: 'true' });
  });
  it('sends the loaded object on a save, and the object the server returned on the next one', async () => {
    const { transport, request } = fake((_p, params) => ({
      ...JSON.parse(params.body),
      metadata: { ...JSON.parse(params.body).metadata, resourceVersion: '10' },
    }));
    const storage = createStorage(transport, 'dash');
    const first = await storage.save(fromConfigMap(loadedCm, 'dash'), emptySpec('A'));
    const sent = JSON.parse(request.mock.calls[0][1].body);
    expect(sent.metadata.annotations).toEqual({ note: 'keep me' });
    expect(sent.data['other.txt']).toBe('keep me too');
    await storage.save(first, emptySpec('B'));
    const again = JSON.parse(request.mock.calls[1][1].body);
    expect(again.metadata.resourceVersion).toBe('10');
    expect(again.metadata.annotations).toEqual({ note: 'keep me' });
  });
});

describe('creating with a name that is taken', () => {
  it('turns HTTP 409 on a create into a NameTakenError with its own message', async () => {
    const { transport } = fake(() => err(409));
    const e = await createStorage(transport, 'dash')
      .create('ops', emptySpec('Ops'))
      .catch(x => x);
    expect(e).toBeInstanceOf(NameTakenError);
    expect(e).not.toBeInstanceOf(ConflictError);
    expect(e.message).toMatch(/ConfigMap named "ops" already exists/);
  });
  it('picks the next free name when a ConfigMap without the label holds the name', async () => {
    const taken = new Set(['ops', 'ops-2']);
    const { transport, request } = fake((_p, params) => {
      const cm = JSON.parse(params.body);
      return taken.has(cm.metadata.name) ? err(409) : cm;
    });
    const storage = createStorage(transport, 'dash');
    const made = await createWithFreeName(storage, 'Ops', emptySpec('Ops'), []);
    expect(made.name).toBe('ops-3');
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('gives up with the correct message after a few tries', async () => {
    const { transport } = fake(() => err(409));
    const e = await createWithFreeName(
      createStorage(transport, 'dash'),
      'Ops',
      emptySpec('Ops'),
      [],
      2
    ).catch(x => x);
    expect(e).toBeInstanceOf(NameTakenError);
    expect(e.message).toMatch(/already exists in the namespace "dash"/);
  });
  it('passes other errors on at once', async () => {
    const { transport, request } = fake(() => err(403));
    await expect(
      createWithFreeName(createStorage(transport, 'dash'), 'Ops', emptySpec('Ops'), [])
    ).rejects.toBeInstanceOf(AccessError);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
