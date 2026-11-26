import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from '../src/agent/chat.js';
import { ModelCatalogue, COOLDOWN_MS, PREVIOUS_DEFAULTS } from '../src/agent/catalogue.js';
import { diagnose } from '../src/agent/engine.js';
import { classifyUsageFailure } from '../src/agent/fallback.js';
import { GATEWAY_ERROR_HEADER, ModelHttpError, ModelStreamError, parseRetryAfter, type CompleteRequest } from '../src/agent/model.js';
import { ChatStore } from '../src/chats.js';
import { loadConfig, loadModelRoutes, type ModelRoute, type ModelRoutesConfig } from '../src/config.js';
import { Metrics } from '../src/metrics.js';
import { startServer } from '../src/server.js';
import { MemoryDiagnosisStore } from '../src/store.js';

const realFetch = globalThis.fetch;
const env = (extra: Record<string, string>) => extra as NodeJS.ProcessEnv;
const route = (id: string): ModelRoute => ({ id, style: 'openai', baseUrl: `http://gw.invalid/${id}`, apiKey: `key-${id}`, headers: {}, systemPrefix: '', maxTokens: 100, timeoutMs: 1000 });
const req: CompleteRequest = { system: 's', messages: [{ role: 'user', text: 'hi' }], tools: [], session: 'x' };

const ORDER = ['grok/g', 'qwen/q', 'glm/z', 'astra/a'];
const cfg = (order = ORDER, skipped: string[] = []): ModelRoutesConfig => ({
  routes: ['grok', 'qwen', 'glm', 'astra'].filter(r => !skipped.includes(r)).map(route),
  defaultModel: order[0]!,
  defaultOrder: order,
  skipped,
});

/** One scripted answer per route. A function answers each call in turn. */
type Answer = Response | (() => Response);
const gateway = { answers: {} as Record<string, Answer[]>, hits: [] as string[] };
const ok = (text = 'ok', calls: Array<{ name: string }> = []) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: text, tool_calls: calls.map((c, i) => ({ id: `c${i}`, type: 'function', function: { name: c.name, arguments: '{}' } })) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
      usage: {},
    }),
    { status: 200 },
  );
const fail = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

function stubGateway(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const m = /^http:\/\/gw\.invalid\/([a-z]+)\/(.*)$/.exec(url);
    if (!m) return realFetch(input as string, init);
    if (m[2] === 'models') return new Response('nope', { status: 500 });
    gateway.hits.push(m[1]!);
    const queue = gateway.answers[m[1]!] ?? [];
    const next = queue.length > 1 ? queue.shift()! : (queue[0] ?? ok());
    return typeof next === 'function' ? next() : next.clone();
  });
}

