import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Metrics } from '../metrics.js';
import type { PushService } from '../push/service.js';
import type { StorageStore } from './store.js';
import { StorageApply } from './apply.js';
import { authenticatedMachine, operatorAuth, tokenFile } from './auth.js';
import { enrolSchema, StorageNotifications, subscriptionSchema } from './notifications.js';
import { StorageReconciler } from './reconcile.js';
import { StorageIncident } from './service.js';
import { HttpScanner } from './transport.js';
import { answerSchema, approvalSchema, decisionSchema, investigationSchema, messageSchema, reconcileSchema, StorageError } from './types.js';

const base = '/api/storage';
const empty = {
  enabled: false, applyEnabled: false, incident: null, drives: [], notices: [], scans: [],
  notifications: { enabled: false, registeredRecipients: 0 },
};
const uuid = z.uuid();
const emptyBody = z.object({}).strict();
const MAX_APPROVAL_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RECONCILE_BODY_BYTES = 8 * 1024 * 1024;

type HttpHelpers = {
  readBody(req: IncomingMessage, maxBytes?: number): Promise<unknown>;
  send(res: ServerResponse, status: number, body: unknown): void;
};

type Settings = {
  urls: ReadonlyMap<string, URL>;
  scannerToken: () => string;
  reconcileToken: () => string;
  cluster: string;
  humanGroups: ReadonlySet<string>;
  userInfo?: URL;
  disposable: ReadonlySet<string>;
  applyEnabled: boolean;
};

function settings(env: NodeJS.ProcessEnv): Settings | undefined {
  const file = env.STORAGE_SCANNERS_FILE;
  if (!file) return;
  const urls = new Map<string, URL>();
  try {
    const values = z.record(z.string().regex(/^[A-Za-z0-9._-]+$/).max(256), z.string()).parse(JSON.parse(readFileSync(file, 'utf8')));
    for (const [node, address] of Object.entries(values)) {
      const url = new URL(address);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid URL');
      urls.set(node, url);
    }
    if (!urls.size || urls.size > 100) throw new Error('invalid scanner count');
  } catch {
    throw new Error('Invalid storage scanner configuration');
  }
  if (!env.STORAGE_SCANNER_TOKEN_FILE || !env.STORAGE_RECONCILE_TOKEN_FILE) throw new Error('Storage token files are required');
  const disposable = new Set((env.STORAGE_DISPOSABLE_SCANNERS ?? '').split(',').map(node => node.trim()).filter(Boolean));
  if ([...disposable].some(node => !urls.has(node))) throw new Error('Invalid disposable scanner configuration');
  let groups: string[];
  let userInfo: URL | undefined;
  try {
    const group = z.string().min(1).max(1024).refine(value => value === value.trim() && !value.startsWith('system:'));
    groups = z.array(group).max(100).parse(JSON.parse(env.STORAGE_OPERATOR_GROUPS || '[]'));
    if (env.STORAGE_OPERATOR_USERINFO_URL) {
      userInfo = new URL(env.STORAGE_OPERATOR_USERINFO_URL);
      const loopback = ['127.0.0.1', '[::1]'].includes(userInfo.hostname);
      if (userInfo.username || userInfo.password || userInfo.search || userInfo.hash
        || (userInfo.protocol !== 'https:' && !(userInfo.protocol === 'http:' && loopback && env.NODE_ENV === 'test'))) {
        throw new Error('invalid issuer endpoint');
      }
    }
  } catch {
    throw new Error('Invalid storage operator configuration');
  }
  return {
    urls,
    humanGroups: new Set(groups),
    userInfo,
    scannerToken: tokenFile(env.STORAGE_SCANNER_TOKEN_FILE),
    reconcileToken: tokenFile(env.STORAGE_RECONCILE_TOKEN_FILE),
    cluster: env.STORAGE_HEADLAMP_CLUSTER ?? '',
    disposable,
    applyEnabled: env.STORAGE_APPLY_ENABLED === 'true',
  };
}

