import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { generateVapidKeys, subscriptionId } from '../src/push/webpush.js';
import { startServer } from '../src/server.js';
import { StorageStore } from '../src/storage/store.js';
import type { Approval, Scan } from '../src/storage/types.js';
import { pgliteDb, podStore } from './helpers/pglite.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const human = 'fixture-human-credential';
const viewer = 'fixture-read-only-credential';
const serviceAccount = 'fixture-view-service-credential';
const headlampAccount = 'fixture-headlamp-service-credential';
const invalid = 'fixture-rejected-credential';
const machine = 'fixture-reconcile-credential';
const scanner = 'fixture-scanner-credential';
const origin = 'https://example.com';
const nodes = Array.from({ length: 6 }, (_, i) => `worker-${i + 1}`);
const api = '/api/storage';
const rbac = 'storage.incidents.example.com';
const dispose: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const close of dispose.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

function reply(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function listener(handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const server = createServer((req, res) => void handle(req, res).catch(() => reply(res, 500, {})));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  dispose.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('Fixture listener did not start');
  return `http://127.0.0.1:${address.port}`;
}

function fs(id: string, mount: string, availableBytes = 10, shared = false): Scan['filesystems'][number] {
  return {
    id, mount, totalBytes: 1000, availableBytes, shared, aliases: [{ device: 'fixture-device', mountpoint: `${mount}-alias` }],
    device: 'fixture-device', majorMinor: '0:42', fsType: 'fixturefs',
  };
}

function item(id: string, filesystemId: string, extra: Partial<Scan['items'][number]> = {}): Scan['items'][number] {
  return {
    id, objectKey: `object-${id}`, category: 'build-cache', path: `/example/work/${id}`, owner: 'fixture-owner',
    filesystemId, bytes: 500, eligible: true, reason: 'Rebuildable cache', visibility: 'jev', inUse: false, ...extra,
  };
}

type ApplyRequest = { planId: string; approvalId: string; itemIds: string[] };
type PushAttempt = { url: string; headers: Headers; content: Buffer };
type NodeFixture = {
  scan: () => Omit<Scan, 'node' | 'version' | 'scannedAt'>;
  status?: number;
};

async function fixture(options: { disposable?: boolean; pushEnabled?: boolean; disabled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'storage-incident-fixture-'));
  dispose.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = pgliteDb();
  dispose.push(() => db.close());
  const store = await podStore(db);
  const reviews: { path: string; token: string | undefined; input: Record<string, unknown> }[] = [];
  let redirected = 0;
  const redirectTarget = await listener(async (_req, res) => {
    redirected++;
    reply(res, 200, {});
  });
  let redirect = false;
  const kubeApi = await listener(async (req, res) => {
    const token = req.headers.authorization;
    const path = req.url ?? '';
    const input = await body(req);
    reviews.push({ path, token, input });
    if (redirect) {
      res.writeHead(307, { location: `${redirectTarget}/review` });
      res.end();
      return;
    }
    const valid = [human, viewer, serviceAccount, headlampAccount].includes(token?.slice(7) ?? '');
    if (!valid) return reply(res, 401, {});
    if (path.endsWith('/selfsubjectreviews')) {
      const username = token === `Bearer ${serviceAccount}` ? 'system:serviceaccount:example:viewer'
        : token === `Bearer ${headlampAccount}` ? 'system:serviceaccount:example:headlamp'
          : token === `Bearer ${human}` ? 'fixture-operator' : 'fixture-reader';
      const groups = ['system:authenticated'];
      if (username.startsWith('system:')) groups.push('system:serviceaccounts');
      return reply(res, 201, { status: { userInfo: { username, groups } } });
    }
    const spec = input.spec as { resourceAttributes?: { group?: string; resource?: string; verb?: string } };
    const attrs = spec?.resourceAttributes;
    const allowed = path.endsWith('/selfsubjectaccessreviews') && attrs?.group === rbac && attrs.resource === 'incidents'
      && (token === `Bearer ${human}` || attrs.verb === 'get');
    return reply(res, 201, { status: { allowed } });
  });
  let at = Date.parse('2026-01-01T00:30:00Z');
  const seenScans: string[] = [];
  const applyCalls: ApplyRequest[] = [];
  const scannerAuth: (string | undefined)[] = [];
  const nodeFixtures = new Map<string, NodeFixture>(nodes.map(node => [node, {
    scan: () => ({ filesystems: [fs('main', '/data', 900)], items: [], complete: true }),
  }]));
  let onScan: ((node: string) => Promise<void>) | undefined;
  let apply = (_request: ApplyRequest, _node: string): { status: number; data: unknown } => ({ status: 409, data: {} });
  const addresses = Object.fromEntries(await Promise.all(nodes.map(async node => [node, await listener(async (req, res) => {
    scannerAuth.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${scanner}`) return reply(res, 401, {});
    if (req.url === '/v1/scan' && req.method === 'GET') {
      seenScans.push(node);
      await onScan?.(node);
      const data = nodeFixtures.get(node)!;
      return reply(res, data.status ?? 200, { version: 1, node, scannedAt: new Date(at).toISOString(), ...data.scan() });
    }
    if (req.url === '/v1/apply' && req.method === 'POST') {
      const request = await body(req) as ApplyRequest;
      applyCalls.push(request);
      const result = apply(request, node);
      return reply(res, result.status, result.data);
    }
    return reply(res, 404, {});
  })])));
  const map = join(dir, 'scanners.json');
  const scannerFile = join(dir, 'scanner-token');
  const machineFile = join(dir, 'reconcile-token');
  const kubeTokenFile = join(dir, 'headlamp-service-token');
  writeFileSync(map, JSON.stringify(addresses));
  writeFileSync(scannerFile, scanner, { mode: 0o600 });
  writeFileSync(machineFile, machine, { mode: 0o600 });
  writeFileSync(kubeTokenFile, headlampAccount, { mode: 0o600 });
  const env = options.disabled ? {} : {
    STORAGE_SCANNERS_FILE: map,
    STORAGE_SCANNER_TOKEN_FILE: scannerFile,
    STORAGE_RECONCILE_TOKEN_FILE: machineFile,
    STORAGE_HEADLAMP_CLUSTER: 'example',
    STORAGE_APPLY_ENABLED: options.disposable ? 'true' : 'false',
    STORAGE_DISPOSABLE_SCANNERS: options.disposable ? nodes[0] : '',
  };
  const config = { ...loadConfig({}), host: '127.0.0.1', port: 0, kubeApi, kubeTokenFile, dataDir: join(dir, 'state'), allowedOrigins: [origin], reconcileSeconds: 0 };
  const sent: PushAttempt[] = [];
  const keys = generateVapidKeys();
  if (options.pushEnabled) config.push = { ...config.push, ...keys, subject: origin, extraHosts: ['example.com'] };
  let providerStatus = 201;
  const pushFetch = (async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), content: Buffer.from(init?.body as Uint8Array) });
    return new Response(null, { status: providerStatus });
  }) as typeof fetch;
  let agent: Awaited<ReturnType<typeof startServer>>;
  let running = false;
  async function start() {
    agent = await startServer(config, 'test', { store, storageEnv: env, pushFetch, now: () => at });
    running = true;
  }
  await start();
  dispose.push(async () => {
    if (running) await agent.close();
  });
  const getUrl = () => `http://127.0.0.1:${agent.port}`;
  const call = async (path: string, opts: { data?: unknown; token?: string | false; headers?: HeadersInit; via?: string } = {}) => {
    const headers = new Headers(opts.headers);
    if (opts.token !== false) headers.set('authorization', `Bearer ${opts.token ?? human}`);
    if (opts.data !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await fetch(`${opts.via ?? getUrl()}${path}`, { headers, ...opts.data !== undefined && { method: 'POST', body: JSON.stringify(opts.data) } });
    const content = response.headers.get('content-type') ?? '';
    const data = content.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data };
  };
  const reconcile = (triggers: unknown[] = []) => call(`${api}/reconcile`, { data: { triggers }, token: machine });
  const parent = async () => (await call(`${api}/incident`)).data;
  const details = async (id: string) => (await call(`${api}/incident/drives/${id}`)).data;
  return {
    db, reviews, seenScans, applyCalls, scannerAuth, nodeFixtures, sent, env, getUrl, parent, details, reconcile, call,
    onScan(fn: typeof onScan) { onScan = fn; },
    onApply(fn: typeof apply) { apply = fn; },
    provider(status: number) { providerStatus = status; },
    redirect(on: boolean) { redirect = on; },
    redirected: () => redirected,
    advance(ms: number) { at += ms; },
    async restart() {
      running = false;
      await agent.close();
      await start();
    },
  };
}

function pushDevice() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const endpoint = `${origin}/push/fixture`;
  const id = subscriptionId(endpoint);
  const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  return { ecdh, auth, endpoint, id, keys };
}

const noticeUrls = {
  question: '/c/example/incidents/storage/drives/{driveId}/questions/{id}',
  cleanup: '/c/example/incidents/storage/drives/{driveId}/findings/{id}',
};
type Device = ReturnType<typeof pushDevice>;
type Payload = { kind: string; title: string; body: string; url: string; tag: string };

function pushPayload(message: Buffer, device: Device): Payload {
  const publicEnd = 21 + message[20];
  const sender = message.subarray(21, publicEnd);
  const record = message.subarray(publicEnd);
  const salt = message.subarray(0, 16);
  const ikm = Buffer.from(hkdfSync('sha256', device.ecdh.computeSecret(sender), device.auth,
    Buffer.concat([Buffer.from('WebPush: info\0'), device.ecdh.getPublicKey(), sender]), 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', key, nonce).setAuthTag(record.subarray(-16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return JSON.parse(plain.subarray(0, -1).toString());
}

async function clickInServiceWorker(payload: Payload) {
  type WorkerEvent = {
    waitUntil(promise: Promise<unknown>): void;
    data?: unknown;
    notification?: unknown;
  };
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const worker = readFileSync(new URL('../../plugins/incidents/sw.js', import.meta.url), 'utf8');
  runInNewContext(worker, {
    URL,
    self: {
      addEventListener: (type: string, handler: (event: WorkerEvent) => void) => handlers.set(type, handler),
      registration: { scope: `${origin}/headlamp/plugins/incidents/`, showNotification },
      location: { origin },
      clients: { matchAll: async () => [], openWindow },
    },
  });
  let pending: Promise<unknown> | undefined;
  const waitUntil = (promise: Promise<unknown>) => { pending = promise; };
  handlers.get('push')!({ data: { json: () => payload }, waitUntil });
  await pending;
  expect(showNotification).toHaveBeenCalledOnce();
  const options = showNotification.mock.calls[0][1];
  const close = vi.fn();
  handlers.get('notificationclick')!({ notification: { data: options.data, close }, waitUntil });
  await pending;
  expect(close).toHaveBeenCalledOnce();
  expect(openWindow).toHaveBeenCalledOnce();
  return openWindow.mock.calls[0][0];
}

describe('Storage incident normal entry points', () => {
  it('advertises disabled state without exposing records', async () => {
    const f = await fixture({ disabled: true });
    expect(await f.call(`${api}/incident`, { token: false })).toEqual({
      status: 200, data: { enabled: false, applyEnabled: false, incident: null, drives: [], notices: [], scans: [], notifications: { enabled: false, registeredRecipients: 0 } },
    });
    expect((await f.reconcile()).status).toBe(503);
    expect((await f.call('/metrics', { token: false })).data).toContain('headlamp_agent_storage_push_registered_recipients 0');
  });

  it('verifies named humans, exact RBAC and HttpOnly proxy requests without using a service account fallback', async () => {
    const f = await fixture();
    const logs = vi.spyOn(process.stdout, 'write');
    const blank = await f.parent();
    expect(blank).toMatchObject({ enabled: true, applyEnabled: false, drives: [], notices: [] });
    expect(blank.incident.chatId).toMatch(/^[a-f0-9-]{36}$/);
    const endpoint = `${api}/incident`;
    f.reviews.length = 0;
    expect((await f.call(endpoint, { token: false, headers: { 'x-forwarded-user': 'fixture-operator' } })).status).toBe(401);
    expect(f.reviews).toEqual([]);
    expect((await f.call(endpoint, { token: invalid })).status).toBe(401);
    expect(f.reviews.map(review => review.token)).toEqual([`Bearer ${invalid}`]);
    expect((await f.call(endpoint, { token: serviceAccount })).status).toBe(403);
    expect((await f.call(endpoint, { token: headlampAccount })).status).toBe(403);
    expect((await f.call(`${api}/incident`, { token: viewer })).status).toBe(200);
    const chat = `${api}/incident/chat/${blank.incident.chatId}`;
    const message = `${chat}/messages`;
    for (const token of [serviceAccount, headlampAccount, viewer]) {
      expect((await f.call(message, { token, data: { text: 'inventory' } })).status).toBe(403);
    }
    expect((await f.call(message, { headers: { origin: 'https://other.example.com' }, data: { text: 'inventory' } })).status).toBe(403);
    expect((await f.call(message, { headers: { 'content-type': 'text/plain' }, data: { text: 'inventory' } })).status).toBe(415);
    const echo = await f.call(message, { data: { text: `inventory ${human}` } });
    expect(echo).toEqual({ status: 400, data: { error: 'Remove the login credential from the request' } });
    expect(JSON.stringify(echo)).not.toContain(human);
    f.redirect(true);
    expect((await f.call(endpoint)).status).toBe(503);
    f.redirect(false);
    expect(f.redirected()).toBe(0);
    expect((await f.call(`${api}/reconcile`, { data: { triggers: [] } })).status).toBe(401);

    const proxy = await listener(async (req, res) => {
      const headers = new Headers();
      for (const name of ['cookie', 'origin', 'content-type']) {
        const value = req.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      const incoming = await fetch(`${f.getUrl()}${req.url}`, {
        headers, ...req.method === 'POST' && { method: 'POST', body: JSON.stringify(await body(req)) },
      });
      reply(res, incoming.status, await incoming.json());
    });
    const cookie = 'headlamp-auth-example.0=fixture-human-; headlamp-auth-example.1=credential';
    expect((await f.call(chat, { via: proxy, headers: { cookie } })).status).toBe(200);
    expect((await f.call(`${chat}/messages`, { via: proxy, headers: { cookie }, data: { text: 'inventory' } })).status).toBe(403);
    expect((await f.call(`${chat}/messages`, { via: proxy, headers: { cookie, origin }, data: { text: 'inventory' } })).data.messages).toHaveLength(2);
    expect((await f.call(chat, { via: proxy, headers: { cookie: 'headlamp-auth-example.1=credential' } })).status).toBe(401);
    expect((await f.call(chat, { token: false, headers: { 'x-storage-operator-token': `Bearer ${human}` } })).status).toBe(200);
    for (const token of [serviceAccount, headlampAccount]) {
      expect(f.reviews.filter(review => review.token === `Bearer ${token}`).map(review => review.path)).toEqual([
        '/apis/authentication.k8s.io/v1/selfsubjectreviews', '/apis/authentication.k8s.io/v1/selfsubjectreviews',
      ]);
    }
    const allowed = f.reviews.filter(review => review.token === `Bearer ${human}` && review.path.endsWith('selfsubjectaccessreviews'));
    expect(allowed.map(review => review.input.spec)).toEqual(expect.arrayContaining([
      { resourceAttributes: { group: rbac, resource: 'incidents', verb: 'get' } },
      { resourceAttributes: { group: rbac, resource: 'incidents', verb: 'update' } },
    ]));
    expect((await f.reconcile()).status).toBe(200);
    expect(f.scannerAuth).toEqual(nodes.map(() => `Bearer ${scanner}`));
    expect(f.sent).toEqual([]);
    const saved = await f.db.query('SELECT data FROM storage_incident_messages');
    expect(saved.rows).toHaveLength(2);
    const output = JSON.stringify([await f.call(chat), logs.mock.calls, saved.rows]);
    for (const token of [human, viewer, serviceAccount, headlampAccount, invalid]) expect(output).not.toContain(token);
    await f.restart();
    expect((await f.parent()).incident).toEqual(blank.incident);
  });

  it('scans six nodes concurrently, retries only misses, and deduplicates shared aliases across nodes', async () => {
    const f = await fixture();
    const volume = fs('shared-disk', '/volume', 20, true);
    for (const node of nodes.slice(0, 2)) f.nodeFixtures.get(node)!.scan = () => ({ filesystems: [volume], items: [], complete: true });
    f.nodeFixtures.get(nodes[5])!.status = 503;
    let release!: () => void;
    const allScanners = new Promise<void>(resolve => { release = resolve; });
    const arrivals = new Set<string>();
    f.onScan(async node => {
      arrivals.add(node);
      if (arrivals.size === nodes.length) release();
      await allScanners;
    });
    const trigger = { node: nodes[0], device: 'fixture-device', mount: '/volume-alias', reason: 'growth', reserveBytes: 90, criticalBytes: 25 };
    expect(await f.reconcile([trigger])).toMatchObject({ status: 503, data: { ok: false } });
    expect(arrivals.size).toBe(6);
    expect(f.scannerAuth.every(token => token === `Bearer ${scanner}`)).toBe(true);
    expect((await f.parent()).drives).toHaveLength(4);
    expect((await f.parent()).drives.find((drive: { filesystemId: string }) => drive.filesystemId === 'shared-disk'))
      .toMatchObject({ reserveBytes: 90, criticalBytes: 25, critical: true, status: 'critical' });
    f.onScan(undefined);
    f.nodeFixtures.get(nodes[5])!.status = undefined;
    f.seenScans.length = 0;
    expect((await f.reconcile([{ ...trigger, node: nodes[1] }])).status).toBe(200);
    expect(f.seenScans).toEqual([nodes[5]]);
    await f.restart();
    f.seenScans.length = 0;
    expect((await f.reconcile()).status).toBe(200);
    expect(f.seenScans).toEqual([]);
    expect((await f.call('/metrics', { token: false })).data).toContain('headlamp_agent_storage_reconcile_last_success_timestamp_seconds 1767227400');
  });

  it('keeps records private, resets Keep on material change, and blocks production approval', async () => {
    const f = await fixture({ disposable: true });
    let bytes = 500;
    let omitted = false;
    f.nodeFixtures.get(nodes[0])!.scan = () => ({
      filesystems: omitted ? [] : [fs('main', '/data')],
      items: omitted ? [] : [
        item('local-a', 'main', { visibility: 'pcg', path: '/private-project/material', owner: 'private-holder', holder: 'private-process', bytes }),
        item('share-a', 'main'),
        item('temp-a', 'main', { category: 'host-temp', eligible: true }),
      ],
      complete: true,
    });
    expect((await f.reconcile()).status).toBe(200);
    const parent = await f.parent();
    const drive = parent.drives.find((record: { node: string }) => record.node === nodes[0]);
    expect(drive.applyEnabled).toBe(false);
    const path = `${api}/incident/drives/${drive.id}`;
    const detail = await f.details(drive.id);
    expect(JSON.stringify(detail)).not.toMatch(/private-project|private-holder|private-process|local-a/);
    expect(detail.items).toEqual(expect.arrayContaining([expect.objectContaining({ label: '/example/work/share-a', owner: 'fixture-owner' })]));
    const local = detail.items.find((row: { label: string }) => row.label === 'build-cache');
    const decision = await f.call(`${path}/decisions`, { data: { decision: 'keep', itemId: local.id } });
    expect(decision.data.by).toBe('fixture-operator');
    const frozen = (await f.call(`${path}/dry-run`, { data: {} })).data;
    expect(frozen.items).toHaveLength(3);
    expect(frozen.items.find((row: { itemId: string }) => row.itemId === local.id)).toMatchObject({ eligible: false, reason: 'Kept by an operator' });
    const selected = frozen.items.find((row: { eligible: boolean }) => row.eligible);
    expect((await f.call(`${api}/incident/plans/${frozen.id}/approve`, { data: { itemIds: [selected.itemId] } })).status).toBe(503);
    expect(f.applyCalls).toEqual([]);
    f.advance(16 * 60_000);
    bytes += 1;
    const trigger = { node: nodes[0], filesystemId: 'main', reason: 'capacity' };
    expect((await f.reconcile([trigger])).status).toBe(200);
    const changed = await f.details(drive.id);
    expect(changed.items.find((row: { id: string }) => row.id === local.id)).toMatchObject({ eligible: true, bytes: 501 });
    expect(changed.plans.find((plan: { id: string }) => plan.id === frozen.id)).toEqual(frozen);
    expect(changed.history).toHaveLength(2);
    f.advance(16 * 60_000);
    omitted = true;
    expect((await f.reconcile([trigger])).status).toBe(503);
    expect((await f.details(drive.id)).current.complete).toBe(false);
    expect((await f.call(`${path}/dry-run`, { data: {} })).data.items.every((row: { eligible: boolean }) => !row.eligible)).toBe(true);
    expect(JSON.stringify(await f.db.query('SELECT data FROM storage_incident_drives'))).not.toMatch(/private-project|private-holder|private-process/);
  });

  it('accepts one authenticated subset and retries the exact disposable request after partial, busy and gated replies', async () => {
    const f = await fixture({ disposable: true });
    let mode: 'disposable' | 'shadow' = 'disposable';
    f.nodeFixtures.get(nodes[0])!.scan = () => ({
      filesystems: [fs('main', '/data')], items: ['first', 'second', 'third'].map(id => item(id, 'main')), complete: true, execution: mode,
    });
    f.onApply((request, node) => {
      const number = f.applyCalls.length;
      if (number === 2 || number === 3) return { status: number === 2 ? 409 : 503, data: {} };
      const make = (itemId: string, status: string) => ({ itemId, status, bytes: status === 'removed' ? 500 : 0, reason: status });
      const receipts = number === 1 ? [make('first', 'removed')] : [make('first', 'removed'), make('second', 'blocked')];
      return { status: 200, data: { planId: request.planId, approvalId: request.approvalId, node, receipts } };
    });
    expect((await f.reconcile()).status).toBe(200);
    const initial = await f.parent();
    const absentPlan = `${api}/incident/plans/${randomUUID()}/approve`;
    expect((await f.call(absentPlan, {
      data: { itemIds: Array.from({ length: 1000 }, () => randomUUID()) },
    })).status).toBe(404);
    const drive = initial.drives.find((row: { node: string }) => row.node === nodes[0]);
    expect(drive.applyEnabled).toBe(true);
    const path = `${api}/incident/drives/${drive.id}`;
    const plan = (await f.call(`${path}/dry-run`, { data: {} })).data;
    expect(f.applyCalls).toEqual([]);
    const [first, second, third] = plan.items.map((row: { itemId: string }) => row.itemId) as string[];
    const approve = `${api}/incident/plans/${plan.id}/approve`;
    expect((await f.call(approve, { token: viewer, data: { itemIds: [first, second] } })).status).toBe(403);
    expect((await f.call(approve, {
      data: { itemIds: Array.from({ length: 1001 }, () => randomUUID()) },
    })).status).toBe(400);
    const queued = await f.call(approve, { data: { itemIds: [second, first] } });
    expect(queued).toMatchObject({ status: 202, data: { approval: { by: 'fixture-operator' } } });
    expect(queued.data.receipts).toHaveLength(2);
    expect((await f.call(approve, { data: { itemIds: [third] } })).status).toBe(409);
    await vi.waitFor(async () => {
      expect((await f.details(drive.id)).receipts).toEqual(expect.arrayContaining([expect.objectContaining({ itemId: first, status: 'removed' })]));
    });
    const request = { planId: plan.id, approvalId: queued.data.approval.id, itemIds: ['first', 'second'] };
    expect(f.applyCalls).toEqual([request]);
    const decisions = `${path}/decisions`;
    for (const data of [
      { itemId: second, decision: 'keep' },
      { itemId: second, decision: 'defer', until: '2026-01-01T03:00:00Z' },
    ]) {
      expect(await f.call(decisions, { data })).toEqual({
        status: 409,
        data: { error: `Cleanup approval ${queued.data.approval.id} is already dispatched. Check Cleanup receipts for the final result.` },
      });
    }
    const keep = await f.call(decisions, { data: { itemId: third, decision: 'keep' } });
    expect(keep.status).toBe(200);
    expect((await f.details(drive.id)).decisions).toEqual([keep.data]);
    await f.restart();
    const trigger = { reason: 'capacity', node: nodes[0], filesystemId: 'main' };
    mode = 'shadow';
    f.advance(16 * 60_000);
    // After the shadow scan commits, a queued attempt must not go to that scanner again.
    await f.reconcile([trigger]);
    const reached = f.applyCalls.length;
    expect((await f.reconcile()).status).toBe(503);
    expect((await f.call('/metrics', { token: false })).data)
      .toContain('headlamp_agent_storage_reconcile_last_success_timestamp_seconds 1767227400');
    expect(f.applyCalls).toHaveLength(reached);
    mode = 'disposable';
    f.advance(16 * 60_000);
    await f.reconcile([trigger]);
    for (let at = 0; at < 4 && f.applyCalls.length < 4; at++) await f.reconcile();
    expect(f.applyCalls).toEqual([request, request, request, request]);
    const final = (await f.details(drive.id)).receipts;
    expect(final).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: first, status: 'removed', bytes: 500 }),
      expect.objectContaining({ itemId: second, status: 'blocked', bytes: 0 }),
    ]));
    const replay = await f.call(approve, { data: { itemIds: [first, second] } });
    expect(replay.data.approval.id).toBe(queued.data.approval.id);
    expect(f.applyCalls).toHaveLength(4);
    expect(f.reviews.some(review => (review.input.spec as { resourceAttributes?: { verb: string } })?.resourceAttributes?.verb === 'approve')).toBe(true);
  });

  it('checks positive inactivity and retains the planned scanner ID across an unchanged scan', async () => {
    const f = await fixture({ disposable: true });
    let opaqueId = 'first-scan';
    f.nodeFixtures.get(nodes[0])!.scan = () => ({
      filesystems: [fs('main', '/data')],
      items: [
        item(opaqueId, 'main', { objectKey: 'stable-key', path: '/example/work/cache' }),
        item('unknown-inactivity', 'main', { inUse: undefined }),
      ],
      complete: true, execution: 'disposable',
    });
    f.onApply((request, node) => ({ status: 200, data: { ...request, node, receipts: [] } }));
    expect((await f.reconcile()).status).toBe(200);
    const drive = (await f.parent()).drives.find((row: { node: string }) => row.node === nodes[0]);
    const path = `${api}/incident/drives/${drive.id}`;
    const plan = (await f.call(`${path}/dry-run`, { data: {} })).data;
    const [eligible, unknown] = plan.items;
    expect(eligible.eligible).toBe(true);
    expect(unknown).toMatchObject({ eligible: false, reason: 'Inactivity was not verified' });
    opaqueId = 'second-scan';
    f.advance(16 * 60_000);
    expect((await f.reconcile([{ node: nodes[0], filesystemId: 'main', reason: 'capacity' }])).status).toBe(200);
    expect((await f.details(drive.id)).items[0].id).toBe(eligible.itemId);
    const approval = await f.call(`${api}/incident/plans/${plan.id}/approve`, { data: { itemIds: [eligible.itemId] } });
    expect(approval.status).toBe(202);
    await vi.waitFor(() => expect(f.applyCalls).toEqual([
      { planId: plan.id, approvalId: approval.data.approval.id, itemIds: ['first-scan'] },
    ]));
  });

  it('cancels queued cleanup when an operator defers before dispatch', async () => {
    const f = await fixture({ disposable: true });
    f.nodeFixtures.get(nodes[0])!.scan = () => ({
      filesystems: [fs('main', '/data')], items: [item('cache', 'main')], complete: true, execution: 'disposable',
    });
    expect((await f.reconcile()).status).toBe(200);
    const drive = (await f.parent()).drives.find((row: { node: string }) => row.node === nodes[0]);
    const path = `${api}/incident/drives/${drive.id}`;
    const plan = (await f.call(`${path}/dry-run`, { data: {} })).data;
    const { itemId } = plan.items[0];
    // This is the durable state after approval commits and before a worker starts dispatch.
    const approval: Approval = {
      id: randomUUID(), planId: plan.id, driveId: drive.id, itemIds: [itemId], by: 'fixture-operator', createdAt: plan.createdAt,
    };
    const store = new StorageStore(f.db);
    await store.transaction(async tx => {
      await tx.putApproval(approval);
      await tx.putReceipts([{
        id: randomUUID(), approvalId: approval.id, planId: plan.id, driveId: drive.id, itemId, status: 'queued',
        reason: 'Awaiting verified scanner receipt', bytes: 0, updatedAt: approval.createdAt,
      }]);
    });
    const until = '2026-01-01T00:31:00Z';
    expect((await f.call(`${path}/decisions`, { data: { itemId, decision: 'defer', until } })).status).toBe(200);
    f.advance(2 * 60_000);
    expect((await f.reconcile()).status).toBe(200);
    expect(f.applyCalls).toEqual([]);
    expect(await store.receipts(approval.id)).toEqual([
      expect.objectContaining({ itemId, status: 'stale', reason: 'An operator changed the cleanup decision before dispatch' }),
    ]);
  });

  it('requires positive merge evidence for worktrees and pod tasks in the plan and at approval', async () => {
    const f = await fixture({ disposable: true });
    let evidence: 'verified' | undefined = 'verified';
    f.nodeFixtures.get(nodes[0])!.scan = () => ({
      filesystems: [fs('main', '/data')],
      items: [
        item('unsupported-owner', 'main', { category: 'linked-worktree', mergeEvidence: 'unavailable' }),
        item('missing-issuer', 'main', { category: 'pod-task' }),
        item('known-merge', 'main', { category: 'linked-worktree', mergeEvidence: evidence }),
      ],
      complete: true, execution: 'disposable',
    });
    expect((await f.reconcile()).status).toBe(200);
    const drive = (await f.parent()).drives.find((row: { node: string }) => row.node === nodes[0]);
    const path = `${api}/incident/drives/${drive.id}`;
    const detail = await f.details(drive.id);
    expect(detail.items.map(({ eligible, mergeEvidence, reason }: { eligible: boolean; mergeEvidence: string; reason: string }) =>
      ({ eligible, mergeEvidence, reason }))).toEqual([
      { eligible: false, mergeEvidence: 'unavailable', reason: 'Merge verification unavailable' },
      { eligible: false, mergeEvidence: 'unavailable', reason: 'Merge verification unavailable' },
      { eligible: true, mergeEvidence: 'verified', reason: 'Rebuildable cache' },
    ]);
    const plan = (await f.call(`${path}/dry-run`, { data: {} })).data;
    expect(plan.items.map(({ eligible, mergeEvidence }: { eligible: boolean; mergeEvidence: string }) => [eligible, mergeEvidence]))
      .toEqual([[false, 'unavailable'], [false, 'unavailable'], [true, 'verified']]);
    const approve = `${api}/incident/plans/${plan.id}/approve`;
    for (const blocked of plan.items.slice(0, 2)) {
      expect(await f.call(approve, { data: { itemIds: [blocked.itemId] } })).toEqual({
        status: 409, data: { error: 'Merge verification unavailable' },
      });
    }
    evidence = undefined;
    f.advance(16 * 60_000);
    expect((await f.reconcile([{ node: nodes[0], filesystemId: 'main', reason: 'capacity' }])).status).toBe(200);
    expect(await f.call(approve, { data: { itemIds: [plan.items[2].itemId] } })).toEqual({
      status: 409, data: { error: 'Merge verification unavailable' },
    });
    expect((await f.details(drive.id)).plans[0]).toEqual(plan);
    expect(f.applyCalls).toEqual([]);
  });

  it('records disabled proactive delivery separately from zero recipients', async () => {
    const f = await fixture();
    f.nodeFixtures.get(nodes[0])!.scan = () => ({
      filesystems: [fs('main', '/data')], items: [item('cleanup', 'main')], complete: true,
    });
    expect((await f.reconcile()).status).toBe(200);
    const parent = await f.parent();
    expect(parent.notifications).toEqual({ enabled: false, registeredRecipients: 0 });
    expect(parent.notices[0].delivery).toMatchObject({ status: 'disabled', targetedRecipients: 0, clientReceived: null });
    expect(f.sent).toEqual([]);
  });

  it('routes unsolicited question and cleanup push to an opted-in device with persisted attempts and PCG excluded', async () => {
    const f = await fixture({ pushEnabled: true });
    f.nodeFixtures.get(nodes[0])!.scan = () => ({
      filesystems: [fs('cleanup-disk', '/cleanup'), fs('question-disk', '/question'), fs('private-disk', '/private')],
      items: [
        item('cleanup', 'cleanup-disk'),
        item('question', 'question-disk', { category: 'pod-task', mergeEvidence: 'unavailable' }),
        item('private', 'private-disk', { visibility: 'pcg', path: '/sensitive-workspace/item', owner: 'sensitive-person' }),
      ],
      complete: true,
    });
    expect((await f.reconcile()).status).toBe(200);
    const externalNotices = (parent: Awaited<ReturnType<typeof f.parent>>) => parent.notices.filter(
      (notice: { delivery: { status: string } }) => notice.delivery.status !== 'private',
    );
    await vi.waitFor(async () => {
      const parent = await f.parent();
      expect(parent.notifications).toEqual({ enabled: true, registeredRecipients: 0 });
      expect(parent.notices).toHaveLength(3);
      expect(externalNotices(parent).map((n: { delivery: { status: string } }) => n.delivery.status))
        .toEqual(['no_recipients', 'no_recipients']);
    });
    const device = pushDevice();
    const subscribe = await f.call(`/api/push/subscriptions/${device.id}`, {
      token: false, data: {
        subscription: { endpoint: device.endpoint, keys: device.keys },
        urls: { incident: '/c/example/incidents/{id}', chat: '/c/example/incidents/chat/{id}' },
        label: 'Storage fixture',
      },
    });
    expect(subscribe.status).toBe(200);
    const registration = `${api}/incident/notifications`;
    expect(await f.call(`${registration}/${device.id}`)).toEqual({
      status: 200, data: { subscriptionId: device.id, enabled: false },
    });
    expect((await f.parent()).notifications.registeredRecipients).toBe(0);
    f.provider(503);
    const grant = { subscriptionId: device.id, enabled: true, auth: device.keys.auth, urls: noticeUrls };
    expect((await f.call(registration, { token: serviceAccount, data: grant })).status).toBe(403);
    expect((await f.call(registration, { data: { ...grant, auth: Buffer.alloc(16, 7).toString('base64url') } })).status).toBe(403);
    expect(await f.call(registration, { data: grant })).toEqual({ status: 200, data: { subscriptionId: device.id, enabled: true } });
    expect((await f.call(`${registration}/${device.id}`)).data.enabled).toBe(true);
    expect((await f.call(`${registration}/${device.id}`, { token: viewer })).data.enabled).toBe(false);
    const outcomes = async () => (await f.db.query(
      'SELECT attempt, result FROM storage_incident_push_attempts ORDER BY attempt, result',
    )).rows;
    await vi.waitFor(async () => {
      expect(await outcomes()).toEqual([{ attempt: 1, result: '503' }, { attempt: 1, result: '503' }]);
    });
    expect(f.sent).toHaveLength(2);
    expect((await f.call('/metrics', { token: false })).data).toContain('headlamp_agent_storage_push_registered_recipients 1');
    expect(externalNotices(await f.parent()).map((n: { delivery: object }) => n.delivery)).toEqual(
      Array(2).fill({ status: 'pending', targetedRecipients: 1, providerAccepted: 0, failed: 0, pending: 1, clientReceived: null }),
    );
    await f.restart();
    expect((await f.reconcile()).status).toBe(200);
    expect(f.sent).toHaveLength(2);
    f.provider(201);
    f.advance(5 * 60_000);
    expect((await f.reconcile()).status).toBe(200);
    await vi.waitFor(async () => {
      expect(f.sent).toHaveLength(4);
      expect(await outcomes()).toEqual([
        { attempt: 1, result: '503' }, { attempt: 1, result: '503' },
        { attempt: 2, result: '201' }, { attempt: 2, result: '201' },
      ]);
    });
    await f.restart();
    expect((await f.reconcile()).status).toBe(200);
    const parent = await f.parent();
    const chat = (await f.call(`${api}/incident/chat/${parent.incident.chatId}`)).data;
    expect(chat).toEqual({ id: parent.incident.chatId, messages: [], checkpoint: null });
    expect((await f.db.query('SELECT watching_chat FROM push_subscriptions')).rows).toEqual([{ watching_chat: null }]);
    expect(f.sent).toHaveLength(4);
    const payloads = f.sent.slice(2).map(attempt => {
      expect(attempt.url).toBe(device.endpoint);
      expect(attempt.headers.get('content-encoding')).toBe('aes128gcm');
      expect(attempt.headers.get('authorization')).toMatch(/^vapid /);
      expect(attempt.headers.get('authorization')).not.toContain(human);
      return pushPayload(attempt.content, device);
    });
    expect(payloads.map(payload => payload.url)).toEqual(expect.arrayContaining(
      externalNotices(parent).map((notice: { action: { driveId: string; kind: keyof typeof noticeUrls; id: string } }) =>
        noticeUrls[notice.action.kind].replace('{driveId}', notice.action.driveId).replace('{id}', notice.action.id)),
    ));
    for (const payload of payloads) {
      const [, driveId, kind, id] = /\/drives\/([a-f0-9-]+)\/(questions|findings)\/([a-f0-9-]+)$/.exec(payload.url)!;
      const notice = parent.notices.find((row: { action: { id: string } }) => row.action.id === id);
      expect(notice.action.chatId).toBe(chat.id);
      expect(notice.delivery).toEqual({
        status: 'accepted', targetedRecipients: 1, providerAccepted: 1, failed: 0, pending: 0, clientReceived: null,
      });
      expect(await clickInServiceWorker(payload)).toBe(`${origin}/headlamp${payload.url}`);
      if (kind === 'questions') {
        expect((await f.details(driveId)).questions[0].id).toBe(id);
        expect((await f.call(`${api}/incident/questions/${id}/answer`, { data: { answer: 'Review repository coverage.' } })).status).toBe(200);
      } else {
        const result = await f.call(`${api}/incident/drives/${driveId}/dry-run`, { data: {} });
        expect(result.data.items).toEqual([expect.objectContaining({ label: '/example/work/cleanup', eligible: true })]);
      }
    }
    const privateNotice = parent.notices.find((notice: { delivery: { status: string } }) => notice.delivery.status === 'private');
    expect(payloads.every(payload => !payload.url.includes(privateNotice.driveId))).toBe(true);
    expect(JSON.stringify([parent, ...payloads, await f.details(privateNotice.driveId)])).not.toMatch(/sensitive-workspace|sensitive-person/);
    expect(await f.call(registration, { data: { subscriptionId: device.id, enabled: false } })).toEqual({
      status: 200, data: { subscriptionId: device.id, enabled: false },
    });
    expect((await f.parent()).notifications.registeredRecipients).toBe(0);
    f.nodeFixtures.get(nodes[1])!.scan = () => ({
      filesystems: [fs('failure-disk', '/failure')], items: [item('failure', 'failure-disk')], complete: true,
    });
    f.advance(16 * 60_000);
    expect((await f.reconcile([{ node: nodes[1], filesystemId: 'failure-disk', reason: 'capacity' }])).status).toBe(200);
    f.provider(400);
    expect((await f.call(registration, { data: grant })).status).toBe(200);
    await vi.waitFor(async () => {
      const notice = (await f.parent()).notices.find((row: { delivery: { status: string } }) => row.delivery.status === 'failed');
      expect(notice?.delivery).toEqual({
        status: 'failed', targetedRecipients: 1, providerAccepted: 0, failed: 1, pending: 0, clientReceived: null,
      });
    });
    expect(f.sent).toHaveLength(5);
  });

  it('keeps structured investigations, compaction links and question answers in the parent database', async () => {
    const f = await fixture();
    f.nodeFixtures.get(nodes[0])!.scan = () => ({
      filesystems: [fs('main', '/data', 0)], items: [], complete: true,
    });
    await f.reconcile();
    const p = await f.parent();
    const notice = p.notices.find((row: { kind: string }) => row.kind === 'question');
    expect(notice.action).toEqual({ driveId: notice.driveId, kind: 'question', chatId: p.incident.chatId, id: notice.questionId });
    expect(notice.delivery).toMatchObject({ status: 'private', clientReceived: null });
    const detail = await f.details(notice.driveId);
    expect(detail.current.critical).toBe(true);
    expect(detail.questions[0].id).toBe(notice.questionId);
    const inspect = await f.call(`${api}/incident/drives/${notice.driveId}/investigate`, { data: { kind: 'capacity' } });
    expect(inspect.data).toMatchObject({ kind: 'capacity', status: 'done' });
    expect(inspect.data.a2ui.length).toBeGreaterThan(0);
    expect(inspect.data.evidenceIds).toHaveLength(1);
    const chat = `${api}/incident/chat/${p.incident.chatId}`;
    for (let n = 0; n < 25; n++) {
      expect((await f.call(`${chat}/messages`, { data: { text: 'Explain capacity', driveId: notice.driveId } })).status).toBe(200);
    }
    const compact = (await f.call(chat)).data;
    expect(compact.messages).toHaveLength(24);
    expect(compact.checkpoint.messageCount).toBe(26);
    expect(compact.checkpoint.evidenceIds).toHaveLength(13);
    const answer = `${api}/incident/questions/${notice.questionId}/answer`;
    expect((await f.call(answer, { data: { answer: 'Review retention policy.' } })).data.answer).toBe('Review retention policy.');
    expect((await f.call(answer, { data: { answer: 'Another answer.' } })).status).toBe(409);
    expect((await f.parent()).notices.some((row: { id: string }) => row.id === notice.id)).toBe(false);
    await f.restart();
    expect((await f.call(chat)).data).toEqual(compact);
    expect((await f.details(notice.driveId)).questions[0].answer).toBe('Review retention policy.');
  });
});
