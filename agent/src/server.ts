import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { loadConfig, modelConfigured, type Config } from './config.js';
import { AlertGate, diagnosisIdFor, fingerprint, parseAlerts } from './alerts.js';
import { ChatError, ChatService, MODEL_PICK_HEADER } from './agent/chat.js';
import { ChatStore } from './chats.js';
import { diagnose } from './agent/engine.js';
import { ModelCatalogue, UnknownModelError } from './agent/catalogue.js';
import { alertSchema, renderDiagnosis, resultSchema, sanitizeResult, type Alert, type Diagnosis } from './agent/report.js';
import { mask, maskText } from './mask.js';
import { mcpBuilder } from './mcp.js';
import { McpEndpoint } from './mcp/endpoint.js';
import { TokenStore } from './mcp/auth.js';
import { McpMetrics } from './mcp/metrics.js';
import { PvWatch } from './mcp/pv-watch.js';
import { IncidentService } from './incidents/service.js';
import { alwaysOn, type AutomaticInvestigationsView } from './incidents/settings.js';
import { publishSchema, storePublished } from './publish.js';
import { Runtime, serviceGet } from './runtime.js';
import { PanelError, buildPanel, listPanels } from './widgets.js';
import { DiagnosisStore, openDiagnosisStore, PgDiagnosisStore } from './store.js';
import { LaunchError, LaunchService } from './launch/service.js';
import { LaunchStore, type Launch } from './launch/store.js';
import { T3Client, tokenFromFile } from './t3/client.js';
import { PushError, PushService } from './push/service.js';
import { Metrics } from './metrics.js';
import { storageHttp } from './storage/http.js';
import { Reconciler, readVmalert } from './reconcile.js';
import { ACP_PATH, AcpEndpoint } from './acp-endpoint.js';
import { tokensFromFile } from './auth/scopes.js';

const MAX_BODY = 1024 * 1024;

