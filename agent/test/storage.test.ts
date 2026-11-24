import { execFile, execFileSync } from 'node:child_process';
import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { generateVapidKeys, subscriptionId } from '../src/push/webpush.js';
import { startServer } from '../src/server.js';
import { StorageQueries, StorageStore } from '../src/storage/store.js';
import type { Approval, Scan, ScanChecks } from '../src/storage/types.js';
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
const operatorGroup = 'fixture-human-operators';
const automation = 'fixture-automation-credential';
const authorityBearer = 'fixture-authority-machine';
const recipient = { issuer: 'https://identity.example.com', subject: 'fixture-immutable-subject' };
const operatorKubernetes = { username: 'fixture-operator', uid: 'fixture-operator-uid' };
const disabledCoverage = { enabled: false, status: 'disabled', registeredRecipients: null, revokedRecipients: null };
const readyCoverage = (registeredRecipients: number, revokedRecipients = 0) => ({
  enabled: true, status: 'ready', registeredRecipients, revokedRecipients,
});
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

async function listener(handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>, tls?: { key: Buffer; cert: Buffer },
  onClose?: (close: () => Promise<void>) => void) {
  const respond = (req: IncomingMessage, res: ServerResponse) => void handle(req, res).catch(() => reply(res, 500, {}));
  const server = tls ? createHttpsServer(tls, respond) : createServer(respond);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise<void>(resolve => server.close(() => resolve()));
  dispose.push(close);
  onClose?.(close);
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('Fixture listener did not start');
  return `${tls ? 'https' : 'http'}://127.0.0.1:${address.port}`;
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
  v2?: () => Record<string, unknown>;
  close?: () => Promise<void>;
  status?: number;
};

