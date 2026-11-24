import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
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

it.skipIf(!scannerFixture).each([
  { mode: '--crash-after-unlink', select: ['target', 'build'] },
  { mode: '--interrupt-after-unlink', select: ['target', 'build', 'node_modules'] },
])('recovers the original scanner request after $mode', async ({ mode, select }) => {
  if (!scratchDir) throw new Error('Set STORAGE_SCANNER_HTTP_SCRATCH to a writable scratch directory');
  const root = mkdtempSync(join(scratchDir, 'storage-apply-http-'));
  dispose.push(() => rmSync(root, { recursive: true, force: true }));
  const scannerDir = join(root, 'scanner');
  mkdirSync(scannerDir, { mode: 0o700 });
  const kubeApi = await kubeFixture();
  const scanner = await startScanner(scannerDir, mode);
  const scan = await call(`${scanner.url}/v1/scan`, scanner.token);
  expect(scan.status).toBe(200);
  const candidates = new Map(scanSchema.parse(scan.data).items.map(item => [basename(item.path), item]));
  const files = (name: string) => {
    const path = candidates.get(name)!.path;
    return Object.fromEntries(readdirSync(path).sort().map(file => [file, readFileSync(join(path, file))]));
  };
  const unselected = files('dist');
  const other = files('node_modules');
  const db = pgliteDb();
  dispose.push(() => db.close());
  const backend = await startBackend(root, kubeApi, scanner, db);
  expect((await backend.reconcile()).status).toBe(200);
  const incident = await backend.call<{ drives: { id: string; applyEnabled: boolean }[] }>('/incident');
  expect(incident.status).toBe(200);
  const drive = incident.data.drives.find(drive => drive.applyEnabled);
  if (!drive) throw new Error('The incident fixture must expose a disposable drive');
  const path = `/incident/drives/${drive.id}`;
  const dryRun = await backend.call<Plan>(`${path}/dry-run`, {});
  expect(dryRun.status).toBe(200);
  const plan = dryRun.data;
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
    }, { timeout: 20_000 });
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
  expect(files('dist')).toEqual(unselected);
  expect(files('node_modules')).toEqual(other);
}, 150_000);
