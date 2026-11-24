import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { StorageStore } from '../src/storage/store.js';
import { applyResultSchema, scanSchema, type Approval, type Plan, type Receipt } from '../src/storage/types.js';
import { pgliteDb, podStore } from './helpers/pglite.js';

// Set both paths to run against the companion scanner checkout and a writable scratch directory.
const scannerFixture = process.env.STORAGE_SCANNER_HTTP_FIXTURE;
const scratchDir = process.env.STORAGE_SCANNER_HTTP_SCRATCH;
const operator = 'fixture-operator';
const operatorBearer = 'fixture-human-bearer';
const operatorGroup = 'fixture-operators';
const machine = 'fixture-reconcile';
const api = '/api/storage';
const receiptWait = { timeout: 65_000, interval: 250 };
const dispose: Array<() => void | Promise<void>> = [];
vi.setConfig({ hookTimeout: 60_000 });

afterEach(async () => {
  for (const close of dispose.splice(0).reverse()) await close();
});

async function call<T = unknown>(url: string, token: string, data?: unknown) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(45_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }),
    });
    return { status: response.status, data: await response.json() as T };
  } catch (cause) {
    throw new Error(`${data === undefined ? 'GET' : 'POST'} ${new URL(url).pathname} failed`, { cause });
  }
}

async function startScanner(directory: string, mode?: string) {
  const process = spawn('python3', ['-B', scannerFixture!, '--directory', directory, ...(mode ? [mode] : [])], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const output = createInterface({ input: process.stdout });
  const exited = new Promise<number | null>((resolve, reject) => {
    process.once('close', resolve);
    process.once('error', reject);
  });
  const close = async () => {
    output.close();
    process.kill('SIGTERM');
    await exited;
  };
  dispose.push(close);
  const [line] = await Promise.race([
    once(output, 'line', { signal: AbortSignal.timeout(45_000) }),
    exited.then(code => { throw new Error(`Scanner fixture exited during startup (${code})`); }),
  ]);
  const { url, token, node } = JSON.parse(line) as { url: string; token: string; node: string };
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('The scanner fixture must use the loopback listener');
  await vi.waitFor(async () => {
    expect((await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(1000) })).status).toBe(200);
  }, { timeout: 20_000 });
  return { url, token, node, exited, close };
}

async function kubeFixture() {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const { spec } = JSON.parse(Buffer.concat(chunks).toString());
    if (req.headers.authorization !== `Bearer ${operatorBearer}`) {
      res.writeHead(401).end('{}');
      return;
    }
    const identity = req.url?.endsWith('/selfsubjectreviews');
    const access = spec?.resourceAttributes;
    const allowed = req.url?.endsWith('/selfsubjectaccessreviews') && access?.group === 'storage.incidents.example.com'
      && access.resource === 'incidents' && ['get', 'update', 'approve'].includes(access.verb);
    const status = identity ? { userInfo: { username: operator, groups: ['system:authenticated', operatorGroup] } } : { allowed };
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ status }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  dispose.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('Kubernetes fixture did not start');
  return `http://127.0.0.1:${address.port}`;
}

async function startBackend(
  directory: string, kubeApi: string, scanner: Awaited<ReturnType<typeof startScanner>>, db: ReturnType<typeof pgliteDb>,
) {
  const map = join(directory, 'scanners.json');
  const scannerToken = join(directory, 'scanner-token');
  const reconcileToken = join(directory, 'reconcile-token');
  writeFileSync(map, JSON.stringify({ [scanner.node]: scanner.url }));
  writeFileSync(scannerToken, scanner.token, { mode: 0o600 });
  writeFileSync(reconcileToken, machine, { mode: 0o600 });
  let closed = false;
  const store = await podStore(db);
  const server = await startServer({
    ...loadConfig({}), host: '127.0.0.1', port: 0, kubeApi, dataDir: join(directory, 'state'), reconcileSeconds: 0,
  }, 'test', {
    store,
    storageEnv: {
      STORAGE_SCANNERS_FILE: map,
      STORAGE_SCANNER_TOKEN_FILE: scannerToken,
      STORAGE_RECONCILE_TOKEN_FILE: reconcileToken,
      STORAGE_OPERATOR_GROUPS: JSON.stringify([operatorGroup]),
      STORAGE_APPLY_ENABLED: 'true',
      STORAGE_DISPOSABLE_SCANNERS: scanner.node,
    },
  });
  dispose.push(async () => {
    if (!closed) await server.close();
  });
  const url = `http://127.0.0.1:${server.port}${api}`;
  return {
    storage: new StorageStore(db),
    call: <T = unknown>(path: string, data?: unknown) => call<T>(url + path, operatorBearer, data),
    reconcile: () => call(url + '/reconcile', machine, { triggers: [] }),
    async stop() {
      await server.close();
      closed = true;
    },
  };
}

