import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { loadConfig, modelConfigured, type Config } from './config.js';
import { AlertGate, diagnosisIdFor, fingerprint, parseAlerts } from './alerts.js';
import { diagnose } from './agent/engine.js';
import { ModelClient } from './agent/model.js';
import { alertSchema, renderDiagnosis, resultSchema, sanitizeResult, type Alert, type Diagnosis } from './agent/report.js';
import { mask, maskText } from './mask.js';
import { mcpHandler } from './mcp.js';
import { Runtime } from './runtime.js';
import { DiagnosisStore } from './store.js';

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
  ) {}

  get configured(): boolean {
    return modelConfigured(this.config.model);
  }

  /** Look for abandoned diagnoses now and every 30 s. */
  start(): void {
    this.scan();
    this.scanTimer = setInterval(() => this.scan(), SCAN_MS);
    this.scanTimer.unref();
  }

  /**
   * Take over queued or running diagnoses that nobody holds: the lease ran out or is missing.
   * They run again with the same id and creation time and do not count against the hourly cap.
   * Without a model, when the alert has resolved, or after 3 attempts, they are marked failed.
   */
  scan(): void {
    if (this.draining) return;
    try {
      const stale = this.store.list().filter(d => (d.status === 'queued' || d.status === 'running') && this.store.expired(d) && !this.held.has(d.id));
      for (const listed of stale.reverse()) {
        try {
          let taken: Diagnosis | undefined;
          // Decided on the record as stored now: the other pod may have renewed the lease meanwhile.
          this.store.update(listed.id, d => {
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
            this.resume(taken);
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
        this.store.update(id, d => (d && d.owner === this.store.owner && d.status === 'queued' ? { ...d, leaseUntil: DiagnosisStore.released() } : undefined));
      } catch (error) {
        log('error', 'lease release failed', { id, error: String(error) });
      }
      this.held.delete(id);
    }
    while (this.pending > 0) await this.chain;
    this.stopRenewing();
  }

  private renew(): void {
    for (const id of this.held) {
      try {
        this.store.update(id, d => (d && d.owner === this.store.owner && (d.status === 'queued' || d.status === 'running') ? { ...d, leaseUntil: this.store.lease() } : undefined));
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
  resume(interrupted: Diagnosis): void {
    this.enqueue(interrupted.alert, interrupted.source, interrupted.id);
  }

  enqueue(alert: Alert, source: Diagnosis['source'], existingId?: string): Diagnosis {
    const existing = existingId ? this.store.get(existingId) : undefined;
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
      model: this.config.model.model,
      a2ui: [],
      owner: this.store.owner,
      leaseUntil: this.draining ? DiagnosisStore.released() : this.store.lease(),
      attempts: existing ? (existing.attempts ?? 1) : 1,
    };
    queued.a2ui = renderDiagnosis(queued);
    if (existing) {
      if (!this.store.put(queued)) return queued;
    } else if (!this.store.putNew(queued)) {
      return this.store.getFresh(queued.id) ?? queued;
    }
    if (this.draining) return queued;
    if (!existing && this.pending >= 20) {
      this.store.put({ ...queued, status: 'failed', error: 'Too many diagnoses queued', leaseUntil: undefined, a2ui: renderDiagnosis({ ...queued, status: 'failed', error: 'Too many diagnoses queued' }) });
      return queued;
    }
    this.pending++;
    this.held.add(queued.id);
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => this.renew(), RENEW_MS);
      this.renewTimer.unref();
    }
    this.chain = this.chain.then(async () => {
      let lost = false;
      try {
        if (this.draining) return;
        const fresh = this.store.getFresh(queued.id);
        if (!fresh || fresh.owner !== this.store.owner || this.store.expired(fresh)) return;
        this.running = queued.id;
        const abort = new AbortController();
        const model = new ModelClient(this.config.model);
        const result = await diagnose({
          alert,
          tools: this.runtime.toolHost(),
          model,
          budget: this.config.diagnosis.toolBudget,
          source,
          host: 'cluster',
          id: queued.id,
          signal: abort.signal,
          onEvent: event => {
            if (event.type !== 'progress' || lost) return;
            try {
              const ok = this.store.put({ ...event.diagnosis, createdAt: queued.createdAt, owner: this.store.owner, leaseUntil: this.store.lease(), attempts: queued.attempts });
              if (!ok) {
                // Another process owns the record now. Stop working on it.
                lost = true;
                abort.abort();
                log('warn', 'diagnosis ownership lost', { id: queued.id });
              }
            } catch (error) {
              log('error', 'diagnosis write failed', { id: queued.id, error: String(error) });
            }
          },
        });
        if (lost) return;
        if (!this.store.put({ ...result, createdAt: queued.createdAt, owner: this.store.owner, attempts: queued.attempts })) return;
        log('info', 'diagnosis finished', { id: result.id, alert: alert.name, status: result.status, toolCalls: result.toolCalls, error: result.error });
      } catch (error) {
        log('error', 'diagnosis crashed', { id: queued.id, error: String(error) });
        // Best effort: a crash must not leave a record that the next scan runs again and again.
        if (!lost) {
          try {
            const message = maskText(error instanceof Error ? error.message : String(error));
            this.store.update(queued.id, d => {
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
    evidence: z.array(z.object({ id: z.string().max(16), tool: z.string().max(80), reason: z.string().max(400), summary: z.string().max(2000), ok: z.boolean() })).max(60).default([]),
    toolCalls: z.number().int().min(0).max(1000).default(0),
    toolBudget: z.number().int().min(0).max(1000).default(0),
    model: z.string().max(120).default(''),
    createdAt: z.string().optional(),
  }),
});

export async function startServer(config: Config = loadConfig(), version = '0.0.0'): Promise<{ close(): Promise<void>; port: number }> {
  const store = new DiagnosisStore(config.dataDir, config.maxDiagnoses);
  const runtime = new Runtime(config, store);
  const runner = new Runner(runtime, store, config);
  const gate = new AlertGate(config.diagnosis);
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
          diagnosis: { model: config.model.model || null, configured: runner.configured, toolBudget: config.diagnosis.toolBudget },
        });
      }
      // Alertmanager v2 API, the shape vmalert's notifier posts.
      if (path === '/api/v2/alerts' && req.method === 'POST') {
        const alerts = parseAlerts(await readBody(req));
        let started = 0;
        for (const { alert, resolved } of alerts) {
          if (resolved) {
            store.markResolved(alert.fingerprint, alert.endsAt ?? new Date().toISOString());
            continue;
          }
          if (store.findByFingerprint(alert.fingerprint, alert.startsAt) || store.getFresh(diagnosisIdFor(alert.fingerprint, alert.startsAt))) continue;
          const verdict = gate.wants(alert);
          if (!verdict.ok) continue;
          if (!runner.configured) {
            log('warn', 'alert not diagnosed: no model configured', { alert: alert.name });
            continue;
          }
          gate.record();
          runner.enqueue(alert, 'webhook');
          started++;
        }
        if (started) log('info', 'alerts received', { alerts: alerts.length, started });
        return send(res, 200, { status: 'success', started });
      }
      if (path === '/api/v2/status' && req.method === 'GET') return send(res, 200, { cluster: { status: 'ready' }, versionInfo: { version } });
      if (path === '/api/diagnoses' && req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
        return send(res, 200, {
          diagnoses: store
            .list()
            .slice(0, limit)
            .map(({ a2ui: _a2ui, evidence, ...d }) => ({ ...d, evidenceCount: evidence.length })),
        });
      }
      if (path.startsWith('/api/diagnoses/') && req.method === 'GET') {
        const d = store.get(decodeURIComponent(path.slice('/api/diagnoses/'.length)));
        return d ? send(res, 200, d) : send(res, 404, { error: 'not found' });
      }
      if (path === '/api/diagnoses' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>;
        if (body && typeof body === 'object' && 'alert' in body && !('diagnosis' in body)) {
          // Start a diagnosis in the cluster.
          if (!runner.configured) throw new HttpError(503, 'No model is configured for in-cluster diagnosis');
          const parsed = alertSchema.safeParse(body.alert);
          if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
          const alert = { ...parsed.data, fingerprint: parsed.data.fingerprint || fingerprint({ alertname: parsed.data.name, ...parsed.data.labels }) };
          const d = runner.enqueue(alert, 'api');
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
          evidence: p.evidence,
          toolCalls: p.toolCalls,
          toolBudget: p.toolBudget,
          model: p.model,
          a2ui: [],
        });
        d.a2ui = renderDiagnosis(d);
        store.put(d);
        return send(res, 201, { id: d.id });
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
      await runner.drain();
      await mcp.close();
      server.closeIdleConnections();
      await closed;
    },
  };
}
