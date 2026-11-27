import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { MemoryDiagnosisStore } from '../src/store.js';
import { SCOPES, bearerToken, checkBearer, parseTokens, tokensFromFile } from '../src/auth/scopes.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const engine = vi.hoisted(() => ({
  /** When set, a run waits for this promise (or for the abort) before it ends. */
  hold: undefined as Promise<void> | undefined,
  started: 0,
  aborted: 0,
  /** Events that the run emitted after its abort. */
  late: 0,
  /** When set, the run emits events after the abort, as the real engine does for its last ones. */
  afterAbort: false,
  /** How many evidence items the finished diagnosis has. */
  evidenceCount: 1,
  toolNames: [] as string[],
}));

vi.mock('../src/agent/engine.js', () => ({
  diagnose: vi.fn(async (opts: { id?: string; alert: any; source: string; host: string; tools: { list(): Promise<Array<{ name: string }>> }; signal?: AbortSignal; onEvent?: (e: unknown) => Promise<void> | void }) => {
    engine.started++;
    engine.toolNames = (await opts.tools.list()).map(t => t.name);
    // The real engine does not wait for its listener: a rejected promise from it reaches nobody.
    void opts.onEvent?.({ type: 'tool_start', id: 't1', tool: 'cluster_overview', reason: 'First look', args: {}, pack: false });
    void opts.onEvent?.({ type: 'tool_end', id: 't1', tool: 'cluster_overview', ok: true, summary: 'All nodes ready' });
    if (engine.hold) {
      await Promise.race([engine.hold, new Promise<void>(resolve => opts.signal?.addEventListener('abort', () => resolve(), { once: true }))]);
      if (opts.signal?.aborted) {
        engine.aborted++;
        if (engine.afterAbort) {
          await new Promise(resolve => setTimeout(resolve, 50));
          void opts.onEvent?.({ type: 'thought', text: 'A late thought' });
          void opts.onEvent?.({ type: 'tool_end', id: 't1', tool: 'cluster_overview', ok: true, summary: 'Late' });
          engine.late++;
        }
      }
    }
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-11-28T00:00:00.000Z',
      source: opts.source,
      host: opts.host,
      alert: opts.alert,
      evidence: Array.from({ length: engine.evidenceCount }, (_, i) => ({ id: `t${i + 1}`, tool: 'cluster_overview', reason: 'First look', summary: 'All nodes ready', ok: true })),
      toolCalls: 1,
      model: 'one/a',
      a2ui: [],
    };
    if (opts.signal?.aborted) return { ...base, status: 'failed', error: 'cancelled' };
    return {
      ...base,
      status: 'done',
      result: { summary: 'The node lost its network link.', likelyCause: 'A switch port flapped', confidence: 'medium', signals: [{ text: 'All nodes ready', evidence: ['t1'], holds: true }], fixes: [{ title: 'Check the switch', detail: 'Read the port counters.', recommended: true }], verify: 'The port counters stay flat.' },
    };
  }),
}));

const { startServer } = await import('../src/server.js');

const route = (id: string, models: string[]) => ({ id, style: 'openai' as const, baseUrl: 'http://127.0.0.1:1', apiKey: 'k', headers: {}, systemPrefix: '', models, maxTokens: 10, timeoutMs: 500 });

const GOOD = 'investigate-token-0123456789abcdef';
const READ_ONLY = 'readonly-token-0123456789abcdef';

let dir: string;
let store: MemoryDiagnosisStore;
let server: Awaited<ReturnType<typeof startServer>>;
const sockets: WebSocket[] = [];

