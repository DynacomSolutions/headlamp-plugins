import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, loadModelRoutes, modelConfigured, type ModelRoute, type ModelRoutesConfig } from '../src/config.js';
import { ModelCatalogue, parseModelList, UnknownIdentityError, UnknownModelError } from '../src/agent/catalogue.js';
import { ModelClient } from '../src/agent/model.js';
import { defaultModelId, modelConfigOptions, pickModel } from '../src/acp.js';

afterEach(() => vi.unstubAllGlobals());

const env = (extra: Record<string, string>) => extra as NodeJS.ProcessEnv;
const route = (id: string, extra: Partial<ModelRoute> = {}): ModelRoute => ({
  id,
  style: 'openai',
  baseUrl: `https://gw.example.com/${id}`,
  apiKey: `key-${id}`,
  headers: {},
  systemPrefix: '',
  maxTokens: 100,
  timeoutMs: 1000,
  ...extra,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('model routes config', () => {
  const routes = JSON.stringify([
    { id: 'claude', style: 'anthropic', urlEnv: 'AIS_GATEWAY_CLAUDE_URL', tokenEnv: 'AIS_GATEWAY_CLAUDE_TOKEN', systemPrefix: "You are Claude Code, Anthropic's official CLI for Claude.", models: ['m1'] },
    { id: 'codex', style: 'responses', urlEnv: 'AIS_GATEWAY_CODEX_URL', tokenEnv: 'AIS_GATEWAY_CODEX_TOKEN' },
    { id: 'grok', style: 'openai', urlEnv: 'AIS_GATEWAY_GROK_URL', tokenEnv: 'AIS_GATEWAY_GROK_TOKEN', headers: { 'x-grok-client-version': '1.0.70' } },
  ]);

  it('reads routes from the inline JSON and skips a route whose variables are empty', () => {
    const cfg = loadModelRoutes(
      env({
        AGENT_MODEL_ROUTES: routes,
        AGENT_MODEL: 'claude/m1',
        AIS_GATEWAY_CLAUDE_URL: 'https://gw.example.com/claude/',
        AIS_GATEWAY_CLAUDE_TOKEN: 't1',
        AIS_GATEWAY_CODEX_URL: 'https://gw.example.com/codex',
        AIS_GATEWAY_CODEX_TOKEN: 't2',
        AIS_GATEWAY_GROK_URL: 'https://gw.example.com/grok',
      }),
    );
    expect(cfg.routes.map(r => r.id)).toEqual(['claude', 'codex']);
    expect(cfg.skipped).toEqual(['grok']);
    expect(cfg.routes[0]).toMatchObject({ style: 'anthropic', baseUrl: 'https://gw.example.com/claude', apiKey: 't1', models: ['m1'] });
    expect(cfg.defaultModel).toBe('claude/m1');
    expect(modelConfigured(cfg)).toBe(true);
  });

  it('reads routes from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-routes-'));
    try {
      writeFileSync(join(dir, 'routes.json'), routes);
      const cfg = loadModelRoutes(env({ AGENT_MODEL_ROUTES_FILE: join(dir, 'routes.json'), AIS_GATEWAY_GROK_URL: 'https://gw.example.com/grok', AIS_GATEWAY_GROK_TOKEN: 't' }));
      expect(cfg.routes).toHaveLength(1);
      expect(cfg.routes[0].headers).toEqual({ 'x-grok-client-version': '1.0.70' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses variables outside AIS_GATEWAY_*', () => {
    const bad = (urlEnv: string, tokenEnv: string) => JSON.stringify([{ id: 'x', style: 'openai', urlEnv, tokenEnv }]);
    expect(() => loadModelRoutes(env({ AGENT_MODEL_ROUTES: bad('OPENAI_BASE_URL', 'AIS_GATEWAY_X_TOKEN') }))).toThrow(/AIS_GATEWAY/);
    expect(() => loadModelRoutes(env({ AGENT_MODEL_ROUTES: bad('AIS_GATEWAY_X_URL', 'OPENAI_API_KEY') }))).toThrow(/AIS_GATEWAY/);
    expect(() => loadModelRoutes(env({ AGENT_MODEL_ROUTES: bad('AIS_GATEWAY_X_TOKEN_FILE', 'AIS_GATEWAY_X_TOKEN') }))).toThrow(/AIS_GATEWAY/);
  });

  it('refuses a raw base URL or API key, a bad style and a duplicate id', () => {
    const one = (extra: object) => JSON.stringify([{ id: 'x', style: 'openai', urlEnv: 'AIS_GATEWAY_X_URL', tokenEnv: 'AIS_GATEWAY_X_TOKEN', ...extra }]);
    expect(() => loadModelRoutes(env({ AGENT_MODEL_ROUTES: one({ baseUrl: 'https://example.com' }) }))).toThrow(/not allowed/);
    expect(() => loadModelRoutes(env({ AGENT_MODEL_ROUTES: one({ apiKey: 'k' }) }))).toThrow(/not allowed/);
    expect(() => loadModelRoutes(env({ AGENT_MODEL_ROUTES: one({ style: 'gemini' }) }))).toThrow(/style/);
    const dup = JSON.stringify([JSON.parse(one({}))[0], JSON.parse(one({}))[0]]);
    expect(() => loadModelRoutes(env({ AGENT_MODEL_ROUTES: dup }))).toThrow(/twice/);
  });

  it('builds one legacy route from the single-route variables', () => {
    const cfg = loadConfig(
      env({ AIS_GATEWAY_URL: 'https://gw.example.com/app/', AIS_GATEWAY_TOKEN: 't', AGENT_MODEL: 'glm-5.3', AGENT_MODEL_STYLE: 'openai', AGENT_MODEL_HEADERS: '{"x-a":"{session}"}', AGENT_MODEL_SYSTEM_PREFIX: 'P' }),
    ).models;
    expect(cfg.routes).toEqual([{ id: 'gateway', style: 'openai', baseUrl: 'https://gw.example.com/app', apiKey: 't', headers: { 'x-a': '{session}' }, systemPrefix: 'P', maxTokens: 4096, timeoutMs: 120000 }]);
    expect(cfg.defaultModel).toBe('glm-5.3');
  });

  it('is not configured without a route or a default model', () => {
    expect(modelConfigured(loadModelRoutes(env({})))).toBe(false);
    expect(modelConfigured(loadModelRoutes(env({ AIS_GATEWAY_URL: 'https://gw.example.com', AIS_GATEWAY_TOKEN: 't' })))).toBe(false);
  });
});

describe('model catalogue', () => {
  const cfg = (routes: ModelRoute[], defaultModel = ''): ModelRoutesConfig => ({ routes, defaultModel, skipped: [] });

  it('parses the OpenAI, Anthropic and Codex list shapes', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (url.includes('/oa/')) return json({ data: [{ id: 'a' }, { id: 'b' }] });
      if (url.includes('/an/')) return json({ data: [{ id: 'claude-x', display_name: 'Claude X' }] });
      return json({ models: [{ slug: 'gpt-x', visibility: 'list', display_name: 'GPT X' }, { slug: 'gpt-hidden', visibility: 'hide' }] });
    });
    const c = new ModelCatalogue(cfg([route('oa/', { baseUrl: 'https://gw.example.com/oa' }), route('an', { style: 'anthropic', baseUrl: 'https://gw.example.com/an' }), route('cx', { style: 'responses', baseUrl: 'https://gw.example.com/cx' })]));
    const list = await c.list();
    expect(list.map(e => `${e.route}:${e.model}:${e.name}`)).toEqual(['oa/:a:a', 'oa/:b:b', 'an:claude-x:Claude X', 'cx:gpt-x:GPT X']);
    expect(calls).toContain('https://gw.example.com/cx/models?client_version=1.0.0');
  });

  it('tries /v1/models after a 404, sends a user agent and the route headers', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return url.endsWith('/v1/models') ? json({ data: [{ id: 'k' }] }) : new Response('', { status: 404 });
    });
    const c = new ModelCatalogue(cfg([route('g', { headers: { 'x-grok-client-version': '1.0.70' } })]));
    expect((await c.list()).map(e => e.id)).toEqual(['g/k']);
    expect(seen.map(s => s.url)).toEqual(['https://gw.example.com/g/models', 'https://gw.example.com/g/v1/models']);
    expect(seen[0].headers['user-agent']).toMatch(/^headlamp-agent\//);
    expect(seen[0].headers['x-grok-client-version']).toBe('1.0.70');
    expect(seen[0].headers.authorization).toBe('Bearer key-g');
  });

  it('caches the list, and falls back to the configured models when listing fails', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n++;
      return json({ data: [{ id: 'a' }] });
    });
    const c = new ModelCatalogue(cfg([route('r')]));
    await c.list();
    await c.list();
    expect(n).toBe(1);
    vi.stubGlobal('fetch', async () => new Response('no', { status: 500 }));
    const f = new ModelCatalogue(cfg([route('r', { models: ['x', 'y'] })]));
    expect((await f.list()).map(e => e.id)).toEqual(['r/x', 'r/y']);
  });

  it('refreshes after the cache time', async () => {
    let n = 0;
    let t = 0;
    vi.stubGlobal('fetch', async () => (n++, json({ data: [{ id: 'a' }] })));
    const c = new ModelCatalogue(cfg([route('r')]), 1000, () => t);
    await c.list();
    t = 2000;
    await c.list();
    expect(n).toBe(2);
  });

  it('keeps only allowlisted ids from the gateway list', async () => {
    vi.stubGlobal('fetch', async () => json({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));
    const c = new ModelCatalogue(cfg([route('r', { models: ['b', 'c', 'zz'] })]));
    expect((await c.list()).map(e => e.id)).toEqual(['r/b', 'r/c']);
  });

  it('resolves the default, qualified ids, bare ids and rejects unknown ids', async () => {
    vi.stubGlobal('fetch', async (url: string) => json({ data: [{ id: url.includes('/one/') ? 'a' : 'b' }] }));
    const c = new ModelCatalogue(cfg([route('one'), route('two')], 'two/b'));
    expect(c.configured).toBe(true);
    expect(await c.resolve()).toMatchObject({ model: 'b', route: { id: 'two' } });
    expect(await c.resolve('one/a')).toMatchObject({ model: 'a', route: { id: 'one' } });
    expect(await c.resolve('b')).toMatchObject({ model: 'b', route: { id: 'two' } });
    const err = await c.resolve('one/zzz').catch(e => e);
    expect(err).toBeInstanceOf(UnknownModelError);
    expect(err.message).toContain('one/a, two/b');
    await expect(c.resolve('nope')).rejects.toThrow(/Unknown model/);
  });

  it('keeps the legacy route working with a bare default the gateway does not list', async () => {
    vi.stubGlobal('fetch', async () => new Response('x', { status: 500 }));
    const c = new ModelCatalogue(cfg([route('gateway')], 'glm-5.3'));
    expect(await c.resolve()).toMatchObject({ model: 'glm-5.3', route: { id: 'gateway' } });
    expect((await c.list()).map(e => e.id)).toEqual(['gateway/glm-5.3']);
    expect(new ModelClient(route('gateway'), 'glm-5.3').name).toBe('gateway/glm-5.3');
  });

  it('is not configured without routes or a default', () => {
    expect(new ModelCatalogue(cfg([], 'x')).configured).toBe(false);
    expect(new ModelCatalogue(cfg([route('r')], '')).configured).toBe(false);
  });
});