async function fixture(options: {
  disposable?: boolean; pushEnabled?: boolean; disabled?: boolean; operatorGroups?: string[] | null; authorityConfigured?: boolean;
  contained?: boolean; policyMount?: string; policyDevice?: string;
  partialScopes?: Record<string, Record<string, string>>;
  policies?: Record<string, { mount: string; device: string }[]>;
} = {}) {
  const dir = mkdtempSync(join(process.env.STORAGE_TEST_FIXTURE_ROOT ?? tmpdir(), 'storage-incident-fixture-'));
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
  let operatorMember = true;
  let authorityStatus = 200;
  let authorityMember = true;
  let authorityVersion = 'fixture-grant-1';
  let authorityResponse: ((input: Record<string, unknown>) => unknown) | undefined;
  const revokedVerbs = new Set<string>();
  const authorityRequests: { token: string | undefined; input: Record<string, unknown> }[] = [];
  const useAuthority = options.pushEnabled && options.authorityConfigured !== false;
  const authorityFile = join(dir, 'authority-token');
  const authorityCA = join(dir, 'authority-ca.pem');
  let authority: string | undefined;
  if (useAuthority) {
    const key = join(dir, 'authority-key.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=example.com', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', authorityCA,
    ], { stdio: 'ignore' });
    writeFileSync(authorityFile, authorityBearer, { mode: 0o600 });
    authority = await listener(async (req, res) => {
      const input = await body(req);
      authorityRequests.push({ token: req.headers.authorization, input });
      if (req.method !== 'POST' || req.url !== '/entitlement' || req.headers.authorization !== `Bearer ${authorityBearer}`) {
        return reply(res, 401, {});
      }
      if (authorityStatus === 307) {
        res.writeHead(307, { location: `${redirectTarget}/authority` });
        res.end();
        return;
      }
      if (authorityStatus !== 200) return reply(res, authorityStatus, {});
      if (authorityResponse) return reply(res, 200, authorityResponse(input));
      const entitled = authorityMember && !revokedVerbs.has('get') && !revokedVerbs.has('update');
      const entitlement = entitled ? { status: 'allowed', version: authorityVersion } : { status: 'revoked' };
      if (input.operation === 'resolve') {
        const matches = JSON.stringify(input.kubernetes) === JSON.stringify(operatorKubernetes);
        return reply(res, 200, {
          kubernetes: input.kubernetes,
          recipient: matches ? recipient : null,
          entitlement: matches ? entitlement : { status: 'revoked' },
        });
      }
      if (input.operation === 'check' && Array.isArray(input.recipients)) {
        return reply(res, 200, {
          decisions: input.recipients.map((identity: unknown) => ({
            recipient: identity,
            entitlement: JSON.stringify(identity) === JSON.stringify(recipient) ? entitlement : { status: 'revoked' },
          })),
        });
      }
      return reply(res, 400, {});
    }, { key: readFileSync(key), cert: readFileSync(authorityCA) });
  }
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
    const valid = [human, viewer, serviceAccount, headlampAccount, automation].includes(token?.slice(7) ?? '');
    if (!valid) return reply(res, 401, {});
    if (path.endsWith('/selfsubjectreviews')) {
      const username = token === `Bearer ${serviceAccount}` ? 'system:serviceaccount:example:viewer'
        : token === `Bearer ${headlampAccount}` ? 'system:serviceaccount:example:headlamp'
          : token === `Bearer ${human}` ? 'fixture-operator'
            : token === `Bearer ${automation}` ? 'fixture-automation' : 'fixture-reader';
      const groups = ['system:authenticated'];
      if (username.startsWith('system:')) groups.push('system:serviceaccounts', operatorGroup);
      else if (username === 'fixture-automation' || (username === 'fixture-operator' && !operatorMember)) groups.push(`${operatorGroup}-other`);
      else groups.push(operatorGroup);
      return reply(res, 201, { status: { userInfo: { username, ...(username === operatorKubernetes.username ? { uid: operatorKubernetes.uid } : {}), groups } } });
    }
    const spec = input.spec as { resourceAttributes?: { group?: string; resource?: string; verb?: string } };
    const attrs = spec?.resourceAttributes;
    const allowed = path.endsWith('/selfsubjectaccessreviews') && attrs?.group === rbac && attrs.resource === 'incidents'
      && !revokedVerbs.has(attrs.verb ?? '')
      && (token === `Bearer ${human}` || token === `Bearer ${automation}` || attrs.verb === 'get');
    return reply(res, 201, { status: { allowed } });
  });
  let at = Date.parse('2026-01-01T00:30:00Z');
  const seenScans: string[] = [];
  const scanPaths: Array<[string, string]> = [];
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
    if ((req.url === '/v1/scan' || req.url === '/v2/scan') && req.method === 'GET') {
      seenScans.push(node);
      scanPaths.push([node, req.url]);
      await onScan?.(node);
      const data = nodeFixtures.get(node)!;
      if (req.url === '/v2/scan') {
        if (!data.v2) return reply(res, 404, {});
        return reply(res, data.status ?? 200, { version: 2, node, scannedAt: new Date(at).toISOString(), ...data.v2() });
      }
      return reply(res, data.status ?? 200, { version: 1, node, scannedAt: new Date(at).toISOString(), inventoryComplete: true, ...data.scan() });
    }
    if (req.url === '/v1/apply' && req.method === 'POST') {
      const request = await body(req) as ApplyRequest;
      applyCalls.push(request);
      const result = apply(request, node);
      return reply(res, result.status, result.data);
    }
    return reply(res, 404, {});
  }, undefined, close => { nodeFixtures.get(node)!.close = close; })])));
  const map = join(dir, 'scanners.json');
  const scannerFile = join(dir, 'scanner-token');
  const machineFile = join(dir, 'reconcile-token');
  const kubeTokenFile = join(dir, 'headlamp-service-token');
  const policiesFile = join(dir, 'filesystem-policies.json');
  const scopesFile = join(dir, 'partial-scan-scopes.json');
  writeFileSync(map, JSON.stringify(addresses));
  writeFileSync(scannerFile, scanner, { mode: 0o600 });
  writeFileSync(machineFile, machine, { mode: 0o600 });
  writeFileSync(kubeTokenFile, headlampAccount, { mode: 0o600 });
  if (options.policies) {
    writeFileSync(policiesFile, JSON.stringify(options.policies));
  } else if (options.policyMount) {
    writeFileSync(policiesFile, JSON.stringify({
      [nodes[0]]: [options.policyDevice ? { mount: options.policyMount, device: options.policyDevice }
        : { mount: options.policyMount, reserveGiB: 100, criticalGiB: 50, growth1hGiB: 20, growth6hGiB: 60 }],
    }));
  }
  if (options.partialScopes) writeFileSync(scopesFile, JSON.stringify(options.partialScopes));
  const env: NodeJS.ProcessEnv = options.disabled ? {} : {
    STORAGE_SCANNERS_FILE: map,
    STORAGE_SCANNER_TOKEN_FILE: scannerFile,
    STORAGE_RECONCILE_TOKEN_FILE: machineFile,
    STORAGE_HEADLAMP_CLUSTER: 'example',
    ...(options.operatorGroups === null ? {} : { STORAGE_OPERATOR_GROUPS: JSON.stringify(options.operatorGroups ?? [operatorGroup]) }),
    ...(authority ? {
      STORAGE_NOTIFICATION_AUTHORITY_URL: `${authority}/entitlement`,
      STORAGE_NOTIFICATION_AUTHORITY_TOKEN_FILE: authorityFile,
      STORAGE_NOTIFICATION_AUTHORITY_CA_FILE: authorityCA,
    } : {}),
    STORAGE_APPLY_ENABLED: options.disposable ? 'true' : 'false',
    STORAGE_DISPOSABLE_SCANNERS: options.disposable ? nodes[0] : '',
    ...(options.contained ? { STORAGE_EXPECT_HOLDER_EVIDENCE: 'false' } : {}),
    ...(options.policyMount || options.policies ? { STORAGE_FILESYSTEM_POLICIES_FILE: policiesFile } : {}),
    ...(options.partialScopes ? { STORAGE_PARTIAL_SCAN_SCOPES_FILE: scopesFile } : {}),
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
  const readMetrics = async () => String((await call('/metrics', { token: false })).data);
  const nodeCheck = (node: string, check: string, result: string, count: number) =>
    `headlamp_agent_storage_reconcile_node_checks_total{check="${check}",node="${node}",result="${result}"} ${count}\n`;
  const parent = async () => (await call(`${api}/incident`)).data;
  const details = async (id: string) => (await call(`${api}/incident/drives/${id}`)).data;
  return {
    db, dir, reviews, seenScans, scanPaths, applyCalls, scannerAuth, nodeFixtures, sent, env, getUrl, parent, details, reconcile, call, readMetrics, nodeCheck,
    authorityRequests, revokedVerbs,
    authority(status: number, member = true) { authorityStatus = status; authorityMember = member; },
    entitlementVersion(version: string) { authorityVersion = version; },
    authorityResponse(override: typeof authorityResponse) { authorityResponse = override; },
    async replica() {
      const replica = await startServer(config, 'test', { store, storageEnv: env, pushFetch, now: () => at });
      dispose.push(() => replica.close());
      return `http://127.0.0.1:${replica.port}`;
    },
    operatorMembership(enabled: boolean) { operatorMember = enabled; },
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
      status: 200, data: { enabled: false, applyEnabled: false, incident: null, drives: [], notices: [], scans: [], notifications: disabledCoverage },
    });
    expect((await f.reconcile()).status).toBe(503);
    const metrics = (await f.call('/metrics', { token: false })).data;
    expect(metrics).toContain('headlamp_agent_storage_push_authority{status="disabled"} 1');
    expect(metrics).toContain('headlamp_agent_storage_push_registered_recipients NaN');
  });

  it.each([{ groups: null }, { groups: ['fixture-unrelated-group'] }])('denies human access with membership configuration $groups', async ({ groups }) => {
    const f = await fixture({ operatorGroups: groups });
    expect((await f.call(`${api}/incident`)).status).toBe(403);
    expect(f.reviews.every(review => review.path.endsWith('/selfsubjectreviews'))).toBe(true);
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
    expect((await f.call(endpoint, { token: automation })).status).toBe(403);
    f.operatorMembership(false);
    expect((await f.call(endpoint)).status).toBe(403);
    f.operatorMembership(true);
    f.revokedVerbs.add('get');
    expect((await f.call(endpoint)).status).toBe(403);
    f.revokedVerbs.clear();
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

  it('accepts contained inventory without recording a complete daily scan', async () => {
    const f = await fixture({ contained: true, policyMount: '/', policyDevice: '/dev/md3' });
    const fixtureNode = f.nodeFixtures.get(nodes[0])!;
    const project = {
      ...fs('project', '/', 20), totalBytes: 1000 * 1024 ** 3,
      aliases: [{ device: '/dev/md3', mountpoint: '/' }],
    };
    const observation = {
      execution: 'shadow' as const, complete: false, inventoryComplete: true,
      filesystems: [project], items: [item('build', project.id)],
    };
    fixtureNode.scan = () => observation;
    const trigger = { node: nodes[0], device: '/dev/md3', mount: '/', reason: 'capacity' };
    const { readMetrics, nodeCheck } = f;
    const expectCheck = async (check: string, result: string, count: number) =>
      expect(await readMetrics()).toContain(nodeCheck(nodes[0], check, result, count));
    const scanRow = async () => (await f.db.query(
      'SELECT result, last_full_at FROM storage_incident_scans WHERE node = $1', [nodes[0]],
    )).rows[0];
    const successMetric = 'headlamp_agent_storage_reconcile_last_success_timestamp_seconds';
    const fullMetric = `headlamp_agent_storage_last_full_scan_timestamp_seconds{node="${nodes[0]}"}`;

    expect(await f.reconcile([trigger])).toEqual({ status: 200, data: { ok: true } });
    expect(await scanRow()).toEqual({ result: 'incomplete', last_full_at: null });
    const { drives } = await f.parent();
    const drive = drives.find((d: { filesystemId: string }) => d.filesystemId === project.id);
    expect(drive).toMatchObject({
      status: 'incomplete', applyEnabled: false, eligibleCount: 0,
      complete: false, inventoryComplete: true, holderEvidenceComplete: false, reserveBytes: 50 * 1024 ** 3, criticalBytes: 25 * 1024 ** 3,
    });
    expect(await readMetrics()).toContain(`${successMetric} 1767227400\n`);
    expect(await readMetrics()).toContain(`${fullMetric} 0\n`);
    expect(await readMetrics()).toContain('headlamp_agent_storage_holder_evidence_expected 0\n');
    await expectCheck('inventory', 'complete', 1);
    await expectCheck('policy', 'matched', 1);
    await expectCheck('trigger', 'matched', 1);
    await expectCheck('holder', 'unavailable', 1);
    await expectCheck('acceptance', 'contained', 1);

    f.advance(60_000);
    expect((await f.reconcile([{ ...trigger, device: '/dev/md4' }])).status).toBe(503);
    await expectCheck('inventory', 'complete', 2);
    await expectCheck('policy', 'matched', 2);
    await expectCheck('trigger', 'unmatched', 1);
    await expectCheck('acceptance', 'rejected', 1);
    for (const degraded of [
      { ...observation, inventoryComplete: false },
      { ...observation, execution: undefined },
      { ...observation, execution: 'disposable' as const },
      { ...observation, filesystems: [fs('other', '/other')], items: [] },
      { ...observation, filesystems: [{ ...project, aliases: [{ device: '/dev/md4', mountpoint: '/' }] }] },
    ]) {
      fixtureNode.scan = () => degraded;
      expect((await f.reconcile()).status).toBe(503);
      expect(await scanRow()).toEqual({ result: 'incomplete', last_full_at: null });
    }
    await expectCheck('inventory', 'incomplete', 1);
    await expectCheck('policy', 'unmatched', 2);
    await expectCheck('trigger', 'not_required', 5);
    await expectCheck('acceptance', 'rejected', 6);
    fixtureNode.status = 503;
    const submittedNode = 'unconfigured-private-node';
    expect((await f.reconcile([{ ...trigger, node: submittedNode }])).status).toBe(503);
    await expectCheck('acceptance', 'scanner_error', 1);
    expect(await scanRow()).toEqual({ result: 'error', last_full_at: null });
    const rendered = await readMetrics();
    for (const privateValue of [submittedNode, trigger.device, observation.items[0].path, machine, scanner]) {
      expect(rendered).not.toContain(privateValue);
    }
    expect(await readMetrics()).toContain(`${successMetric} 1767227400\n`);
    expect(await readMetrics()).toContain(`${fullMetric} 0\n`);

    fixtureNode.status = undefined;
    fixtureNode.scan = () => observation;
    f.seenScans.length = 0;
    expect((await f.reconcile()).status).toBe(200);
    expect(f.seenScans).toEqual([nodes[0]]);
    expect(await readMetrics()).toContain(`${successMetric} 1767227460\n`);
    expect(await scanRow()).toEqual({ result: 'incomplete', last_full_at: null });
    await expectCheck('acceptance', 'contained', 2);

    f.advance(24 * 60 * 60_000);
    fixtureNode.scan = () => ({ ...observation, complete: true });
    expect((await f.reconcile()).status).toBe(200);
    expect(await scanRow()).toMatchObject({ result: 'complete' });
    expect(await readMetrics()).toContain(`${fullMetric} 1767313860\n`);
    await expectCheck('holder', 'complete', 1);
    await expectCheck('acceptance', 'full', 1);
    expect(f.applyCalls).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  it('preserves historical scan and snapshot fields without adding outcomes', async () => {
    const f = await fixture();
    expect((await f.reconcile()).status).toBe(200);
    const { drives, scans } = await f.parent();
    const drive = drives[0];
    const scan = scans.find((record: { node: string }) => record.node === drive.node);
    const { current, history } = await f.details(drive.id);
    expect(scan.checks).toBeDefined();
    expect(current.checks).toBeDefined();

    await f.db.query('ALTER TABLE storage_incident_scans DROP COLUMN checks');
    await f.db.query("UPDATE storage_incident_drives SET data = data #- '{drive,checks}' #- '{current,checks}'");
    await f.db.query("UPDATE storage_incident_snapshots SET data = data - 'checks'");
    await f.restart();

    const withoutChecks = ({ checks: _checks, ...legacy }: { checks?: ScanChecks }) => legacy;
    const legacy = await f.parent();
    expect(legacy.scans).toEqual(scans.map(withoutChecks));
    expect(legacy.drives).toEqual(drives.map(withoutChecks));
    const detail = await f.details(drive.id);
    expect(detail.current).toEqual(withoutChecks(current));
    expect(detail.history).toEqual(history.map(withoutChecks));
  });

  it('rejects duplicate scanner identities and distinguishes a storage failure', async () => {
    const f = await fixture();
    const node = nodes[0];
    const source = f.nodeFixtures.get(node)!;
    const valid = { ...source.scan(), items: [item('one', 'main')] };
    source.scan = () => valid;
    expect((await f.reconcile()).status).toBe(200);
    const initial = (await f.parent()).drives.find((record: { node: string }) => record.node === node);
    const checkpoint = async () => (await f.db.query(
      'SELECT last_full_at FROM storage_incident_scans WHERE node = $1', [node],
    )).rows[0];
    const initialCheckpoint = await checkpoint();
    expect(initialCheckpoint).toEqual({ last_full_at: new Date('2026-01-01T00:30:00Z') });
    const trigger = { node, filesystemId: 'main', reason: 'capacity' };
    const expectFailure = async (acceptance: 'scanner_error' | 'store_error', count: number) => {
      const checks = { inventory: 'unknown', policy: 'unknown', trigger: 'unknown', holder: 'unknown', acceptance };
      expect((await f.reconcile([trigger])).status).toBe(503);
      expect((await f.parent()).scans.find((row: { node: string }) => row.node === node))
        .toMatchObject({ status: 'error', checks });
      expect((await f.db.query('SELECT checks FROM storage_incident_scans WHERE node = $1', [node])).rows)
        .toEqual([{ checks }]);
      const detail = await f.details(initial.id);
      expect(detail.history).toHaveLength(1);
      expect(detail.current).toMatchObject({ scannedAt: initial.scannedAt, complete: false, eligibleCount: 0 });
      expect(await checkpoint()).toEqual(initialCheckpoint);
      const metrics = await f.readMetrics();
      expect(metrics).toContain(f.nodeCheck(node, 'acceptance', acceptance, count));
      expect(metrics).toContain('headlamp_agent_storage_reconcile_last_success_timestamp_seconds 1767227400\n');
    };
    f.advance(60_000);
    source.scan = () => ({ ...valid, items: [valid.items[0], { ...valid.items[0], id: 'two' }] });
    await expectFailure('scanner_error', 1);
    const legacy = { ...valid.items[0], objectKey: undefined };
    source.scan = () => ({ ...valid, items: [legacy, { ...legacy, id: 'two' }] });
    await expectFailure('scanner_error', 2);

    source.scan = () => valid;
    const putSnapshot = StorageQueries.prototype.putSnapshot;
    vi.spyOn(StorageQueries.prototype, 'putSnapshot').mockImplementationOnce(async function (this: StorageQueries, drive, snapshot) {
      await putSnapshot.call(this, drive, snapshot);
      throw new Error('Synthetic storage failure');
    });
    await expectFailure('store_error', 1);

    expect((await f.reconcile([trigger])).status).toBe(200);
    const detail = await f.details(initial.id);
    expect(detail.current).toMatchObject({ complete: true, eligibleCount: 1, checks: { acceptance: 'full' } });
    expect(detail.history).toHaveLength(2);
    expect(await checkpoint()).toEqual(initialCheckpoint);
    expect(await f.readMetrics()).toContain('headlamp_agent_storage_reconcile_last_success_timestamp_seconds 1767227460\n');
    expect(f.applyCalls).toEqual([]);
  });

  it('accepts only the configured omission in a six-node scheduled reconciliation', async () => {
    const partialNode = nodes[5];
    const scopes = {
      '.data/first-owner': 'omitted',
      '.worktrees/first-owner': 'complete',
      '.data/second-owner': 'complete',
      '.worktrees/second-owner': 'complete',
    };
    const project = { device: '/dev/fixture-project', mount: '/projects', reserveGiB: 80, criticalGiB: 40, growth1hGiB: 20, growth6hGiB: 60 };
    const policies = { [nodes[0]]: [project], [partialNode]: [project] };
    const f = await fixture({ contained: true, partialScopes: { [partialNode]: scopes }, policies });
    const gib = 1024 ** 3;
    const drive = {
      ...fs('project', project.mount, 20 * gib), totalBytes: 1000 * gib,
      aliases: [{ device: project.device, mountpoint: project.mount }],
    };
    f.nodeFixtures.get(nodes[0])!.scan = () => ({ filesystems: [drive], items: [], complete: true });
    const partial = f.nodeFixtures.get(partialNode)!;
    partial.scan = () => ({ filesystems: [drive], items: [], complete: false, execution: 'shadow', inventoryComplete: false });
    const coverage = { scopes, filesystemInventoryComplete: true };
    const observation = {
      ...partial.scan(), items: [item('contained-cache', drive.id)], inventoryCoverage: coverage,
    };
    partial.v2 = () => observation;
    const triggers = [nodes[0], partialNode].map(node => ({
      node, device: project.device, mount: project.mount, reason: 'capacity',
      reserveBytes: project.reserveGiB * gib, criticalBytes: project.criticalGiB * gib,
    }));
    let dispatch = async () => (await f.reconcile(triggers)).status === 200;
    const dispatcher = process.env.STORAGE_TEST_DISPATCHER;
    if (dispatcher) {
      const result = nodes.flatMap(node => {
        const labels = { node, device: project.device, mountpoint: project.mount, fstype: 'ext4' };
        return Object.entries({
          avail: policies[node] ? 20 * gib : 500 * gib, size: 1000 * gib, readonly: 0,
          device_error: 0, hour: 500 * gib, six_hours: 500 * gib,
        }).map(([storage_sample, value]) => ({ metric: { ...labels, storage_sample }, value: [1, String(value)] }));
      });
      result.push({
        metric: { node: partialNode, device: '/dev/fixture-unreadable', mountpoint: '/unreadable', fstype: 'ext4', storage_sample: 'device_error' },
        value: [1, '1'],
      });
      const telemetry: string[] = [];
      const metrics = await listener(async (req, res) => {
        if (req.method === 'GET' && req.url?.startsWith('/api/v1/query?')) {
          return reply(res, 200, { status: 'success', data: { resultType: 'vector', result } });
        }
        if (req.method === 'POST' && req.url === '/import') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          telemetry.push(Buffer.concat(chunks).toString());
          return reply(res, 204, {});
        }
        return reply(res, 404, {});
      });
      writeFileSync(join(f.dir, 'pressure-only-filesystems.json'), '{}');
      dispatch = async () => {
        const { stdout, stderr, code } = await promisify(execFile)('python3', [
          '-B', '-c',
          'import runpy, sys; from pathlib import Path; main = runpy.run_path(sys.argv[1])["main"]; main.__globals__["CONFIG"] = Path(sys.argv[2]); sys.exit(main())',
          dispatcher, f.dir,
        ], {
          timeout: 5000,
          env: {
            ...process.env, METRICS_URL: metrics, PRESSURE_METRICS_IMPORT_URL: `${metrics}/import`,
            STORAGE_RECONCILE_TOKEN_FILE: f.env.STORAGE_RECONCILE_TOKEN_FILE,
            STORAGE_RECONCILE_URL: `${f.getUrl()}${api}/reconcile`,
          },
        }).then(output => ({ ...output, code: 0 }), error => {
          if (error.code !== 1) throw error;
          return { stdout: String(error.stdout), stderr: String(error.stderr), code: 1 };
        });
        expect(stderr).toContain('Device errors 1.');
        expect(telemetry.at(-1)).toContain(`headlamp_storage_dispatch_pressure_device_errors{node="${partialNode}"} 1 `);
        expect(telemetry.at(-1)).toContain(`headlamp_storage_dispatch_pressure_missing_current{node="${partialNode}"} 0 `);
        expect(telemetry.at(-1)).toContain('headlamp_storage_dispatch_pressure_lookup_success 1 ');
        if (code === 0) expect(stdout).toContain('Reconcile accepted 2 filesystem triggers.');
        else expect(stderr).toContain('Reconcile failed (HTTPError).');
        return code === 0;
      };
    }
    const partialRow = async () => (await f.db.query(
      'SELECT result, last_full_at, checks FROM storage_incident_scans WHERE node = $1', [partialNode],
    )).rows[0];
    const success = async () => String((await f.call('/metrics', { token: false })).data)
      .match(/^headlamp_agent_storage_reconcile_last_success_timestamp_seconds (\d+)$/m)?.[1];
    const accepted: ScanChecks = {
      inventory: 'configured_omission', policy: 'matched', trigger: 'matched', holder: 'unknown', acceptance: 'configured_omission',
    };
    const scannerError: ScanChecks = {
      inventory: 'unknown', policy: 'unknown', trigger: 'unknown', holder: 'unknown', acceptance: 'scanner_error',
    };
    const expectChecks = async (status: 'incomplete' | 'error', checks: ScanChecks) => {
      expect(await partialRow()).toEqual({ result: status, last_full_at: null, checks });
      const parent = await f.parent();
      expect(parent.scans.find((record: { node: string }) => record.node === partialNode))
        .toMatchObject({ status, checks });
    };
    expect(await dispatch()).toBe(true);
    const firstMetrics = await f.readMetrics();
    for (const [check, result] of [
      ['inventory', 'configured_omission'], ['policy', 'matched'], ['trigger', 'matched'],
      ['holder', 'unknown'], ['acceptance', 'configured_omission'],
    ]) {
      expect(firstMetrics).toContain(f.nodeCheck(partialNode, check, result, 1));
    }
    expect(f.scanPaths.sort()).toEqual(nodes.map(node => [node, node === partialNode ? '/v2/scan' : '/v1/scan']));
    await expectChecks('incomplete', accepted);
    expect((await f.db.query('SELECT node FROM storage_incident_scans WHERE last_full_at IS NOT NULL ORDER BY node')).rows)
      .toEqual(nodes.slice(0, -1).map(node => ({ node })));
    const { drives } = await f.parent();
    const observed = drives.find((record: { node: string }) => record.node === partialNode);
    const expectEvidence = async (checks: ScanChecks) => {
      const detail = await f.details(observed.id);
      expect(detail.current).toMatchObject({
        complete: false, inventoryComplete: false, holderEvidenceComplete: false, eligibleCount: 0, checks,
      });
      expect(detail.history).toContainEqual(detail.current);
      expect(detail.items).toEqual([expect.objectContaining({ eligible: false })]);
      expect((await f.db.query(
        'SELECT data FROM storage_incident_snapshots WHERE id = $1', [detail.current.id],
      )).rows).toEqual([{ data: detail.current }]);
    };
    expect(observed).toMatchObject({ complete: false, inventoryComplete: false, eligibleCount: 0, applyEnabled: false, checks: accepted });
    await expectEvidence(accepted);
    expect(drives.find((record: { node: string }) => record.node === nodes[0]))
      .toMatchObject({ critical: true, reserveBytes: 80 * gib, criticalBytes: 40 * gib });
    expect((await f.db.query('SELECT scope FROM storage_incident_cooldowns')).rows)
      .toEqual([{ scope: JSON.stringify(['node', nodes[0], drive.id]) }]);
    const firstSuccess = await success();
    expect(firstSuccess).toBe('1767227400');

    f.advance(60_000);
    f.scanPaths.length = 0;
    for (const [name, change] of Object.entries({
      'enumeration error': { inventoryCoverage: { ...coverage, scopes: { ...scopes, '.worktrees/first-owner': 'error' } } },
      'wrong bind': { inventoryCoverage: { ...coverage, filesystemInventoryComplete: false } },
      'wrong exact pair': { filesystems: [{ ...drive, aliases: [{ device: project.device, mountpoint: '/wrong' }] }] },
      'ambiguous exact pair': {
        filesystems: [drive, { ...drive, id: 'second-filesystem' }],
      },
      'missing coverage': { inventoryCoverage: undefined },
      'malformed coverage': { inventoryCoverage: { ...coverage, filesystemInventoryComplete: 'true' } },
      'unexpected coverage field': { inventoryCoverage: { ...coverage, verified: true } },
      'unexpected response field': { verified: true },
      'missing scope': { inventoryCoverage: { ...coverage, scopes: { ...scopes, '.data/second-owner': undefined } } },
      'additional scope': { inventoryCoverage: { ...coverage, scopes: { ...scopes, '.data/extra-owner': 'complete' } } },
      'unconfigured omission': { inventoryCoverage: { ...coverage, scopes: { ...scopes, '.data/second-owner': 'omitted' } } },
      'missing execution': { execution: undefined },
      'wrong execution': { execution: 'disposable' },
      'wrong version': { version: 1 },
      'false full inventory': { inventoryComplete: true },
      'false holder evidence': { complete: true },
    })) {
      partial.v2 = () => ({ ...observation, ...change });
      expect(await dispatch(), name).toBe(false);
      if (name === 'wrong exact pair') {
        const rejected: ScanChecks = { ...accepted, policy: 'unmatched', trigger: 'unmatched', acceptance: 'rejected' };
        await expectChecks('incomplete', rejected);
        await expectEvidence(rejected);
      }
    }
    for (const status of [404, 503]) {
      partial.status = status;
      expect(await dispatch(), `scanner HTTP ${status}`).toBe(false);
    }
    expect(await success()).toBe(firstSuccess);
    const failedMetrics = await f.readMetrics();
    expect(failedMetrics).toContain(f.nodeCheck(partialNode, 'inventory', 'incomplete', 5));
    expect(failedMetrics).toContain(f.nodeCheck(partialNode, 'policy', 'unmatched', 2));
    expect(failedMetrics).toContain(f.nodeCheck(partialNode, 'trigger', 'unmatched', 2));
    expect(failedMetrics).toContain(f.nodeCheck(partialNode, 'acceptance', 'rejected', 7));
    expect(failedMetrics).toContain(f.nodeCheck(partialNode, 'acceptance', 'scanner_error', 11));
    await expectChecks('error', scannerError);
    expect([...new Set(f.scanPaths.map(path => path.join(' ')))]).toEqual([`${partialNode} /v2/scan`]);

    partial.status = undefined;
    partial.v2 = () => observation;
    expect(await dispatch()).toBe(true);
    await expectChecks('incomplete', accepted);
    await expectEvidence(accepted);
    expect(await success()).toBe('1767227460');
    expect(await f.readMetrics()).toContain(f.nodeCheck(partialNode, 'acceptance', 'configured_omission', 2));
    f.advance(60_000);
    await partial.close!();
    expect(await dispatch(), 'unreachable opted-in scanner').toBe(false);
    await expectChecks('error', scannerError);
    expect(await success()).toBe('1767227460');
    expect(f.applyCalls).toEqual([]);
    expect(f.sent).toEqual([]);
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
    expect(parent.notifications).toEqual(disabledCoverage);
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
      expect(parent.notifications).toEqual(readyCoverage(0));
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
    expect((await f.call(`${registration}/${device.id}`)).data.enabled).toBe(true);
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
    f.provider(410);
    expect((await f.call(registration, { data: grant })).status).toBe(200);
    await vi.waitFor(async () => {
      const notice = (await f.parent()).notices.find((row: { delivery: { status: string } }) => row.delivery.status === 'failed');
      expect(notice?.delivery).toEqual({
        status: 'failed', targetedRecipients: 1, providerAccepted: 0, failed: 1, pending: 0, clientReceived: null,
      });
    });
    expect(f.sent).toHaveLength(5);
    expect(await f.call(`/api/push/subscriptions/${device.id}`, { token: false })).toEqual({
      status: 200, data: subscribe.data,
    });
    expect(JSON.stringify((await f.db.query('SELECT * FROM storage_incident_push_registrations')).rows)).not.toContain(human);
  });

  it('disables storage enrolment without an approved authority', async () => {
    const f = await fixture({ pushEnabled: true, authorityConfigured: false });
    expect((await f.parent()).notifications.enabled).toBe(false);
    const device = pushDevice();
    expect((await f.call(`${api}/incident/notifications`, {
      data: { subscriptionId: device.id, enabled: true, auth: device.keys.auth, urls: noticeUrls },
    })).status).toBe(503);
  });

  async function enrolFixture(f: Awaited<ReturnType<typeof fixture>>) {
    const device = pushDevice();
    const generic = `/api/push/subscriptions/${device.id}`;
    const subscribe = await f.call(generic, { token: false, data: {
      subscription: { endpoint: device.endpoint, keys: device.keys },
      urls: { incident: '/c/example/incidents/{id}', chat: '/c/example/incidents/chat/{id}' },
    } });
    expect(subscribe.status).toBe(200);
    const registration = `${api}/incident/notifications`;
    const grant = { subscriptionId: device.id, enabled: true, auth: device.keys.auth, urls: noticeUrls };
    expect((await f.call(registration, { data: grant })).status).toBe(200);
    return { device, generic, registration, grant, subscribe };
  }

  function cleanupFixture(f: Awaited<ReturnType<typeof fixture>>) {
    f.nodeFixtures.get(nodes[0])!.scan = () => ({
      filesystems: [fs('main', '/data')], items: [item('cleanup', 'main')], complete: true,
    });
  }

  function outcomes(f: Awaited<ReturnType<typeof fixture>>) {
    return f.db.query('SELECT attempt, result FROM storage_incident_push_attempts ORDER BY attempt').then(result => result.rows);
  }

  it('sends one new notice four hours after enrolment with two replicas and no human session', async () => {
    const f = await fixture({ pushEnabled: true });
    await enrolFixture(f);
    expect(f.authorityRequests).toContainEqual({
      token: `Bearer ${authorityBearer}`,
      input: { operation: 'resolve', kubernetes: operatorKubernetes },
    });
    const reviews = f.reviews.length;
    f.operatorMembership(false);
    f.advance(4 * 60 * 60_000);
    await f.restart();
    const replica = await f.replica();
    cleanupFixture(f);
    await Promise.all([f.reconcile(), f.call(`${api}/reconcile`, {
      via: replica, token: machine, data: { triggers: [] },
    })]);
    await vi.waitFor(async () => expect(await outcomes(f)).toEqual([{ attempt: 1, result: '201' }]));
    expect(f.sent).toHaveLength(1);
    expect(f.reviews).toHaveLength(reviews);
    expect(f.authorityRequests.every(request => request.token === `Bearer ${authorityBearer}`)).toBe(true);
    expect(f.authorityRequests).toContainEqual({
      token: `Bearer ${authorityBearer}`, input: { operation: 'check', recipients: [recipient] },
    });
    expect(JSON.stringify(f.authorityRequests.map(request => request.input))).not.toMatch(/groups|fixture-human-credential/);
  });

  it.each(['membership', 'RBAC get', 'RBAC update', 'regrant', 'grant expiry'])(
    'suppresses storage retry after %s',
    async loss => {
      const f = await fixture({ pushEnabled: true });
      cleanupFixture(f);
      expect((await f.reconcile()).status).toBe(200);
      f.provider(503);
      const { generic, subscribe } = await enrolFixture(f);
      await vi.waitFor(async () => expect(await outcomes(f)).toEqual([{ attempt: 1, result: '503' }]));
      if (loss === 'membership') f.authority(200, false);
      if (loss === 'RBAC get') f.revokedVerbs.add('get');
      if (loss === 'RBAC update') f.revokedVerbs.add('update');
      if (loss === 'regrant') f.entitlementVersion('fixture-grant-2');
      f.provider(201);
      f.advance((loss === 'grant expiry' ? 31 * 24 * 60 : 5) * 60_000);
      await f.restart();
      await vi.waitFor(async () => expect(await outcomes(f)).toEqual([
        { attempt: 1, result: '503' },
        { attempt: 2, result: loss === 'grant expiry' ? 'authorisation_or_notice_withdrawn' : 'revoked' },
      ]));
      const metrics = (await f.call('/metrics', { token: false })).data;
      expect(metrics).toContain('headlamp_agent_storage_push_registered_recipients 0');
      expect(metrics).toContain(`headlamp_agent_storage_push_revoked_recipients ${loss === 'grant expiry' ? 0 : 1}`);
      if (loss !== 'grant expiry') expect(metrics).toContain('headlamp_agent_storage_push_notices{status="revoked"} 1');
      expect(f.sent).toHaveLength(1);
      expect(await f.call(generic, { token: false })).toEqual(subscribe);
    },
  );

  it('checks entitlement again after selecting a recipient and before provider dispatch', async () => {
    const f = await fixture({ pushEnabled: true });
    await enrolFixture(f);
    let checks = 0;
    cleanupFixture(f);
    f.provider(503);
    expect((await f.reconcile()).status).toBe(200);
    await vi.waitFor(async () => expect(await outcomes(f)).toEqual([{ attempt: 1, result: '503' }]));
    f.authorityResponse(input => ({
      decisions: Array.isArray(input.recipients) ? input.recipients.map((identity: unknown) => ({
        recipient: identity,
        entitlement: ++checks === 1
          ? { status: 'allowed', version: 'fixture-grant-1' }
          : { status: 'revoked' },
      })) : [],
    }));
    f.provider(201);
    f.advance(5 * 60_000);
    await f.restart();
    await vi.waitFor(async () => expect(await outcomes(f)).toEqual([
      { attempt: 1, result: '503' }, { attempt: 2, result: 'revoked' },
    ]));
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(f.sent).toHaveLength(1);
  });

  it('reports a lost in-flight result after restart without repeating the send', async () => {
    const f = await fixture({ pushEnabled: true });
    await enrolFixture(f);
    f.provider(503);
    cleanupFixture(f);
    expect((await f.reconcile()).status).toBe(200);
    await vi.waitFor(async () => expect(await outcomes(f)).toEqual([{ attempt: 1, result: '503' }]));
    f.advance(5 * 60_000);
    const store = new StorageStore(f.db);
    const [due] = await store.dueDeliveries(Date.parse('2026-01-01T00:35:00Z'));
    expect(await store.claimDelivery(due, Date.parse('2026-01-01T00:35:00Z'))).toMatchObject({ status: 'sending' });
    f.advance(61_000);
    await f.restart();
    await vi.waitFor(async () => expect(await outcomes(f)).toEqual([
      { attempt: 1, result: '503' }, { attempt: 2, result: 'delivery_unverified' },
    ]));
    expect(f.sent).toHaveLength(1);
    expect((await f.parent()).notices[0].delivery).toMatchObject({
      status: 'failed', providerAccepted: 0, clientReceived: null,
    });
  });

  it('reports an outage before targeting and retries queued deliveries on recovery without consuming a provider attempt', async () => {
    const f = await fixture({ pushEnabled: true });
    f.authority(503);
    cleanupFixture(f);
    expect((await f.reconcile()).status).toBe(200);
    const unavailable = { enabled: true, status: 'unavailable', registeredRecipients: null, revokedRecipients: null };
    await vi.waitFor(async () => {
      const parent = await f.parent();
      expect(parent.notifications).toEqual(unavailable);
      expect(parent.notices[0].delivery.status).toBe('authority_unavailable');
    });
    expect(await outcomes(f)).toEqual([]);
    const metrics = (await f.call('/metrics', { token: false })).data;
    expect(metrics).toContain('headlamp_agent_storage_push_authority{status="unavailable"} 1');
    expect(metrics).toContain('headlamp_agent_storage_push_registered_recipients NaN');
    f.authority(200);
    f.provider(503);
    await enrolFixture(f);
    await vi.waitFor(async () => expect(await outcomes(f)).toEqual([{ attempt: 1, result: '503' }]));
    f.authority(503);
    f.advance(5 * 60_000);
    await f.restart();
    await vi.waitFor(async () => {
      const parent = await f.parent();
      expect(parent.notifications).toEqual(unavailable);
      expect(parent.notices[0].delivery).toMatchObject({ status: 'authority_unavailable', pending: 1 });
    });
    expect(await outcomes(f)).toEqual([{ attempt: 1, result: '503' }]);
    expect(f.sent).toHaveLength(1);
    f.authority(200);
    f.provider(201);
    f.advance(60_000);
    await f.restart();
    await vi.waitFor(async () => expect(await outcomes(f)).toEqual([
      { attempt: 1, result: '503' }, { attempt: 2, result: '201' },
    ]));
    expect(f.sent).toHaveLength(2);
    expect((await f.parent()).notifications).toEqual(readyCoverage(1));
  });

  it('fails closed on redirects, bad TLS and mismatched authority responses', async () => {
    const f = await fixture({ pushEnabled: true });
    expect((await f.parent()).notifications).toEqual(readyCoverage(0));
    const { grant, device, registration } = await enrolFixture(f);
    f.authority(307);
    expect((await f.parent()).notifications.status).toBe('unavailable');
    expect(f.redirected()).toBe(0);
    f.authority(200);
    const ca = f.env.STORAGE_NOTIFICATION_AUTHORITY_CA_FILE!;
    const cert = readFileSync(ca);
    writeFileSync(ca, '');
    expect((await f.parent()).notifications.status).toBe('unavailable');
    writeFileSync(ca, cert);
    const tokenPath = f.env.STORAGE_NOTIFICATION_AUTHORITY_TOKEN_FILE!;
    writeFileSync(tokenPath, 'invalid-fixture-service-credential');
    expect((await f.parent()).notifications.status).toBe('unavailable');
    writeFileSync(tokenPath, authorityBearer);
    expect((await f.parent()).notifications).toEqual(readyCoverage(1));
    f.authorityResponse(input => input.operation === 'resolve'
      ? { kubernetes: { ...operatorKubernetes, uid: 'wrong-uid' }, recipient, entitlement: { status: 'allowed', version: 'fixture-grant-1' } }
      : { decisions: [{ recipient: { ...recipient, subject: 'wrong-subject' }, entitlement: { status: 'allowed', version: 'fixture-grant-1' } }] });
    expect((await f.call(registration, { data: grant })).status).toBe(503);
    expect((await f.parent()).notifications.status).toBe('unavailable');
    expect((await f.call(registration, { data: { subscriptionId: device.id, enabled: false, auth: device.keys.auth } })).status).toBe(200);
    expect(await f.db.query('SELECT data FROM storage_incident_push_registrations').then(result => result.rows)).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  it('requires a fresh opt-in for legacy records with no immutable identity', async () => {
    const f = await fixture({ pushEnabled: true });
    const { device, registration, grant } = await enrolFixture(f);
    await f.db.query("UPDATE storage_incident_push_registrations SET data = data - 'entitlement' WHERE subscription_id = $1", [device.id]);
    cleanupFixture(f);
    expect((await f.reconcile()).status).toBe(200);
    await vi.waitFor(async () => expect((await f.parent()).notices[0].delivery.status).toBe('no_recipients'));
    expect((await f.call(`${registration}/${device.id}`)).data.enabled).toBe(false);
    expect(f.sent).toEqual([]);
    expect((await f.call(registration, { data: grant })).status).toBe(200);
    await vi.waitFor(async () => expect(await outcomes(f)).toEqual([{ attempt: 1, result: '201' }]));
  });

  it('sends one notice per pressure stage and preserves answers across recurrence', async () => {
    const f = await fixture({ pushEnabled: true });
    const device = pushDevice();
    expect((await f.call(`/api/push/subscriptions/${device.id}`, { token: false, data: {
      subscription: { endpoint: device.endpoint, keys: device.keys },
      urls: { incident: '/c/example/incidents/{id}', chat: '/c/example/incidents/chat/{id}' },
    } })).status).toBe(200);
    const renew = async () => expect((await f.call(`${api}/incident/notifications`, { data: {
      subscriptionId: device.id, enabled: true, auth: device.keys.auth, urls: noticeUrls,
    } })).status).toBe(200);

    let available = 50;
    let complete = true;
    const names = ['cleanup-disk', 'question-disk'];
    f.nodeFixtures.get(nodes[0])!.scan = () => ({
      filesystems: names.map(id => fs(id, `/${id}`, available)),
      items: [item('cleanup', names[0]), item('question', names[1], { inUse: true })],
      complete,
      inventoryComplete: complete,
    });
    const triggers = names.map(filesystemId => ({
      node: nodes[0], filesystemId, reason: 'capacity', reserveBytes: 100, criticalBytes: 20,
    }));
    const scan = async (status = 200) => {
      f.advance(16 * 60_000);
      await renew();
      expect((await f.reconcile(triggers)).status).toBe(status);
    };
    const current = async (count: number) => {
      await vi.waitFor(async () => {
        expect(f.sent).toHaveLength(count);
        const rows = (await f.db.query(
          "SELECT count(*)::int AS total FROM storage_incident_push_deliveries WHERE status = 'accepted'",
        )).rows;
        expect(rows).toEqual([{ total: count }]);
      });
      const { notices } = await f.parent();
      return {
        cleanup: notices.find((n: { kind: string }) => n.kind === 'cleanup'),
        question: notices.find((n: { kind: string }) => n.kind === 'question'),
      };
    };
    const answer = (id: string, text: string) => f.call(`${api}/incident/questions/${id}/answer`, { data: { answer: text } });

    await scan();
    const first = await current(2);
    expect((await answer(first.question.questionId, 'Check initial retention.')).status).toBe(200);
    await scan();
    expect((await current(2)).cleanup.id).toBe(first.cleanup.id);
    expect((await current(2)).question).toBeUndefined();

    available = 10;
    await scan();
    const critical = await current(4);
    expect(critical.cleanup.id).not.toBe(first.cleanup.id);
    expect(critical.question.questionId).not.toBe(first.question.questionId);
    expect((await answer(critical.question.questionId, 'Check emergency retention.')).status).toBe(200);

    available = 900;
    complete = false;
    await scan(503);
    complete = true;
    available = 10;
    await scan();
    expect((await current(4)).cleanup.id).toBe(critical.cleanup.id);
    expect((await current(4)).question).toBeUndefined();

    available = 900;
    await scan();
    expect((await current(4)).cleanup.id).toBe(critical.cleanup.id);
    expect((await current(4)).question).toBeUndefined();
    available = 50;
    await scan();
    const recurrent = await current(6);
    expect(new Set([first.cleanup.id, critical.cleanup.id, recurrent.cleanup.id]).size).toBe(3);
    expect(new Set([first.question.questionId, critical.question.questionId, recurrent.question.questionId]).size).toBe(3);
    expect(new Set(f.sent.map(attempt => attempt.headers.get('topic'))).size).toBe(6);
    expect((await f.details(recurrent.question.driveId)).questions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.question.questionId, answer: 'Check initial retention.' }),
      expect.objectContaining({ id: critical.question.questionId, answer: 'Check emergency retention.' }),
      expect.objectContaining({ id: recurrent.question.questionId }),
    ]));
    await scan();
    expect((await current(6)).question.id).toBe(recurrent.question.id);
  });

  it('keeps structured investigations, compaction links and question answers in the parent database', async () => {
    const f = await fixture({ disposable: true });
    const receiptReason = 'Verified by the scanner. '.repeat(15).trim();
    f.onApply((request, node) => ({ status: 200, data: {
      ...request, node, receipts: [{ itemId: 'remove', status: 'removed', reason: receiptReason, bytes: 500 }],
    } }));
    f.nodeFixtures.get(nodes[0])!.scan = () => ({
      filesystems: [fs('main', '/data', 0), fs('cleanup', '/cleanup')],
      items: [item('keep', 'cleanup'), item('remove', 'cleanup')],
      complete: true,
      execution: 'disposable',
    });
    expect((await f.reconcile()).status).toBe(200);
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
    const answer = `${api}/incident/questions/${notice.questionId}/answer`;
    const answerText = 'Review retention policy. '.repeat(16).trim();
    expect((await f.call(answer, { data: { answer: answerText } })).data.answer).toBe(answerText);
    expect((await f.call(answer, { data: { answer: 'Another answer.' } })).status).toBe(409);
    expect((await f.parent()).notices.some((row: { id: string }) => row.id === notice.id)).toBe(false);
    const cleanup = p.drives.find((drive: { filesystemId: string }) => drive.filesystemId === 'cleanup');
    const cleanupPath = `${api}/incident/drives/${cleanup.id}`;
    const [keepItem, removeItem] = (await f.details(cleanup.id)).items;
    const keep = await f.call(`${cleanupPath}/decisions`, { data: { itemId: keepItem.id, decision: 'keep' } });
    expect(keep.status).toBe(200);
    const plan = (await f.call(`${cleanupPath}/dry-run`, { data: {} })).data;
    expect((await f.call(`${api}/incident/plans/${plan.id}/approve`, { data: { itemIds: [removeItem.id] } })).status).toBe(202);
    await vi.waitFor(async () => expect((await f.details(cleanup.id)).receipts[0]?.status).toBe('removed'));

    for (let n = 0; n < 25; n++) {
      expect((await f.call(`${chat}/messages`, { data: { text: 'Explain capacity', driveId: notice.driveId } })).status).toBe(200);
    }
    const compact = (await f.call(chat)).data;
    expect(compact.messages).toHaveLength(24);
    expect(compact.checkpoint.messageCount).toBe(26);
    expect(compact.checkpoint.evidenceIds).toHaveLength(13);
    expect(compact.checkpoint.evidence).toHaveLength(16);
    expect(compact.checkpoint.evidence.slice(0, 13).map((row: { id: string }) => row.id))
      .toEqual([...compact.checkpoint.evidenceIds].reverse());
    expect(compact.checkpoint.evidence[0]).toMatchObject({
      kind: 'capacity', driveId: notice.driveId, summary: expect.stringContaining('0 bytes are available'),
    });
    expect(compact.checkpoint.decisions).toEqual([expect.objectContaining({ id: keep.data.id, decision: 'keep', driveId: cleanup.id })]);
    expect(compact.checkpoint.questions).toEqual([expect.objectContaining({ id: notice.questionId, answer: answerText.slice(0, 280) })]);
    expect(compact.checkpoint.receipts).toEqual([expect.objectContaining({
      driveId: cleanup.id, itemId: removeItem.id, status: 'removed', reason: receiptReason.slice(0, 280), bytes: 500,
    })]);

    const transcript = `${chat}/transcript`;
    expect((await f.call(transcript, { token: false })).status).toBe(401);
    expect((await f.call(transcript, { token: automation })).status).toBe(403);
    expect((await f.call(`${transcript}?limit=25`)).status).toBe(400);
    expect((await f.call(`${transcript}?before=${randomUUID()}`)).status).toBe(404);
    expect((await f.call(`${api}/incident/chat/${randomUUID()}/transcript`)).status).toBe(404);
    const tail = await f.call(transcript, { token: viewer });
    expect(tail).toEqual({ status: 200, data: { id: p.incident.chatId, messages: compact.messages, nextBefore: compact.messages[0].id } });
    const archived = (await f.call(`${transcript}?before=${tail.data.nextBefore}`)).data;
    expect(archived.messages).toHaveLength(24);
    expect(archived.messages.at(-1).id).toBe(compact.checkpoint.throughMessageId);
    const first = (await f.call(`${transcript}?before=${archived.nextBefore}&limit=2`)).data;
    expect(first.nextBefore).toBeNull();
    expect(first.messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'Explain capacity' }),
      expect.objectContaining({ role: 'assistant', text: expect.stringContaining('0 bytes are available') }),
    ]);
    const all = [...first.messages, ...archived.messages, ...tail.data.messages];
    expect(new Set(all.map(message => message.id)).size).toBe(50);

    await f.restart();
    expect((await f.call(chat)).data).toEqual(compact);
    expect((await f.call(`${transcript}?before=${archived.nextBefore}&limit=2`)).data).toEqual(first);
    expect((await f.details(notice.driveId)).questions[0].answer).toBe(answerText);
  });
});
