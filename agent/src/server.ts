import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { loadConfig, modelConfigured, type Config } from './config.js';
import { AlertGate, fingerprint, parseAlerts } from './alerts.js';
import { diagnose } from './agent/engine.js';
import { ModelClient } from './agent/model.js';
import { alertSchema, renderDiagnosis, resultSchema, sanitizeResult, type Alert, type Diagnosis } from './agent/report.js';
import { mask } from './mask.js';
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

/** Runs diagnoses one at a time, in arrival order, so a burst of alerts cannot overload the model quota. */
export class Runner {
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private draining = false;

  constructor(
    private readonly runtime: Runtime,
    private readonly store: DiagnosisStore,
    private readonly config: Config,
  ) {}

  get configured(): boolean {
    return modelConfigured(this.config.model);
  }

  /**
   * Stop starting work and resolve when the diagnosis that runs now has finished.
   * Diagnoses that have not started stay `queued` in the store, so the next start runs them.
   */
  async drain(): Promise<void> {
    this.draining = true;
    while (this.pending > 0) await this.chain;
  }

  /** Run again a diagnosis that a restart interrupted. It keeps its id and its creation time. */
  resume(interrupted: Diagnosis): void {
    this.enqueue(interrupted.alert, interrupted.source, interrupted.id);
  }

  enqueue(alert: Alert, source: Diagnosis['source'], existingId?: string): Diagnosis {
    const existing = existingId ? this.store.get(existingId) : undefined;
    const queued: Diagnosis = {
      id: existing?.id ?? randomUUID(),
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
    };
    queued.a2ui = renderDiagnosis(queued);
    this.store.put(queued);
    if (this.draining) return queued;
    if (!existing && this.pending >= 20) {
      this.store.put({ ...queued, status: 'failed', error: 'Too many diagnoses queued', a2ui: renderDiagnosis({ ...queued, status: 'failed', error: 'Too many diagnoses queued' }) });
      return queued;
    }
    this.pending++;
    this.chain = this.chain.then(async () => {
      try {
        if (this.draining) return;
        const model = new ModelClient(this.config.model);
        const result = await diagnose({
          alert,
          tools: this.runtime.toolHost(),
          model,
          budget: this.config.diagnosis.toolBudget,
          source,
          host: 'cluster',
          id: queued.id,
          onEvent: event => {
            if (event.type === 'progress') this.store.put({ ...event.diagnosis, createdAt: queued.createdAt });
          },
        });
        const latest = this.store.get(queued.id);
        this.store.put({ ...result, createdAt: queued.createdAt, resolvedAt: latest?.resolvedAt });
        log('info', 'diagnosis finished', { id: result.id, alert: alert.name, status: result.status, toolCalls: result.toolCalls, error: result.error });
      } catch (error) {
        log('error', 'diagnosis crashed', { id: queued.id, error: String(error) });
      } finally {
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

  // Diagnoses that a hard kill interrupted run again, oldest first. They do not count against the hourly cap.
  for (const interrupted of store.interrupted().reverse()) {
    if (runner.configured) {
      runner.resume(interrupted);
      log('info', 'diagnosis resumed', { id: interrupted.id, alert: interrupted.alert.name });
    } else {
      const failed = { ...interrupted, status: 'failed' as const, error: 'Interrupted by a restart' };
      store.put({ ...failed, a2ui: renderDiagnosis(failed) });
    }
  }

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
          if (store.findByFingerprint(alert.fingerprint, alert.startsAt)) continue;
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
      store.flush();
    },
  };
}