async function setup(mode: string) {
  if (!scratchDir) throw new Error('Set STORAGE_SCANNER_HTTP_SCRATCH to a writable scratch directory');
  const root = mkdtempSync(join(scratchDir, 'storage-apply-http-'));
  dispose.push(() => rmSync(root, { recursive: true, force: true }));
  const scannerDir = join(root, 'scanner');
  mkdirSync(scannerDir, { mode: 0o700 });
  const kubeApi = await kubeFixture();
  const scanner = await startScanner(scannerDir, mode);
  const scan = await call(`${scanner.url}/v1/scan`, scanner.token);
  expect(scan.status).toBe(200);
  const candidates = new Map(scanSchema.parse(scan.data).items
    .map(item => [item.category === 'pod-task' ? item.category : basename(item.path), item]));
  return { root, scannerDir, scanner, kubeApi, candidates };
}

type FileTree = { [file: string]: Buffer | FileTree };

function files(path: string): FileTree {
  return Object.fromEntries(readdirSync(path).sort().map(file => {
    const name = join(path, file);
    return [file, statSync(name).isDirectory() ? files(name) : readFileSync(name)];
  }));
}

async function openDrive(backend: Awaited<ReturnType<typeof startBackend>>) {
  expect((await backend.reconcile()).status).toBe(200);
  const incident = await backend.call<{ drives: { id: string; applyEnabled: boolean }[] }>('/incident');
  expect(incident.status).toBe(200);
  const drive = incident.data.drives.find(drive => drive.applyEnabled);
  if (!drive) throw new Error('The incident fixture must expose a disposable drive');
  return `/incident/drives/${drive.id}`;
}

async function dryRun(backend: Awaited<ReturnType<typeof startBackend>>, path: string) {
  const response = await backend.call<Plan>(`${path}/dry-run`, {});
  expect(response.status).toBe(200);
  return response.data;
}

