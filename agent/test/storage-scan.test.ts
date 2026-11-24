import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Metrics } from '../src/metrics.js';
import { PushService } from '../src/push/service.js';
import { MemoryPushStore } from '../src/push/store.js';
import { StorageApply } from '../src/storage/apply.js';
import { itemViews } from '../src/storage/inventory.js';
import { StorageNotifications } from '../src/storage/notifications.js';
import { StorageReconciler } from '../src/storage/reconcile.js';
import { StorageIncident } from '../src/storage/service.js';
import { StorageQueries, StorageStore } from '../src/storage/store.js';
import { HttpScanner, requestJson } from '../src/storage/transport.js';
import { filesystemPoliciesSchema, reconcileSchema, type FilesystemPolicy, type Scan } from '../src/storage/types.js';
import { pgliteDb, podStore } from './helpers/pglite.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const start = Date.parse('2026-01-01T00:30:00Z');
const token = 'fixture-scanner-token';
const nodes = ['worker-1', 'worker-2'];
const dispose: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of dispose.splice(0).reverse()) await close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function listen(handle: (response: ServerResponse) => void): Promise<URL> {
  const server = createServer((req, res) => {
    if (req.url === '/v1/scan' && req.headers.authorization === 'Bearer ' + token) handle(res);
    else res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  dispose.push(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('Fixture listener did not start');
  return new URL('http://127.0.0.1:' + address.port + '/v1/scan');
}

function clock() {
  let time = start;
  return { now: () => time, advance: (ms: number) => { time += ms; } };
}

function scan(node: string, at: number, extra: Partial<Scan> = {}): Scan {
  return {
    version: 1, node, execution: 'shadow', scannedAt: new Date(at).toISOString(), complete: true, inventoryComplete: true,
    filesystems: [{ id: 'volume', mount: '/srv/volume', totalBytes: 1_000_000, availableBytes: 250_000 }],
    items: [],
    ...extra,
  };
}

function item(id: string, extra: Partial<Scan['items'][number]> = {}): Scan['items'][number] {
  return {
    id, objectKey: 'object-' + id, filesystemId: 'volume', category: 'build-cache',
    path: '/srv/volume/cache/' + id, owner: 'fixture', bytes: 500, reason: 'Rebuildable cache',
    eligible: true, inUse: false, visibility: 'local', ...extra,
  };
}

async function fixture(
  now: () => number,
  nodeNames: string[],
  serve: (node: string, res: ServerResponse, at: number) => void,
  filesystemPolicies?: ReadonlyMap<string, FilesystemPolicy[]>,
) {
  const db = pgliteDb();
  dispose.push(() => db.close());
  await podStore(db);
  const store = new StorageStore(db);
  await store.init(now());
  const calls: string[] = [];
  const urls = new Map(await Promise.all(nodeNames.map(async node => [node, await listen(res => {
    calls.push(node);
    serve(node, res, now());
  })] as const)));
  const scanner = new HttpScanner(urls, () => token);
  const apply = new StorageApply({ store, scanner, now, disposable: new Set(nodeNames), enabled: true });
  const push = new PushService({ store: new MemoryPushStore() });
  const notificationDeps = { store, push, now, issuerConfigured: false };
  const notifications = new StorageNotifications(notificationDeps);
  const reconciler = new StorageReconciler({ store, scanner, nodes: new Set(nodeNames), metrics: new Metrics(), now, filesystemPolicies });
  const incident = new StorageIncident({ store, apply, notifications, now, nodes: nodeNames });
  return { store, incident, reconciler, apply, calls };
}

function send(res: ServerResponse, data: Scan) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}

describe('Storage scanner contract', () => {
  it('retains partial evidence without advancing coverage or enabling cleanup', async () => {
    const { now, advance } = clock();
    const [affected, peer] = nodes;
    const initial = now();
    let inventoryComplete: boolean | undefined = false;
    const f = await fixture(now, nodes, (node, res, at) => send(res, scan(node, at, {
      execution: 'disposable',
      inventoryComplete: node === affected ? inventoryComplete : true,
      items: [item('cache')],
    })));
    expect(await f.reconciler.run([])).toBe(false);
    const parent = await f.incident.parent();
    expect(parent.scans.map(row => row.status)).toEqual(['incomplete', 'complete']);
    const drive = parent.drives.find(row => row.node === affected)!;
    const detail = await f.incident.drive(drive.id);
    expect(detail.current).toMatchObject({
      complete: false, holderEvidenceComplete: true, inventoryComplete: false, itemCount: 1, eligibleCount: 0,
    });
    expect(detail.items).toMatchObject([{ eligible: false, reason: 'The scan is incomplete' }]);
    expect((await f.store.drive(drive.id))?.items).toMatchObject([{ eligible: false }]);
    expect((await f.apply.dryRun(drive.id)).items).toMatchObject([{ eligible: false }]);
    expect(await f.store.scanState(affected, now())).toMatchObject({ lastFullAt: 0 });
    expect(await f.store.aliases(affected)).toEqual([]);
    expect(await f.store.scanState(peer, now())).toMatchObject({ lastFullAt: initial });

    inventoryComplete = undefined;
    advance(60_000);
    expect(await f.reconciler.run([])).toBe(false);
    expect(await f.store.scanState(affected, now())).toMatchObject({ status: 'incomplete', lastFullAt: 0 });
    expect((await f.incident.drive(drive.id)).items[0]).toMatchObject({ id: detail.items[0].id, eligible: false });

    inventoryComplete = true;
    advance(60_000);
    expect(await f.reconciler.run([])).toBe(true);
    expect(await f.store.scanState(affected, now())).toMatchObject({ status: 'complete', lastFullAt: now() });
    expect((await f.incident.drive(drive.id)).items[0]).toMatchObject({ id: detail.items[0].id, eligible: true });
    expect(f.calls.filter(node => node === affected)).toHaveLength(3);
    expect(f.calls.filter(node => node === peer)).toHaveLength(1);

    const lastFullAt = now();
    expect(await f.store.aliases(affected)).not.toEqual([]);
    inventoryComplete = false;
    advance(60_000);
    expect(await f.reconciler.run([{ node: affected, filesystemId: 'volume', reason: 'capacity' }])).toBe(false);
    expect(await f.store.scanState(affected, now())).toMatchObject({ status: 'incomplete', lastFullAt });
    expect(await f.store.aliases(affected)).toEqual([]);
    expect((await f.incident.drive(drive.id)).items[0]).toMatchObject({ eligible: false });
    expect(f.calls.filter(node => node === peer)).toHaveLength(1);
  });

  it('uses the mounted thresholds on the daily scan and requires coverage of the exact policy mount', async () => {
    const { now, advance } = clock();
    const node = nodes[0];
    const gib = 1024 ** 3;
    const policyMount = '/srv/Team\\040\tqueue\nready ';
    const policy = { mount: policyMount, reserveGiB: 160, criticalGiB: 40, growth1hGiB: 20, growth6hGiB: 60 };
    const policies = new Map(Object.entries(filesystemPoliciesSchema.parse({ [node]: [policy] })));
    let mountpoint = policyMount.trimEnd();
    let complete = false;
    const f = await fixture(now, [node], (name, res, at) => send(res, scan(name, at, {
      complete,
      filesystems: [{
        id: 'volume', mount: '/srv/volume', aliases: [{ device: '/dev/example', mountpoint }],
        totalBytes: 1000 * gib, availableBytes: 120 * gib,
      }],
    })), policies);
    expect(await f.reconciler.run([])).toBe(false);
    expect(await f.store.scanState(node, now())).toMatchObject({ status: 'incomplete', lastFullAt: 0 });
    const [drive] = (await f.incident.parent()).drives;
    expect(drive).toMatchObject({ complete: false, status: 'incomplete', inventoryComplete: false });
    expect((await f.incident.drive(drive.id)).questions).toEqual([]);

    mountpoint = policyMount;
    advance(60_000);
    expect(await f.reconciler.run([])).toBe(false);
    expect(await f.store.scanState(node, now())).toMatchObject({ status: 'incomplete', lastFullAt: 0 });
    const shadow = await f.incident.drive(drive.id);
    expect(shadow.drive).toMatchObject({
      status: 'incomplete', complete: false, inventoryComplete: true, holderEvidenceComplete: false,
      reserveBytes: 160 * gib, criticalBytes: 40 * gib, applyEnabled: false,
    });
    expect(shadow.questions.map(question => question.text)).toEqual([expect.stringContaining('below its reserve')]);

    complete = true;
    advance(60_000);
    expect(await f.reconciler.run([])).toBe(true);
    expect(await f.store.scanState(node, now())).toMatchObject({ status: 'complete', lastFullAt: now() });
    const detail = await f.incident.drive(drive.id);
    expect(detail.drive).toMatchObject({ status: 'pressure', reserveBytes: 160 * gib, criticalBytes: 40 * gib });
    expect(detail.questions.map(question => question.text)).toEqual([expect.stringContaining('below its reserve')]);

    advance(60_000);
    expect(await f.reconciler.run([{
      node, device: '/dev/example', mount: policyMount, reason: 'capacity', reserveBytes: 240 * gib, criticalBytes: 180 * gib,
    }])).toBe(true);
    expect((await f.incident.parent()).drives[0]).toMatchObject({ status: 'pressure', reserveBytes: 160 * gib, criticalBytes: 40 * gib });
  });

  it('ingests 3,240 rows after a 900s scan with time left for the transaction', async () => {
    const { now, advance } = clock();
    const response = deferred<ServerResponse>();
    const f = await fixture(now, [nodes[0]], (_node, res) => response.resolve(res));
    const data = scan(nodes[0], now(), { execution: 'disposable', items: Array.from({ length: 3240 }, (_, i) => item('row-' + i)) });
    const reconcile = f.reconciler.run([]);
    const res = await response.promise;
    advance(900_000);
    expect(await f.reconciler.run([])).toBe(false);
    expect(f.calls).toEqual([nodes[0]]);
    expect((await f.incident.parent()).scans).toMatchObject([{ node: nodes[0], status: 'running' }]);

    const putDrive = StorageQueries.prototype.putDrive;
    vi.spyOn(StorageQueries.prototype, 'putDrive').mockImplementation(async function (this: StorageQueries, scope, state) {
      await putDrive.call(this, scope, state);
      if (state.items.length === data.items.length) advance(40_000);
    });
    send(res, data);
    expect(await reconcile).toBe(true);
    const parent = await f.incident.parent();
    expect(parent.scans).toEqual([{ node: nodes[0], status: 'complete', completedAt: new Date(start + 940_000).toISOString() }]);
    expect(parent.drives[0]).toMatchObject({ scannedAt: data.scannedAt, itemCount: 3240, eligibleCount: 3240, applyEnabled: true });

    const { id } = parent.drives[0];
    advance(24 * 60 * 60_000 - 940_000);
    const plan = await f.apply.dryRun(id);
    expect(plan.items[0].eligible).toBe(true);
    advance(1);
    expect((await f.incident.parent()).drives[0]).toMatchObject({ applyEnabled: false, eligibleCount: 0 });
    const detail = await f.incident.drive(id);
    expect(detail.current.eligibleCount).toBe(0);
    expect(detail.items[0]).toMatchObject({ eligible: false, reason: 'The scan is too old' });
    const approval = await f.apply.approve(plan.id, [plan.items[0].itemId], 'fixture');
    expect(approval.receipts[0].status).toBe('stale');
    expect(f.calls).toEqual([nodes[0]]);
  });

  it('times out a partial HTTP body and retries only that node after daily success', async () => {
    const { now, advance } = clock();
    const partial = deferred<ServerResponse>();
    let mode = 'complete';
    const f = await fixture(now, nodes, (node, res, at) => {
      if (node === nodes[0] && mode === 'partial') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"version":1,');
        partial.resolve(res);
      } else send(res, scan(node, at, { complete: mode !== 'incomplete' || node !== nodes[0], items: [item('cache')] }));
    });
    expect(await f.reconciler.run([])).toBe(true);
    advance(16 * 60_000);
    mode = 'partial';
    const deadline = deferred<() => void>();
    const setTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay !== undefined && delay > 959_000 && delay <= 960_000) deadline.resolve(() => callback(...args));
      return setTimer(callback, delay, ...args);
    });
    const reconcile = f.reconciler.run([{ node: nodes[0], filesystemId: 'volume', reason: 'capacity' }]);
    const res = await partial.promise;
    const closed = once(res, 'close');
    advance(959_999);
    expect((await f.incident.parent()).scans[0].status).toBe('running');
    advance(1);
    (await deadline.promise)();
    expect(await reconcile).toBe(false);
    await closed;
    const parent = await f.incident.parent();
    expect(parent.scans.map(row => row.status)).toEqual(['timeout', 'complete']);
    expect(parent.drives.find(drive => drive.node === nodes[0])).toMatchObject({ complete: false, eligibleCount: 0 });
    expect(parent.drives.find(drive => drive.node === nodes[1])).toMatchObject({ complete: true, eligibleCount: 1 });

    mode = 'incomplete';
    expect(await f.reconciler.run([])).toBe(false);
    expect((await f.incident.parent()).scans.map(row => row.status)).toEqual(['incomplete', 'complete']);
    mode = 'complete';
    expect(await f.reconciler.run([])).toBe(true);
    expect((await f.incident.parent()).scans.map(row => row.status)).toEqual(['complete', 'complete']);
    expect(f.calls.filter(node => node === nodes[0])).toHaveLength(4);
    expect(f.calls.filter(node => node === nodes[1])).toHaveLength(1);
  });

  it('rolls back an expired ingest transaction and lets a later scan commit', async () => {
    const { now, advance } = clock();
    const f = await fixture(now, [nodes[0]], (node, res, at) => send(res, scan(node, at, { items: [item('cache')] })));
    const putDrive = StorageQueries.prototype.putDrive;
    const delay = vi.spyOn(StorageQueries.prototype, 'putDrive').mockImplementation(async function (this: StorageQueries, scope, state) {
      await putDrive.call(this, scope, state);
      if (state.items.length) advance(90_000);
    });
    expect(await f.reconciler.run([])).toBe(false);
    expect(await f.incident.parent()).toMatchObject({ scans: [{ status: 'timeout' }], drives: [] });
    expect(await f.store.aliases(nodes[0])).toEqual([]);
    delay.mockRestore();
    expect(await f.reconciler.run([])).toBe(true);
    expect(await f.incident.parent()).toMatchObject({ scans: [{ status: 'complete' }], drives: [{ itemCount: 1 }] });
  });

  it('reclaims an expired lease and rejects completion from its previous owner', async () => {
    const { now, advance } = clock();
    const response = deferred<ServerResponse>();
    const node = nodes[0];
    const owner = randomUUID();
    const f = await fixture(now, [node], (_node, res) => response.resolve(res));
    expect(await f.store.leaseScan(node, owner, now(), 1_110_000)).toBe(true);
    advance(1_109_999);
    expect(await f.reconciler.run([])).toBe(false);
    expect(f.calls).toEqual([]);
    advance(1);
    expect((await f.incident.parent()).scans[0].status).toBe('timeout');
    expect(await f.store.transaction(tx => tx.ownsScan(node, owner, now()))).toBe(false);
    const retry = f.reconciler.run([]);
    const res = await response.promise;
    await f.store.finishScan(node, owner, 'error', now());
    expect((await f.incident.parent()).scans[0].status).toBe('running');
    send(res, scan(node, now()));
    expect(await retry).toBe(true);
    expect((await f.incident.parent()).scans[0].status).toBe('complete');
  });

  it('rejects bodies over the scan limit before and during streaming', async () => {
    const limit = 32 * 1024 * 1024;
    const declared = await listen(res => res.writeHead(200, { 'content-length': limit + 1 }).flushHeaders());
    const streamed = await listen(res => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.alloc(limit + 1, 32));
    });
    for (const url of [declared, streamed]) {
      await expect(requestJson(url, { token, timeoutMs: 5000 })).rejects.toThrow('Response exceeds size limit');
    }
  });

  it('joins both decoded labels on the reporting node and shares network identity across nodes', async () => {
    const { now, advance } = clock();
    const source = 'nfs.example:/export/team share';
    const id = 'network:nfs4:' + source;
    const primary = { device: source, mountpoint: '/srv/team share' };
    const escaped = { device: 'nfs.example:/Exports//Team\\040\tqueue\nready', mountpoint: '/srv/Team\\040\tqueue\nready ' };
    const peer = { device: source, mountpoint: '/srv/peer' };
    const f = await fixture(now, nodes, (node, res, at) => send(res, scan(node, at, {
      filesystems: [{
        id, shared: true, fsType: 'nfs4', device: source, mount: node === nodes[0] ? primary.mountpoint : peer.mountpoint,
        totalBytes: 1000, availableBytes: 80, aliases: node === nodes[0] ? [primary, escaped] : [peer],
      }],
    })));
    function trigger(node: string, alias: typeof primary, reserveBytes: number) {
      return { node, device: alias.device, mount: alias.mountpoint, reason: 'capacity', reserveBytes };
    }
    const run = (...triggers: ReturnType<typeof trigger>[]) => f.reconciler.run(reconcileSchema.parse({ triggers }).triggers);
    expect(await run(trigger(nodes[0], primary, 150))).toBe(true);
    const [drive] = (await f.incident.parent()).drives;
    expect(drive).toMatchObject({ filesystemId: id, reserveBytes: 150 });
    expect(await run(trigger(nodes[1], peer, 175))).toBe(true);
    expect(f.calls).toHaveLength(2);

    advance(16 * 60_000);
    expect(await run(trigger(nodes[0], escaped, 200))).toBe(true);
    const good = await f.incident.parent();
    expect(good.drives).toHaveLength(1);
    expect(good.drives[0]).toMatchObject({ id: drive.id, filesystemId: id, reserveBytes: 200 });
    expect((await f.store.aliases(nodes[0])).map(([key]) => key)).toContain(JSON.stringify([escaped.device, escaped.mountpoint]));
    const wrongPairs = [
      { device: escaped.device, mountpoint: primary.mountpoint },
      { device: primary.device, mountpoint: escaped.mountpoint },
      { ...escaped, device: escaped.device.replace('\\040', ' ') },
      { ...escaped, mountpoint: escaped.mountpoint.replace('\\040', ' ') },
      { ...escaped, mountpoint: escaped.mountpoint.trimEnd() },
      { ...escaped, mountpoint: '/host' + escaped.mountpoint },
      { ...escaped, device: escaped.device.toLowerCase().replace('//', '/') },
      primary,
    ];
    for (const [index, alias] of wrongPairs.entries()) {
      const node = index === wrongPairs.length - 1 ? nodes[1] : nodes[0];
      expect(await run(trigger(node, alias, 900))).toBe(false);
      expect((await f.incident.parent()).drives[0].reserveBytes).toBe(200);
    }
    expect(reconcileSchema.safeParse({ triggers: [{ node: nodes[0], mount: primary.mountpoint, reason: 'capacity' }] }).success).toBe(false);
  });

  it('requires verified inactivity and keeps stable proof apart from the scanner ID', async () => {
    const { now, advance } = clock();
    let revision = 1;
    const f = await fixture(now, [nodes[0]], (node, res, at) => send(res, scan(node, at, {
      execution: 'disposable',
      items: [
        item('proof-' + revision, { objectKey: 'proof', path: '/srv/volume/proof' }),
        item('no-proof-' + revision, { objectKey: undefined, path: '/srv/volume/no-proof' }),
        item('active', { inUse: true }),
        item('unknown', { inUse: undefined }),
      ],
    })));
    expect(await f.reconciler.run([])).toBe(true);
    const [drive] = (await f.incident.parent()).drives;
    const first = (await f.store.drive(drive.id))!;
    expect(first.items.map(row => row.eligible)).toEqual([true, true, false, false]);
    const legacy = { ...first, items: first.items.map(row => ({ ...row, eligible: true })) };
    expect(itemViews(legacy, [], now()).map(row => row.eligible)).toEqual([true, true, false, false]);
    const legacyCoverage = { ...first, current: { ...first.current, inventoryComplete: undefined } };
    expect(itemViews(legacyCoverage, [], now())).toEqual(first.items.map(() =>
      expect.objectContaining({ eligible: false, reason: 'The scan is incomplete' })));
    const plan = await f.apply.dryRun(drive.id);
    const frozen = (await f.store.plan(plan.id))!;
    expect(frozen.checks.map(row => row.scannerId)).toEqual(['proof-1', 'no-proof-1']);
    advance(16 * 60_000);
    revision++;
    expect(await f.reconciler.run([{ node: nodes[0], filesystemId: 'volume', reason: 'capacity' }])).toBe(true);
    const next = (await f.store.drive(drive.id))!;
    expect(next.items[0]).toMatchObject({ id: first.items[0].id, material: first.items[0].material, scannerId: 'proof-2' });
    expect(next.items[1].material).not.toBe(first.items[1].material);
    expect((await f.store.plan(plan.id))!.checks).toEqual(frozen.checks);
  });
});
