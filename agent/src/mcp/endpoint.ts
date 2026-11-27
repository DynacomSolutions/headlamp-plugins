import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NodeStreamableHTTPServerTransport, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, ProtocolError, type EventStore, type JSONRPCMessage, type McpServer } from '@modelcontextprotocol/server';
import { eventMatches, parseUri, scopeForUri, type ParsedUri } from '../incidents/model.js';
import type { EventLog } from '../incidents/events.js';
import type { EventRecord } from '../incidents/types.js';
import { ANONYMOUS, authenticate, type Principal, type TokenStore } from './auth.js';
import { CONTRACT_VERSION, META_KEY, type ContractDeps } from './contract.js';
import type { McpMetrics } from './metrics.js';

export const MAX_SESSIONS = 200;
export const MAX_SUBSCRIPTIONS = 100;
const IDLE_MS = 30 * 60_000;
const SESSION_VERSIONS = ['2025-06-18', '2025-11-25'];
const STANDALONE = '_GET_stream';

export interface EndpointDeps {
  contract: ContractDeps;
  /** Builds an MCP server for one caller. `stateful` servers get subscriptions. */
  build(who: Principal, stateful: boolean): Promise<McpServer>;
  tokens: TokenStore;
  authMode: 'optional' | 'required';
  allowedOrigins: string[];
  metrics: McpMetrics;
  events: EventLog;
  log: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
  /** Reads a JSON body. Resolves undefined for no body. */
  readBody(req: IncomingMessage): Promise<unknown>;
  send(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void;
}

interface Session {
  id: string;
  who: Principal;
  mcp: McpServer;
  transport: NodeStreamableHTTPServerTransport;
  subs: Map<string, ParsedUri>;
  lastSeen: number;
  streams: number;
  /** The highest event id that dispatch handled for this session. */
  dispatched: bigint;
  chain: Promise<void>;
  closed: boolean;
}

const notification = (method: string, params: Record<string, unknown>): JSONRPCMessage => ({ jsonrpc: '2.0', method, params }) as JSONRPCMessage;

function eventMeta(e: EventRecord): Record<string, unknown> {
  return { [META_KEY]: { eventId: e.id, kind: e.kind, incidentId: e.incidentId, at: e.at, labels: e.labels } };
}

export const updated = (uri: string, e: EventRecord) => notification('notifications/resources/updated', { uri, _meta: eventMeta(e) });
export const listChanged = (e: EventRecord) => notification('notifications/resources/list_changed', { _meta: eventMeta(e) });
const LIST_CHANGING = new Set(['incident.created', 'incident.resolved']);

/** MCP over streamable HTTP: stateful sessions with push, and the stateless fallback (contract section 1). */
export class McpEndpoint {
  private readonly sessions = new Map<string, Session>();
  private readonly als = new AsyncLocalStorage<Principal>();
  private stateless: ReturnType<typeof toNodeHandler> | undefined;
  private sweeper: NodeJS.Timeout | undefined;
  private unlisten: (() => void) | undefined;

  constructor(private readonly d: EndpointDeps) {}

  async start(): Promise<void> {
    this.stateless = toNodeHandler(createMcpHandler(() => this.d.build(this.als.getStore() ?? ANONYMOUS, false), { responseMode: 'json' }));
    this.unlisten = this.d.events.listen(e => this.dispatch(e));
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref();
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.unlisten?.();
    await Promise.all([...this.sessions.values()].map(s => this.end(s)));
  }

  stats(): { sessions: number; subscriptions: number; streams: number } {
    let subscriptions = 0;
    let streams = 0;
    for (const s of this.sessions.values()) {
      subscriptions += s.subs.size;
      streams += s.streams;
    }
    return { sessions: this.sessions.size, subscriptions, streams };
  }