async function start(maxSessions = 4, tokens: unknown = [
  { name: 'example-client', token: GOOD, scopes: [SCOPES.investigate] },
  { name: 'viewer', token: READ_ONLY, scopes: ['incidents:read'] },
], drainTimeoutMs = 20_000) {
  const file = join(dir, 'tokens.json');
  writeFileSync(file, JSON.stringify(tokens));
  const config = { ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent', dataDir: dir };
  config.models = { routes: [route('one', ['a', 'b'])], defaultModel: 'one/a', skipped: [] };
  config.acp = { maxSessions, tokensFile: file, drainTimeoutMs };
  server = await startServer(config, 'test', { store });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-acp-'));
  store = new MemoryDiagnosisStore();
  engine.hold = undefined;
  engine.started = 0;
  engine.aborted = 0;
  engine.late = 0;
  engine.afterAbort = false;
  engine.evidenceCount = 1;
  engine.toolNames = [];
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Rpc {
  socket: WebSocket;
  updates: any[];
  frames: string[];
  call(method: string, params?: unknown): Promise<any>;
  notify(method: string, params?: unknown): void;
  closed: Promise<number>;
}

/** Opens /acp with a bearer token. Resolves with a small JSON-RPC client that checks one message per text frame. */
function connect(token: string | null = GOOD, path = '/acp'): Promise<Rpc> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    sockets.push(socket);
    socket.on('error', () => undefined);
    const pending = new Map<number, (m: any) => void>();
    const updates: any[] = [];
    const frames: string[] = [];
    let id = 0;
    const closed = new Promise<number>(r => socket.once('close', code => r(code)));
    socket.on('message', (data, isBinary) => {
      expect(isBinary).toBe(false);
      const text = data.toString();
      frames.push(text);
      // One ACP message per frame: no newline inside, one JSON value.
      const message = JSON.parse(text);
      if (message.id !== undefined && pending.has(message.id)) pending.get(message.id)!(message);
      else if (message.method === 'session/update') updates.push(message.params);
    });
    socket.once('open', () =>
      resolve({
        socket,
        updates,
        frames,
        closed,
        call: (method, params) =>
          new Promise(res => {
            const n = ++id;
            pending.set(n, res);
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }));
          }),
        notify: (method, params) => socket.send(JSON.stringify({ jsonrpc: '2.0', method, params })),
      }),
    );
    socket.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, headers: res.headers })));
    socket.once('error', error => reject(error));
  });
}

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 500 && !(await check()); i++) await new Promise(r => setTimeout(r, 10));
  expect(await check()).toBe(true);
};

const init = async (rpc: Rpc) => {
  const initialised = await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const created = await rpc.call('session/new', { cwd: '/', mcpServers: [] });
  return { initialised, sessionId: created.result.sessionId as string };
};

const metric = (name: string) => fetch(`http://127.0.0.1:${server.port}/metrics`).then(r => r.text()).then(t => t.split('\n').filter(l => l.startsWith(name)));