beforeEach(() => {
  gateway.answers = {};
  gateway.hits = [];
  stubGateway();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('AGENT_MODEL list', () => {
  const routes = JSON.stringify(['grok', 'qwen', 'glm', 'astra'].map(id => ({ id, style: 'openai', urlEnv: `AIS_GATEWAY_${id.toUpperCase()}_URL`, tokenEnv: `AIS_GATEWAY_${id.toUpperCase()}_TOKEN` })));
  const creds = Object.fromEntries(['GROK', 'QWEN', 'GLM', 'ASTRA'].flatMap(r => [[`AIS_GATEWAY_${r}_URL`, `https://gw.example.com/${r}`], [`AIS_GATEWAY_${r}_TOKEN`, 't']]));

  it('reads an ordered, comma-separated list and keeps the first as the default', () => {
    const c = loadModelRoutes(env({ AGENT_MODEL_ROUTES: routes, AGENT_MODEL: ' grok/grok-4.7, qwen/qwen4-max ,glm/glm-5.4,astra/gpt-6.2-astra', ...creds }));
    expect(c.defaultOrder).toEqual(['grok/grok-4.7', 'qwen/qwen4-max', 'glm/glm-5.4', 'astra/gpt-6.2-astra']);
    expect(c.defaultModel).toBe('grok/grok-4.7');
  });

  it('keeps a single value working, also a bare model id', () => {
    expect(loadModelRoutes(env({ AGENT_MODEL_ROUTES: routes, AGENT_MODEL: 'grok/grok-4.7', ...creds })).defaultOrder).toEqual(['grok/grok-4.7']);
    const legacy = loadModelRoutes(env({ AIS_GATEWAY_URL: 'https://gw.example.com', AIS_GATEWAY_TOKEN: 't', AGENT_MODEL: 'glm-5.3' }));
    expect(legacy.defaultModel).toBe('glm-5.3');
    expect(legacy.defaultOrder).toEqual(['glm-5.3']);
    expect(loadModelRoutes(env({})).defaultOrder).toEqual([]);
  });

  it('throws for an unknown route, a bare entry in a list and a repeated entry', () => {
    expect(() => loadModelRoutes(env({ AGENT_MODEL_ROUTES: routes, AGENT_MODEL: 'grok/a,nope/b', ...creds }))).toThrow(/unknown route "nope"/);
    expect(() => loadModelRoutes(env({ AGENT_MODEL_ROUTES: routes, AGENT_MODEL: 'grok/a,plain', ...creds }))).toThrow(/<route>\/<model>/);
    expect(() => loadModelRoutes(env({ AGENT_MODEL_ROUTES: routes, AGENT_MODEL: 'grok/a,grok/a', ...creds }))).toThrow(/twice/);
  });

  it('accepts a route with no credentials, so the run can skip it', () => {
    const { AIS_GATEWAY_QWEN_TOKEN: _t, ...rest } = creds;
    const c = loadModelRoutes(env({ AGENT_MODEL_ROUTES: routes, AGENT_MODEL: 'grok/a,qwen/b', ...rest }));
    expect(c.skipped).toEqual(['qwen']);
    expect(c.defaultOrder).toEqual(['grok/a', 'qwen/b']);
  });
});

describe('usage failure detection', () => {
  const http = (status: number, body: unknown, retryAfterMs?: number, headers: Record<string, string> = {}) =>
    new ModelHttpError(status, typeof body === 'string' ? body : JSON.stringify(body), retryAfterMs, headers);

  it('counts 429, 402, a quota 403, usage codes and failed streams', () => {
    expect(classifyUsageFailure(http(429, 'slow down', 7000))).toEqual({ reason: 'rate_limit', retryAfterMs: 7000 });
    expect(classifyUsageFailure(http(402, 'pay'))).toEqual({ reason: 'payment' });
    expect(classifyUsageFailure(http(403, { error: { message: 'You exceeded your current quota' } }))).toEqual({ reason: 'quota' });
    expect(classifyUsageFailure(http(403, { error: 'Monthly credit limit reached' }))).toEqual({ reason: 'quota' });
    expect(classifyUsageFailure(http(403, { error: { code: 'usage_limit_reached', resets_in_seconds: 90 } }))).toEqual({ reason: 'usage_limit', retryAfterMs: 90_000 });
    expect(classifyUsageFailure(http(502, 'AIS gateway: upstream credential unavailable', undefined, { [GATEWAY_ERROR_HEADER]: 'credential_unavailable' }))).toEqual({ reason: 'missing_credentials' });
    expect(classifyUsageFailure(new ModelStreamError('x', 'usage_limit_reached'))).toEqual({ reason: 'usage_limit' });
    expect(classifyUsageFailure(new ModelStreamError('x', 'rate_limit_exceeded'))).toEqual({ reason: 'rate_limit' });
    expect(classifyUsageFailure(new ModelStreamError('x', '', 429))).toEqual({ reason: 'rate_limit' });
  });

  it('leaves validation errors, 5xx, other 403s, stream failures and plain errors alone', () => {
    expect(classifyUsageFailure(http(400, { error: { message: 'tool_choice is invalid' } }))).toBeUndefined();
    expect(classifyUsageFailure(http(400, { error: { message: 'max limit of tools' } }))).toBeUndefined();
    expect(classifyUsageFailure(http(500, 'boom'))).toBeUndefined();
    expect(classifyUsageFailure(http(502, '<html>Bad gateway</html>'))).toBeUndefined();
    expect(classifyUsageFailure(http(403, '<html>Forbidden</html>'))).toBeUndefined();
    // A word that is not a usage word, and a usage code outside 429, 402 and 403.
    expect(classifyUsageFailure(http(403, { error: { message: 'The request was limited by policy' } }))).toBeUndefined();
    expect(classifyUsageFailure(http(503, { error: { type: 'insufficient_quota' } }))).toBeUndefined();
    expect(classifyUsageFailure(http(400, { error: { code: 'usage_limit_reached' } }))).toBeUndefined();
    expect(classifyUsageFailure(http(500, { error: { code: 'rate_limit_exceeded' } }))).toBeUndefined();
    // A 502 from the gateway for another reason, and a credential header on another status.
    expect(classifyUsageFailure(http(502, 'x', undefined, { [GATEWAY_ERROR_HEADER]: 'upstream_unreachable' }))).toBeUndefined();
    expect(classifyUsageFailure(http(500, 'x', undefined, { [GATEWAY_ERROR_HEADER]: 'credential_unavailable' }))).toBeUndefined();
    expect(classifyUsageFailure(http(401, 'no'))).toBeUndefined();
    expect(classifyUsageFailure(new ModelStreamError('x', 'server_error', 500))).toBeUndefined();
    expect(classifyUsageFailure(new Error('The operation was aborted due to timeout'))).toBeUndefined();
    expect(classifyUsageFailure(new Error('quota'))).toBeUndefined();
  });

  it('reads Retry-After as seconds or as a date', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('Thu, 26 Nov 2026 10:00:30 GMT', Date.parse('Thu, 26 Nov 2026 10:00:00 GMT'))).toBe(30_000);
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('ordered default models', () => {
  const clock = { t: 1_000_000 };
  const open = (c: ModelCatalogue, id?: string) => c.open(id);
  const catalogue = (config = cfg()) => {
    const metrics = new Metrics();
    const c = new ModelCatalogue(config, 600_000, () => clock.t);
    c.attachMetrics(metrics);
    return { c, metrics };
  };
  beforeEach(() => {
    clock.t = 1_000_000;
  });

  it('uses the first model while it has usage left', async () => {
    const { c } = catalogue();
    const m = await open(c);
    expect((await m.complete(req)).text).toBe('ok');
    expect(m.name).toBe('grok/g');
    expect(gateway.hits).toEqual(['grok']);
  });

  it('falls through on a 429 at once, names the answering model and counts the move', async () => {
    gateway.answers = { grok: [fail(429, 'limit', { 'retry-after': '120' })], qwen: [ok('from qwen')] };
    const { c, metrics } = catalogue();
    const m = await open(c);
    expect((await m.complete(req)).text).toBe('from qwen');
    expect(m.name).toBe('qwen/q');
    // No retries on the model that has no usage left.
    expect(gateway.hits).toEqual(['grok', 'qwen']);
    expect(metrics.get('headlamp_agent_model_fallback_total', { from: 'grok/g', to: 'qwen/q', reason: 'rate_limit' })).toBe(1);
    expect(metrics.get('headlamp_agent_model_exhausted', { model: 'grok/g' })).toBe(1);
    expect(metrics.render()).toContain('headlamp_agent_model_exhausted{model="grok/g"} 1');
  });

  it('falls through on a 403 whose body names a quota, and on to the next model again', async () => {
    gateway.answers = { grok: [fail(403, { error: { message: 'Quota exceeded for this plan' } })], qwen: [fail(402, 'payment required')], glm: [ok('from glm')] };
    const { c, metrics } = catalogue();
    const m = await open(c);
    expect((await m.complete(req)).text).toBe('from glm');
    expect(m.name).toBe('glm/z');
    expect(metrics.get('headlamp_agent_model_fallback_total', { from: 'grok/g', to: 'qwen/q', reason: 'quota' })).toBe(1);
    expect(metrics.get('headlamp_agent_model_fallback_total', { from: 'qwen/q', to: 'glm/z', reason: 'payment' })).toBe(1);
  });

  it('falls through at once, with no retries, when the gateway has no upstream credential', async () => {
    const credential = () => fail(502, { error: { message: 'AIS gateway: upstream credential unavailable' } }, { [GATEWAY_ERROR_HEADER]: 'credential_unavailable' });
    gateway.answers = { grok: [credential()], qwen: [ok('from qwen')] };
    const { c, metrics } = catalogue();
    const m = await open(c);
    expect((await m.complete(req)).text).toBe('from qwen');
    expect(gateway.hits).toEqual(['grok', 'qwen']);
    expect(metrics.get('headlamp_agent_model_fallback_total', { from: 'grok/g', to: 'qwen/q', reason: 'missing_credentials' })).toBe(1);
    expect(c.isExhausted('grok/g')).toBe(true);
    // Also the last entry makes one call only: a credential does not come back in seconds.
    gateway.hits = [];
    gateway.answers = { astra: [credential()] };
    const last = await open(catalogue(cfg(['astra/a', 'astra/b'])).c);
    await expect(last.complete(req)).rejects.toMatchObject({ status: 502 });
    expect(gateway.hits.filter(h => h === 'astra')).toHaveLength(2);
  });

  it('keeps retrying a plain 502 that the gateway does not mark as a credential failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    gateway.answers = { grok: [fail(502, 'bad gateway', { [GATEWAY_ERROR_HEADER]: 'upstream_unreachable' })], qwen: [ok('from qwen')] };
    const { c } = catalogue();
    const m = await open(c);
    const done = m.complete(req).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await vi.runAllTimersAsync();
    expect(await done).toMatch(/answered 502/);
    expect(gateway.hits.every(h => h === 'grok')).toBe(true);
    expect(gateway.hits.length).toBeGreaterThan(1);
  });

  it('falls through on a failed Responses stream with a usage code', async () => {
    const sse = `data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: 'usage_limit_reached', message: 'The usage limit has been reached' } } })}\n\n`;
    const config = cfg();
    config.routes[0] = { ...config.routes[0]!, style: 'responses' };
    gateway.answers = { grok: [new Response(sse, { status: 200 })], qwen: [ok('from qwen')] };
    const { c } = catalogue(config);
    const m = await open(c);
    expect((await m.complete(req)).text).toBe('from qwen');
  });

  it.each([
    ['400', () => fail(400, { error: { message: 'bad request' } })],
    ['401', () => fail(401, 'unauthorised')],
    ['403 without a usage word', () => fail(403, '<html>Forbidden</html>')],
  ])('does not fall through on a %s', async (_name, answer) => {
    gateway.answers = { grok: [answer()], qwen: [ok('from qwen')] };
    const { c, metrics } = catalogue();
    const m = await open(c);
    await expect(m.complete(req)).rejects.toThrow(/Model endpoint answered/);
    expect(gateway.hits).toEqual(['grok']);
    expect(m.name).toBe('grok/g');
    expect(metrics.get('headlamp_agent_model_exhausted', { model: 'grok/g' })).toBe(0);
  });

  it('does not fall through on a 500 or a timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    gateway.answers = { grok: [fail(500, 'boom')], qwen: [ok('from qwen')] };
    const { c } = catalogue();
    const m = await open(c);
    const done = m.complete(req).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await vi.runAllTimersAsync();
    expect(await done).toMatch(/answered 500/);
    expect(gateway.hits.every(h => h === 'grok')).toBe(true);
    gateway.hits = [];
    gateway.answers = {
      grok: [
        () => {
          throw new Error('The operation was aborted due to timeout');
        },
      ],
      qwen: [ok('from qwen')],
    };
    const m2 = await open(c);
    const done2 = m2.complete(req).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await vi.runAllTimersAsync();
    expect(await done2).toMatch(/timeout/);
    expect(gateway.hits.every(h => h === 'grok')).toBe(true);
  });

  it('does not fall through after the model has answered in this run', async () => {
    gateway.answers = { grok: [ok('looking', [{ name: 'get_resource' }]), fail(429, 'limit')], qwen: [ok('from qwen')] };
    const { c } = catalogue();
    const m = await open(c);
    expect((await m.complete(req)).toolCalls).toHaveLength(1);
    // A usage failure on the second call comes after output: it is reported, not hidden.
    await expect(m.complete(req)).rejects.toMatchObject({ status: 429 });
    expect(m.name).toBe('grok/g');
    expect(gateway.hits).toEqual(['grok', 'grok']);
  });

  it('skips an exhausted model for the Retry-After time, then tries it again', async () => {
    gateway.answers = { grok: [fail(429, 'limit', { 'retry-after': '120' }), ok('grok is back')], qwen: [ok('from qwen')] };
    const { c, metrics } = catalogue();
    await (await open(c)).complete(req);
    expect(gateway.hits).toEqual(['grok', 'qwen']);
    gateway.hits = [];
    // Inside the cool-down grok is not called.
    clock.t += 119_000;
    const during = await open(c);
    expect((await during.complete(req)).text).toBe('from qwen');
    expect(during.name).toBe('qwen/q');
    expect(gateway.hits).toEqual(['qwen']);
    expect(c.currentDefault()).toBe('qwen/q');
    // After it, grok comes first again.
    clock.t += 2_000;
    gateway.hits = [];
    const after = await open(c);
    expect((await after.complete(req)).text).toBe('grok is back');
    expect(gateway.hits).toEqual(['grok']);
    expect(c.currentDefault()).toBe('grok/g');
    c.refreshMetrics();
    expect(metrics.get('headlamp_agent_model_exhausted', { model: 'grok/g' })).toBe(0);
  });

  it('cools down for 5 minutes when the endpoint gives no Retry-After', async () => {
    gateway.answers = { grok: [fail(429, 'limit')], qwen: [ok()] };
    const { c } = catalogue();
    await (await open(c)).complete(req);
    clock.t += COOLDOWN_MS - 1000;
    expect(c.isExhausted('grok/g')).toBe(true);
    clock.t += 2000;
    expect(c.isExhausted('grok/g')).toBe(false);
  });

  it('skips a route with no credentials and counts it', async () => {
    const { c, metrics } = catalogue(cfg(ORDER, ['grok']));
    const m = await open(c);
    await m.complete(req);
    expect(m.name).toBe('qwen/q');
    expect(gateway.hits).toEqual(['qwen']);
    expect(metrics.get('headlamp_agent_model_fallback_total', { from: 'grok/g', to: 'qwen/q', reason: 'missing_credentials' })).toBe(1);
  });

  it('reports the usage failure of the last model as it is', async () => {
    gateway.answers = { grok: [fail(429, 'a')], qwen: [fail(429, 'b')], glm: [fail(429, 'c')], astra: [fail(429, 'last')] };
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { c } = catalogue();
    const m = await open(c);
    const done = m.complete(req).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await vi.runAllTimersAsync();
    expect(await done).toMatch(/429: last/);
    // The last model kept its retries: three calls.
    expect(gateway.hits.filter(h => h === 'astra')).toHaveLength(3);
    // All four are now in a cool-down. The next run probes the one that recovers first.
    gateway.hits = [];
    gateway.answers = { grok: [ok('grok again')] };
    const next = await open(c);
    expect(next.name).toBe('grok/g');
  });

  it('uses an explicit pick as it is, with no fallback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    gateway.answers = { qwen: [fail(429, 'limit')], glm: [ok('from glm')] };
    const { c, metrics } = catalogue();
    const m = await open(c, 'qwen/q');
    expect(m.name).toBe('qwen/q');
    const done = m.complete(req).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await vi.runAllTimersAsync();
    expect(await done).toMatch(/429/);
    expect(gateway.hits.every(h => h === 'qwen')).toBe(true);
    expect(metrics.render()).not.toContain('headlamp_agent_model_fallback_total');
    expect(c.isExhausted('qwen/q')).toBe(false);
  });

  it('is plain with one default model', async () => {
    const one: ModelRoutesConfig = { routes: [route('grok')], defaultModel: 'grok/g', defaultOrder: ['grok/g'], skipped: [] };
    gateway.answers = { grok: [fail(429, 'limit')] };
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { c } = catalogue(one);
    const m = await open(c);
    const done = m.complete(req).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await vi.runAllTimersAsync();
    expect(await done).toMatch(/429/);
    // Three tries, as before the default order existed.
    expect(gateway.hits).toHaveLength(3);
  });
});

describe('records the model that answered', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-fallback-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 400 && !fn(); i++) await new Promise(r => setTimeout(r, 5));
    expect(fn()).toBe(true);
  };
  const chatService = (config = cfg()) => {
    const c = new ModelCatalogue(config);
    const store = new ChatStore(dir);
    const chats = new ChatService({
      store,
      diagnoses: new MemoryDiagnosisStore(),
      tools: { list: async () => [], call: async () => ({ ok: true, summary: '', data: {} }) },
      catalogue: c,
      budget: 2,
      maxTurns: 3,
    });
    return { c, chats, store };
  };

  it('an unpicked chat moves to the next model and records which one answered', async () => {
    gateway.answers = { grok: [fail(429, 'limit', { 'retry-after': '60' })], qwen: [ok('from qwen')] };
    const { chats } = chatService();
    const { id } = await chats.create({});
    expect(chats.get(id)).toMatchObject({ model: 'grok/g' });
    await chats.send(id, 'hello');
    await until(() => !(chats.get(id) as any).running);
    const chat = chats.get(id) as any;
    expect(chat.messages[1]).toMatchObject({ status: 'done', text: 'from qwen', model: 'qwen/q' });
    expect(chat.model).toBe('qwen/q');
    // The next turn does not try grok inside its cool-down, and the chat is still not pinned.
    gateway.hits = [];
    await chats.send(id, 'again');
    await until(() => !(chats.get(id) as any).running);
    expect(gateway.hits).toEqual(['qwen']);
  });

  it('a chat created with a model, or patched to one, never falls back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    gateway.answers = { qwen: [fail(429, 'limit')], glm: [ok('from glm')] };
    const { chats } = chatService();
    // The model is not the default, so it is a real pick.
    const { id } = await chats.create({ model: 'qwen/q' });
    await chats.send(id, 'hello');
    for (let i = 0; i < 20 && (chats.get(id) as any).running; i++) await vi.advanceTimersByTimeAsync(5000);
    const chat = chats.get(id) as any;
    expect(chat.messages[1]).toMatchObject({ status: 'failed', model: 'qwen/q' });
    expect(chat.model).toBe('qwen/q');
    expect(gateway.hits.every(h => h === 'qwen')).toBe(true);
    // A pick on send pins the chat as well.
    gateway.hits = [];
    gateway.answers = { glm: [fail(429, 'limit')], astra: [ok('from astra')] };
    const unpicked = await chats.create({});
    await chats.send(unpicked.id, 'hello', 'glm/z');
    for (let i = 0; i < 20 && (chats.get(unpicked.id) as any).running; i++) await vi.advanceTimersByTimeAsync(5000);
    expect((chats.get(unpicked.id) as any).messages[1]).toMatchObject({ status: 'failed', model: 'glm/z' });
    expect(gateway.hits.every(h => h === 'glm')).toBe(true);
  });

  it('a default chat uses the first live entry when the first route has no credentials', async () => {
    gateway.answers = { qwen: [ok('from qwen')] };
    const { chats } = chatService(cfg(ORDER, ['grok']));
    // Create and send go through the chat service, not open(): the first entry must not be resolved.
    const { id } = await chats.create({});
    expect(chats.get(id)).toMatchObject({ model: 'qwen/q' });
    await chats.send(id, 'hello');
    await until(() => !(chats.get(id) as any).running);
    expect((chats.get(id) as any).messages[1]).toMatchObject({ status: 'done', text: 'from qwen', model: 'qwen/q' });
    expect(gateway.hits).toEqual(['qwen']);
    // A patch to no model and a send with no model do not fail either.
    expect(await chats.patch(id, { model: '' })).toMatchObject({ model: 'qwen/q' });
    await chats.send(id, 'again');
    await until(() => !(chats.get(id) as any).running);
  });

  it('a chat or diagnosis record with no modelPinned follows the new order', async () => {
    gateway.answers = { grok: [ok('from grok')] };
    const { chats, store } = chatService();
    const { id } = await chats.create({});
    // An old record: the old default, no flag.
    const old = store.get(id)!;
    old.model = 'codex/gpt-6.2-sol';
    delete old.modelPinned;
    store.save(old);
    await chats.send(id, 'hello');
    await until(() => !(chats.get(id) as any).running);
    expect((chats.get(id) as any).messages[1]).toMatchObject({ status: 'done', model: 'grok/g' });
    expect(chats.get(id)).toMatchObject({ model: 'grok/g' });
    expect(gateway.hits).toEqual(['grok']);
    // With one default model the old inference stays: a model other than the default counts as picked.
    const one = new ModelCatalogue({ routes: cfg().routes, defaultModel: 'grok/g', defaultOrder: ['grok/g'], skipped: [] });
    expect(one.isPinned(undefined, 'qwen/q')).toBe(true);
    expect(one.isPinned(undefined, 'grok/g')).toBe(false);
    expect(one.isPinned(false, 'qwen/q')).toBe(false);
    const ordered = new ModelCatalogue(cfg());
    expect(ordered.isPinned(undefined, 'qwen/q')).toBe(false);
    expect(ordered.isPinned(true, 'qwen/q')).toBe(true);
  });

  it('an echo of the default is no pick: the current default and the old default', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    gateway.answers = { grok: [fail(429, 'limit', { 'retry-after': '60' })], qwen: [ok('from qwen')] };
    const { chats, c } = chatService();
    expect(PREVIOUS_DEFAULTS).toContain('codex/gpt-6.2-sol');
    // The old plugin sends the default it shows on create and on send.
    const a = await chats.create({ model: 'grok/g' });
    expect(chats.get(a.id)).toMatchObject({ model: 'grok/g' });
    await chats.send(a.id, 'hello', 'grok/g');
    for (let i = 0; i < 20 && (chats.get(a.id) as any).running; i++) await vi.advanceTimersByTimeAsync(5000);
    // Not pinned: it fell through to qwen.
    expect((chats.get(a.id) as any).messages[1]).toMatchObject({ status: 'done', model: 'qwen/q' });
    // The shown default is now qwen, and an echo of it, or of the old default, is still no pick.
    expect(c.currentDefault()).toBe('qwen/q');
    const b = await chats.create({ model: 'codex/gpt-6.2-sol' });
    expect(chats.get(b.id)).toMatchObject({ model: 'qwen/q' });
    const d = await chats.create({ model: 'qwen/q' });
    gateway.hits = [];
    await chats.send(d.id, 'hello', 'codex/gpt-6.2-sol');
    for (let i = 0; i < 20 && (chats.get(d.id) as any).running; i++) await vi.advanceTimersByTimeAsync(5000);
    expect(gateway.hits).toEqual(['qwen']);
    // A real pick of another model is still pinned, and has no fallback.
    const e = await chats.create({ model: 'glm/z' });
    expect(chats.get(e.id)).toMatchObject({ model: 'glm/z' });
  });

  it('a diagnosis run records the model that answered', async () => {
    const calls: string[] = [];
    const model = {
      name: 'grok/g',
      async complete() {
        calls.push(this.name);
        model.name = 'qwen/q';
        return { text: '', toolCalls: [{ id: 'c', name: 'submit_diagnosis', args: { summary: 's', likelyCause: 'c', confidence: 'low', signals: [], fixes: [{ title: 't', detail: 'd', recommended: true }], verify: 'v' } }], stop: 'tool_use', usage: { input: 0, output: 0 } };
      },
    };
    const d = await diagnose({ alert: { name: 'A', severity: 'warning', labels: {}, annotations: {}, startsAt: '2026-11-26T00:00:00Z', fingerprint: 'f' }, tools: { list: async () => [], call: async () => ({ ok: true, summary: '', data: {} }) }, model, budget: 1, source: 'api' });
    expect(d.model).toBe('qwen/q');
  });

  it('serves the order on /api/models and the fallback metrics on /metrics', async () => {
    gateway.answers = { grok: [fail(429, 'limit', { 'retry-after': '60' })], qwen: [ok('from qwen')] };
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent', dataDir: dir, models: cfg() };
    const server = await startServer(config, 'test');
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const get = async (p: string) => realFetch(`${base}${p}`);
      let listed = (await (await get('/api/models')).json()) as any;
      expect(listed.default).toBe('grok/g');
      expect(listed.defaultOrder).toEqual(ORDER);
      const created = await (await realFetch(`${base}/api/chats`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
      await realFetch(`${base}/api/chats/${created.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
      await until(() => gateway.hits.includes('qwen'));
      const text = await (await get('/metrics')).text();
      expect(text).toContain('headlamp_agent_model_fallback_total{from="grok/g",reason="rate_limit",to="qwen/q"} 1');
      expect(text).toContain('headlamp_agent_model_exhausted{model="grok/g"} 1');
      expect(text).toContain('headlamp_agent_model_exhausted{model="qwen/q"} 0');
      listed = (await (await get('/api/models')).json()) as any;
      expect(listed.default).toBe('qwen/q');
    } finally {
      await server.close();
    }
  });
});
