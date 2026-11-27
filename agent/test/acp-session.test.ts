import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createAcpApp, type AcpDeps } from '../src/acp.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const run = vi.hoisted(() => ({ started: 0, aborted: 0, hold: undefined as Promise<void> | undefined }));

vi.mock('../src/agent/engine.js', () => ({
  diagnose: vi.fn(async (opts: { alert: any; source: string; host: string; signal?: AbortSignal; onEvent?: (e: unknown) => unknown }) => {
    run.started++;
    void opts.onEvent?.({ type: 'thought', text: 'Looking' });
    await Promise.race([run.hold, new Promise<void>(resolve => opts.signal?.addEventListener('abort', () => resolve(), { once: true }))]);
    if (opts.signal?.aborted) run.aborted++;
    return {
      id: '22222222-2222-4222-8222-222222222222',
      createdAt: '2026-11-28T00:00:00.000Z',
      source: opts.source,
      host: opts.host,
      alert: opts.alert,
      status: 'failed',
      error: 'cancelled',
      evidence: [],
      toolCalls: 0,
      model: 'one/a',
      a2ui: [],
    };
  }),
}));

type Rpc = { call(method: string, params: unknown): Promise<any>; close(): void; updates: any[] };

/** Connects the ACP app to an in-memory stream pair and returns a small JSON-RPC client. */
function harness(deps: Partial<AcpDeps> = {}) {
  const config = loadConfig({} as NodeJS.ProcessEnv);
  config.models = { routes: [{ id: 'one', style: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', headers: {}, systemPrefix: '', models: ['a'], maxTokens: 10, timeoutMs: 500 }], defaultModel: 'one/a', skipped: [] };
  const catalogue = { configured: false, defaultOrder: [], open: async () => ({ name: 'one/a', complete: async () => undefined }) } as any;
  const released: string[] = [];
  let acquired = 0;
  const { app, dispose } = createAcpApp({
    config,
    catalogue,
    log: () => undefined,
    tools: { list: async () => [], call: async () => ({ ok: true, summary: '', data: {} }) },
    publish: async () => undefined,
    hooks: { acquireSession: () => { const n = ++acquired; return () => released.push(`s${n}`); } },
    ...deps,
  });
  let inbound!: ReadableStreamDefaultController<any>;
  const readable = new ReadableStream<any>({ start: c => void (inbound = c) });
  const pending = new Map<number, (m: any) => void>();
  const updates: any[] = [];
  const writable = new WritableStream<any>({
    write: message => {
      if (message.id !== undefined && pending.has(message.id)) pending.get(message.id)!(message);
      else if (message.method === 'session/update') updates.push(message.params);
    },
  });
  app.connect({ readable, writable } as any);
  let id = 0;
  const ready = new Promise<void>(resolve => {
    pending.set(0, () => resolve());
    inbound.enqueue({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
  });
  const rpc: Rpc = {
    updates,
    call: (method, params) => ready.then(() => new Promise<any>(resolve => {
      const n = ++id;
      pending.set(n, resolve);
      inbound.enqueue({ jsonrpc: '2.0', id: n, method, params });
    })),
    close: () => inbound.close(),
  };
  return { rpc, dispose, released };
}

const prompt = (sessionId: string, text = 'NodeNotReady node=w1') => ({ sessionId, prompt: [{ type: 'text', text }] });
const until = async (check: () => boolean) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe('ACP session lifecycle', () => {
  it('frees the place of a session at once when no run is in flight', async () => {
    const { rpc, dispose, released } = harness();
    await rpc.call('session/new', { cwd: '/', mcpServers: [] });
    dispose();
    dispose();
    expect(released).toEqual(['s1']);
  });

  it('frees the place of a session with a run only when the run has ended', async () => {
    run.started = 0;
    run.aborted = 0;
    run.hold = new Promise<void>(() => undefined);
    const { rpc, dispose, released } = harness();
    const { result } = await rpc.call('session/new', { cwd: '/', mcpServers: [] });
    void rpc.call('session/prompt', prompt(result.sessionId));
    await until(() => run.started === 1);
    dispose();
    await until(() => run.aborted === 1);
    await until(() => released.length === 1);
    expect(released).toEqual(['s1']);
  });

  it('stops a prompt whose connection closed while the model was opened, and starts no run', async () => {
    run.started = 0;
    let finish!: (model: unknown) => void;
    const opening = new Promise<unknown>(resolve => (finish = resolve));
    const { rpc, dispose, released } = harness({ catalogue: { configured: false, defaultOrder: [], open: () => opening } as any });
    const { result } = await rpc.call('session/new', { cwd: '/', mcpServers: [] });
    const answer = rpc.call('session/prompt', prompt(result.sessionId));
    await new Promise(r => setTimeout(r, 30));
    dispose();
    // The session is gone: the open finishes later and nothing runs.
    finish({ name: 'one/a', complete: async () => undefined });
    expect((await answer).result.stopReason).toBe('cancelled');
    expect(run.started).toBe(0);
    await until(() => released.length === 1);
  });

  it('refuses a prompt that comes while the model of the first one is still opening', async () => {
    run.started = 0;
    let finish!: (model: unknown) => void;
    const opening = new Promise<unknown>(resolve => (finish = resolve));
    run.hold = undefined;
    const { rpc } = harness({ catalogue: { configured: false, defaultOrder: [], open: () => opening } as any });
    const { result } = await rpc.call('session/new', { cwd: '/', mcpServers: [] });
    const first = rpc.call('session/prompt', prompt(result.sessionId));
    await new Promise(r => setTimeout(r, 30));
    const second = await rpc.call('session/prompt', prompt(result.sessionId));
    expect(second.error.message).toContain('already running');
    finish({ name: 'one/a', complete: async () => undefined });
    expect((await first).result).toBeDefined();
    expect(run.started).toBe(1);
  });

  it('frees a session that finishes opening after the connection closed', async () => {
    let finish!: (model: unknown) => void;
    const slow = new Promise<unknown>(resolve => (finish = resolve));
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const catalogue = { configured: true, defaultOrder: [], defaultModel: 'one/a', list: async () => { await slow; return []; } } as any;
    const { rpc, dispose, released } = harness({ config, catalogue });
    const created = rpc.call('session/new', { cwd: '/', mcpServers: [] });
    await new Promise(r => setTimeout(r, 30));
    dispose();
    finish(undefined);
    expect((await created).error).toBeDefined();
    expect(released).toEqual(['s1']);
  });
});