it.skipIf(!scannerFixture).each([
  { mode: '--crash-after-unlink', select: ['target', 'build'] },
  { mode: '--interrupt-after-unlink', select: ['target', 'build', 'node_modules'] },
])('recovers the original scanner request after $mode', async ({ mode, select }) => {
  const { root, scannerDir, scanner, kubeApi, candidates } = await setup(mode);
  const unselected = files(candidates.get('dist')!.path);
  const other = files(candidates.get('node_modules')!.path);
  const db = pgliteDb();
  dispose.push(() => db.close());
  const backend = await startBackend(root, kubeApi, scanner, db);
  const path = await openDrive(backend);
  const plan = await dryRun(backend, path);
  const frozen = (await backend.storage.plan(plan.id))!;
  const selected = select.map(name => {
    const scannerId = candidates.get(name)?.id;
    const check = frozen.checks.find(check => check.scannerId === scannerId);
    expect(check, name).toBeDefined();
    return check!;
  });
  const [target, build, stale] = selected;
  const approvePath = `/incident/plans/${plan.id}/approve`;
  const approvalBody = { itemIds: selected.map(check => check.itemId) };
  const approved = await backend.call<{ approval: Approval; receipts: Receipt[] }>(approvePath, approvalBody);
  expect(approved.status).toBe(202);
  const { approval } = approved.data;
  expect(approved.data.receipts).toHaveLength(select.length);
  let terminal: Receipt | undefined;
  if (mode === '--crash-after-unlink') {
    expect(await scanner.exited).toBe(75);
    expect((await backend.storage.receipts(approval.id)).map(receipt => receipt.status)).toEqual(['queued', 'queued']);
  } else {
    await vi.waitFor(async () => {
      const receipts = await backend.storage.receipts(approval.id);
      expect(receipts).toEqual(expect.arrayContaining([
        expect.objectContaining({ itemId: target.itemId, status: 'removed' }),
        expect.objectContaining({ itemId: stale.itemId, status: 'stale' }),
        expect.objectContaining({ itemId: build.itemId, status: 'queued' }),
      ]));
      terminal = receipts.find(receipt => receipt.itemId === stale.itemId);
    }, receiptWait);
    expect(await backend.call(`${path}/decisions`, { itemId: target.itemId, decision: 'keep' })).toEqual({
      status: 409,
      data: { error: 'Cleanup already removed this item. Refresh the inventory and check Cleanup receipts.' },
    });
  }
  const conflict = await backend.call(`${path}/decisions`, { itemId: build.itemId, decision: 'keep' });
  expect(conflict).toEqual({
    status: 409,
    data: { error: `Cleanup approval ${approval.id} is already dispatched. Check Cleanup receipts for the final result.` },
  });
  await backend.stop();
  await scanner.close();

  const restartedScanner = await startScanner(scannerDir);
  const restartedBackend = await startBackend(root, kubeApi, restartedScanner, db);
  expect((await restartedBackend.reconcile()).status).toBe(200);
  const final = await restartedBackend.storage.receipts(approval.id);
  expect(final).toHaveLength(select.length);
  expect(final).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemId: target.itemId, status: 'removed', bytes: expect.any(Number) }),
    expect.objectContaining({ itemId: build.itemId, status: 'removed', bytes: expect.any(Number) }),
    ...(terminal ? [terminal] : []),
  ]));
  const replay = await restartedBackend.call(approvePath, approvalBody);
  expect(replay).toEqual({ status: 202, data: { approval, receipts: final } });
  const request = { planId: plan.id, approvalId: approval.id, itemIds: selected.map(check => check.scannerId).sort() };
  const scannerReplay = () => call(`${restartedScanner.url}/v1/apply`, restartedScanner.token, request);
  const response = await scannerReplay();
  expect(response.status).toBe(200);
  const parsed = applyResultSchema.parse(response.data);
  expect(parsed.receipts).toHaveLength(select.length);
  expect(parsed.receipts).toEqual(expect.arrayContaining(final.map(receipt => ({
    itemId: selected.find(check => check.itemId === receipt.itemId)!.scannerId,
    status: receipt.status, bytes: receipt.bytes, reason: expect.any(String),
  }))));
  expect(await scannerReplay()).toEqual(response);
  expect(existsSync(candidates.get('target')!.path)).toBe(false);
  expect(existsSync(candidates.get('build')!.path)).toBe(false);
  expect(files(candidates.get('dist')!.path)).toEqual(unselected);
  expect(files(candidates.get('node_modules')!.path)).toEqual(other);
}, 150_000);

function journal(directory: string, planId: string, itemId: string) {
  const db = new DatabaseSync(join(directory, 'state', 'scanner.sqlite3'), { readOnly: true });
  try {
    const progress = db.prepare('SELECT phase, receipt FROM progress WHERE plan_id = ? AND item_id = ?').get(planId, itemId);
    const purges = db.prepare(`SELECT name, completed, pending, verified_bytes AS bytes,
      json_array_length(manifest) AS entries FROM purges WHERE plan_id = ? AND item_id = ? ORDER BY name`).all(planId, itemId);
    return { progress, purges };
  } finally {
    db.close();
  }
}

async function recordApplyRequests(scanner: Awaited<ReturnType<typeof startScanner>>, dropFirstResponse = false) {
  const requests: unknown[] = [];
  const dropped: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      if (req.url === '/v1/apply') requests.push(body);
      const response = await call(scanner.url + req.url, scanner.token, body);
      if (req.url === '/v1/apply' && dropFirstResponse && !dropped.length) {
        dropped.push(response.data);
        res.destroy();
        return;
      }
      res.writeHead(response.status, { 'content-type': 'application/json' }).end(JSON.stringify(response.data));
    } catch {
      res.writeHead(502).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  dispose.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('Scanner test relay did not start');
  return { scanner: { ...scanner, url: `http://127.0.0.1:${address.port}` }, requests, dropped };
}