describe('ACP over WebSocket', () => {
  it('runs initialize, session/new and a prompt, streams the updates and publishes the diagnosis', async () => {
    const logged: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...rest: any[]) => {
      logged.push(String(chunk));
      return write(chunk, ...rest);
    }) as typeof process.stdout.write);
    await start();
    const rpc = await connect();
    const { initialised, sessionId } = await init(rpc);
    expect(initialised.result.agentInfo.name).toBe('headlamp-agent');
    expect(initialised.result.agentCapabilities.loadSession).toBe(false);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const answer = await rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'NodeNotReady severity=critical node=w1' }] });
    expect(answer.result.stopReason).toBe('end_turn');

    const kinds = rpc.updates.map(u => u.update.sessionUpdate);
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_call_update');
    expect(kinds.filter(k => k === 'agent_message_chunk').length).toBeGreaterThanOrEqual(2);
    const text = rpc.updates.filter(u => u.update.sessionUpdate === 'agent_message_chunk' && u.update.content.type === 'text').map(u => u.update.content.text).join('');
    expect(text).toContain('A switch port flapped');
    expect(text, text).toContain('Published to Headlamp');
    // Every frame is one JSON message with no line break inside.
    for (const frame of rpc.frames) expect(frame).not.toContain('\n');

    // The result is in the diagnosis store, so Headlamp shows it.
    const stored = await store.get('11111111-1111-4111-8111-111111111111');
    expect(stored?.published).toBe(true);
    expect(stored?.source).toBe('acp');
    expect(stored?.status).toBe('done');
    expect(stored?.alert.name).toBe('NodeNotReady');
    // The name of the token is on the diagnosis and in the prompt logs. The token is in neither.
    expect(stored?.client).toBe('example-client');
    spy.mockRestore();
    const promptLogs = logged.filter(l => l.includes('acp prompt'));
    expect(promptLogs.length).toBe(2);
    for (const line of promptLogs) expect(line).toContain('"client":"example-client"');
    expect(logged.join('')).not.toContain(GOOD);
    expect(stored?.result?.likelyCause).toBe('A switch port flapped');
    // The tools came from the in-process registry: no MCP URL was given.
    expect(engine.toolNames).toContain('cluster_overview');
    expect(engine.toolNames).not.toContain('list_diagnoses');

    const prompts = await metric('headlamp_agent_acp_prompts_total');
    expect(prompts).toContain('headlamp_agent_acp_prompts_total{result="ok"} 1');
    expect(await metric('headlamp_agent_acp_sessions')).toContain('headlamp_agent_acp_sessions 1');
    rpc.socket.close();
    await rpc.closed;
    await until(async () => (await metric('headlamp_agent_acp_sessions')).includes('headlamp_agent_acp_sessions 0'));
  });

  it('refuses the upgrade without a token, with a wrong token and without the scope, and counts each', async () => {
    await start();
    await expect(connect(null)).rejects.toMatchObject({ status: 401 });
    await expect(connect('not-a-known-token-0123456789')).rejects.toMatchObject({ status: 401 });
    await expect(connect(READ_ONLY)).rejects.toMatchObject({ status: 403 });
    const failures = await metric('headlamp_agent_acp_auth_failures_total');
    expect(failures).toContain('headlamp_agent_acp_auth_failures_total{reason="missing"} 1');
    expect(failures).toContain('headlamp_agent_acp_auth_failures_total{reason="invalid"} 1');
    expect(failures).toContain('headlamp_agent_acp_auth_failures_total{reason="scope"} 1');
    expect(engine.started).toBe(0);
    const refused = await connect(null).catch(e => e);
    expect(refused.headers['www-authenticate']).toMatch(/^Bearer/);
  });

  it('refuses every upgrade when no token is configured', async () => {
    await start(4, []);
    await expect(connect(GOOD)).rejects.toMatchObject({ status: 401 });
    expect(await metric('headlamp_agent_acp_auth_failures_total')).toContain('headlamp_agent_acp_auth_failures_total{reason="unconfigured"} 1');
  });

  it('refuses a browser origin that is not allowed', async () => {
    await start();
    const refused = await new Promise<number>(resolve => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/acp`, { headers: { authorization: `Bearer ${GOOD}`, origin: 'https://evil.example.com' } });
      sockets.push(socket);
      socket.on('error', () => undefined);
      socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      socket.once('open', () => resolve(101));
    });
    expect(refused).toBe(403);
  });

  it('answers a plain GET with 426 and any other upgrade path with 404', async () => {
    await start();
    const res = await fetch(`http://127.0.0.1:${server.port}/acp`);
    expect(res.status).toBe(426);
    await expect(connect(GOOD, '/other')).rejects.toMatchObject({ status: 404 });
  });

  it('cancels a prompt: session/cancel ends the run with stopReason cancelled', async () => {
    await start();
    engine.hold = new Promise<void>(() => undefined);
    const rpc = await connect();
    const { sessionId } = await init(rpc);
    const prompt = rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'NodeNotReady node=w1' }] });
    await until(() => engine.started === 1 && rpc.updates.some(u => u.update.sessionUpdate === 'tool_call_update'));
    rpc.notify('session/cancel', { sessionId });
    const answer = await prompt;
    expect(answer.result.stopReason).toBe('cancelled');
    expect(engine.aborted).toBe(1);
    // A cancelled run publishes nothing.
    expect(await store.get('11111111-1111-4111-8111-111111111111')).toBeUndefined();
    expect(await metric('headlamp_agent_acp_prompts_total')).toContain('headlamp_agent_acp_prompts_total{result="cancelled"} 1');
  });

  it('aborts the run and frees the session when the socket closes', async () => {
    await start(1);
    engine.hold = new Promise<void>(() => undefined);
    const first = await connect();
    const { sessionId } = await init(first);
    void first.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'NodeNotReady node=w1' }] });
    await until(() => engine.started === 1);
    expect(await metric('headlamp_agent_acp_sessions')).toContain('headlamp_agent_acp_sessions 1');
    first.socket.terminate();
    await until(() => engine.aborted === 1);
    await until(async () => (await metric('headlamp_agent_acp_sessions')).includes('headlamp_agent_acp_sessions 0'));
    // The place is free again.
    engine.hold = undefined;
    const second = await connect();
    expect((await init(second)).sessionId).toBeTruthy();
  });

  it('limits the open sessions: the upgrade past the limit gets 503, and session/new past the limit fails', async () => {
    await start(2);
    const a = await connect();
    const b = await connect();
    await expect(connect()).rejects.toMatchObject({ status: 503 });
    expect((await init(a)).sessionId).toBeTruthy();
    expect((await init(b)).sessionId).toBeTruthy();
    // A second session on one socket needs a place too.
    const third = await a.call('session/new', { cwd: '/', mcpServers: [] });
    expect(third.error.message).toContain('Too many ACP sessions');
    b.socket.close();
    await b.closed;
    await until(async () => (await metric('headlamp_agent_acp_connections')).includes('headlamp_agent_acp_connections 1'));
    const again = await a.call('session/new', { cwd: '/', mcpServers: [] });
    expect(again.result.sessionId).toBeTruthy();
    expect(await metric('headlamp_agent_acp_errors_total')).toContain('headlamp_agent_acp_errors_total{kind="limit"} 2');
  });

  it('answers a bad frame with a JSON-RPC error and keeps the socket open', async () => {
    await start();
    const rpc = await connect();
    const reply = new Promise<any>(resolve => rpc.socket.once('message', data => resolve(JSON.parse(data.toString()))));
    rpc.socket.send('{not json');
    expect((await reply).error.code).toBe(-32700);
    const batch = new Promise<any>(resolve => rpc.socket.once('message', data => resolve(JSON.parse(data.toString()))));
    rpc.socket.send('[]');
    expect((await batch).error.code).toBe(-32600);
    expect((await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: {} })).result.agentInfo.name).toBe('headlamp-agent');
    expect(await metric('headlamp_agent_acp_errors_total')).toContain('headlamp_agent_acp_errors_total{kind="protocol"} 2');
  });

  it('turns the endpoint off with a limit of 0', async () => {
    await start(0);
    await expect(connect()).rejects.toMatchObject({ status: 404 });
  });

  it('survives a late update after the client closed the socket', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      await start(1);
      engine.hold = new Promise<void>(() => undefined);
      engine.afterAbort = true;
      const rpc = await connect();
      const { sessionId } = await init(rpc);
      void rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'NodeNotReady node=w1' }] });
      await until(() => engine.started === 1);
      rpc.socket.terminate();
      await until(() => engine.late === 1);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(rejections).toEqual([]);
      // The place is free after the run ended, and the endpoint still serves.
      await until(async () => (await metric('headlamp_agent_acp_sessions')).includes('headlamp_agent_acp_sessions 0'));
      expect((await init(await connect())).sessionId).toBeTruthy();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('refuses a second prompt while one runs in the session, and takes a new one when it ends', async () => {
    await start();
    let release!: () => void;
    engine.hold = new Promise<void>(resolve => (release = resolve));
    const rpc = await connect();
    const { sessionId } = await init(rpc);
    const first = rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'NodeNotReady node=w1' }] });
    await until(() => engine.started === 1);
    const second = await rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'NodeNotReady node=w2' }] });
    expect(second.error.message).toContain('already running');
    // The refused prompt did not take the slot of the first one, nor start a run.
    expect(engine.started).toBe(1);
    release();
    expect((await first).result.stopReason).toBe('end_turn');
    engine.hold = undefined;
    const third = await rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'NodeNotReady node=w3' }] });
    expect(third.result.stopReason).toBe('end_turn');
    expect(engine.started).toBe(2);
  });

  it('keeps the session place until its run has ended after the socket closed', async () => {
    await start(1);
    engine.hold = new Promise<void>(() => undefined);
    engine.afterAbort = true;
    const rpc = await connect();
    const { sessionId } = await init(rpc);
    void rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'NodeNotReady node=w1' }] });
    await until(() => engine.started === 1);
    rpc.socket.terminate();
    await until(() => engine.aborted === 1);
    // The run is still ending (it emits its late events for 50 ms), so the place is not free yet.
    expect(await metric('headlamp_agent_acp_sessions')).toContain('headlamp_agent_acp_sessions 1');
    await until(() => engine.late === 1);
    await until(async () => (await metric('headlamp_agent_acp_sessions')).includes('headlamp_agent_acp_sessions 0'));
  });

  it('lets a prompt in flight finish and writes its answer before it closes the socket on a drain', async () => {
    await start();
    let release!: () => void;
    engine.hold = new Promise<void>(resolve => (release = resolve));
    const rpc = await connect();
    const { sessionId } = await init(rpc);
    const order: string[] = [];
    rpc.socket.on('message', data => {
      if (JSON.parse(data.toString()).result?.stopReason) order.push('answer');
    });
    void rpc.closed.then(() => order.push('close'));
    const prompt = rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'NodeNotReady node=w1' }] });
    await until(() => engine.started === 1);
    const closing = server.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(rpc.socket.readyState).toBe(WebSocket.OPEN);
    release();
    expect((await prompt).result.stopReason).toBe('end_turn');
    expect(await rpc.closed).toBe(1001);
    await closing;
    expect(order).toEqual(['answer', 'close']);
    // The finished run was published.
    expect((await store.get('11111111-1111-4111-8111-111111111111'))?.status).toBe('done');
  });

  it('refuses a prompt that comes during a drain', async () => {
    await start();
    let release!: () => void;
    engine.hold = new Promise<void>(resolve => (release = resolve));
    const rpc = await connect();
    const { sessionId } = await init(rpc);
    const other = (await rpc.call('session/new', { cwd: '/', mcpServers: [] })).result.sessionId as string;
    const prompt = rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'NodeNotReady node=w1' }] });
    await until(() => engine.started === 1);
    const closing = server.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    const refused = await rpc.call('session/prompt', { sessionId: other, prompt: [{ type: 'text', text: 'NodeNotReady node=w2' }] });
    expect(refused.error.message).toContain('draining');
    expect(engine.started).toBe(1);
    // The refused prompt does not close the socket before the first one has its answer.
    expect(rpc.socket.readyState).toBe(WebSocket.OPEN);
    release();
    expect((await prompt).result.stopReason).toBe('end_turn');
    expect(await rpc.closed).toBe(1001);
    await closing;
  });

  it('keeps the socket open for a prompt in flight when a second request reuses its id', async () => {
    await start();
    let release!: () => void;
    engine.hold = new Promise<void>(resolve => (release = resolve));
    const rpc = await connect();
    const { sessionId } = await init(rpc);
    const other = (await rpc.call('session/new', { cwd: '/', mcpServers: [] })).result.sessionId as string;
    const answers: any[] = [];
    rpc.socket.on('message', data => {
      const m = JSON.parse(data.toString());
      if (m.id === 900) answers.push(m);
    });
    const send = (session: string) => rpc.socket.send(JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'session/prompt', params: { sessionId: session, prompt: [{ type: 'text', text: 'NodeNotReady node=w1' }] } }));
    send(sessionId);
    await until(() => engine.started === 1);
    const closing = server.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    // The same id again: the drain refuses it. Its error answer must not close the socket.
    send(other);
    await until(() => answers.length === 1);
    expect(answers[0].error.message).toContain('draining');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(rpc.socket.readyState).toBe(WebSocket.OPEN);
    release();
    await until(() => answers.length === 2);
    expect(answers[1].result.stopReason).toBe('end_turn');
    expect(await rpc.closed).toBe(1001);
    await closing;
  });

  it('aborts the runs that remain when the drain limit passes', async () => {
    await start(4, undefined, 100);
    engine.hold = new Promise<void>(() => undefined);
    const rpc = await connect();
    const { sessionId } = await init(rpc);
    void rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'NodeNotReady node=w1' }] });
    await until(() => engine.started === 1);
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(engine.aborted).toBe(1);
    expect(await rpc.closed).toBe(1001);
  });

  it('keeps a long run: evidence past the limit of the schema is cut, not lost', async () => {
    await start();
    engine.evidenceCount = 61;
    const rpc = await connect();
    const { sessionId } = await init(rpc);
    const answer = await rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'NodeNotReady node=w1' }] });
    expect(answer.result.stopReason).toBe('end_turn');
    const text = rpc.updates.filter(u => u.update.sessionUpdate === 'agent_message_chunk' && u.update.content.type === 'text').map(u => u.update.content.text).join('');
    expect(text).toContain('Published to Headlamp');
    const stored = await store.get('11111111-1111-4111-8111-111111111111');
    expect(stored?.status).toBe('done');
    expect(stored?.result?.likelyCause).toBe('A switch port flapped');
    expect(stored?.evidence.length).toBe(60);
    // The item that the result cites stays.
    expect(stored?.evidence.some(e => e.id === 't1')).toBe(true);
  });

  it('closes an idle connection with code 1001 when the agent drains', async () => {
    await start();
    const rpc = await connect();
    await init(rpc);
    const code = rpc.closed;
    await server.close();
    expect(await code).toBe(1001);
  });
});

