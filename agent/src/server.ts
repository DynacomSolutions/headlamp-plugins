import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { loadConfig, modelConfigured, type Config } from './config.js';
import { AlertGate, diagnosisIdFor, fingerprint, parseAlerts } from './alerts.js';
import { ChatError, ChatService } from './agent/chat.js';
import { ChatStore } from './chats.js';
import { diagnose } from './agent/engine.js';
import { ModelCatalogue, UnknownModelError } from './agent/catalogue.js';
import { ModelClient } from './agent/model.js';
import { alertSchema, renderDiagnosis, resultSchema, sanitizeResult, type Alert, type Diagnosis } from './agent/report.js';
import { mask, maskText } from './mask.js';
import { mcpHandler } from './mcp.js';
import { Runtime, serviceGet } from './runtime.js';
import { PanelError, buildPanel, listPanels } from './widgets.js';
import { DiagnosisStore, openDiagnosisStore } from './store.js';
import { LaunchError, LaunchService } from './launch/service.js';
import { LaunchStore, type Launch } from './launch/store.js';
import { T3Client, tokenFromFile } from './t3/client.js';

const MAX_BODY = 1024 * 1024;

function log(level: 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...extra })}\n`);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Body is not JSON');
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

const RENEW_MS = 20_000;
const SCAN_MS = 30_000;
const MAX_ATTEMPTS = 3;

/** Runs diagnoses one at a time, in arrival order, so a burst of alerts cannot overload the model quota. */
export class Runner {
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private draining = false;
  /** Ids this process holds (queued or running) and keeps the lease of. */
  private readonly held = new Set<string>();
  private running: string | undefined;
  private renewTimer: NodeJS.Timeout | undefined;
  private scanTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly runtime: Runtime,
    private readonly store: DiagnosisStore,
    private readonly config: Config,
    readonly catalogue: ModelCatalogue = new ModelCatalogue(config.models),
  ) {}

  get configured(): boolean {
    return modelConfigured(this.config.models);
  }

  /** Look for abandoned diagnoses now and every 30 s. */
  start(): void {
    void this.scan();
    this.scanTimer = setInterval(() => void this.scan(), SCAN_MS);
    this.scanTimer.unref();
  }

  /**
   * Take over queued or running diagnoses that nobody holds: the lease ran out or is missing.
   * They run again with the same id and creation time and do not count against the hourly cap.
   * Without a model, when the alert has resolved, or after 3 attempts, they are marked failed.
   */
  async scan(): Promise<void> {
    if (this.draining) return;
    try {
      const stale = (await this.store.stale()).filter(d => !this.held.has(d.id));
      for (const listed of stale) {
        try {
          let taken: Diagnosis | undefined;
          // Decided on the record as stored now: the other pod may have renewed the lease meanwhile.
          await this.store.update(listed.id, d => {
            if (!d || (d.status !== 'queued' && d.status !== 'running') || !this.store.expired(d)) return undefined;
            const attempts = d.attempts ?? 1;
            const fail = (error: string): Diagnosis => {
              const failed = { ...d, status: 'failed' as const, error, owner: this.store.owner, leaseUntil: undefined };
              return { ...failed, a2ui: renderDiagnosis(failed) };
            };
            if (d.resolvedAt || !this.configured) return fail('Interrupted by a restart');
            if (attempts >= MAX_ATTEMPTS) return fail(`Gave up after ${attempts} attempts`);
            taken = { ...d, status: 'queued', evidence: [], result: undefined, error: undefined, toolCalls: 0, attempts: attempts + 1, owner: this.store.owner, leaseUntil: this.store.lease() };
            return taken;
          });
          if (taken) {
            await this.resume(taken);
            log('info', 'diagnosis taken over', { id: listed.id, alert: listed.alert.name });
          }
        } catch (error) {
          log('error', 'takeover failed', { id: listed.id, error: String(error) });
        }
      }
    } catch (error) {
      log('error', 'takeover scan failed', { error: String(error) });
    }
  }

  /**
   * Stop starting work and resolve when the diagnosis that runs now has finished.
   * Diagnoses that have not started give up their lease, so the next pod takes them over.
   * The running one keeps its lease until it finishes.
   */
  async drain(): Promise<void> {
    this.draining = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = undefined;
    for (const id of [...this.held]) {
      if (id === this.running) continue;
      try {
        await this.store.update(id, d => (d && d.owner === this.store.owner && d.status === 'queued' ? { ...d, leaseUntil: DiagnosisStore.released() } : undefined));
      } catch (error) {
        log('error', 'lease release failed', { id, error: String(error) });
      }
      this.held.delete(id);
    }
    while (this.pending > 0) await this.chain;
    this.stopRenewing();
  }

  private async renew(): Promise<void> {
    for (const id of [...this.held]) {
      try {
        await this.store.update(id, d => (d && d.owner === this.store.owner && (d.status === 'queued' || d.status === 'running') ? { ...d, leaseUntil: this.store.lease() } : undefined));
      } catch (error) {
        log('error', 'lease renewal failed', { id, error: String(error) });
      }
    }
  }

  private stopRenewing(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = undefined;
  }

  /** Run again a diagnosis that a restart interrupted. It keeps its id and its creation time. */
  async resume(interrupted: Diagnosis): Promise<void> {
    await this.enqueue(interrupted.alert, interrupted.source, interrupted.id, interrupted.model || undefined);
  }

  /** `model` is a model id (`<route>/<model>`) the caller has checked. Without it the run uses the recorded model or the default. */
  async enqueue(alert: Alert, source: Diagnosis['source'], existingId?: string, model?: string): Promise<Diagnosis> {
    const existing = existingId ? await this.store.get(existingId) : undefined;
    // One firing alert has one diagnosis id, so a second pod or a repeated request finds the record and stops.
    const derived = !existingId && (source === 'webhook' || alert.startsAt) ? diagnosisIdFor(alert.fingerprint, alert.startsAt) : undefined;
    const queued: Diagnosis = {
      id: existing?.id ?? derived ?? randomUUID(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      status: 'queued',
      source,
      host: 'cluster',
      alert: mask(alert),
      evidence: [],
      toolCalls: 0,
      toolBudget: this.config.diagnosis.toolBudget,
      model: model ?? existing?.model ?? this.config.models.defaultModel,
      a2ui: [],
      owner: this.store.owner,
      leaseUntil: this.draining ? DiagnosisStore.released() : this.store.lease(),
      attempts: existing ? (existing.attempts ?? 1) : 1,
    };
    queued.a2ui = renderDiagnosis(queued);
    if (existing) {
      if (!(await this.store.put(queued))) return queued;
    } else if (!(await this.store.putNew(queued))) {
      return (await this.store.get(queued.id)) ?? queued;
    }
    if (this.draining) return queued;
    if (!existing && this.pending >= 20) {
      await this.store.put({ ...queued, status: 'failed', error: 'Too many diagnoses queued', leaseUntil: undefined, a2ui: renderDiagnosis({ ...queued, status: 'failed', error: 'Too many diagnoses queued' }) });
      return queued;
    }
    this.pending++;
    this.held.add(queued.id);
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => void this.renew(), RENEW_MS);
      this.renewTimer.unref();
    }
    this.chain = this.chain.then(async () => {
      let lost = false;
      try {
        if (this.draining) return;
        const fresh = await this.store.get(queued.id);
        if (!fresh || fresh.owner !== this.store.owner || this.store.expired(fresh)) return;
        this.running = queued.id;
        const abort = new AbortController();
        // Progress writes run one after another, so an older step never overwrites a newer one.
        let writes: Promise<void> = Promise.resolve();
        const resolved = await this.catalogue.resolve(queued.model || undefined);
        const client = new ModelClient(resolved.route, resolved.model);
        const result = await diagnose({
          alert,
          tools: this.runtime.toolHost(),
          model: client,
          budget: this.config.diagnosis.toolBudget,
          source,
          host: 'cluster',
          id: queued.id,
          signal: abort.signal,
          onEvent: event => {
            if (event.type !== 'progress') return;
            const diagnosis = event.diagnosis;
            writes = writes.then(async () => {
              if (lost) return;
              try {
                const ok = await this.store.put({ ...diagnosis, createdAt: queued.createdAt, owner: this.store.owner, leaseUntil: this.store.lease(), attempts: queued.attempts });
                if (!ok) {
                  // Another process owns the record now. Stop working on it.
                  lost = true;
                  abort.abort();
                  log('warn', 'diagnosis ownership lost', { id: queued.id });
                }
              } catch (error) {
                log('error', 'diagnosis write failed', { id: queued.id, error: String(error) });
              }
            });
          },
        });
        await writes;
        if (lost) return;
        if (!(await this.store.put({ ...result, createdAt: queued.createdAt, owner: this.store.owner, attempts: queued.attempts }))) return;
        log('info', 'diagnosis finished', { id: result.id, alert: alert.name, status: result.status, toolCalls: result.toolCalls, error: result.error });
      } catch (error) {
        log('error', 'diagnosis crashed', { id: queued.id, error: String(error) });
        // Best effort: a crash must not leave a record that the next scan runs again and again.
        if (!lost) {
          try {
            const message = maskText(error instanceof Error ? error.message : String(error));
            await this.store.update(queued.id, d => {
              if (!d || d.owner !== this.store.owner) return undefined;
              const failed = { ...d, status: 'failed' as const, error: message, leaseUntil: undefined };
              return { ...failed, a2ui: renderDiagnosis(failed) };
            });
          } catch (writeError) {
            log('error', 'could not record the failure', { id: queued.id, error: String(writeError) });
          }
        }
      } finally {
        this.running = undefined;
        this.held.delete(queued.id);
        if (this.held.size === 0 && !this.draining) this.stopRenewing();
        this.pending--;
      }
    });
    return queued;
  }
}

const publishSchema = z.object({
  diagnosis: z.object({
    id: z.string().uuid().optional(),
    source: z.enum(['acp', 'api', 'cli']).default('api'),
    host: z.string().max(80).optional(),
    alert: alertSchema,
    status: z.enum(['done', 'failed']),
    result: resultSchema.optional(),
    error: z.string().max(2000).optional(),
    evidence: z.array(z.object({ id: z.string().max(16), tool: z.string().max(80), reason: z.string().max(400), summary: z.string().max(2000), ok: z.boolean(), data: z.unknown().refine(v => v === undefined || JSON.stringify(v).length <= 30_000, 'data is too large').optional() })).max(60).default([]),
    toolCalls: z.number().int().min(0).max(1000).default(0),
    toolBudget: z.number().int().min(0).max(1000).default(0),
    model: z.string().max(120).default(''),
    createdAt: z.string().optional(),
  }),
});

const createChatSchema = z.object({ model: z.string().max(200).optional(), diagnosisId: z.string().max(200).optional() }).strict();
const sendSchema = z.object({ text: z.string().min(1).max(8000), model: z.string().max(200).optional() });
const patchChatSchema = z.object({ title: z.string().max(200).optional(), model: z.string().max(200).optional() });

const launchSchema = z
  .object({
    purpose: z.string().min(1).max(200),
    diagnosisId: z.string().max(200).optional(),
    chatId: z.string().max(200).optional(),
    /** Index into the diagnosis fixes. The server looks the fix up and builds the brief. */
    fix: z.number().int().min(0).max(20).optional(),
    projectKey: z.string().max(60).optional(),
    requestedBy: z.string().max(80).optional(),
  })
  .strict();
const decisionSchema = z.object({ by: z.string().max(80).optional() }).strict();
const launchMessageSchema = z.object({ text: z.string().min(1).max(8000) }).strict();

/**
 * Checks for a write that changes state or feeds a brief. A browser page of another origin must not
 * start it: the Origin must be in ALLOWED_ORIGINS, and the body must be JSON, which a cross-site form
 * cannot send without a preflight. The routes also rely on the network boundary of the deployment.
 */
function guardWrite(req: IncomingMessage, config: Config): void {
  const origin = req.headers.origin;
  if (origin && !config.allowedOrigins.includes(origin)) throw new HttpError(403, 'Origin not allowed');
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'The content type must be application/json');
}

/** Who asked. The service proxy does not pass the user on, so this is a label for the record, not proof. */
function operator(req: IncomingMessage, claimed?: string): string {
  const header = req.headers['x-remote-user'] ?? req.headers['x-forwarded-user'];
  const value = (Array.isArray(header) ? header[0] : header) || claimed || 'operator';
  return maskText(value.slice(0, 80));
}

/** The launch as the list shows it: no brief and no timeline. */
function launchSummary({ brief: _brief, timeline, lastReply, ...l }: Launch): Omit<Launch, 'brief' | 'timeline' | 'lastReply'> & { steps: number } {
  return { ...l, steps: timeline.length };
}

async function chatBody<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readBody(req));
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

/** `deps.store` replaces the diagnosis store, for tests. The caller then closes it. */
export async function startServer(config: Config = loadConfig(), version = '0.0.0', deps: { store?: DiagnosisStore } = {}): Promise<{ close(): Promise<void>; port: number }> {
  const store = deps.store ?? (await openDiagnosisStore(config.databaseUrl, config.dataDir, (message, extra) => log('info', message, extra)));
  const launchStore = new LaunchStore(config.dataDir, config.maxLaunches);
  const runtime = new Runtime(config, store, launchStore);
  const runner = new Runner(runtime, store, config);
  const chats = new ChatService({ store: new ChatStore(config.dataDir), diagnoses: store, tools: runtime.toolHost(), catalogue: runner.catalogue, budget: config.diagnosis.toolBudget, maxTurns: config.maxChatTurns });
  const launches = new LaunchService({
    store: launchStore,
    diagnoses: store,
    config: config.launch,
    t3: config.launch.t3Url && config.launch.t3TokenFile ? new T3Client({ url: config.launch.t3Url, readToken: tokenFromFile(config.launch.t3TokenFile) }) : undefined,
    log,
  });
  void launches.resume().catch(error => log('error', 'launch resume failed', { error: String(error) }));
  // Webhook diagnoses in the shared store, so a rollout or a second pod does not reset the hourly cap.
  const gate = new AlertGate(config.diagnosis, since => store.countWebhookSince(since));
  const mcp = await mcpHandler(runtime, store, version);
  const mcpNode = toNodeHandler(mcp);
  let ready = true;

  runner.start();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/mcp') {
        const origin = req.headers.origin;
        if (origin && !config.allowedOrigins.includes(origin)) return send(res, 403, { jsonrpc: '2.0', error: { code: -32600, message: 'Origin not allowed' } });
        return void (await mcpNode(req, res));
      }
      if (path === '/healthz') return send(res, 200, { ok: true });
      if (path === '/readyz') return send(res, ready ? 200 : 503, { ok: ready });
      if (path === '/') {
        return send(res, 200, {
          name: 'headlamp-agent',
          version,
          mcp: '/mcp',
          tools: runtime.registry.tools.size,
          providers: runtime.registry.providers.map(p => p.name),
          diagnosis: { model: config.models.defaultModel || null, models: (await runner.catalogue.list({ waitMs: 2000 })).length, configured: runner.configured, toolBudget: config.diagnosis.toolBudget },
        });
      }
      // Alertmanager v2 API, the shape vmalert's notifier posts.
      if (path === '/api/v2/alerts' && req.method === 'POST') {
        const alerts = parseAlerts(await readBody(req));
        let started = 0;
        for (const { alert, resolved } of alerts) {
          if (resolved) {
            await store.markResolved(alert.fingerprint, alert.endsAt ?? new Date().toISOString());
            continue;
          }
          if ((await store.findByFingerprint(alert.fingerprint, alert.startsAt)) || (await store.get(diagnosisIdFor(alert.fingerprint, alert.startsAt)))) continue;
          const verdict = await gate.wants(alert);
          if (!verdict.ok) continue;
          if (!runner.configured) {
            log('warn', 'alert not diagnosed: no model configured', { alert: alert.name });
            continue;
          }
          // The alert may pick a model. An unknown one falls back to the default.
          let model: string | undefined;
          const wanted = alert.annotations.agent_model || alert.labels.agent_model;
          if (wanted) {
            try {
              const r = await runner.catalogue.resolve(wanted);
              model = `${r.route.id}/${r.model}`;
            } catch (error) {
              log('warn', 'alert asks for an unknown model, using the default', { alert: alert.name, model: wanted, error: error instanceof Error ? error.message : String(error) });
            }
          }
          gate.record();
          await runner.enqueue(alert, 'webhook', undefined, model);
          started++;
        }
        if (started) log('info', 'alerts received', { alerts: alerts.length, started });
        return send(res, 200, { status: 'success', started });
      }
      if (path === '/api/models' && req.method === 'GET') {
        const models = await runner.catalogue.list({ waitMs: 5000 });
        let def = config.models.defaultModel;
        try {
          const r = await runner.catalogue.resolve();
          def = `${r.route.id}/${r.model}`;
        } catch {
          /* keep the configured value */
        }
        return send(res, 200, { default: def || null, models: models.map(({ id, route, model, name }) => ({ id, route, model, name })) });
      }
      if (path === '/api/widgets' && req.method === 'GET') return send(res, 200, listPanels());
      if (path.startsWith('/api/widgets/') && req.method === 'GET') {
        const id = decodeURIComponent(path.slice('/api/widgets/'.length));
        try {
          const model = await buildPanel(id, {
            call: async (tool, args) => {
              const out = await runtime.registry.call(tool, args, p => runtime.context(p));
              if (!out.ok) throw new PanelError(out.summary);
              return out.data;
            },
            serviceGet,
            kubeList: (kind, options) => runtime.kube.listAll(kind, options),
            agentResourceUrl: config.agentResourceUrl,
            agentResourceFallbackUrl: config.agentResourceFallbackUrl,
            registryCatalogueUrl: config.registryCatalogueUrl,
            query: url.searchParams,
            now: new Date(),
          });
          return model ? send(res, 200, model) : send(res, 404, { error: 'unknown panel' });
        } catch (error) {
          if (error instanceof PanelError) return send(res, 502, { error: error.message });
          throw error;
        }
      }
      if (path === '/api/v2/status' && req.method === 'GET') return send(res, 200, { cluster: { status: 'ready' }, versionInfo: { version } });
      if (path === '/api/diagnoses' && req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
        const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
        // `total` is every stored diagnosis, so a client can page with `offset` and count them all.
        return send(res, 200, await store.page({ offset, limit }));
      }
      if (path.startsWith('/api/diagnoses/') && req.method === 'GET') {
        const d = await store.get(decodeURIComponent(path.slice('/api/diagnoses/'.length)));
        return d ? send(res, 200, d) : send(res, 404, { error: 'not found' });
      }
      if (path === '/api/diagnoses' && req.method === 'POST') {
        guardWrite(req, config);
        const body = (await readBody(req)) as Record<string, unknown>;
        if (body && typeof body === 'object' && 'alert' in body && !('diagnosis' in body)) {
          // Start a diagnosis in the cluster.
          if (!runner.configured) throw new HttpError(503, 'No model is configured for in-cluster diagnosis');
          const parsed = alertSchema.safeParse(body.alert);
          if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
          const alert = { ...parsed.data, fingerprint: parsed.data.fingerprint || fingerprint({ alertname: parsed.data.name, ...parsed.data.labels }) };
          let model: string | undefined;
          if (body.model !== undefined && body.model !== null && body.model !== '') {
            if (typeof body.model !== 'string') throw new HttpError(400, 'model must be a string');
            try {
              const r = await runner.catalogue.resolve(body.model);
              model = `${r.route.id}/${r.model}`;
            } catch (error) {
              if (error instanceof UnknownModelError) throw new HttpError(400, error.message);
              throw error;
            }
          }
          const d = await runner.enqueue(alert, 'api', undefined, model);
          return send(res, 202, { id: d.id, status: d.status });
        }
        // Publish a diagnosis an agent made elsewhere (the ACP agent in T3 Code, a CLI run).
        const parsed = publishSchema.safeParse(body);
        if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
        const p = parsed.data.diagnosis;
        const known = new Set(p.evidence.map(e => e.id));
        const d: Diagnosis = mask({
          id: p.id ?? randomUUID(),
          createdAt: p.createdAt ?? new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: p.status,
          source: p.source,
          host: p.host,
          alert: { ...p.alert, fingerprint: p.alert.fingerprint || fingerprint({ alertname: p.alert.name, ...p.alert.labels }) },
          result: p.result ? sanitizeResult(p.result, known) : undefined,
          error: p.error,
          // An outside agent made this. Its full tool data is dropped: a launch brief never trusts it.
          evidence: p.evidence.map(({ data: _data, ...e }) => e),
          published: true,
          toolCalls: p.toolCalls,
          toolBudget: p.toolBudget,
          model: p.model,
          a2ui: [],
        });
        d.a2ui = renderDiagnosis(d);
        await store.put(d);
        return send(res, 201, { id: d.id });
      }
      if (path === '/api/chats' || path.startsWith('/api/chats/')) {
        const parts = path.split('/').slice(3).map(decodeURIComponent);
        const [id, action] = parts;
        if (parts.length > 2 || (action && action !== 'messages' && action !== 'cancel')) return send(res, 404, { error: 'not found' });
        if (req.method === 'POST' || req.method === 'PATCH') guardWrite(req, config);
        try {
          if (!id && req.method === 'GET') {
            const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
            return send(res, 200, { chats: chats.list(limit) });
          }
          if (!id && req.method === 'POST') return send(res, 201, await chats.create(await chatBody(req, createChatSchema)));
          if (id && !action && req.method === 'GET') return send(res, 200, chats.get(id));
          if (id && !action && req.method === 'PATCH') return send(res, 200, await chats.patch(id, await chatBody(req, patchChatSchema)));
          if (id && !action && req.method === 'DELETE') {
            chats.delete(id);
            res.writeHead(204, { 'cache-control': 'no-store' });
            return void res.end();
          }
          if (id && action === 'messages' && req.method === 'POST') {
            const body = await chatBody(req, sendSchema);
            return send(res, 202, await chats.send(id, body.text, body.model));
          }
          if (id && action === 'cancel' && req.method === 'POST') {
            chats.cancel(id);
            return send(res, 200, { ok: true });
          }
        } catch (error) {
          if (error instanceof ChatError) throw new HttpError(error.status, error.message);
          throw error;
        }
      }
      if (path === '/api/launches' || path.startsWith('/api/launches/')) {
        const parts = path.split('/').slice(3).map(decodeURIComponent);
        const [id, action] = parts;
        // An id has letters, digits, dash and underscore only. Any other id cannot exist.
        if (id && id !== 'config' && id !== 'preview' && !/^[A-Za-z0-9_-]+$/.test(id)) return send(res, 404, { error: 'not found' });
        if (parts.length > 2 || (action && !['approve', 'reject', 'messages'].includes(action)) || (id === 'config' && (action || req.method !== 'GET')) || (id === 'preview' && (action || req.method !== 'POST'))) return send(res, 404, { error: 'not found' });
        try {
          if (id === 'config') return send(res, 200, launches.publicConfig());
          launches.requireEnabled();
          if (req.method === 'POST') guardWrite(req, config);
          if (!id && req.method === 'GET') {
            const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
            return send(res, 200, { launches: launchStore.list().slice(0, limit).map(launchSummary) });
          }
          if (!id && req.method === 'POST') {
            const body = await chatBody(req, launchSchema);
            const { requestedBy, ...request } = body;
            return send(res, 201, await launches.create(request, operator(req, requestedBy)));
          }
          if (id === 'preview') {
            const { requestedBy: _by, ...request } = await chatBody(req, launchSchema);
            return send(res, 200, { brief: await launches.brief(request) });
          }
          if (id && !action && req.method === 'GET') {
            const l = launchStore.get(id);
            return l ? send(res, 200, l) : send(res, 404, { error: 'not found' });
          }
          if (id && action === 'approve' && req.method === 'POST') return send(res, 200, await launches.approve(id, operator(req, (await chatBody(req, decisionSchema)).by)));
          if (id && action === 'reject' && req.method === 'POST') return send(res, 200, await launches.reject(id, operator(req, (await chatBody(req, decisionSchema)).by)));
          if (id && action === 'messages' && req.method === 'POST') return send(res, 202, await launches.message(id, (await chatBody(req, launchMessageSchema)).text));
        } catch (error) {
          if (error instanceof LaunchError) throw new HttpError(error.status, error.message);
          throw error;
        }
      }
      if (path === '/mcp' || path.startsWith('/api/')) return send(res, 405, { error: 'method not allowed' });
      return send(res, 404, { error: 'not found' });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log('error', 'request failed', { path, error: String(error) });
      if (!res.headersSent) send(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>(resolve => server.listen(config.port, config.host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  log('info', 'listening', { port, tools: runtime.registry.tools.size, modelConfigured: runner.configured });

  return {
    port,
    async close() {
      ready = false;
      // Stop accepting connections, then let the running diagnosis finish. No timer: the platform kill is the only limit.
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeIdleConnections();
      chats.shutdown();
      await launches.shutdown();
      await runner.drain();
      await mcp.close();
      if (!deps.store) await store.close();
      server.closeIdleConnections();
      await closed;
    },
  };
}