function log(level: 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...extra })}\n`);
}

async function readBody(req: IncomingMessage, maxBytes = MAX_BODY): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'Body too large');
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

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

const RENEW_MS = 20_000;
const SCAN_MS = 30_000;
const MAX_ATTEMPTS = 3;
/** A record keeps the last 10 failed attempts that re-runs replaced. */
const MAX_PREVIOUS = 10;

/** Why a re-run did not start. */
export class RerunError extends Error {
  constructor(
    readonly status: 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

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
  private renewal: Promise<void> | undefined;
  private scanTask: Promise<void> | undefined;

  constructor(
    private readonly runtime: Runtime,
    private readonly store: DiagnosisStore,
    private readonly config: Config,
    readonly catalogue: ModelCatalogue = new ModelCatalogue(config.models),
    /** Called once when a diagnosis that this process ran has reached `done`. Must not throw. */
    private readonly onDone: (d: Diagnosis) => void = () => {},
  ) {}

  get configured(): boolean {
    return modelConfigured(this.config.models);
  }

  /** Look for abandoned diagnoses now and every 30 s. */
  start(): void {
    const tick = () => {
      this.scanTask ??= this.scan().finally(() => { this.scanTask = undefined; });
    };
    tick();
    this.scanTimer = setInterval(tick, SCAN_MS);
    this.scanTimer.unref();
  }

  /**
   * Take over queued or running diagnoses that nobody holds: the lease ran out or is missing.
   * They run again with the same id and creation time and do not count against the hourly cap.
   * Without a model, when the alert has resolved (unless a person asked for the re-run), or after 3 attempts,
   * they are marked failed.
   */
  async scan(): Promise<void> {
    if (this.draining) return;
    try {
      const stale = (await this.store.stale()).filter(d => !this.held.has(d.id));
      for (const listed of stale) {
        if (this.draining) break;
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
            // A person asked for a re-run of a resolved alert: diagnose it as it was, do not fail it for being resolved.
            if ((d.resolvedAt && !d.rerunAt) || !this.configured) return fail('Interrupted by a restart');
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
    await this.scanTask;
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
    await this.renewal;
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
    // A picked model stays. A record with no flag comes from before the default order and follows the order (see `ModelCatalogue.isPinned`).
    const pinned = this.catalogue.isPinned(interrupted.modelPinned, interrupted.model);
    await this.enqueue(interrupted.alert, interrupted.source, interrupted.id, pinned ? interrupted.model : undefined);
  }

  /** True while the pod stops: it starts no new work. */
  get stopping(): boolean {
    return this.draining;
  }

  /**
   * Run a failed diagnosis again under its own id. `model` is a model id (`<route>/<model>`) the caller has checked.
   * Without `model` the run uses the default order.
   * The failed attempt moves to `previousAttempts`, the error clears and the attempts count starts again.
   * Throws `RerunError` when no record has this id or when it is not failed.
   */
  async rerun(id: string, model?: string): Promise<Diagnosis> {
    const current = await this.store.get(id);
    if (!current) throw new RerunError(404, 'Diagnosis not found');
    let moved: Diagnosis | undefined;
    // Decided on the record as stored now: two requests for one id start it once.
    const ok = await this.store.update(id, d => {
      if (!d || d.status !== 'failed') return undefined;
      const previous = [...(d.previousAttempts ?? []), { at: d.finishedAt ?? d.createdAt, model: d.model, error: d.error ?? '' }].slice(-MAX_PREVIOUS);
      moved = { ...d, status: 'queued', error: undefined, finishedAt: undefined, model: model ?? this.catalogue.currentDefault(), modelPinned: model !== undefined, attempts: 1, previousAttempts: previous, rerunAt: new Date().toISOString(), owner: this.store.owner, leaseUntil: this.store.lease() };
      return moved;
    });
    if (!ok || !moved) {
      const now = await this.store.get(id);
      throw new RerunError(now ? 409 : 404, now ? `Only a failed diagnosis can run again. This one is ${now.status}.` : 'Diagnosis not found');
    }
    return this.enqueue(moved.alert, moved.source, id, model);
  }

  /** `model` is a model id (`<route>/<model>`) the caller has checked, picked by a person or an alert: it is used as it is, with no fallback. Without it the run uses the default order. */
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
      model: model ?? this.catalogue.currentDefault(),
      modelPinned: model !== undefined,
      a2ui: [],
      owner: this.store.owner,
      leaseUntil: this.draining ? DiagnosisStore.released() : this.store.lease(),
      attempts: existing ? (existing.attempts ?? 1) : 1,
      rerunAt: existing?.rerunAt,
      previousAttempts: existing?.previousAttempts,
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
      this.renewTimer = setInterval(() => {
        this.renewal ??= this.renew().finally(() => { this.renewal = undefined; });
      }, RENEW_MS);
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
        const client = await this.catalogue.open(queued.modelPinned ? queued.model : undefined);
        const result = await diagnose({
          alert,
          tools: this.runtime.toolHost(),
          model: client,
          // Diagnoses run one after another, so a webhook diagnosis has a shorter limit than a chat turn.
          timeoutMs: this.config.diagnosis.diagnosisTimeoutMs,
          maxModelCalls: this.config.diagnosis.maxModelCalls,
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
                const ok = await this.store.put({ ...diagnosis, createdAt: queued.createdAt, owner: this.store.owner, leaseUntil: this.store.lease(), modelPinned: queued.modelPinned, attempts: queued.attempts, rerunAt: queued.rerunAt, previousAttempts: queued.previousAttempts });
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
        if (!(await this.store.put({ ...result, createdAt: queued.createdAt, owner: this.store.owner, modelPinned: queued.modelPinned, attempts: queued.attempts, rerunAt: queued.rerunAt, previousAttempts: queued.previousAttempts }))) return;
        log('info', 'diagnosis finished', { id: result.id, alert: alert.name, status: result.status, toolCalls: result.toolCalls, error: result.error });
        if (result.status === 'done') this.onDone({ ...result, createdAt: queued.createdAt });
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

const rerunSchema = z.object({ model: z.string().max(200).nullish() }).strict();
const createChatSchema = z
  .object({ model: z.string().max(200).optional(), identity: z.string().max(60).optional(), diagnosisId: z.string().max(200).optional(), diagnosisIds: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
    groupName: z.string().min(1).max(200).optional(),
    summaryIds: z.array(z.string().min(1).max(200)).min(1).max(500).optional(),
    groupOmitted: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();
const sendSchema = z.object({ text: z.string().min(1).max(8000), model: z.string().max(200).optional(), identity: z.string().max(60).optional(), push: z.string().regex(/^[0-9a-f]{32}$/).optional() });
const patchChatSchema = z.object({ title: z.string().max(200).optional(), model: z.string().max(200).optional(), identity: z.string().max(60).optional() });

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
export async function startServer(config: Config = loadConfig(), version = '0.0.0', deps: { store?: DiagnosisStore; automaticInvestigations?: AutomaticInvestigationsView; watchVolumes?: boolean; storageEnv?: NodeJS.ProcessEnv; pushFetch?: typeof fetch; now?: () => number; signal?: AbortSignal } = {}): Promise<{ close(): Promise<void>; port: number; sessionPort?: number }> {
  const store = deps.store ?? (await openDiagnosisStore(config.databaseUrl, config.dataDir, (message, extra) => log('info', message, extra)));
  const launchStore = new LaunchStore(config.dataDir, config.maxLaunches);
  const runtime = new Runtime(config, store, launchStore);
  const push = new PushService({
    store: store.pushStore(),
    keys: config.push.publicKey && config.push.privateKey ? { publicKey: config.push.publicKey, privateKey: config.push.privateKey, subject: config.push.subject } : undefined,
    extraHosts: config.push.extraHosts,
    maxPerWindow: config.push.maxPer10Min,
    fetch: deps.pushFetch,
    now: deps.now,
    log: (level, message, extra) => log(level, message, extra),
  });
  // A push is best effort and never holds up the diagnosis or the answer.
  const runner = new Runner(runtime, store, config, undefined, d => void push.notifyDiagnosis(d));
  const chats = new ChatService({
    store: new ChatStore(config.dataDir),
    diagnoses: store,
    tools: runtime.toolHost(),
    catalogue: runner.catalogue,
    timeoutMs: config.diagnosis.runTimeoutMs,
    maxModelCalls: config.diagnosis.maxModelCalls,
    maxTurns: config.maxChatTurns,
    onAnswer: e => void push.notifyChatAnswer(e.subscription, e.chatId, e.text),
  });
  const launches = new LaunchService({
    store: launchStore,
    diagnoses: store,
    config: config.launch,
    t3: config.launch.t3Url && config.launch.t3TokenFile ? new T3Client({ url: config.launch.t3Url, readToken: tokenFromFile(config.launch.t3TokenFile) }) : undefined,
    log,
  });
  // Webhook diagnoses in the shared store, so a rollout or a second pod does not reset the hourly cap.
  const gate = new AlertGate(config.diagnosis, since => store.countStartedSince(since));
  const metrics = new Metrics();
  const mcpMetrics = new McpMetrics(metrics);
  store.events.onRecorded = kind => mcpMetrics.eventRecorded(kind);
  const incidents = new IncidentService({
    store,
    runner: {
      get configured() {
        return runner.configured;
      },
      rerun: (id, model) => runner.rerun(id, model),
      enqueue: (alert, source, id, model) => runner.enqueue(alert, source, id, model),
      async resolveModel(model) {
        try {
          const r = await runner.catalogue.resolve(model);
          return `${r.route.id}/${r.model}`;
        } catch (error) {
          if (error instanceof UnknownModelError) throw Object.assign(error, { unknown: true });
          throw error;
        }
      },
    },
    onEscalate: (d, reason) => void push.notifyEscalation(d, reason),
    maxConcurrentReruns: config.diagnosis.maxConcurrentReruns,
    now: deps.now,
  });
  const contract = { runtime, incidents, events: store.events, settings: deps.automaticInvestigations ?? alwaysOn, metrics: mcpMetrics };
  const buildMcp = await mcpBuilder(runtime, store, version, contract);
  const mcp = new McpEndpoint({
    contract,
    build: async who => buildMcp(who),
    tokens: new TokenStore(config.mcp.tokensFile, () => mcpMetrics.authFailure('bad_scopes')),
    authMode: config.mcp.auth,
    allowedOrigins: config.allowedOrigins,
    metrics: mcpMetrics,
    events: store.events,
    log: (level, message, extra) => log(level, message, extra),
    readBody,
    send,
  });
  await mcp.start();
  // The event source of `storage.updated`: a watch on PersistentVolumes. Only in a cluster (tests and local runs use KUBE_API and start none).
  const volumeWatch = deps.watchVolumes !== false && process.env.KUBERNETES_SERVICE_HOST ? new PvWatch(runtime.kube, store.events, (level, message, extra) => log(level, message, extra)) : undefined;
  // The log keeps events 7 days (contract section 8.2). Removal runs once an hour, not to find changes.
  const prune = setInterval(() => void store.events.prune().catch(() => undefined), 3600_000);
  prune.unref();
  void store.events.prune().catch(() => undefined);
  let ready = false;
  let draining = false;
  let rerunTurn: Promise<void> = Promise.resolve();
  runner.catalogue.attachMetrics(metrics);
  // The incident agent over ACP on a WebSocket. It shares the registry, the store and the models with the rest of the service.
  const acp = new AcpEndpoint({
    config,
    catalogue: runner.catalogue,
    tools: runtime.toolHost(),
    store,
    metrics,
    tokens: tokensFromFile(config.acp.tokensFile, message => log('warn', message, { endpoint: 'acp' })),
    onPublished: d => void push.notifyDiagnosis(d),
    log,
  });
  const storage = await storageHttp({
    config, metrics, push, readBody, send, env: deps.storageEnv, now: deps.now,
    store: store instanceof PgDiagnosisStore ? store.storageIncidentStore() : undefined,
  });
  // Keeps open diagnoses in step with vmalert. A resolved notification can be lost (a vmalert restart forgets its alerts).
  const reconciler = new Reconciler({
    store,
    snapshot: config.vmalertUrl ? () => readVmalert(config.vmalertUrl) : undefined,
    metrics,
    intervalMs: config.reconcileSeconds * 1000,
    log,
  });

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/healthz') return send(res, 200, { ok: true });
      if (path === '/readyz') return send(res, ready ? 200 : 503, { ok: ready });
      if (draining) {
        res.setHeader('connection', 'close');
        return send(res, 503, { error: 'Agent is draining' });
      }
      if (path === ACP_PATH) {
        res.setHeader('upgrade', 'websocket');
        return send(res, 426, { error: 'Open /acp with a WebSocket upgrade and a bearer token' });
      }
      if (path === '/mcp') return void (await mcp.handle(req, res));
      if (await storage.route(req, res, path)) return;
      if (path === '/metrics' && req.method === 'GET') {
        await storage.metrics();
        runner.catalogue.refreshMetrics();
        mcpMetrics.gauges({ ...mcp.stats(), logEvents: await store.events.count().catch(() => undefined) });
        metrics.clear('headlamp_agent_diagnoses_open');
        const counts = new Map<string, number>([['critical', 0], ['warning', 0], ['info', 0]]);
        for (const d of await store.openSummaries()) counts.set(d.alert.severity || 'none', (counts.get(d.alert.severity || 'none') ?? 0) + 1);
        for (const [severity, n] of counts) metrics.set('headlamp_agent_diagnoses_open', { severity }, n);
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        return void res.end(metrics.render());
      }
      if (path === '/') {
        return send(res, 200, {
          name: 'headlamp-agent',
          version,
          mcp: '/mcp',
          tools: runtime.registry.tools.size,
          providers: runtime.registry.providers.map(p => p.name),
          diagnosis: { model: config.models.defaultModel || null, defaultOrder: runner.catalogue.defaultOrder, models: (await runner.catalogue.list({ waitMs: 2000 })).length, configured: runner.configured, runTimeoutMs: config.diagnosis.runTimeoutMs, diagnosisTimeoutMs: config.diagnosis.diagnosisTimeoutMs, maxModelCalls: config.diagnosis.maxModelCalls },
        });
      }
      // Alertmanager v2 API, the shape vmalert's notifier posts.
      if (path === '/api/v2/alerts' && req.method === 'POST') {
        const alerts = parseAlerts(await readBody(req));
        let started = 0;
        for (const { alert, resolved } of alerts) {
          if (resolved) {
            metrics.inc('headlamp_agent_resolve_notifications_total');
            await store.markResolved(alert.fingerprint, alert.endsAt ?? new Date().toISOString());
            continue;
          }
          if ((await store.findByFingerprint(alert.fingerprint, alert.startsAt)) || (await store.get(diagnosisIdFor(alert.fingerprint, alert.startsAt)))) continue;
          // The same alert fired again (vmalert restarted, or the alert flapped): it joins the open diagnosis. A failed one does not take it in, so a new run can retry.
          const open = await store.findOpenByFingerprint(alert.fingerprint);
          if (open && open.status !== 'failed') {
            if (await store.attachFire(open.id, alert.startsAt)) metrics.inc('headlamp_agent_alert_repeats_merged_total');
            continue;
          }
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
          // A race (two pods) or a failed older run can leave other open ones of this fingerprint. The newest stays.
          const folded = (await store.foldDuplicates(alert.fingerprint).catch(() => undefined))?.folded ?? 0;
          if (folded) metrics.inc('headlamp_agent_reconcile_folded_total', {}, folded);
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
        // With ordered default models `default` is the one that answers first now, and `defaultOrder` lists them all.
        const defaultOrder = runner.catalogue.defaultOrder;
        if (defaultOrder.length > 1) def = runner.catalogue.currentDefault();
        return send(res, 200, { default: def || null, defaultOrder, models: models.map(({ id, route, model, name, provider, identity, contextWindow }) => ({ id, route, model, name, provider, identity, ...(contextWindow ? { contextWindow } : {}) })) });
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
      const rerunMatch = /^\/api\/diagnoses\/([^/]+)\/rerun$/.exec(path);
      if (rerunMatch && req.method === 'POST') {
        guardWrite(req, config);
        const id = decodeURIComponent(rerunMatch[1]!);
        const parsed = rerunSchema.safeParse(await readBody(req));
        if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
        const known = await store.get(id);
        if (!known) throw new HttpError(404, 'Diagnosis not found');
        if (known.status !== 'failed') throw new HttpError(409, `Only a failed diagnosis can run again. This one is ${known.status}.`);
        if (!runner.configured) throw new HttpError(503, 'No model is configured for in-cluster diagnosis');
        if (runner.stopping) throw new HttpError(503, 'The agent is restarting. Try again in a moment.');
        // The current default model, unless the body names a valid one. The failed model is not reused.
        let model: string | undefined;
        if (parsed.data.model) {
          try {
            const r = await runner.catalogue.resolve(parsed.data.model);
            model = `${r.route.id}/${r.model}`;
          } catch (error) {
            if (error instanceof UnknownModelError) throw new HttpError(400, error.message);
            throw error;
          }
        }
        // A re-run by hand skips the hourly limit of webhook diagnoses. A small cap on open re-runs guards against abuse.
        // The check and the start run one after another in this pod, so two requests cannot both take the last place.
        const turn = rerunTurn.then(async () => {
          const open = await store.countOpenReruns();
          if (open >= config.diagnosis.maxConcurrentReruns) {
            throw new HttpError(429, `${open} re-run${open === 1 ? ' is' : 's are'} already queued or running (limit ${config.diagnosis.maxConcurrentReruns}). Try again when one finishes.`);
          }
          return runner.rerun(id, model);
        });
        rerunTurn = turn.then(() => undefined, () => undefined);
        try {
          const d = await turn;
          return send(res, 202, { id: d.id, status: d.status, model: d.model });
        } catch (error) {
          if (error instanceof RerunError) throw new HttpError(error.status, error.message);
          throw error;
        }
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
        const d = await storePublished(store, parsed.data.diagnosis);
        if (d.status === 'done') void push.notifyDiagnosis(d);
        return send(res, 201, { id: d.id });
      }
      if (path === '/api/push' || path.startsWith('/api/push/')) {
        const parts = path.split('/').slice(3).map(decodeURIComponent);
        const [kind, id, action] = parts;
        try {
          if (parts.length === 1 && kind === 'config' && req.method === 'GET') return send(res, 200, push.publicConfig());
          // Only GET and POST: the service proxy maps them to the `get` and `create` rights the chat already needs.
          if (kind === 'subscriptions' && id && (parts.length === 2 || (parts.length === 3 && ['settings', 'presence', 'unsubscribe'].includes(action ?? '')))) {
            if (req.method === 'POST') guardWrite(req, config);
            if (parts.length === 2 && req.method === 'GET') return send(res, 200, await push.get(id));
            if (parts.length === 2 && req.method === 'POST') return send(res, 200, await push.subscribe(id, await readBody(req)));
            if (parts.length === 3 && req.method === 'POST') {
              const body = (await readBody(req)) as Record<string, unknown>;
              if (action === 'settings') return send(res, 200, await push.update(id, body));
              if (action === 'unsubscribe') {
                await push.unsubscribe(id);
                return send(res, 200, { ok: true });
              }
              await push.presence(id, body && typeof body === 'object' ? (body.chatId ?? null) : null);
              return send(res, 200, { ok: true });
            }
          }
        } catch (error) {
          if (error instanceof PushError) throw new HttpError(error.status, error.message);
          throw error;
        }
        return send(res, 404, { error: 'not found' });
      }
      if (path === '/api/chats' || path.startsWith('/api/chats/')) {
        const parts = path.split('/').slice(3).map(decodeURIComponent);
        const [id, action] = parts;
        if (parts.length > 2 || (action && action !== 'messages' && action !== 'cancel')) return send(res, 404, { error: 'not found' });
        if (req.method === 'POST' || req.method === 'PATCH') guardWrite(req, config);
        try {
          if (!id && req.method === 'GET') {
            const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
            return send(res, 200, { chats: chats.list(limit, url.searchParams.get('diagnosisId') || undefined) });
          }
          if (!id && req.method === 'POST') return send(res, 201, await chats.create(await chatBody(req, createChatSchema), { pickHeader: req.headers[MODEL_PICK_HEADER] === '1' }));
          if (id && !action && req.method === 'GET') return send(res, 200, chats.get(id));
          if (id && !action && req.method === 'PATCH') return send(res, 200, await chats.patch(id, await chatBody(req, patchChatSchema)));
          if (id && !action && req.method === 'DELETE') {
            chats.delete(id);
            res.writeHead(204, { 'cache-control': 'no-store' });
            return void res.end();
          }
          if (id && action === 'messages' && req.method === 'POST') {
            const body = await chatBody(req, sendSchema);
            return send(res, 202, await chats.send(id, body.text, body.model, body.push, body.identity));
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
      const storageRoute = path === '/api/storage' || path.startsWith('/api/storage/');
      if (status === 500) log('error', 'request failed', storageRoute ? { path: '/api/storage' } : { path, error: String(error) });
      const message = storageRoute && status === 500 ? 'Storage request failed' : error instanceof Error ? error.message : String(error);
      if (!res.headersSent) send(res, status, { error: message });
    }
  };

  // A socket can close while its request still uses the store.
  const requests = new Set<Promise<void>>();
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const request = handleRequest(req, res);
    requests.add(request);
    void request.then(
      () => requests.delete(request),
      error => {
        requests.delete(request);
        res.destroy(error instanceof Error ? error : undefined);
      },
    );
  };
  const server = createServer(onRequest);
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    if (path === ACP_PATH) return acp.upgrade(req, socket, head);
    socket.on('error', () => undefined);
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  // Session trust (see STORAGE_SESSION_PORT) lives only on this second listener, so the public route to the main port never reaches it.
  const sessionServer = storage.sessionPort === undefined ? undefined : createServer(onRequest);

  async function drain(): Promise<void> {
    // An ACP prompt in flight finishes first. Upgraded sockets keep the listener open until they close.
    const acpClosed = acp.close();
    // Open push streams never end by themselves: close the MCP sessions first, so the listeners can close.
    await volumeWatch?.stop();
    await mcp.close();
    const closing = [server, sessionServer].flatMap(listener => {
      if (!listener?.listening) return [];
      const closed = new Promise<void>((resolve, reject) =>
        listener.close(error => error ? reject(error) : resolve()));
      listener.closeIdleConnections();
      return [closed];
    });
    await Promise.all([...closing, acpClosed]);
    await Promise.allSettled(requests);
    await launches.shutdown();
    await reconciler.stop();
    await chats.drain();
    await runner.drain();
    await storage.drain();
    clearInterval(prune);
    if (!deps.store) await store.close();
  }

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    ready = false;
    draining = true;
    return closing ??= drain();
  }

  let port: number;
  try {
    deps.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (sessionServer) {
      await new Promise<void>((resolve, reject) => {
        sessionServer.once('error', reject);
        sessionServer.listen(storage.sessionPort, config.host, () => {
          sessionServer.off('error', reject);
          resolve();
        });
      });
      const sessionAddress = sessionServer.address();
      if (!sessionAddress || typeof sessionAddress === 'string') throw new Error('Session listener has no TCP address');
      storage.sessionBound(sessionAddress.port);
    }
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP listener has no TCP address');
    port = address.port;
    const bound = address.address;
    const host = bound === '0.0.0.0' ? '127.0.0.1' : bound === '::' ? '[::1]' :
      address.family === 'IPv6' ? `[${bound}]` : bound;
    const response = await fetch(`http://${host}:${port}/api/diagnoses?limit=1`, {
      signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(deps.signal ? [deps.signal] : [])]),
    });
    if (!response.ok) throw new Error(`HTTP warm render failed (${response.status})`);
    const page = await response.json();
    if (!Array.isArray(page.diagnoses)) throw new Error('HTTP warm render returned an invalid page');
    deps.signal?.throwIfAborted();
    ready = true;
  } catch (error) {
    await close();
    throw error;
  }

  runner.start();
  void launches.resume().catch(error => log('error', 'launch resume failed', { error: String(error) }));
  reconciler.start();
  volumeWatch?.start(); // after the warm render, so readiness does not wait for the Kubernetes API
  log('info', 'listening', { port, tools: runtime.registry.tools.size, modelConfigured: runner.configured });
  return { port, sessionPort: sessionServer ? storage.sessionPort : undefined, close };
}
