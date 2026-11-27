import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { RequestError, type Stream } from '@agentclientprotocol/sdk';
import { createAcpApp, type PromptOutcome } from './acp.js';
import type { ModelCatalogue } from './agent/catalogue.js';
import type { ToolHost } from './agent/engine.js';
import type { Diagnosis } from './agent/report.js';
import { checkBearer, SCOPES, type TokenEntry } from './auth/scopes.js';
import type { Config } from './config.js';
import type { Metrics } from './metrics.js';
import { fitForPublish, publishSchema, storePublished } from './publish.js';
import type { DiagnosisStore } from './store.js';

/** The path of the endpoint. */
export const ACP_PATH = '/acp';

/** One ACP message is one text frame. A frame of more than this many bytes closes the socket (code 1009). */
const MAX_FRAME_BYTES = 1024 * 1024;
const PING_MS = 30_000;
/** How long a closing socket may stay open after the drain limit, before it is cut. */
const DRAIN_CLOSE_MS = 2_000;
const SOCKET_OPEN = 1;
type AnyMessage = Stream extends { readable: ReadableStream<infer M> } ? M : never;

export interface AcpEndpointDeps {
  config: Config;
  catalogue: ModelCatalogue;
  /** The in-process tools (the same registry the /mcp endpoint serves). No network call is made for a tool. */
  tools: ToolHost;
  store: DiagnosisStore;
  metrics: Metrics;
  /** The current tokens. Called for every upgrade, so a changed Secret takes effect without a restart. */
  tokens: () => TokenEntry[];
  /** Called after a diagnosis is stored, for the push notification. Must not throw. */
  onPublished?: (diagnosis: Diagnosis) => void;
  log: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
}

interface Connection {
  socket: WebSocket;
  /** How many prompt requests have no answer written yet, by request id. A reused id counts once per request. */
  prompts: Map<string | number, number>;
  /** The total of `prompts`. */
  pending: number;
  dispose(): void;
}

/** What the endpoint needs to see on a stream: the prompt requests that come in and the answers that go out. */
interface StreamHooks {
  onProtocolError(): void;
  onRequest(message: { id?: unknown; method?: unknown }): void;
  /** An answer (a result or an error) was written to the socket. */
  onAnswered(id: string | number): void;
}