export async function storageHttp(deps: HttpHelpers & {
  config: Config;
  store?: StorageStore;
  metrics: Metrics;
  push: PushService;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}) {
  const { readBody, send, config, store, metrics, push } = deps;
  const active = settings(deps.env ?? process.env);
  const now = deps.now ?? Date.now;
  if (active && !store) throw new Error('Storage incidents require the shared Postgres store');

  const backend = active && store ? await start(active, store) : undefined;

  async function start(configured: Settings, db: StorageStore) {
    await db.init(now());
    const scanner = new HttpScanner(configured.urls, configured.scannerToken);
    const apply = new StorageApply({ store: db, scanner, now, enabled: configured.applyEnabled, disposable: configured.disposable });
    const notifications = new StorageNotifications({ store: db, now, push, issuerConfigured: Boolean(configured.userInfo) });
    const nodes = [...configured.urls.keys()];
    const reconcile = new StorageReconciler({ store: db, scanner, now, metrics, nodes: new Set(nodes) });
    return { apply, notifications, reconcile, db, service: new StorageIncident({ store: db, now, apply, notifications, nodes }) };
  }

  function validId<T>(type: z.ZodType<T>, value: unknown): T {
    const parsed = type.safeParse(value);
    if (!parsed.success) throw new StorageError(404, 'Record not found');
    return parsed.data;
  }

  async function body<T>(req: IncomingMessage, schema: z.ZodType<T>, maxBytes?: number): Promise<T> {
    const parsed = schema.safeParse(await readBody(req, maxBytes));
    if (!parsed.success) throw new StorageError(400, 'Invalid storage request');
    return parsed.data;
  }

  const auth = operatorAuth(config, active?.cluster ?? '', active?.humanGroups ?? new Set(), active?.userInfo);

  async function dispatch(req: IncomingMessage, path: string): Promise<{ status?: number; data: unknown }> {
    const method = req.method;
    const parts = path.slice(base.length + 1).split('/');
    const [root, kind, id, action] = parts;
    const parent = root === 'incident' && parts.length === 1 && method === 'GET';
    if (!active || !backend) {
      if (parent) return { data: empty };
      throw new StorageError(503, 'Storage incidents are disabled');
    }
    const { apply, notifications, reconcile, db, service } = backend;
    if (root === 'reconcile' && parts.length === 1 && method === 'POST') {
      if (!authenticatedMachine(req, active.reconcileToken())) throw new StorageError(401, 'Reconcile authentication required');
      const { triggers } = await body(req, reconcileSchema, MAX_RECONCILE_BODY_BYTES);
      const scanned = await reconcile.run(triggers);
      const applied = await apply.retryPending();
      const ok = scanned && applied;
      notifications.kick();
      if (ok) await db.markReconcile(now());
      metrics.inc('headlamp_agent_storage_reconcile_total', { result: ok ? 'success' : 'error' });
      if (!ok) return { status: 503, data: { ok: false, error: 'Storage reconcile needs retry' } };
      return { data: { ok: true } };
    }
    if (root !== 'incident' || !['GET', 'POST'].includes(method ?? '') || parts.length > 4) throw new StorageError(404, 'Storage route not found');
    const operator = await auth(req, method === 'GET' ? 'get' : kind === 'plans' && action === 'approve' ? 'approve' : 'update');
    async function operatorBody<T>(schema: z.ZodType<T>, maxBytes?: number) {
      const data = await body(req, schema, maxBytes);
      operator.checkBody(data);
      return data;
    }
    if (parent) return { data: await service.parent() };
    if (kind === 'notifications') {
      if (method === 'POST' && parts.length === 2) return { data: await notifications.enrol(await operatorBody(enrolSchema), operator) };
      if (method === 'GET' && parts.length === 3) return { data: await notifications.device(validId(subscriptionSchema, id), operator.name) };
    }
    if (kind === 'drives' && id) {
      const driveId = validId(uuid, id);
      if (method === 'GET' && parts.length === 3) return { data: await service.drive(driveId) };
      if (method === 'POST') {
        if (action === 'investigate') return { data: await service.investigate(driveId, await operatorBody(investigationSchema)) };
        if (action === 'decisions') return { data: await service.decide(driveId, await operatorBody(decisionSchema), operator.name) };
        if (action === 'dry-run') {
          await operatorBody(emptyBody);
          return { data: await apply.dryRun(driveId) };
        }
      }
    }
    if (kind === 'chat' && id) {
      const chatId = validId(uuid, id);
      if (method === 'GET' && parts.length === 3) return { data: await service.chat(chatId) };
      if (method === 'GET' && action === 'transcript') {
        const query = new URL(req.url ?? '/', 'http://example.com').searchParams;
        const before = query.get('before');
        const limit = query.get('limit') ?? '24';
        if (!/^(?:[1-9]|1\d|2[0-4])$/.test(limit)) throw new StorageError(400, 'Transcript limit must be between 1 and 24');
        return { data: await service.transcript(chatId, before === null ? undefined : validId(uuid, before), Number(limit)) };
      }
      if (method === 'POST' && action === 'messages') return { data: await service.chat(chatId, await operatorBody(messageSchema)) };
    }
    if (kind === 'questions' && id && action === 'answer' && method === 'POST') {
      const { answer } = await operatorBody(answerSchema);
      return { data: await service.answer(validId(uuid, id), answer, operator.name) };
    }
    if (kind === 'plans' && id && action === 'approve' && method === 'POST') {
      const { itemIds } = await operatorBody(approvalSchema, MAX_APPROVAL_BODY_BYTES);
      return { status: 202, data: await apply.approve(validId(uuid, id), itemIds, operator.name) };
    }
    throw new StorageError(404, 'Storage route not found');
  }

  return {
    async route(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
      if (path !== base && !path.startsWith(base + '/')) return false;
      try {
        const { status = 200, data } = await dispatch(req, path);
        send(res, status, data);
      } catch (error) {
        if (!(error instanceof StorageError)) throw error;
        send(res, error.status, { error: error.message });
      }
      return true;
    },
    async metrics() {
      if (!backend || !store || !active) {
        metrics.set('headlamp_agent_storage_push_registered_recipients', {}, 0);
        metrics.set('headlamp_agent_storage_reconcile_last_success_timestamp_seconds', {}, 0);
        return;
      }
      const current = await store.metrics();
      metrics.set('headlamp_agent_storage_reconcile_last_success_timestamp_seconds', {}, current.lastSuccess);
      const byNode = new Map(current.scans.map(scan => [scan.node, scan.at]));
      for (const node of active.urls.keys()) metrics.set('headlamp_agent_storage_last_full_scan_timestamp_seconds', { node }, byNode.get(node) ?? 0);
      const counts = new Map(current.receipts.map(row => [row.status, row.count]));
      for (const status of ['queued', 'removed', 'stale', 'blocked', 'failed']) metrics.set('headlamp_agent_storage_receipts', { status }, counts.get(status) ?? 0);
      await backend.notifications.metrics(metrics);
    },
    async drain() {
      await backend?.apply.drain();
      await backend?.notifications.drain();
    },
  };
}