it.skipIf(!scannerFixture).each([
  { mode: '--holder-after-unlink', name: 'build', first: 'CACHEDIR.TAG', code: 'host-process-or-bind-mount', siblings: ['target', 'node_modules'] },
  { mode: '--changed-merge-after-unlink', name: 'pod-task', first: '.git/HEAD', code: 'snapshot-merge-proof-changed', siblings: [] },
])('preserves a terminal partial receipt after $mode', async ({ mode, name, first, code, siblings }) => {
  const { root, scannerDir, scanner, kubeApi, candidates } = await setup(mode);
  const affected = candidates.get(name)!;
  const siblingItems = siblings.map(name => candidates.get(name)!);
  const unselected = candidates.get('dist')!.path;
  const originalUnselected = files(unselected);
  const originalSiblings = siblingItems.map(item => files(item.path));
  const bytes = statSync(join(affected.path, first)).blocks * 512;
  expect(bytes).toBeGreaterThan(0);
  expect(bytes).toBeLessThan(affected.bytes);
  const dbPath = join(root, 'database');
  let db = pgliteDb(dbPath);
  dispose.push(() => db.close());
  const backend = await startBackend(root, kubeApi, scanner, db);
  const path = await openDrive(backend);
  const plan = await dryRun(backend, path);
  const competing = await dryRun(backend, path);
  const checks = (await backend.storage.plan(plan.id))!.checks;
  const check = checks.find(row => row.scannerId === affected.id)!;
  const siblingChecks = siblingItems.map(item => checks.find(row => row.scannerId === item.id)!);
  const selected = [check, ...siblingChecks];
  const approvePath = `/incident/plans/${plan.id}/approve`;
  const approvalBody = { itemIds: selected.map(row => row.itemId) };
  const response = await backend.call<{ approval: Approval }>(approvePath, approvalBody);
  expect(response.status).toBe(202);
  const { approval } = response.data;
  const intervention = `needs-intervention:${code}`;
  const partial = { itemId: check.itemId, status: 'partial', reason: intervention, bytes };
  await vi.waitFor(async () => {
    expect(await backend.storage.receipts(approval.id)).toEqual(expect.arrayContaining([
      expect.objectContaining(partial),
      ...siblingChecks.map(row => expect.objectContaining({ itemId: row.itemId, status: 'queued', bytes: 0 })),
    ]));
  }, receiptWait);
  const originalReceipts = await backend.storage.receipts(approval.id);
  expect(originalReceipts).toHaveLength(selected.length);
  expect(await backend.storage.pending()).not.toContain(approval.id);
  const stored = journal(scannerDir, plan.id, affected.id);
  expect(stored.progress?.phase).toBe('done');
  expect(JSON.parse(String(stored.progress?.receipt))).toEqual({ ...partial, itemId: affected.id });
  expect(stored.purges).toEqual([expect.objectContaining({ completed: 1, pending: 1, bytes })]);
  const namespace = name === 'pod-task' ? '.worktrees' : '.data';
  const quarantined = join(scannerDir, 'projects', namespace, 'Fixture', '.storage-incident-quarantine', String(stored.purges[0].name));
  expect(existsSync(affected.path)).toBe(false);
  expect(existsSync(join(quarantined, first))).toBe(false);
  const remaining = files(quarantined);
  if (name === 'build') expect(Object.keys(remaining)).toEqual(['a-entry', 'z-entry']);
  else expect(Object.keys(remaining).length).toBeGreaterThan(0);

  const initial = await backend.call<{ receipts: Receipt[]; items: { id: string; eligible: boolean }[] }>(path);
  expect(initial.status).toBe(200);
  expect(initial.data.receipts).toEqual(expect.arrayContaining(originalReceipts));
  expect(initial.data.items).toContainEqual(expect.objectContaining({ id: check.itemId, eligible: false }));
  await backend.stop();
  await db.close();
  await scanner.close();

  const restartedScanner = await startScanner(scannerDir);
  const relay = await recordApplyRequests(restartedScanner);
  db = pgliteDb(dbPath);
  const restarted = await startBackend(root, kubeApi, relay.scanner, db);
  expect((await restarted.reconcile()).status).toBe(200);
  const detail = await restarted.call<{ receipts: Receipt[]; plans: Plan[] }>(path);
  expect(detail.status).toBe(200);
  expect(detail.data.receipts).toEqual(expect.arrayContaining(originalReceipts));
  expect(detail.data.plans).toContainEqual(plan);
  expect(await restarted.storage.receipts(approval.id)).toEqual(originalReceipts);
  expect(await restarted.call(approvePath, approvalBody)).toEqual({
    status: 202, data: { approval, receipts: originalReceipts },
  });
  expect((await restarted.call(`${path}/decisions`, { itemId: check.itemId, decision: 'keep' })).status).toBe(409);
  expect((await restarted.call(`/incident/plans/${competing.id}/approve`, { itemIds: [check.itemId] })).status).toBe(409);
  expect((await restarted.reconcile()).status).toBe(200);
  expect(relay.requests).toEqual([]);

  const request = { planId: plan.id, approvalId: approval.id, itemIds: selected.map(row => row.scannerId).sort() };
  const scannerUrl = `${restartedScanner.url}/v1/apply`;
  const replay = await call(scannerUrl, restartedScanner.token, request);
  expect(replay.status).toBe(200);
  expect(applyResultSchema.parse(replay.data).receipts).toEqual([{ ...partial, itemId: affected.id }]);
  expect(await call(scannerUrl, restartedScanner.token, request)).toEqual(replay);
  if (siblingItems.length) {
    expect((await call(scannerUrl, restartedScanner.token, { ...request, itemIds: [affected.id] })).status).toBe(409);
    expect(siblingItems.map(item => files(item.path))).toEqual(originalSiblings);
  }
  expect(journal(scannerDir, plan.id, affected.id)).toEqual(stored);
  const persisted = detail.data.receipts.find(receipt => receipt.itemId === check.itemId)!;
  console.info(`${mode}: scanner HTTP ${replay.status}, parent HTTP ${detail.status}, ${persisted.status}, ${persisted.bytes} verified allocated bytes`);
  expect(existsSync(affected.path)).toBe(false);
  expect(files(quarantined)).toEqual(remaining);
  expect(files(unselected)).toEqual(originalUnselected);
}, 150_000);