describe('scoped tokens', () => {
  it('warns about each dropped entry by name and never shows a token', () => {
    const secret = 'secret-value-that-must-not-be-logged';
    const warnings: string[] = [];
    const entries = parseTokens(
      [{ name: 'good', token: GOOD, scopes: [SCOPES.investigate] }, { name: 'short', token: 'abc', scopes: ['x'] }, { name: 'noscope', token: secret, scopes: [] }, { token: secret, scopes: ['x'] }, 'junk'],
      message => warnings.push(message),
    );
    expect(entries.map(e => e.name)).toEqual(['good']);
    expect(warnings.length).toBe(4);
    expect(warnings.some(w => w.includes('"short"'))).toBe(true);
    expect(warnings.some(w => w.includes('"noscope"'))).toBe(true);
    expect(warnings.some(w => w.includes('#4'))).toBe(true);
    expect(warnings.join('\n')).not.toContain(secret);
    expect(warnings.join('\n')).not.toContain('abc');
    // A bad entry still denies access.
    expect(checkBearer(entries, `Bearer ${secret}`, 'x')).toMatchObject({ ok: false, status: 401 });
  });

  it('warns once about a token file that cannot be read, and refuses every request', () => {
    const file = join(dir, 'broken.json');
    writeFileSync(file, '{not json');
    const warnings: string[] = [];
    const read = tokensFromFile(file, message => warnings.push(message));
    expect(read()).toEqual([]);
    expect(read()).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(tokensFromFile(join(dir, 'missing.json'), message => warnings.push(message))()).toEqual([]);
    expect(warnings.length).toBe(2);
  });

  it('reads a bearer header, a plain token and a SHA-256 entry', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer   abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
    const hash = '2fc9f4c1c2b0f4d9a7f5a8a1b9b2c7d3e6a0b1c2d3e4f5061728394a5b6c7d8e';
    const entries = parseTokens({ tokens: [{ name: 'a', token: GOOD, scopes: [SCOPES.investigate] }, { name: 'b', sha256: hash, scopes: ['x'] }, { name: 'short', token: 'abc', scopes: ['x'] }, { name: 'noscope', token: GOOD + '1', scopes: [] }, 'junk'] });
    expect(entries.map(e => e.name)).toEqual(['a', 'b']);
    expect(checkBearer(entries, `Bearer ${GOOD}`, SCOPES.investigate)).toMatchObject({ ok: true, name: 'a' });
    expect(checkBearer(entries, `Bearer ${GOOD}`, 'other')).toMatchObject({ ok: false, status: 403 });
    expect(checkBearer(entries, 'Bearer nope', SCOPES.investigate)).toMatchObject({ ok: false, status: 401, reason: 'invalid' });
    expect(checkBearer([], `Bearer ${GOOD}`, SCOPES.investigate)).toMatchObject({ ok: false, status: 401, reason: 'unconfigured' });
  });
});