/** Rejects the upgrade with a plain HTTP answer. The socket never becomes a WebSocket. */
function reject(socket: Duplex, status: number, reason: string, headers: Record<string, string> = {}): void {
  const text: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' };
  const body = JSON.stringify({ error: reason });
  const lines = [
    `HTTP/1.1 ${status} ${text[status] ?? 'Error'}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Cache-Control: no-store',
    'Connection: close',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    '',
    body,
  ];
  socket.end(lines.join('\r\n'));
}

/** An ACP stream over a server-side WebSocket: one JSON-RPC message per text frame. */
function webSocketStream(socket: WebSocket, hooks: StreamHooks): Stream {
  const { onProtocolError } = hooks;
  const send = (message: unknown): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      // A late update after the socket closed is dropped: the run was aborted with the socket.
      if (socket.readyState !== SOCKET_OPEN) return resolve();
      socket.send(JSON.stringify(message), error => (error ? reject(error) : resolve()));
    });
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      socket.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          onProtocolError();
          socket.close(1003, 'ACP frames are text');
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(data.toString('utf8'));
        } catch {
          onProtocolError();
          void send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }).catch(() => undefined);
          return;
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          // ACP does not use JSON-RPC batches.
          onProtocolError();
          void send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request: send one message per frame' } }).catch(() => undefined);
          return;
        }
        hooks.onRequest(message as { id?: unknown; method?: unknown });
        controller.enqueue(message as AnyMessage);
      });
      socket.on('close', () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      socket.on('error', error => {
        try {
          controller.error(error);
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      socket.close(1000);
    },
  });
  const writable = new WritableStream<AnyMessage>({
    write: async message => {
      await send(message);
      const m = message as { id?: unknown; method?: unknown };
      // An answer has an id and no method. Only then is the request done: a late notification is not an answer.
      if (m.method === undefined && (typeof m.id === 'string' || typeof m.id === 'number')) hooks.onAnswered(m.id);
    },
    close() {
      socket.close(1000);
    },
    abort() {
      socket.terminate();
    },
  });
  return { readable, writable } as Stream;
}

/**
 * The ACP agent on the network: a WebSocket upgrade on /acp, one ACP connection per socket, one JSON-RPC message per text frame.
 * The agent is the one that serves stdio (see createAcpApp). Its tools come from the in-process registry.
 */
export class AcpEndpoint {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  private readonly connections = new Set<Connection>();
  private sessions = 0;
  private draining = false;

  constructor(private readonly deps: AcpEndpointDeps) {
    this.gauges();
  }

  /** Connections that are open now. */
  get open(): number {
    return this.connections.size;
  }

  private get limit(): number {
    return this.deps.config.acp.maxSessions;
  }

  private gauges(): void {
    this.deps.metrics.set('headlamp_agent_acp_sessions', {}, this.sessions);
    this.deps.metrics.set('headlamp_agent_acp_connections', {}, this.connections.size);
  }

  /** Handles one upgrade request for the ACP path. Authentication and the limit are checked before the socket is upgraded. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const { metrics, log, config } = this.deps;
    socket.on('error', () => undefined);
    if (this.limit === 0) return reject(socket, 404, 'The ACP endpoint is off');
    if (this.draining) return reject(socket, 503, 'Agent is draining', { 'Retry-After': '5' });
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      metrics.inc('headlamp_agent_acp_errors_total', { kind: 'upgrade' });
      return reject(socket, 400, 'A WebSocket upgrade is required');
    }
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      metrics.inc('headlamp_agent_acp_auth_failures_total', { reason: 'origin' });
      log('warn', 'acp upgrade refused', { reason: 'origin' });
      return reject(socket, 403, 'Origin not allowed');
    }
    const auth = checkBearer(this.deps.tokens(), req.headers.authorization, SCOPES.investigate);
    if (!auth.ok) {
      metrics.inc('headlamp_agent_acp_auth_failures_total', { reason: auth.reason });
      log('warn', 'acp upgrade refused', { reason: auth.reason });
      return reject(socket, auth.status, auth.status === 403 ? `The token needs the scope ${SCOPES.investigate}` : 'A bearer token is required', auth.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="headlamp-agent"' } : {});
    }
    if (this.connections.size >= this.limit) {
      metrics.inc('headlamp_agent_acp_errors_total', { kind: 'limit' });
      log('warn', 'acp upgrade refused', { reason: 'limit', limit: this.limit });
      return reject(socket, 503, `Too many ACP sessions: the limit is ${this.limit}`, { 'Retry-After': '10' });
    }
    this.wss.handleUpgrade(req, socket, head, ws => this.accept(ws, auth.name));
  }

  private accept(socket: WebSocket, client: string): void {
    const { metrics, log, config } = this.deps;
    const conn: Connection = {
      socket,
      prompts: new Map(),
      pending: 0,
      dispose: () => undefined,
    };
    const { app, dispose } = createAcpApp({
      config,
      catalogue: this.deps.catalogue,
      log: message => log('info', message, { endpoint: 'acp' }),
      tools: this.deps.tools,
      publish: async d => {
        const { a2ui: _a2ui, finishedAt: _f, resolvedAt: _r, ...rest } = d;
        // A long run can pass a limit of the schema (60 evidence items, 2000 characters). Cut first, so the diagnosis is not lost.
        const parsed = publishSchema.parse({ diagnosis: fitForPublish({ ...rest, source: 'acp', status: d.status === 'done' ? 'done' : 'failed' }) });
        // The label comes from the token, set here after the parse. The HTTP route never takes it from a body.
        const saved = await storePublished(this.deps.store, { ...parsed.diagnosis, client });
        if (saved.status === 'done') this.deps.onPublished?.(saved);
        return saved.id;
      },
      hooks: {
        acquireSession: () => {
          if (this.draining) throw new RequestError(-32000, 'Agent is draining');
          if (this.sessions >= this.limit) {
            metrics.inc('headlamp_agent_acp_errors_total', { kind: 'limit' });
            throw new RequestError(-32000, `Too many ACP sessions: the limit is ${this.limit}`);
          }
          this.sessions++;
          this.gauges();
          let freed = false;
          const release = () => {
            if (freed) return;
            freed = true;
            this.sessions--;
            this.gauges();
          };
          return release;
        },
        promptStarted: sessionId => {
          // A prompt that starts during a drain would hold the drain open.
          if (this.draining) {
            metrics.inc('headlamp_agent_acp_errors_total', { kind: 'draining' });
            throw new RequestError(-32000, 'Agent is draining');
          }
          log('info', 'acp prompt started', { client, sessionId });
        },
        // The socket closes after the answer is written (see onAnswered), so the client gets its stopReason.
        prompt: (outcome: PromptOutcome, sessionId) => {
          metrics.inc('headlamp_agent_acp_prompts_total', { result: outcome });
          log('info', 'acp prompt ended', { client, sessionId, outcome });
        },
      },
    });
    // A run that is still ending frees its session place when it ends (see createAcpApp).
    conn.dispose = dispose;
    this.connections.add(conn);
    this.gauges();
    log('info', 'acp connection opened', { client, open: this.connections.size });

    // A client that does not answer a ping is gone: free its places.
    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });
    const ping = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, PING_MS);
    ping.unref();

    const connection = app.connect(
      webSocketStream(socket, {
        onProtocolError: () => {
          metrics.inc('headlamp_agent_acp_errors_total', { kind: 'protocol' });
        },
        onRequest: message => {
          if (message.method === 'session/prompt' && (typeof message.id === 'string' || typeof message.id === 'number')) {
            conn.prompts.set(message.id, (conn.prompts.get(message.id) ?? 0) + 1);
            conn.pending++;
          }
        },
        onAnswered: id => {
          const count = conn.prompts.get(id);
          if (!count) return;
          if (count === 1) conn.prompts.delete(id);
          else conn.prompts.set(id, count - 1);
          conn.pending--;
          // The drain closes the socket after the last answer is written, so the client keeps its stopReason.
          if (this.draining && conn.pending === 0) socket.close(1001, 'Agent is draining');
        },
      }),
    );
    const finish = () => {
      clearInterval(ping);
      // Closing the socket aborts every run of the connection.
      conn.dispose();
      this.connections.delete(conn);
      this.gauges();
      log('info', 'acp connection closed', { client, open: this.connections.size });
    };
    socket.once('close', finish);
    socket.on('error', error => {
      metrics.inc('headlamp_agent_acp_errors_total', { kind: 'protocol' });
      log('warn', 'acp socket error', { client, error: String(error) });
    });
    void connection.closed.then(() => socket.close(1000), () => socket.terminate());
  }

  /**
   * Stops new connections, sessions and prompts. A connection with no prompt in flight closes at once (code 1001).
   * A prompt in flight finishes, its answer is written, then its connection closes.
   * After `acp.drainTimeoutMs` the runs that remain are aborted and their sockets close, so a drain cannot be held open.
   * The returned promise resolves when every connection is closed.
   */
  async close(): Promise<void> {
    this.draining = true;
    const done: Array<Promise<void>> = [];
    for (const conn of this.connections) {
      done.push(new Promise<void>(resolve => conn.socket.once('close', () => resolve())));
      if (conn.pending === 0) conn.socket.close(1001, 'Agent is draining');
    }
    const timer = setTimeout(() => {
      for (const conn of this.connections) {
        this.deps.log('warn', 'acp drain timed out: runs aborted', { prompts: conn.pending });
        conn.dispose();
        conn.socket.close(1001, 'Agent is draining');
        // A client that does not answer the close frame is cut after a short wait.
        setTimeout(() => conn.socket.terminate(), DRAIN_CLOSE_MS).unref();
      }
    }, this.deps.config.acp.drainTimeoutMs);
    try {
      await Promise.all(done);
    } finally {
      clearTimeout(timer);
    }
    this.wss.close();
  }
}