it.skipIf(!scannerFixture)('recovers a lost partial receipt using the original scanner request', async () => {
  const { root, scannerDir, scanner, kubeApi, candidates } = await setup('--holder-after-unlink');
  const affected = candidates.get('build')!;
  const untouched = ['target', 'node_modules', 'dist'].map(name => candidates.get(name)!.path);
  const original = untouched.map(files);
  const bytes = statSync(join(affected.path, 'CACHEDIR.TAG')).blocks * 512;
  const db = pgliteDb();
  dispose.push(() => db.close());
  const relay = await recordApplyRequests(scanner, true);
  const backend = await startBackend(root, kubeApi, relay.scanner, db);
  const path = await openDrive(backend);
  const plan = await dryRun(backend, path);
  const checks = (await backend.storage.plan(plan.id))!.checks;
  const affectedCheck = checks.find(check => check.scannerId === affected.id)!;
  const siblingCheck = checks.find(check => check.scannerId === candidates.get('target')!.id)!;
  const approvalBody = { itemIds: [affectedCheck.itemId, siblingCheck.itemId] };
  const approved = await backend.call<{ approval: Approval }>(`/incident/plans/${plan.id}/approve`, approvalBody);
  expect(approved.status).toBe(202);
  const approvalId = approved.data.approval.id;
  const partial = { status: 'partial', reason: 'needs-intervention:host-process-or-bind-mount', bytes };
  await vi.waitFor(() => {
    expect(applyResultSchema.parse(relay.dropped[0]).receipts).toEqual([{ ...partial, itemId: affected.id }]);
  }, receiptWait);
  await backend.stop();
  expect((await backend.storage.receipts(approvalId)).map(receipt => receipt.status)).toEqual(['queued', 'queued']);
  const before = journal(scannerDir, plan.id, affected.id);
  await scanner.close();

  const restartedScanner = await startScanner(scannerDir);
  const restartedRelay = await recordApplyRequests(restartedScanner);
  const restarted = await startBackend(root, kubeApi, restartedRelay.scanner, db);
  expect((await restarted.reconcile()).status).toBe(200);
  const receipts = await restarted.storage.receipts(approvalId);
  expect(receipts).toHaveLength(2);
  expect(receipts).toEqual(expect.arrayContaining([
    expect.objectContaining({ ...partial, itemId: affectedCheck.itemId }),
    expect.objectContaining({ status: 'queued', bytes: 0, itemId: siblingCheck.itemId }),
  ]));
  expect((await restarted.reconcile()).status).toBe(200);
  expect(relay.requests).toEqual([{ planId: plan.id, approvalId, itemIds: [affected.id, siblingCheck.scannerId].sort() }]);
  expect(restartedRelay.requests).toEqual(relay.requests);
  expect(journal(scannerDir, plan.id, affected.id)).toEqual(before);
  expect(existsSync(affected.path)).toBe(false);
  expect(untouched.map(files)).toEqual(original);
}, 150_000);

