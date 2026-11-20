import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * A fake T3 server: HTTP routes, the ticket route and a WebSocket endpoint that speaks
 * the Effect RPC frames of SPEC.md. It checks the same things the real server checks
 * (bearer token, protocol header, ticket, query parameters) so a client bug shows here.
 */
export interface FakeThread {
  projection: {
    thread: Record<string, unknown>;
    runs: Array<Record<string, unknown>>;
    messages: Array<Record<string, unknown>>;
    turnItems: Array<Record<string, unknown>>;
    runtimeRequests: Array<Record<string, unknown>>;
  };
}

export interface FakeT3 {
  url: string;
  token: string;
  threads: Map<string, FakeThread>;
  /** Every JSON frame the clients sent over the WebSocket. */
  frames: Array<Record<string, unknown>>;
  /** HTTP requests: method, path, headers. */
  requests: Array<{ method: string; path: string; headers: IncomingMessage['headers'] }>;
  /** WebSocket upgrade URLs, with the ticket replaced. */
  upgrades: string[];
  /** When set, thread reads answer with this status. */
  readStatus?: number;
  /** When set, RPC calls fail with a Die defect. */
  rpcDie?: string;
  /** When true, launchThread creates the thread and then answers with a failure, like a lost answer. */
  failAfterCreate?: boolean;
  /** When true, a message does not create a run at once, like a server that is slow to start it. */
  slowRun?: boolean;
  connections: number;
  close(): Promise<void>;
}

function frameText(text: string): Buffer {
  const body = Buffer.from(text);
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), Buffer.alloc(4), Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])]);
  return Buffer.concat([head, body]);
}

