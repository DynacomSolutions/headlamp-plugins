import { once } from 'node:events';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { diagnosticGeneration, diagnosticHeader, ScheduledDiagnostic } from '../src/storage/diagnostic.js';
import { pgliteDb, podStore } from './helpers/pglite.js';

const start = 1_800_000_000;
const pod = '00000000-0000-4000-8000-000000000001';
const job = `fixture-dispatch-${start / 60}/${pod}`;
const nextJob = `fixture-dispatch-${start / 60 + 5}/${pod}`;
const replacement = `${job.slice(0, -1)}2`;
const nodes = ['worker-1', 'worker-2', 'worker-3'];
const dispose: Array<() => unknown | Promise<unknown>> = [];
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
vi.mock('node:fs', { spy: true });

afterEach(async () => {
  vi.mocked(unlinkSync).mockClear();
  for (const close of dispose.splice(0).reverse()) await close();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'storage-diagnostic-'));
  dispose.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'state');
  const dir = join(dataDir, '.storage-diagnostic');
  const arm = join(dir, 'arm');
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  function write(expires = start + 60, generation = diagnosticGeneration(), mode = 0o600) {
    writeFileSync(arm, `${job} ${expires} ${generation} ${nodes[0]} ${nodes[1]}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(arm, mode);
  }
  return { root, dataDir, dir, arm, write };
}

it('rejects expired or broad windows, stale generations, and non-private controls', () => {
  const { root, dataDir, dir, arm, write } = fixture();
  const now = () => (start + 1) * 1000;
  const claim = new ScheduledDiagnostic(dataDir, now);
  write();
  expect(claim.claim([`${job}\n`])).toBeUndefined();
  expect(claim.claim([`other-dispatch-${start / 60}/${pod}`])).toBeUndefined();
  expect(claim.claim([job.split('/')[0]])).toBeUndefined();
  expect(claim.claim([replacement])).toBeUndefined();
  expect(existsSync(arm)).toBe(true);
  unlinkSync(arm);
  for (const deadline of [start + 1, start + 241]) {
    write(deadline);
    expect(claim.claim([job])).toBeUndefined();
    unlinkSync(arm);
  }
  write(start + 60, 'stale-generation');
  expect(claim.claim([job])).toBeUndefined();
  unlinkSync(arm);
  write(start + 60, diagnosticGeneration(), 0o640);
  expect(claim.claim([job])).toBeUndefined();
  unlinkSync(arm);
  write();
  expect(new ScheduledDiagnostic(dataDir, () => (start - 1) * 1000).claim([job])).toBeUndefined();
  const link = join(root, 'linked-arm');
  linkSync(arm, link);
  expect(claim.claim([job])).toBeUndefined();
  unlinkSync(arm);
  symlinkSync(link, arm);
  expect(claim.claim([job])).toBeUndefined();
  unlinkSync(arm);
  write();
  const linkedData = join(root, 'linked-data');
  mkdirSync(linkedData);
  symlinkSync(dir, join(linkedData, '.storage-diagnostic'));
  expect(new ScheduledDiagnostic(linkedData, now).claim([job])).toBeUndefined();
  expect(claim.claim([job])).toEqual({ job, nodes: new Set(nodes.slice(0, 2)) });
  expect(existsSync(arm)).toBe(false);
  write();
  expect(claim.claim([job])).toBeUndefined();
});

it('spends a validated match when unlink fails and refuses a duplicate after recovery', () => {
  const { dataDir, arm, write } = fixture();
  const claim = new ScheduledDiagnostic(dataDir, () => (start + 1) * 1000);
  const unlink = vi.mocked(unlinkSync);
  write();
  unlink.mockImplementationOnce(() => { throw new Error('Fixture unlink failure'); });
  expect(claim.claim([job])).toBeUndefined();
  expect(unlink).toHaveBeenCalledTimes(1);
  expect(existsSync(arm)).toBe(true);
  expect(claim.claim([job])).toBeUndefined();
  expect(unlink).toHaveBeenCalledTimes(1);
  unlinkSync(arm);
  expect(existsSync(arm)).toBe(false);
});

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  dispose.push(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('Fixture listener did not start');
  return `http://127.0.0.1:${address.port}`;
}

it('passes one authenticated scheduled pod to exactly two scanners across concurrent requests and retries', async () => {
  const { root, dataDir, arm, write } = fixture();
  const db = pgliteDb();
  dispose.push(() => db.close());
  let time = (start + 1) * 1000;
  const observations: Array<{ node: string; jobs?: string[] }> = [];
  const urls = Object.fromEntries(await Promise.all(nodes.map(async node => [node, await listen(createServer((req, res) => {
    if (req.url !== '/v1/scan' || req.headers.authorization !== 'Bearer fixture-scanner') {
      res.writeHead(401).end('{}');
      return;
    }
    observations.push({ node, jobs: req.headersDistinct[diagnosticHeader] });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      node, version: 1, execution: 'shadow', scannedAt: new Date(time).toISOString(), complete: true,
      inventoryComplete: false, filesystems: [], items: [],
    }));
  }))] as const)));
  const scanners = join(root, 'scanners');
  const scanToken = join(root, 'scanner-token');
  const reconcileToken = join(root, 'reconcile-token');
  writeFileSync(scanners, JSON.stringify(urls));
  writeFileSync(scanToken, 'fixture-scanner', { mode: 0o600 });
  writeFileSync(reconcileToken, 'fixture-dispatcher', { mode: 0o600 });
  const agent = await startServer({
    ...loadConfig({}), dataDir, port: 0, host: '127.0.0.1', reconcileSeconds: 0,
  }, 'test', {
    store: await podStore(db), now: () => time, storageEnv: {
      STORAGE_SCANNERS_FILE: scanners, STORAGE_SCANNER_TOKEN_FILE: scanToken,
      STORAGE_RECONCILE_TOKEN_FILE: reconcileToken,
      STORAGE_HEADLAMP_SERVICE_ACCOUNT: 'system:serviceaccount:k8s:headlamp',
    },
  });
  dispose.push(() => agent.close());
  const url = `http://127.0.0.1:${agent.port}`;
  const reconcile = (jobs: string[], token = 'fixture-dispatcher', payload = '{"triggers":[]}') =>
    new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const call = request(url + '/api/storage/reconcile', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`, 'content-type': 'application/json',
          [diagnosticHeader]: jobs,
        },
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => { chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }); });
      });
      call.on('error', reject);
      call.end(payload);
    });

  expect((await reconcile([job])).body).not.toContain(job);
  expect(observations.filter(seen => seen.jobs)).toEqual([]);
  write();
  expect((await reconcile([job], 'wrong-token')).status).toBe(401);
  expect((await reconcile([job], 'fixture-dispatcher', '{}')).status).toBe(400);
  await reconcile([job, job]);
  await reconcile([nextJob]);
  await reconcile([replacement]);
  expect(observations.filter(seen => seen.jobs)).toEqual([]);
  expect(existsSync(arm)).toBe(true);
  const results = await Promise.all([reconcile([job]), reconcile([job])]);
  expect(results.every(result => !result.body.includes(job))).toBe(true);
  expect(existsSync(arm)).toBe(false);
  expect(observations.filter(seen => seen.jobs).sort((a, b) => a.node.localeCompare(b.node))).toEqual([
    { node: nodes[0], jobs: [job] }, { node: nodes[1], jobs: [job] },
  ]);
  const before = observations.length;
  await reconcile([job]);
  await reconcile([replacement]);
  time += 300_000;
  await reconcile([nextJob]);
  expect(observations.length).toBeGreaterThan(before);
  expect(observations.slice(before).every(seen => seen.jobs === undefined)).toBe(true);
  const metrics = await (await fetch(url + '/metrics')).text();
  expect(metrics).not.toContain(job);
});