it.skipIf(!scannerFixture)('records removal after the final unlink checkpoint without repeating mutation', async () => {
  const { root, scannerDir, scanner, kubeApi, candidates } = await setup('--crash-before-receipt');
  const affected = candidates.get('build')!;
  const unselected = candidates.get('dist')!.path;
  const originalUnselected = files(unselected);
  const entries = [affected.path, ...readdirSync(affected.path).map(entry => join(affected.path, entry))];
  const bytes = entries.reduce((total, entry) => total + statSync(entry).blocks * 512, 0);
  const dbPath = join(root, 'database');
  let db = pgliteDb(dbPath);
  dispose.push(() => db.close());
  const backend = await startBackend(root, kubeApi, scanner, db);
  const path = await openDrive(backend);
  const plan = await dryRun(backend, path);
  const { itemId } = (await backend.storage.plan(plan.id))!.checks.find(check => check.scannerId === affected.id)!;
  const approvePath = `/incident/plans/${plan.id}/approve`;
  const approvalBody = { itemIds: [itemId] };
  const approved = await backend.call<{ approval: Approval }>(approvePath, approvalBody);
  expect(approved.status).toBe(202);
  const { approval } = approved.data;
  expect(await scanner.exited).toBe(75);
  const checkpoint = journal(scannerDir, plan.id, affected.id);
  expect(checkpoint.progress).toEqual({ phase: 'purging', receipt: null });
  expect(checkpoint.purges).toEqual([expect.objectContaining({ completed: 4, entries: 4, pending: 0, bytes })]);
  expect(existsSync(affected.path)).toBe(false);
  expect(await backend.storage.receipts(approval.id)).toEqual([expect.objectContaining({ itemId, status: 'queued' })]);
  await backend.stop();
  await db.close();
  await scanner.close();

  mkdirSync(affected.path);
  writeFileSync(join(affected.path, 'replacement'), 'replacement at the original path');
  const replacement = files(affected.path);
  const restartedScanner = await startScanner(scannerDir);
  const relay = await recordApplyRequests(restartedScanner);
  db = pgliteDb(dbPath);
  const restarted = await startBackend(root, kubeApi, relay.scanner, db);
  expect((await restarted.reconcile()).status).toBe(200);
  const request = { planId: plan.id, approvalId: approval.id, itemIds: [affected.id] };
  expect(relay.requests).toEqual([request]);
  const receipts = await restarted.storage.receipts(approval.id);
  expect(receipts).toEqual([expect.objectContaining({ itemId, status: 'removed', bytes })]);
  const detail = await restarted.call<{ receipts: Receipt[] }>(path);
  expect(detail.status).toBe(200);
  expect(detail.data.receipts).toEqual(expect.arrayContaining(receipts));
  expect(await restarted.call(approvePath, approvalBody)).toEqual({ status: 202, data: { approval, receipts } });
  expect((await restarted.reconcile()).status).toBe(200);
  expect(relay.requests).toEqual([request]);
  const expected = { itemId: affected.id, status: 'removed', reason: 'removed', bytes };
  const replay = await call(`${restartedScanner.url}/v1/apply`, restartedScanner.token, request);
  expect(replay.status).toBe(200);
  expect(applyResultSchema.parse(replay.data).receipts).toEqual([expected]);
  const finished = journal(scannerDir, plan.id, affected.id);
  expect(finished.progress?.phase).toBe('done');
  expect(JSON.parse(String(finished.progress?.receipt))).toEqual(expected);
  expect(finished.purges).toEqual([]);
  expect(files(affected.path)).toEqual(replacement);
  expect(files(unselected)).toEqual(originalUnselected);
}, 150_000);