/** Reads complete client frames (always masked) out of `buf`. Returns the texts and the rest. */
function readFrames(buf: Buffer): { texts: string[]; rest: Buffer; close: boolean } {
  const texts: string[] = [];
  let close = false;
  let off = 0;
  while (buf.length - off >= 2) {
    const opcode = buf[off] & 15;
    let len = buf[off + 1] & 127;
    let pos = off + 2;
    if (len === 126) {
      if (buf.length - off < 4) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buf.length - off < 10) break;
      len = Number(buf.readBigUInt64BE(pos));
      pos += 8;
    }
    if (buf.length < pos + 4 + len) break;
    const mask = buf.subarray(pos, pos + 4);
    const data = Buffer.from(buf.subarray(pos + 4, pos + 4 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    if (opcode === 8) close = true;
    else if (opcode === 1) texts.push(data.toString('utf8'));
    off = pos + 4 + len;
  }
  return { texts, rest: buf.subarray(off), close };
}

export function sampleThread(threadId: string, extra: Partial<FakeThread['projection']> = {}): FakeThread {
  return {
    projection: {
      thread: { id: threadId, title: 'x', modelSelection: { instanceId: 'pool', model: 'm' }, runtimeMode: 'full-access', interactionMode: 'default', deletedAt: null, archivedAt: null },
      runs: [],
      messages: [],
      turnItems: [],
      runtimeRequests: [],
      ...extra,
    },
  };
}

export async function startFakeT3(token = 'fake-bearer-value'): Promise<FakeT3> {
  const fake: FakeT3 = { url: '', token, threads: new Map(), frames: [], requests: [], upgrades: [], connections: 0, close: async () => undefined };
  const tickets = new Set<string>();
  let ticketSeq = 0;
  const sockets = new Set<Duplex>();
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    fake.requests.push({ method: req.method ?? 'GET', path, headers: req.headers });
    if (req.headers.authorization !== `Bearer ${fake.token}`) return json(res, 401, { _tag: 'EnvironmentAuthInvalidError', code: 'auth_invalid', reason: 'missing_credential' });
    if (path === '/api/auth/websocket-ticket/rpc' && req.method === 'POST') {
      const ticket = `ticket-${++ticketSeq}`;
      tickets.add(ticket);
      return json(res, 200, { ticket, expiresAt: '2026-11-20T06:56:16.100Z' });
    }
    const m = /^\/api\/orchestration\/threads\/([^/]+)$/.exec(path);
    if (m && req.method === 'GET') {
      if (req.headers['x-t3-orchestration-protocol'] !== '2') return json(res, 400, { code: 'orchestration_protocol_incompatible' });
      if (fake.readStatus) return json(res, fake.readStatus, { _tag: 'Environment error', code: 'boom' });
      const t = fake.threads.get(decodeURIComponent(m[1]));
      if (!t) return json(res, 404, { _tag: 'EnvironmentNotFoundError', code: 'thread_not_found' });
      return json(res, 200, { snapshotSequence: 1, projection: t.projection });
    }
    json(res, 404, { code: 'not_found' });
  });

  server.on('upgrade', (req, socket) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const ticket = u.searchParams.get('wsTicket') ?? '';
    fake.upgrades.push(`${u.pathname}?${[...u.searchParams].map(([k, v]) => `${k}=${k === 'wsTicket' ? '<ticket>' : v}`).join('&')}`);
    if (u.searchParams.get('orchestrationProtocol') !== '2' || !u.searchParams.get('clientCapabilities')) {
      socket.end('HTTP/1.1 426 Upgrade Required\r\ncontent-type: application/json\r\n\r\n{"code":"orchestration_protocol_incompatible"}');
      return;
    }
    if (!tickets.delete(ticket)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    fake.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (m: unknown) => socket.write(frameText(JSON.stringify(m)));
    // The real server pings on an interval. Ping once, shortly after the upgrade answer.
    setTimeout(() => !socket.destroyed && send({ _tag: 'Ping' }), 5);
    let buf = Buffer.alloc(0);
    socket.on('error', () => undefined);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      const { texts, rest, close } = readFrames(buf);
      buf = Buffer.from(rest);
      if (close) socket.end();
      for (const text of texts) {
        const frame = JSON.parse(text) as Record<string, unknown>;
        fake.frames.push(frame);
        if (frame._tag !== 'Request') continue;
        const id = String(frame.id);
        const payload = frame.payload as Record<string, unknown>;
        const fail = (defect: string) => send({ _tag: 'Exit', requestId: id, exit: { _tag: 'Failure', cause: [{ _tag: 'Die', defect }] } });
        if (fake.rpcDie) return fail(fake.rpcDie);
        if (frame.tag === 'orchestration.launchThread') {
          const required = ['commandId', 'creationSource', 'threadId', 'projectId', 'title', 'generateTitle', 'modelSelection', 'runtimeMode', 'interactionMode', 'workspaceStrategy', 'initialMessage'];
          const missing = required.filter(k => !(k in payload));
          if (missing.length) return fail(`Expected launchThread, missing ${missing.join(', ')}`);
          const threadId = String(payload.threadId);
          const initial = payload.initialMessage as { messageId: string; text: string };
          const t = sampleThread(threadId);
          t.projection.thread.title = payload.title;
          t.projection.thread.modelSelection = payload.modelSelection;
          t.projection.runs.push({ id: `${threadId}-run1`, ordinal: 1, status: 'running', requestedAt: '2026-11-20T07:00:00.000Z', startedAt: '2026-11-20T07:00:01.000Z', completedAt: null });
          t.projection.messages.push({ id: initial.messageId, role: 'user', text: initial.text, streaming: false, createdAt: '2026-11-20T07:00:00.000Z', runId: `${threadId}-run1` });
          fake.threads.set(threadId, t);
          if (fake.failAfterCreate) return fail('connection lost after the thread was created');
          return send({ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: { threadId, projection: t.projection, resumed: false, sequence: 10 } } });
        }
        if (frame.tag === 'orchestration.dispatchCommand') {
          if ('command' in payload || payload.type !== 'message.dispatch') return fail('Expected the bare command object');
          const t = fake.threads.get(String(payload.threadId));
          if (!t) return fail('thread not found');
          if (fake.slowRun) return send({ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: { sequence: 11 } } });
          const n = t.projection.runs.length + 1;
          t.projection.messages.push({ id: payload.messageId, role: 'user', text: payload.text, streaming: false, createdAt: '2026-11-20T07:10:00.000Z', runId: `${payload.threadId}-run${n}` });
          t.projection.runs.push({ id: `${payload.threadId}-run${n}`, ordinal: n, status: 'running', requestedAt: '2026-11-20T07:10:00.000Z', startedAt: '2026-11-20T07:10:01.000Z', completedAt: null });
          return send({ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: { sequence: 11 } } });
        }
        fail(`Unknown tag ${String(frame.tag)}`);
      }
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  fake.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  fake.close = async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  return fake;
}
