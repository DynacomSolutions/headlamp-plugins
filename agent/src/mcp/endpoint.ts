import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NodeStreamableHTTPServerTransport, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, ProtocolError, type EventStore, type JSONRPCMessage, type McpServer } from '@modelcontextprotocol/server';
import { canSee, eventMatches, parseUri, scopeForUri, SCOPES, type ParsedUri } from '../incidents/model.js';
import type { EventLog } from '../incidents/events.js';
import type { EventRecord } from '../incidents/types.js';
import { ANONYMOUS, authenticate, type Principal, type TokenStore } from './auth.js';
import { CONTRACT_VERSION, META_KEY, type ContractDeps } from './contract.js';
import type { McpMetrics } from './metrics.js';

export const MAX_SESSIONS = 200;
export const MAX_SESSIONS_PER_CLIENT = 20;
export const MAX_SUBSCRIPTIONS = 100;
/** A replay sends at most this many notifications. Then it sends a reset (contract section 8.4). */
export const MAX_REPLAY = 5000;
const IDLE_MS = 30 * 60_000;
const MARKS = 1000;
const SESSION_VERSIONS = ['2025-06-18', '2025-11-25'];
const STANDALONE = '_GET_stream';
const EVENT_ID = /^(\d{1,18})\.(\d{1,6})$/;
const MARK_ID = /^[A-Za-z0-9._-]{1,64}$/;

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
  /** SSE ids of live notifications that are on their way to the transport (key: event id and URI). */
  liveIds: Map<string, string>;
  /** Positions that `p<k>` ids stand for: replay starts after the event id. */
  marks: Map<string, bigint>;
  counter: number;
  /** True while a replay runs: live events wait in `held` and the replay sends them last (contract section 8.4). */
  replaying: boolean;
  held: EventRecord[];
  /** The newest GET request of the session: set when its response closes. */
  get?: { closed: boolean };
}

type Message = { id: string; message: JSONRPCMessage };

const notification = (method: string, params: Record<string, unknown>): JSONRPCMessage => ({ jsonrpc: '2.0', method, params }) as JSONRPCMessage;

function eventMeta(e: EventRecord): Record<string, unknown> {
  return { [META_KEY]: { eventId: e.id, kind: e.kind, uri: e.uri, incidentId: e.incidentId, at: e.at, labels: e.labels } };
}

export const updated = (uri: string, e: EventRecord) => notification('notifications/resources/updated', { uri, _meta: eventMeta(e) });
export const listChanged = (e: EventRecord) => notification('notifications/resources/list_changed', { _meta: eventMeta(e) });
const LIST_CHANGING = new Set(['incident.created', 'incident.resolved']);
const liveKey = (eventId: string, uri: string | undefined) => `${eventId}\u0000${uri ?? ''}`;