describe('ACP model picker', () => {
  const catalogue = () => new ModelCatalogue({ routes: [route('one', { models: ['a', 'b'] }), route('two', { models: ['c'] })], defaultModel: 'one/a', skipped: [] });
  const down = () => vi.stubGlobal('fetch', async () => new Response('x', { status: 500 }));

  it('offers one select option with a group per route', async () => {
    down();
    const options = await modelConfigOptions(catalogue(), 'one/a');
    expect(options).toEqual([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'one/a',
        options: [
          { group: 'one', name: 'one', options: [{ value: 'one/a', name: 'a' }, { value: 'one/b', name: 'b' }] },
          { group: 'two', name: 'two', options: [{ value: 'two/c', name: 'c' }] },
        ],
      },
    ]);
    expect(await defaultModelId(catalogue())).toBe('one/a');
  });

  it('accepts a listed value and rejects an unknown one', async () => {
    down();
    expect(await pickModel(catalogue(), 'two/c')).toBe('two/c');
    await expect(pickModel(catalogue(), 'two/zzz')).rejects.toThrow(/Unknown model/);
    await expect(pickModel(catalogue(), 5)).rejects.toThrow(/string/);
  });

  it('does not wait for a slow gateway longer than the cap', async () => {
    vi.stubGlobal('fetch', () => new Promise(() => undefined));
    const c = new ModelCatalogue({ routes: [route('one', { models: ['a'] })], defaultModel: 'one/a', skipped: [] });
    const list = await c.list({ waitMs: 30 });
    expect(list.map(e => e.id)).toEqual(['one/a']);
  });
});