  private async end(s: Session): Promise<void> {
    if (s.closed) return;
    s.closed = true;
    this.sessions.delete(s.id);
    await s.transport.close().catch(() => {});
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) if (s.streams === 0 && now - s.lastSeen > IDLE_MS) await this.end(s);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { d } = this;
    const origin = req.headers.origin;
    if (origin && !d.allowedOrigins.includes(origin)) return d.send(res, 403, { jsonrpc: '2.0', error: { code: -32600, message: 'Origin not allowed' } });
    const auth = authenticate(req, d.tokens, d.authMode);
    if (!auth.ok) {
      d.metrics.authFailure(auth.reason);
      const challenge = auth.reason === 'invalid' ? 'Bearer realm="headlamp-agent", error="invalid_token"' : 'Bearer realm="headlamp-agent"';
      return d.send(res, 401, { error: { code: 'unauthenticated', message: auth.reason === 'invalid' ? 'The token is not valid.' : 'A bearer token is required.' } }, { 'www-authenticate': challenge });
    }
    const who = auth.principal;
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') return this.inSession(req, res, who, sessionId);

    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await d.readBody(req);
      } catch (error) {
        return d.send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: error instanceof Error ? error.message : 'Parse error' } });
      }
      if (!who.anonymous && isSessionInitialize(body)) return this.open(req, res, who, body);
    }
    // No session: stateless mode. Subscriptions are not available here.
    await this.als.run(who, () => this.stateless!(req, res, body));
  }

  private async open(req: IncomingMessage, res: ServerResponse, who: Principal, body: unknown): Promise<void> {
    if (this.sessions.size >= MAX_SESSIONS) return this.d.send(res, 503, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many sessions', data: { code: 'rate_limited', retryAfterSeconds: 30 } } }, { 'retry-after': '30' });
    const mcp = await this.d.build(who, true);
    const session: Session = { id: '', who, mcp, transport: undefined as never, subs: new Map(), lastSeen: Date.now(), streams: 0, dispatched: 0n, chain: Promise.resolve(), closed: false };
    this.hook(session);
    session.transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore: this.eventStore(session),
      keepAliveMs: 25_000,
      onsessioninitialized: id => {
        session.id = id;
        this.sessions.set(id, session);
      },
      onsessionclosed: () => void this.end(session),
    });
    session.transport.onclose = () => {
      if (!session.closed) {
        session.closed = true;
        if (session.id) this.sessions.delete(session.id);
      }
    };
    // The newest event at the start: this session never sees earlier ones as live events.
    session.dispatched = BigInt((await this.d.events.head()).latest ?? '0');
    await mcp.connect(session.transport);
    await this.als.run(who, () => session.transport.handleRequest(req, res, body));
  }

  private async inSession(req: IncomingMessage, res: ServerResponse, who: Principal, id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return this.d.send(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } });
    if (session.who.client !== who.client) {
      this.d.metrics.authFailure('scope');
      return this.d.send(res, 403, { error: { code: 'forbidden', message: 'The session belongs to another client.' } });
    }
    session.lastSeen = Date.now();
    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await this.d.readBody(req);
      } catch (error) {
        return this.d.send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: error instanceof Error ? error.message : 'Parse error' } });
      }
    }
    if (req.method === 'GET') {
      session.streams++;
      let counted = true;
      const done = () => {
        if (counted) session.streams--;
        counted = false;
        session.lastSeen = Date.now();
      };
      res.on('close', done);
    }
    await this.als.run(who, () => session.transport.handleRequest(req, res, body));
  }

  /** Subscribe and unsubscribe handlers, and the capabilities of a stateful session. */
  private hook(session: Session): void {
    const { mcp, who } = session;
    mcp.server.registerCapabilities({
      resources: { subscribe: true, listChanged: true },
      experimental: { 'dev.dynacom.headlamp': { contract: CONTRACT_VERSION, eventLog: { uri: 'headlamp://events', retentionHours: 168 }, scopes: [...who.scopes] } },
    } as never);
    mcp.server.setRequestHandler('resources/subscribe', async request => {
      const uri = request.params.uri;
      const parsed = parseUri(uri);
      if (!parsed || parsed.type === 'contract') throw new ProtocolError(-32002, `Resource ${uri} not found`, { code: 'not_found' });
      const scope = scopeForUri(parsed);
      if (scope && !who.scopes.has(scope)) {
        this.d.metrics.authFailure('scope');
        throw new ProtocolError(-32003, `The scope ${scope} is required.`, { code: 'forbidden', requiredScope: scope });
      }
      if (!session.subs.has(uri) && session.subs.size >= MAX_SUBSCRIPTIONS) throw new ProtocolError(-32000, 'Too many subscriptions in this session.', { code: 'rate_limited' });
      if ((parsed.type === 'incident' || parsed.type === 'timeline' || parsed.type === 'investigation') && !(await this.d.contract.incidents.get(parsed.id).then(() => true, () => false))) {
        throw new ProtocolError(-32002, `Resource ${uri} not found`, { code: 'not_found' });
      }
      session.subs.set(uri, parsed);
      return {};
    });
    mcp.server.setRequestHandler('resources/unsubscribe', async request => {
      session.subs.delete(request.params.uri);
      return {};
    });
  }

  /** SSE ids of event notifications are event ids. Other messages get ids that only mark a position. */
  private eventStore(session: Session): EventStore {
    let counter = 0;
    const marks = new Map<string, { stream: string; after: bigint }>();
    const numeric = (id: string) => /^\d{1,18}$/.test(id);
    return {
      storeEvent: async (streamId, message) => {
        const meta = ((message as { params?: { _meta?: Record<string, { eventId?: string }> } }).params?._meta ?? {})[META_KEY];
        if (meta?.eventId && numeric(String(meta.eventId))) return String(meta.eventId);
        const id = `m${++counter}`;
        marks.set(id, { stream: streamId, after: session.dispatched });
        if (marks.size > 1000) marks.delete(marks.keys().next().value as string);
        return id;
      },
      getStreamIdForEventId: async id => (numeric(id) ? STANDALONE : marks.get(id)?.stream),
      replayEventsAfter: async (lastEventId, { send }) => {
        const mark = marks.get(lastEventId);
        const from = numeric(lastEventId) ? BigInt(lastEventId) : mark ? mark.after + 1n : session.dispatched + 1n;
        if (!numeric(lastEventId) && mark?.stream !== STANDALONE) return mark?.stream ?? STANDALONE;
        await this.replay(session, from, send);
        return STANDALONE;
      },
    };
  }

  private async replay(session: Session, from: bigint, send: (id: string, message: JSONRPCMessage) => Promise<void>): Promise<void> {
    let after = from - 1n;
    for (;;) {
      const page = await this.d.events.readAfter(after, 500);
      if (page.reset) {
        // The log no longer holds what the client missed (contract section 8.5).
        const e = { id: page.oldestRetained ?? page.latest ?? '0', at: new Date().toISOString(), kind: 'reset', uri: 'headlamp://events', incidentId: null, labels: {}, actor: null } satisfies EventRecord;
        await send(e.id, notification('notifications/resources/list_changed', { _meta: { [META_KEY]: { eventId: e.id, kind: 'reset', incidentId: null, at: e.at, labels: {}, latest: page.latest } } }));
      }
      for (const e of page.events) for (const m of this.messagesFor(session, e)) await send(e.id, m);
      if (!page.hasMore) return;
      after = BigInt(page.nextAfter);
    }
  }

  private messagesFor(session: Session, e: EventRecord): JSONRPCMessage[] {
    const out: JSONRPCMessage[] = [];
    for (const [uri, parsed] of session.subs) if (eventMatches(e, parsed)) out.push(updated(uri, e));
    if (LIST_CHANGING.has(e.kind) && session.who.scopes.has('incidents:read')) out.push(listChanged(e));
    return out;
  }

  /** One event, for every session, in order. */
  private dispatch(e: EventRecord): void {
    for (const session of this.sessions.values()) {
      session.chain = session.chain.then(async () => {
        if (session.closed) return;
        session.dispatched = BigInt(e.id) > session.dispatched ? BigInt(e.id) : session.dispatched;
        for (const m of this.messagesFor(session, e)) {
          try {
            await session.mcp.server.notification({ method: (m as { method: string }).method, params: (m as { params: Record<string, unknown> }).params } as never);
            this.d.metrics.eventSent(e.kind);
          } catch (error) {
            this.d.log('warn', 'mcp notification failed', { session: session.id, error: String(error) });
          }
        }
      });
    }
  }
}

function isSessionInitialize(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const b = body as { method?: unknown; params?: { protocolVersion?: unknown } };
  return b.method === 'initialize' && typeof b.params?.protocolVersion === 'string' && SESSION_VERSIONS.includes(b.params.protocolVersion);
}