/** MCP over streamable HTTP: stateful sessions with push, and the stateless fallback (contract section 1). */
export class McpEndpoint {
  private readonly sessions = new Map<string, Session>();
  /** Sessions that `initialize` is building. They count against the limits at once, so parallel requests cannot go over. */
  private readonly pending = new Map<string, number>();
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
    await this.revalidate();
    for (const s of [...this.sessions.values()]) if (s.streams === 0 && now - s.lastSeen > IDLE_MS) await this.end(s);
  }

  /** Ends the sessions whose token is gone from the token file, or has fewer scopes now (contract section 1.1, rule 9). */
  async revalidate(): Promise<void> {
    for (const s of [...this.sessions.values()]) {
      if (!this.d.tokens.stillValid(s.who)) {
        this.d.log('info', 'mcp session ended: its token changed', { client: s.who.client });
        await this.end(s);
      }
    }
  }

  private sessionsOf(client: string): number {
    let n = this.pending.get(client) ?? 0;
    for (const s of this.sessions.values()) if (s.who.client === client) n++;
    return n;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { d } = this;
    const origin = req.headers.origin;
    if (origin && !d.allowedOrigins.includes(origin)) {
      d.metrics.authFailure('origin');
      return d.send(res, 403, { jsonrpc: '2.0', error: { code: -32600, message: 'Origin not allowed' } });
    }
    const auth = authenticate(req, d.tokens, d.authMode);
    if (!auth.ok) {
      d.metrics.authFailure(auth.reason);
      const challenge = auth.reason === 'invalid' ? 'Bearer realm="headlamp-agent", error="invalid_token"' : 'Bearer realm="headlamp-agent"';
      return d.send(res, 401, { error: { code: 'unauthenticated', message: auth.reason === 'invalid' ? 'The token is not valid.' : 'A bearer token is required.' } }, { 'www-authenticate': challenge });
    }
    const who = auth.principal;
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') return this.inSession(req, res, who, sessionId);
    // No push stream without a session: a server that offers none answers 405 (contract section 1.2).
    if (req.method === 'GET') return d.send(res, 405, { error: { code: 'session_required', message: 'The push stream needs a session: send initialize first.' } }, { allow: 'POST, DELETE' });

    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await d.readBody(req);
      } catch (error) {
        return d.send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: error instanceof Error ? error.message : 'Parse error' } });
      }
      if (!who.anonymous && isSessionInitialize(body)) return this.open(req, res, who, body);
      // No session: subscriptions are not available here (contract section 1.2).
      const method = body && typeof body === 'object' && !Array.isArray(body) ? (body as { method?: unknown }).method : undefined;
      if (method === 'resources/subscribe' || method === 'resources/unsubscribe') {
        const id = (body as { id?: unknown }).id ?? null;
        return d.send(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Subscriptions need a session: send initialize first.', data: { code: 'session_required' } } });
      }
    }
    await this.als.run(who, () => this.stateless!(req, res, body));
  }

  private async open(req: IncomingMessage, res: ServerResponse, who: Principal, body: unknown): Promise<void> {
    const rate = (status: number) => this.d.send(res, status, { jsonrpc: '2.0', id: null, error: { code: -32000, message: status === 429 ? 'Too many sessions for this client' : 'Too many sessions', data: { code: 'rate_limited', retryAfterSeconds: 30 } } }, { 'retry-after': '30' });
    let total = this.sessions.size;
    for (const n of this.pending.values()) total += n;
    if (total >= MAX_SESSIONS) return rate(503);
    if (this.sessionsOf(who.client) >= MAX_SESSIONS_PER_CLIENT) return rate(429);
    // Reserve the slot before the first await.
    this.pending.set(who.client, (this.pending.get(who.client) ?? 0) + 1);
    try {
      const mcp = await this.d.build(who, true);
      const session: Session = { id: '', who, mcp, transport: undefined as never, subs: new Map(), lastSeen: Date.now(), streams: 0, dispatched: 0n, chain: Promise.resolve(), closed: false, liveIds: new Map(), marks: new Map(), counter: 0, replaying: false, held: [] };
      this.hook(session);
      session.transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore: this.eventStore(session),
        // Every POST of a session gets a JSON answer. The only SSE stream is the GET push stream (contract section 1.1, rule 4).
        enableJsonResponse: true,
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
    } finally {
      const left = (this.pending.get(who.client) ?? 1) - 1;
      if (left > 0) this.pending.set(who.client, left);
      else this.pending.delete(who.client);
    }
  }

  private async inSession(req: IncomingMessage, res: ServerResponse, who: Principal, id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return this.d.send(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } });
    // A session belongs to the token that opened it. Two entries can share a name, so the digest decides (contract section 4.3).
    if (session.who.digest !== who.digest) {
      this.d.metrics.authFailure('scope');
      return this.d.send(res, 403, { error: { code: 'forbidden', message: 'The session belongs to another token.' } });
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
      // A new stream replaces the old one: the old connection can look alive for a while after a network break (contract section 1.1, rule 4).
      session.transport.closeStandaloneSSEStream();
      const get = { closed: false };
      session.get = get;
      session.streams++;
      let counted = true;
      res.on('close', () => {
        get.closed = true;
        if (counted) session.streams--;
        counted = false;
        session.lastSeen = Date.now();
      });
    }
    await this.als.run(who, () => session.transport.handleRequest(req, res, body));
  }

  /** Subscribe and unsubscribe handlers, and the capabilities of a stateful session. */
  private hook(session: Session): void {
    const { mcp, who } = session;
    mcp.server.registerCapabilities({
      resources: { subscribe: true, listChanged: true },
      experimental: { 'headlamp-agent': { contract: CONTRACT_VERSION, eventLog: { uri: 'headlamp://events', retentionHours: 168 }, scopes: SCOPES } },
    } as never);
    mcp.server.setRequestHandler('resources/subscribe', async request => {
      const uri = request.params.uri;
      const parsed = parseUri(uri);
      if (!parsed) throw new ProtocolError(-32002, `Resource ${uri} not found`, { code: 'not_found' });
      if (parsed.type === 'contract' || (parsed.type === 'storage' && parsed.kind !== 'volumes')) throw new ProtocolError(-32002, `Resource ${uri} has no event source`, { code: 'not_subscribable' });
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

  /**
   * SSE ids (contract sections 7.3 and 8.4): an event notification gets `<eventId>.<n>`, unique in the session.
   * Priming events and reset frames get `p<k>`, and the session remembers the position of each.
   */
  private eventStore(session: Session): EventStore {
    return {
      storeEvent: async (_streamId, message) => {
        const params = (message as { params?: { uri?: string; _meta?: Record<string, { eventId?: string }> } }).params;
        const eventId = params?._meta?.[META_KEY]?.eventId;
        if (eventId !== undefined) {
          const key = liveKey(String(eventId), params?.uri);
          const id = session.liveIds.get(key);
          session.liveIds.delete(key);
          if (id) return id;
        }
        return this.mark(session, session.dispatched);
      },
      // Every id this server can resume is on the one standalone stream. A malformed id is refused, an unknown one gets a reset.
      getStreamIdForEventId: async id => (EVENT_ID.test(id) || MARK_ID.test(id) ? STANDALONE : undefined),
      replayEventsAfter: async (lastEventId, { send }) => {
        session.replaying = true;
        // The highest event id that the client has or reads by itself (a reset frame says: read from `latest`).
        const covered = { value: 0n };
        try {
          await this.replay(session, lastEventId, send, covered);
          await this.flush(session, covered, send);
        } finally {
          // Any exit: the replay no longer holds events. A client that left reads the log when it comes back.
          session.replaying = false;
          session.held = [];
        }
        return STANDALONE;
      },
    };
  }

  private mark(session: Session, after: bigint): string {
    const id = `p${++session.counter}`;
    session.marks.set(id, after);
    if (session.marks.size > MARKS) session.marks.delete(session.marks.keys().next().value as string);
    return id;
  }

  /**
   * Sends the live events that came while the replay ran, whatever way the replay ended (contract section 8.4).
   * No await sits between the last check of `held` and the end of the replay, so no event falls between.
   */
  private async flush(session: Session, covered: { value: bigint }, send: (id: string, message: JSONRPCMessage) => Promise<void>): Promise<void> {
    while (session.held.length) {
      const e = session.held.shift()!;
      if (BigInt(e.id) <= covered.value) continue;
      for (const n of this.notificationsFor(session, e)) {
        if (session.get?.closed) return;
        await send(n.id, n.message);
      }
    }
    session.replaying = false;
  }

  private async replay(session: Session, lastEventId: string, send: (id: string, message: JSONRPCMessage) => Promise<void>, covered: { value: bigint }): Promise<void> {
    const get = session.get;
    const head = await this.d.events.head();
    const reset = async (after: bigint) => {
      const at = new Date().toISOString();
      // `eventId` is "0": the reset frame never matches a real event in the de-duplication key. The cursor is `latest` (contract section 8.5).
      const meta = { eventId: '0', kind: 'reset', uri: 'headlamp://events', incidentId: null, at, labels: {}, latest: head.latest, logId: head.logId };
      await send(this.mark(session, after), notification('notifications/resources/list_changed', { _meta: { [META_KEY]: meta } }));
    };
    const latest = BigInt(head.latest ?? '0');
    const m = EVENT_ID.exec(lastEventId);
    let cursor: bigint;
    let skip: { id: bigint; n: number } | undefined;
    if (m) {
      cursor = BigInt(m[1]!);
      skip = { id: cursor, n: Number(m[2]) };
    } else if (session.marks.has(lastEventId)) {
      cursor = session.marks.get(lastEventId)!;
    } else {
      // An id that the server does not know: the client cannot rely on events (contract section 8.5).
      covered.value = latest;
      await reset(latest);
      return;
    }
    covered.value = cursor;
    let sent = 0;
    // True when the replay must stop: the client left, or a notification beyond the cap follows (then a reset tells the client to re-read).
    const emit = async (list: Message[]): Promise<boolean> => {
      for (const n of list) {
        if (get?.closed) return true;
        if (sent >= MAX_REPLAY) {
          covered.value = latest;
          await reset(latest);
          return true;
        }
        await send(n.id, n.message);
        sent++;
      }
      return false;
    };
    // The notifications of the event that the id names, after its position.
    if (skip) {
      const [first] = await this.d.events.readFrom(skip.id, 1);
      if (first && BigInt(first.id) === skip.id && (await emit(this.notificationsFor(session, first).filter((_, i) => i + 1 > skip!.n)))) return;
    }
    let first = true;
    for (;;) {
      if (get?.closed) return;
      const page = await this.d.events.readAfter(cursor, 500);
      if (first && page.reset) {
        if (cursor > latest) covered.value = latest;
        await reset(cursor > latest ? latest : BigInt(head.oldestRetained ?? '1') - 1n);
        // Events ahead of the log cannot be replayed. A lost window can: from the oldest retained event.
        if (cursor > latest) return;
      }
      first = false;
      for (const e of page.events) if (await emit(this.notificationsFor(session, e))) return;
      cursor = BigInt(page.nextAfter);
      covered.value = cursor;
      if (!page.hasMore) break;
    }
  }

  /**
   * The notifications that one event makes for a session, in the order of the contract: by URI in byte order, then `list_changed`.
   * The position in this list is the `n` of the SSE id.
   */
  private notificationsFor(session: Session, e: EventRecord): Message[] {
    const { scopes } = session.who;
    // A session without `agent:investigate` sees an investigation event as an update of the incident (contract section 7.2).
    const view: EventRecord = e.kind.startsWith('investigation.') && !scopes.has('agent:investigate') ? { ...e, kind: 'incident.updated' } : e;
    const visible = canSee(scopes, e.kind);
    const uris = [...session.subs].filter(([, parsed]) => (parsed.type === 'events' ? visible : true) && eventMatches(parsed.type === 'events' ? e : view, parsed)).map(([uri]) => uri);
    uris.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const out: JSONRPCMessage[] = uris.map(uri => updated(uri, view));
    if (LIST_CHANGING.has(e.kind) && scopes.has('incidents:read')) out.push(listChanged(view));
    return out.map((message, i) => ({ id: `${e.id}.${i + 1}`, message }));
  }

  /** One event, for every session, in order. */
  private dispatch(e: EventRecord): void {
    void this.revalidate();
    for (const session of this.sessions.values()) {
      session.chain = session.chain.then(async () => {
        if (session.closed) return;
        session.dispatched = BigInt(e.id) > session.dispatched ? BigInt(e.id) : session.dispatched;
        if (session.replaying) {
          session.held.push(e);
          return;
        }
        for (const { id, message } of this.notificationsFor(session, e)) {
          const params = (message as { params: Record<string, unknown> }).params;
          session.liveIds.set(liveKey(e.id, params.uri as string | undefined), id);
          try {
            await session.mcp.server.notification({ method: (message as { method: string }).method, params } as never);
            this.d.metrics.eventSent(e.kind);
          } catch (error) {
            this.d.log('warn', 'mcp notification failed', { session: session.id, error: String(error) });
          } finally {
            session.liveIds.delete(liveKey(e.id, params.uri as string | undefined));
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