describe('model client', () => {
  const req = {
    system: 'SYS',
    session: 'sess-1',
    tools: [{ name: 'q', description: 'd', parameters: { type: 'object' } }],
    messages: [
      { role: 'user' as const, text: 'go' },
      { role: 'assistant' as const, text: 'thinking', toolCalls: [{ id: 'c1', name: 'q', args: { a: 1 } }] },
      { role: 'tool' as const, results: [{ id: 'c1', name: 'q', content: 'result', isError: false }] },
    ],
  };
  const capture = (response: () => Response) => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return response();
    });
    return calls;
  };
  const sse = (events: unknown[]) => events.map(e => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

  it('sends a Responses request and parses the SSE stream without a content-type', async () => {
    const calls = capture(
      () =>
        new Response(
          sse([
            { type: 'response.created', response: { id: 'r' } },
            { type: 'response.output_text.delta', delta: 'He' },
            {
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [
                  { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
                  { type: 'function_call', call_id: 'call_9', name: 'q', arguments: '{"x":2}' },
                ],
                usage: { input_tokens: 11, output_tokens: 4 },
              },
            },
          ]),
        ),
    );
    const client = new ModelClient(route('cx', { style: 'responses', systemPrefix: 'PRE', headers: { 'x-s': '{session}' } }), 'gpt-x');
    const out = await client.complete({ ...req, forceTool: 'q' });
    expect(out).toMatchObject({ text: 'Hello', toolCalls: [{ id: 'call_9', name: 'q', args: { x: 2 } }], usage: { input: 11, output: 4 } });
    const [call] = calls;
    expect(call.url).toBe('https://gw.example.com/cx/responses');
    expect(call.headers['x-s']).toBe('sess-1');
    expect(call.headers['user-agent']).toMatch(/^headlamp-agent\//);
    expect(call.body).toMatchObject({
      model: 'gpt-x',
      instructions: 'PRE\n\nSYS',
      store: false,
      stream: true,
      tools: [{ type: 'function', name: 'q', description: 'd', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'q' },
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'thinking' }] },
        { type: 'function_call', call_id: 'c1', name: 'q', arguments: '{"a":1}' },
        { type: 'function_call_output', call_id: 'c1', output: 'result' },
      ],
    });
    expect(call.body).not.toHaveProperty('max_tokens');
    expect(call.body).not.toHaveProperty('max_output_tokens');
  });

  it('builds the answer from output items when the stream has no completed event', async () => {
    capture(() => new Response(sse([{ type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'Hi' }] } }])));
    const out = await new ModelClient(route('cx', { style: 'responses' }), 'm').complete(req);
    expect(out.text).toBe('Hi');
  });

  it('fails on a failed stream', async () => {
    capture(() => new Response(sse([{ type: 'response.failed', response: { error: { message: 'quota' } } }])));
    await expect(new ModelClient(route('cx', { style: 'responses' }), 'm').complete(req)).rejects.toThrow(/quota/);
  });

  it('keeps the type, code and message of a stream failure wherever the upstream puts them', async () => {
    const run = async (event: object) => {
      capture(() => new Response(sse([event])));
      return new ModelClient(route('cx', { style: 'responses' }), 'm').complete(req).then(
        () => '',
        (e: Error) => e.message,
      );
    };
    expect(await run({ type: 'error', error: { type: 'server_error', code: 'internal', message: 'overloaded' } })).toBe(
      'Model stream failed: error (internal): overloaded',
    );
    expect(await run({ type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'slow down' } } })).toBe(
      'Model stream failed: response.failed (rate_limit_exceeded): slow down',
    );
    expect(await run({ type: 'error', status: 502, code: 'bad_gateway', message: 'upstream closed' })).toBe(
      'Model stream failed: error 502 (bad_gateway): upstream closed',
    );
  });

  it('shows the raw event when a stream failure has no message', async () => {
    capture(() => new Response(sse([{ type: 'response.failed', response: { id: 'resp_1', status: 'failed', error: null } }])));
    const err = await new ModelClient(route('cx', { style: 'responses' }), 'm').complete(req).catch((e: Error) => e);
    expect((err as Error).message).toContain('response.failed');
    expect((err as Error).message).toContain('"status":"failed"');
    expect((err as Error).message).not.toContain('unknown error');
  });

  it('still sends Chat Completions and Messages requests', async () => {
    const oa = capture(() => json({ choices: [{ message: { content: 'ok', tool_calls: [{ id: 't', function: { name: 'q', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    const a = await new ModelClient(route('oa'), 'glm').complete(req);
    expect(oa[0].url).toBe('https://gw.example.com/oa/chat/completions');
    expect(oa[0].body).toMatchObject({ model: 'glm', max_tokens: 100 });
    expect(a).toMatchObject({ text: 'ok', toolCalls: [{ id: 't', name: 'q' }], usage: { input: 3, output: 2 } });
    vi.unstubAllGlobals();
    const an = capture(() => json({ content: [{ type: 'text', text: 'yo' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }));
    const b = await new ModelClient(route('an', { style: 'anthropic', systemPrefix: 'You are Claude Code' }), 'claude-x').complete(req);
    expect(an[0].url).toBe('https://gw.example.com/an/v1/messages');
    expect(an[0].headers['x-api-key']).toBe('key-an');
    expect(an[0].body.system).toEqual([{ type: 'text', text: 'You are Claude Code' }, { type: 'text', text: 'SYS' }]);
    expect(b).toMatchObject({ text: 'yo', usage: { input: 5, output: 1 } });
  });

  it('sends a plain string system for anthropic without a prefix', async () => {
    const calls = capture(() => json({ content: [], usage: {} }));
    await new ModelClient(route('an2', { style: 'anthropic' }), 'm').complete(req);
    expect(calls[0].body.system).toBe('SYS');
  });

  it('keeps the string system for openai and responses with a prefix', async () => {
    const oa = capture(() => json({ choices: [{ message: { content: 'x' } }] }));
    await new ModelClient(route('oa2', { systemPrefix: 'PRE' }), 'm').complete(req);
    expect(oa[0].body.messages[0]).toEqual({ role: 'system', content: 'PRE\n\nSYS' });
    vi.unstubAllGlobals();
    const rs = capture(() => new Response(sse([{ type: 'response.completed', response: { status: 'completed', output: [], usage: {} } }])));
    await new ModelClient(route('rs2', { style: 'responses', systemPrefix: 'PRE' }), 'm').complete(req);
    expect(rs[0].body.instructions).toBe('PRE\n\nSYS');
  });

  describe('forced tool', () => {
    it('puts the forced-tool line in the second block when a prefix is set', async () => {
      let n = 0;
      const calls = capture(() => (n++ === 0 ? new Response('{"error":{"message":"tool_choice: type \\"tool\\" is not supported"}}', { status: 400 }) : json({ content: [], usage: {} })));
      await new ModelClient(route('f6', { style: 'anthropic', systemPrefix: 'PRE' }), 'm').complete({ ...req, forceTool: 'q' });
      expect(calls[1].body.system).toEqual([{ type: 'text', text: 'PRE' }, { type: 'text', text: 'SYS\n\nYou must call the q tool now.' }]);
    });

    const two = [
      { name: 'q', description: 'd', parameters: { type: 'object' } },
      { name: 'other', description: 'o', parameters: { type: 'object' } },
    ];
    const refuse = '{"type":"error","error":{"message":"tool_choice: type \\"tool\\" is not supported for this model."}}';
    const ok = () => json({ content: [{ type: 'tool_use', id: 'u', name: 'q', input: {} }], usage: {} });

    it('sends only the forced tool with the forced choice', async () => {
      const calls = capture(ok);
      await new ModelClient(route('f1', { style: 'anthropic' }), 'm').complete({ ...req, tools: two, forceTool: 'q' });
      expect(calls[0].body.tools.map((t: any) => t.name)).toEqual(['q']);
      expect(calls[0].body.tool_choice).toEqual({ type: 'tool', name: 'q' });
    });

    it('retries once without tool_choice on a 400 about it, names the tool, and remembers the pair', async () => {
      let n = 0;
      const calls = capture(() => (n++ === 0 ? new Response(refuse, { status: 400 }) : ok()));
      const client = new ModelClient(route('f2', { style: 'anthropic' }), 'm');
      const out = await client.complete({ ...req, tools: two, forceTool: 'q' });
      expect(out.toolCalls[0].name).toBe('q');
      expect(calls).toHaveLength(2);
      expect(calls[0].body.tool_choice).toBeDefined();
      expect(calls[1].body).not.toHaveProperty('tool_choice');
      expect(calls[1].body.tools.map((t: any) => t.name)).toEqual(['q']);
      expect(calls[1].body.system).toContain('You must call the q tool now.');
      await client.complete({ ...req, tools: two, forceTool: 'q' });
      expect(calls).toHaveLength(3);
      expect(calls[2].body).not.toHaveProperty('tool_choice');
      expect(calls[2].body.system).toContain('You must call the q tool now.');
      // Another model on the same route is not affected.
      await new ModelClient(route('f2', { style: 'anthropic' }), 'other-model').complete({ ...req, tools: two, forceTool: 'q' });
      expect(calls[3].body.tool_choice).toBeDefined();
    });

    it('does not retry other 400 answers', async () => {
      const calls = capture(() => new Response('{"error":"bad schema"}', { status: 400 }));
      await expect(new ModelClient(route('f3', { style: 'anthropic' }), 'm').complete({ ...req, forceTool: 'q' })).rejects.toThrow(/400/);
      expect(calls).toHaveLength(1);
    });

    it('works the same for the openai and responses styles', async () => {
      let n = 0;
      const oa = capture(() => (n++ === 0 ? new Response('tool_choice not supported', { status: 400 }) : json({ choices: [{ message: { content: 'x' } }] })));
      await new ModelClient(route('f4'), 'm').complete({ ...req, forceTool: 'q' });
      expect(oa[0].body.tool_choice).toBeDefined();
      expect(oa[1].body).not.toHaveProperty('tool_choice');
      expect(oa[1].body.messages[0].content).toContain('You must call the q tool now.');
      vi.unstubAllGlobals();
      n = 0;
      const rs = capture(() => (n++ === 0 ? new Response('tool_choice not supported', { status: 400 }) : new Response(sse([{ type: 'response.completed', response: { output: [] } }]))));
      await new ModelClient(route('f5', { style: 'responses' }), 'm').complete({ ...req, forceTool: 'q' });
      expect(rs[1].body).not.toHaveProperty('tool_choice');
      expect(rs[1].body.instructions).toContain('You must call the q tool now.');
    });
  });
});

describe('identities of a provider', () => {
  const two = (): ModelRoutesConfig => ({
    routes: [
      route('claude', { provider: 'claude', identity: 'Pool', models: ['opus'], contextWindow: 200000, pricing: { input: 3, output: 15 } }),
      route('claude-account-a', { provider: 'claude', identity: 'Account A', models: ['opus'] }),
      route('grok', { models: ['g'] }),
    ],
    defaultModel: 'grok/g',
    skipped: [],
  });

  it('reads provider, identity, context window and pricing from a route, and refuses bad values', () => {
    const file = JSON.stringify([
      { id: 'claude-a', style: 'anthropic', urlEnv: 'AIS_GATEWAY_A_URL', tokenEnv: 'AIS_GATEWAY_A_TOKEN', provider: 'claude', identity: 'Account A', contextWindow: 200000, pricing: { input: 3, output: 15 } },
    ]);
    const base = { AGENT_MODEL_ROUTES: file, AGENT_MODEL: 'claude-a/m', AIS_GATEWAY_A_URL: 'https://gw.example.com/a', AIS_GATEWAY_A_TOKEN: 't' };
    expect(loadModelRoutes(env(base)).routes[0]).toMatchObject({ provider: 'claude', identity: 'Account A', contextWindow: 200000, pricing: { input: 3, output: 15 } });
    const bad = JSON.stringify([{ id: 'x', style: 'openai', urlEnv: 'AIS_GATEWAY_A_URL', tokenEnv: 'AIS_GATEWAY_A_TOKEN', provider: 'not valid!' }]);
    expect(() => loadModelRoutes(env({ ...base, AGENT_MODEL_ROUTES: bad, AGENT_MODEL: 'x/m' }))).toThrow(/provider must be a short text/);
  });

  it('lists each model with its provider, its identity and its context window', async () => {
    vi.stubGlobal('fetch', async () => json({ data: [{ id: 'opus', context_window: 123000 }] }));
    const entries = await new ModelCatalogue(two()).list();
    expect(entries.find(e => e.id === 'claude/opus')).toMatchObject({ provider: 'claude', identity: 'Pool', contextWindow: 123000 });
    expect(entries.find(e => e.id === 'claude-account-a/opus')).toMatchObject({ provider: 'claude', identity: 'Account A' });
    expect(entries.find(e => e.id === 'grok/g')).toMatchObject({ provider: 'grok', identity: 'Pool' });
  });

  it('reads the context size from the fields the gateways use', () => {
    const sizes = parseModelList({ data: [{ id: 'a', context_window: 1 }, { id: 'b', max_input_tokens: 2 }, { id: 'c', context_length: 3 }, { id: 'd' }] }).map(m => m.contextWindow);
    expect(sizes).toEqual([1, 2, 3, undefined]);
  });

  it('gives a bare model the prefix of the identity, keeps a matching id, and refuses a mismatch or an unknown identity', () => {
    const c = new ModelCatalogue(two());
    expect(c.withIdentity('opus', 'claude-account-a')).toBe('claude-account-a/opus');
    expect(c.withIdentity('claude-account-a/opus', 'claude-account-a')).toBe('claude-account-a/opus');
    expect(c.withIdentity('claude/opus', undefined)).toBe('claude/opus');
    expect(() => c.withIdentity('claude/opus', 'claude-account-a')).toThrow(UnknownIdentityError);
    expect(() => c.withIdentity('opus', 'nope')).toThrow(/Unknown identity "nope"/);
    expect(() => c.withIdentity(undefined, 'grok')).toThrow(/needs a model/);
  });

  it('knows the context window and the price of a model of a route', () => {
    const c = new ModelCatalogue(two());
    expect(c.contextWindow('claude/opus')).toBe(200000);
    expect(c.pricing('claude/opus')).toEqual({ input: 3, output: 15 });
    expect(c.labels('claude-account-a/opus')).toEqual({ provider: 'claude', identity: 'Account A' });
    expect(c.contextWindow('grok/g')).toBeUndefined();
  });
});

describe('run time limit', () => {
  it('replaces the tool budget: the old variable is accepted and ignored', () => {
    const cfg = loadConfig({ AGENT_TOOL_BUDGET: '3' } as NodeJS.ProcessEnv);
    expect(cfg.diagnosis).not.toHaveProperty('toolBudget');
    expect(cfg.diagnosis.runTimeoutMs).toBe(15 * 60_000);
    expect(loadConfig({ AGENT_RUN_TIMEOUT_MS: '120000' } as NodeJS.ProcessEnv).diagnosis.runTimeoutMs).toBe(120000);
  });
});
