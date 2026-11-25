import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatError, ChatService, systemPrompt, trimHistory } from '../src/agent/chat.js';
import { ModelCatalogue } from '../src/agent/catalogue.js';
import type { ToolHost } from '../src/agent/engine.js';
import type { Message } from '../src/agent/model.js';
import type { Diagnosis } from '../src/agent/report.js';
import { ChatStore, type Chat } from '../src/chats.js';
import { loadConfig, type ModelRoutesConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { MemoryDiagnosisStore, type DiagnosisStore } from '../src/store.js';

const realFetch = globalThis.fetch;
const FAKE_TOKEN = ['abc', '123'].join('');
const GW = 'http://gw.invalid/gateway';

const models = (): ModelRoutesConfig => ({
  routes: [{ id: 'gateway', style: 'openai', baseUrl: GW, apiKey: 'k', headers: {}, systemPrefix: '', models: ['m1', 'm2'], maxTokens: 100, timeoutMs: 1000 }],
  defaultModel: 'gateway/m1',
  skipped: [],
});

type Reply = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };
const script = { queue: [] as Array<Reply | (() => Promise<Reply>)>, requests: [] as any[] };

/** Answers the model endpoint from the script; every other URL goes to the real fetch. */
function stubGateway(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(GW)) return realFetch(input as string, init);
    if (url.endsWith('/models')) return new Response('nope', { status: 500 });
    script.requests.push(JSON.parse(String(init?.body)));
    const next = script.queue.shift();
    const reply = typeof next === 'function' ? await next() : (next ?? { text: 'ok' });
    const message = {
      content: reply.text ?? null,
      tool_calls: (reply.calls ?? []).map((c, i) => ({ id: `call${script.requests.length}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: reply.calls?.length ? 'tool_calls' : 'stop' }], usage: {} }), { status: 200 });
  });
}

function host(calls: string[] = []): ToolHost {
  return {
    list: async () => [{ name: 'get_resource', description: 'Get one', parameters: { type: 'object', properties: { kind: { type: 'string' } } } }],
    call: async (name, args) => {
      calls.push(name);
      return { ok: true, summary: 'Pod is CrashLoopBackOff.', data: { args, note: `token=${FAKE_TOKEN}` } };
    },
  };
}

function diagnosis(id: string): Diagnosis {
  return {
    id,
    createdAt: '2026-11-18T05:00:00.000Z',
    status: 'done',
    source: 'webhook',
    alert: { name: 'KubePodCrashLooping', severity: 'warning', labels: { pod: 'web-1' }, annotations: {}, startsAt: '2026-11-18T05:00:00Z', fingerprint: 'f' },
    evidence: [{ id: 'e1', tool: 'get_resource', reason: 'r', summary: 'OOMKilled seen', ok: true }],
    result: { summary: 'The pod ran out of memory.', likelyCause: 'Memory limit too low.', confidence: 'high', signals: [], fixes: [{ title: 'Raise the limit', detail: 'In Git.', recommended: true }], verify: 'No restarts.' },
    toolCalls: 1,
    toolBudget: 10,
    model: 'gateway/m1',
    a2ui: [],
  };
}

const until = async (fn: () => boolean) => {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise(r => setTimeout(r, 5));
  expect(fn()).toBe(true);
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-chats-'));
  script.queue = [];
  script.requests = [];
  stubGateway();
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function service(calls: string[] = [], overrides: { maxTurns?: number; diagnoses?: DiagnosisStore } = {}) {
  const store = new ChatStore(dir);
  const diagnoses = overrides.diagnoses ?? new MemoryDiagnosisStore();
  const chats = new ChatService({ store, diagnoses, tools: host(calls), catalogue: new ModelCatalogue(models()), budget: 2, maxTurns: overrides.maxTurns ?? 3 });
  return { store, chats, diagnoses };
}

describe('chat service', () => {
  it('creates, lists, patches and deletes chats, and validates the model', async () => {
    const { chats } = service();
    const { id } = await chats.create({});
    expect(chats.get(id)).toMatchObject({ id, title: 'New chat', model: 'gateway/m1', running: false, messages: [] });
    await expect(chats.create({ model: 'gateway/nope' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('gateway/m2') });
    const second = await chats.create({ model: 'gateway/m2' });
    expect(chats.list(50).map(c => c.id)).toEqual([second.id, id]);
    expect(await chats.patch(id, { title: 'Disk alarm', model: 'gateway/m2' })).toMatchObject({ id, title: 'Disk alarm', model: 'gateway/m2', running: false });
    await expect(chats.patch(id, { model: 'bad/x' })).rejects.toMatchObject({ status: 400 });
    chats.delete(id);
    expect(() => chats.get(id)).toThrow(ChatError);
    expect(existsSync(join(dir, 'chats', `${id}.json`))).toBe(false);
    await expect(chats.create({ diagnosisId: 'missing' })).rejects.toMatchObject({ status: 404 });
  });

  it('runs a turn with one tool call and a final answer, storing steps during the turn', async () => {
    const calls: string[] = [];
    const { chats } = service(calls);
    let release: () => void = () => undefined;
    script.queue.push({ text: 'Let me look.', calls: [{ name: 'get_resource', args: { reason: 'Is the pod healthy?', kind: 'Pod' } }] });
    script.queue.push(async () => {
      await new Promise<void>(r => (release = r));
      return { text: 'The pod is crash looping.' };
    });
    const { id } = await chats.create({});
    const { messageId } = await chats.send(id, '  Why is   web-1 failing?  ');
    const mid = chats.get(id) as any;
    expect(mid.running).toBe(true);
    expect(mid.title).toBe('Why is web-1 failing?');
    await until(() => (chats.get(id) as any).messages[1].steps[0]?.status === 'done');
    const during = (chats.get(id) as any).messages[1];
    expect(during).toMatchObject({ id: messageId, role: 'assistant', status: 'running', text: 'Let me look.' });
    expect(during.steps[0]).toMatchObject({ tool: 'get_resource', reason: 'Is the pod healthy?', ok: true, summary: 'Pod is CrashLoopBackOff.', status: 'done' });
    release();
    await until(() => !(chats.get(id) as any).running);
    const done = chats.get(id) as any;
    expect(done.messages[0]).toMatchObject({ role: 'user', text: '  Why is   web-1 failing?  ', status: 'done' });
    expect(done.messages[1]).toMatchObject({ status: 'done', text: 'Let me look.\n\nThe pod is crash looping.', model: 'gateway/m1' });
    expect(done.messages[1].trace).toBeUndefined();
    expect(calls).toEqual(['get_resource']);
    // The second model call saw the masked tool result, and the system prompt names the budget.
    const second = script.requests[1];
    expect(JSON.stringify(second)).not.toContain(FAKE_TOKEN);
    expect(second.messages[0].content).toContain('at most 2 tool calls');
    expect(second.messages.some((m: any) => m.role === 'tool')).toBe(true);
    expect(second.tools[0].function.parameters.required).toContain('reason');
  });

  it('sends the whole history on the next turn, and switches the model with a message', async () => {
    const { chats } = service();
    script.queue.push({ text: 'One.' }, { text: 'Two.' });
    const { id } = await chats.create({});
    await chats.send(id, 'first');
    await until(() => !(chats.get(id) as any).running);
    await chats.send(id, 'second', 'gateway/m2');
    await until(() => !(chats.get(id) as any).running);
    expect((chats.get(id) as any).model).toBe('gateway/m2');
    expect(script.requests[1].model).toBe('m2');
    expect(script.requests[1].messages.map((m: any) => m.content)).toContain('first');
    expect(script.requests[1].messages.map((m: any) => m.content)).toContain('One.');
    await expect(chats.send(id, 'third', 'gateway/nope')).rejects.toMatchObject({ status: 400 });
  });

  it('answers 409 for a parallel turn in the same chat and 429 above the turn cap', async () => {
    const { chats } = service([], { maxTurns: 1 });
    let release: () => void = () => undefined;
    script.queue.push(async () => {
      await new Promise<void>(r => (release = r));
      return { text: 'late' };
    });
    const a = await chats.create({});
    const b = await chats.create({});
    await chats.send(a.id, 'hello');
    await expect(chats.send(a.id, 'again')).rejects.toMatchObject({ status: 409 });
    await expect(chats.send(b.id, 'hello')).rejects.toMatchObject({ status: 429 });
    release();
    await until(() => !(chats.get(a.id) as any).running);
    await expect(chats.send(b.id, 'hello')).resolves.toBeTruthy();
  });

  it('cancels a running turn and keeps what it had', async () => {
    const { chats } = service();
    script.queue.push({ text: 'Looking.', calls: [{ name: 'get_resource', args: { reason: 'x' } }] });
    script.queue.push(() => new Promise<Reply>(() => undefined));
    const { id } = await chats.create({});
    await chats.send(id, 'hello');
    await until(() => script.requests.length === 2);
    chats.cancel(id);
    const c = chats.get(id) as any;
    expect(c.running).toBe(false);
    expect(c.messages[1]).toMatchObject({ status: 'cancelled', text: 'Looking.' });
    await new Promise(r => setTimeout(r, 20));
    expect((chats.get(id) as any).messages[1].status).toBe('cancelled');
    chats.cancel(id);
    await expect(chats.send(id, 'next')).resolves.toBeTruthy();
  });

  it('marks a failed model call and a used-up budget', async () => {
    const calls: string[] = [];
    const { chats } = service(calls);
    const call = { name: 'get_resource', args: { reason: 'again' } };
    script.queue.push({ calls: [call, call, call] }, { text: 'Done with two.' });
    const { id } = await chats.create({});
    await chats.send(id, 'hello');
    await until(() => !(chats.get(id) as any).running);
    const m = (chats.get(id) as any).messages[1];
    expect(m.status).toBe('done');
    expect(calls).toHaveLength(2);
    expect(m.steps.map((s: any) => s.ok)).toEqual([true, true, false]);
    expect(m.steps[2].summary).toMatch(/budget/);

    vi.stubGlobal('fetch', async (input: string) => (String(input).startsWith(GW) ? new Response('bad key', { status: 401 }) : realFetch(input)));
    await chats.send(id, 'again');
    await until(() => !(chats.get(id) as any).running);
    expect((chats.get(id) as any).messages[3]).toMatchObject({ status: 'failed', error: expect.stringContaining('401') });
  });

  it('puts the diagnosis into the system prompt', async () => {
    const diagnoses = new MemoryDiagnosisStore();
    await diagnoses.put(diagnosis('d1'));
    const { chats } = service([], { diagnoses });
    script.queue.push({ text: 'It ran out of memory.' });
    const { id } = await chats.create({ diagnosisId: 'd1' });
    expect(chats.get(id)).toMatchObject({ diagnosisId: 'd1' });
    await chats.send(id, 'What happened?');
    await until(() => !(chats.get(id) as any).running);
    const system = script.requests[0].messages[0].content as string;
    expect(system).toContain('You are chatting with an operator');
    expect(system).toContain('KubePodCrashLooping');
    expect(system).toContain('Memory limit too low.');
    expect(system).toContain('OOMKilled seen');
    expect(systemPrompt(3)).not.toContain('KubePodCrashLooping');
  });

  it('links one chat to several incidents and puts all of them into the system prompt', async () => {
    const diagnoses = new MemoryDiagnosisStore();
    const second = { ...diagnosis('d2'), alert: { ...diagnosis('d2').alert, name: 'NodeDiskPressure' } };
    await diagnoses.put(diagnosis('d1'));
    await diagnoses.put(second);
    const { chats } = service([], { diagnoses });
    script.queue.push({ text: 'Both share one cause.' });
    // A repeated id counts once. The old single field still works next to the new list.
    const { id } = await chats.create({ diagnosisIds: ['d1', 'd2', 'd1'] });
    expect(chats.get(id)).toMatchObject({ diagnosisId: 'd1', diagnosisIds: ['d1', 'd2'] });
    expect(chats.list(50)[0]).toMatchObject({ id, diagnosisIds: ['d1', 'd2'] });
    expect(chats.list(50, 'd2').map(c => c.id)).toEqual([id]);
    expect(chats.list(50, 'other')).toEqual([]);
    await chats.send(id, 'Compare them');
    await until(() => !(chats.get(id) as any).running);
    const system = script.requests[0].messages[0].content as string;
    expect(system).toContain('The 2 incidents this chat is about');
    expect(system).toContain('Incident 1 of 2');
    expect(system).toContain('Incident 2 of 2');
    expect(system).toContain('Diagnosis d1');
    expect(system).toContain('Diagnosis d2');
    expect(system).toContain('NodeDiskPressure');
    // The file keeps the list, and a chat written before the list existed still loads.
    const file = JSON.parse(readFileSync(join(dir, 'chats', `${id}.json`), 'utf8'));
    expect(file.diagnosisIds).toEqual(['d1', 'd2']);
    const old = await chats.create({ diagnosisId: 'd1' });
    expect(chats.get(old.id)).toMatchObject({ diagnosisId: 'd1', diagnosisIds: ['d1'] });
    delete (file as any).diagnosisIds;
    writeFileSync(join(dir, 'chats', `${id}.json`), JSON.stringify(file));
    expect(service().chats.get(id)).toMatchObject({ diagnosisIds: ['d1'] });
  });

  it('rejects a missing incident or too many incidents for one chat', async () => {
    const diagnoses = new MemoryDiagnosisStore();
    await diagnoses.put(diagnosis('d1'));
    const { chats } = service([], { diagnoses });
    await expect(chats.create({ diagnosisIds: ['d1', 'missing'] })).rejects.toMatchObject({ status: 404, message: 'No diagnosis missing' });
    const many = Array.from({ length: 21 }, (_, i) => `d${i}`);
    await expect(chats.create({ diagnosisIds: many })).rejects.toMatchObject({ status: 400 });
  });

  it('lists the older incidents of a large group in one short line each', async () => {
    const diagnoses = new MemoryDiagnosisStore();
    const mk = (id: string, cause: string): Diagnosis => ({
      ...diagnosis(id),
      createdAt: `2026-11-25T10:00:${id.slice(1).padStart(2, '0')}Z`,
      resolvedAt: id === 'd5' ? '2026-11-25T11:00:00Z' : undefined,
      result: { ...diagnosis(id).result!, likelyCause: cause },
    });
    for (const id of ['d1', 'd2', 'd3', 'd4', 'd5']) await diagnoses.put(mk(id, `cause of ${id}`));
    const { chats } = service([], { diagnoses });
    script.queue.push({ text: 'Mostly one cause.' });
    // d1 and d2 get the full context. d3 to d5 and a removed incident get a short line, or none.
    const { id } = await chats.create({ diagnosisIds: ['d1', 'd2'], groupName: 'KubePodCrashLooping', summaryIds: ['d3', 'd4', 'd5', 'gone', 'd1'], groupOmitted: 7 });
    expect(chats.get(id)).toMatchObject({ diagnosisIds: ['d1', 'd2'], groupName: 'KubePodCrashLooping', groupCount: 12 });
    await chats.send(id, 'Is this one root cause?');
    await until(() => !(chats.get(id) as any).running);
    const system = script.requests[0].messages[0].content as string;
    expect(system).toContain('Incident 1 of 2');
    expect(system).toContain('## The group of incidents: KubePodCrashLooping');
    expect(system).toContain('with 12 incidents');
    expect(system).toContain('The next 3 have one short line each');
    expect(system).toMatch(/- d3 \| .*cause: cause of d3/);
    expect(system).toMatch(/- d5 \| .*resolved.*cause: cause of d5/);
    expect(system).toContain('(7 more older incidents are not listed.)');
    expect(system).not.toContain('Incident 3 of');
    expect(system).not.toContain('gone');
  });

  it('counts the short lines that do not fit instead of cutting one in half', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ ...diagnosis(`s${i}`), result: { ...diagnosis(`s${i}`).result!, likelyCause: 'x'.repeat(400) } }));
    const prompt = systemPrompt(3, [diagnosis('d1'), diagnosis('d2')], { name: 'Big', summaries: many });
    expect(prompt).toContain('The next 300 have');
    expect(prompt).toMatch(/\(\d+ more older incidents are not listed\.\)/);
    expect(prompt.length).toBeLessThan(48_000 + 30_000 + 30_000);
  });

  it('rejects a short list without full incidents, and too long a short list', async () => {
    const diagnoses = new MemoryDiagnosisStore();
    await diagnoses.put(diagnosis('d1'));
    const { chats } = service([], { diagnoses });
    await expect(chats.create({ summaryIds: ['d1'] })).rejects.toMatchObject({ status: 400 });
    await expect(chats.create({ diagnosisIds: ['d1'], summaryIds: Array.from({ length: 501 }, (_, i) => `s${i}`) })).rejects.toMatchObject({ status: 400 });
  });

  it('shares the prompt budget between the linked incidents', () => {
    const big = (id: string): Diagnosis => ({ ...diagnosis(id), evidence: Array.from({ length: 400 }, (_, i) => ({ id: `e${i}`, tool: 'get_resource', reason: 'r', summary: 'x'.repeat(100), ok: true })) });
    const ids = Array.from({ length: 20 }, (_, i) => `d${i}`);
    const prompt = systemPrompt(3, ids.map(big));
    for (const id of ids) expect(prompt).toContain(`Diagnosis ${id}`);
    expect(prompt.length).toBeLessThan(80_000);
  });

  it('trims the oldest tool results first', () => {
    const tool = (content: string): Message => ({ role: 'tool', results: [{ id: 'x', name: 'n', content, isError: false }] });
    const history: Message[] = [tool('a'.repeat(200)), { role: 'user', text: 'q' }, tool('b'.repeat(200))];
    const out = trimHistory(history, 300);
    expect((out[0] as any).results[0].content).toMatch(/removed/);
    expect((out[2] as any).results[0].content).toBe('b'.repeat(200));
    expect((history[0] as any).results[0].content).toBe('a'.repeat(200));
  });
});

describe('chat store', () => {
  it('marks an interrupted turn failed on load and caps the number of chats', () => {
    const chat: Chat = {
      id: 'c1',
      title: 't',
      model: 'gateway/m1',
      createdAt: '2026-11-18T05:00:00.000Z',
      updatedAt: '2026-11-18T05:00:00.000Z',
      messages: [
        { id: 'u', role: 'user', text: 'hi', createdAt: 'x', status: 'done', steps: [] },
        { id: 'a', role: 'assistant', text: 'part', createdAt: 'x', status: 'running', steps: [{ id: 's1', tool: 'get_resource', reason: 'r', status: 'running' }] },
      ],
    };
    new ChatStore(dir); // creates the directory
    writeFileSync(join(dir, 'chats', 'c1.json'), JSON.stringify(chat));
    const store = new ChatStore(dir);
    const loaded = store.get('c1')!;
    expect(loaded.messages[1]).toMatchObject({ status: 'failed', error: 'interrupted by restart', text: 'part' });
    expect(loaded.messages[1].steps[0]).toMatchObject({ status: 'done', ok: false });
    expect(JSON.parse(readFileSync(join(dir, 'chats', 'c1.json'), 'utf8')).messages[1].status).toBe('failed');
    // No count limit drops a chat: the old one stays however many are made.
    for (let i = 0; i < 205; i++) store.create({ model: 'm' });
    expect(store.list()).toHaveLength(206);
    expect(store.get('c1')).toBeDefined();
    expect(new ChatStore(dir).list()).toHaveLength(206);
  });
});

describe('chat routes', () => {
  async function api(base: string, method: string, path: string, body?: unknown) {
    const res = await realFetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  it('serves the contract with its status codes', async () => {
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent', dataDir: dir, models: models() };
    const server = await startServer(config, 'test');
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const listed = await api(base, 'GET', '/api/models');
      expect(listed.body.models[0]).toEqual({ id: 'gateway/m1', route: 'gateway', model: 'm1', name: 'm1' });
      expect((await api(base, 'GET', '/api/chats')).body).toEqual({ chats: [] });
      expect((await api(base, 'POST', '/api/chats', { model: 'gateway/zzz' })).status).toBe(400);
      expect((await api(base, 'POST', '/api/chats', { diagnosisId: 'nope' })).status).toBe(404);
      expect((await api(base, 'POST', '/api/chats', { diagnosisIds: ['nope'] })).status).toBe(404);
      expect((await api(base, 'POST', '/api/chats', { diagnosisIds: [] })).status).toBe(400);
      // The group fields pass the schema (the unknown incident is the only error), and a short list alone is refused.
      expect((await api(base, 'POST', '/api/chats', { diagnosisIds: ['nope'], groupName: 'A', summaryIds: ['x'], groupOmitted: 3 })).status).toBe(404);
      expect((await api(base, 'POST', '/api/chats', { summaryIds: ['x'] })).status).toBe(400);
      expect((await api(base, 'POST', '/api/chats', { diagnosisIds: ['nope'], groupOmitted: 0 })).status).toBe(400);
      expect((await api(base, 'POST', '/api/chats', { diagnosisIds: Array.from({ length: 21 }, (_, i) => `d${i}`) })).status).toBe(400);
      const created = await api(base, 'POST', '/api/chats', {});
      expect(created.status).toBe(201);
      const id = created.body.id as string;
      expect((await api(base, 'GET', `/api/chats/${id}`)).body).toMatchObject({ id, title: 'New chat', model: 'gateway/m1', running: false, messages: [] });
      expect((await api(base, 'GET', '/api/chats/missing')).status).toBe(404);
      expect((await api(base, 'POST', `/api/chats/${id}/messages`, { text: '' })).status).toBe(400);
      expect((await api(base, 'POST', `/api/chats/${id}/messages`, { text: 'x'.repeat(8001) })).status).toBe(400);
      script.queue.push(() => new Promise<Reply>(r => setTimeout(() => r({ text: 'Fine.' }), 80)));
      const sent = await api(base, 'POST', `/api/chats/${id}/messages`, { text: 'How is the cluster?' });
      expect(sent.status).toBe(202);
      expect(sent.body.messageId).toBeTruthy();
      expect((await api(base, 'POST', `/api/chats/${id}/messages`, { text: 'again' })).status).toBe(409);
      expect((await api(base, 'GET', '/api/chats')).body.chats[0]).toMatchObject({ id, title: 'How is the cluster?', running: true });
      await until(() => script.requests.length === 1);
      for (let i = 0; i < 200; i++) {
        if (!(await api(base, 'GET', `/api/chats/${id}`)).body.running) break;
        await new Promise(r => setTimeout(r, 10));
      }
      const done = (await api(base, 'GET', `/api/chats/${id}`)).body;
      expect(done.messages.map((m: any) => [m.role, m.status, m.text])).toEqual([
        ['user', 'done', 'How is the cluster?'],
        ['assistant', 'done', 'Fine.'],
      ]);
      expect((await api(base, 'PATCH', `/api/chats/${id}`, { title: 'Status' })).body).toMatchObject({ id, title: 'Status', running: false });
      expect((await api(base, 'POST', `/api/chats/${id}/cancel`)).status).toBe(200);
      expect((await api(base, 'DELETE', `/api/chats/${id}`)).status).toBe(204);
      expect((await api(base, 'GET', `/api/chats/${id}`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe('diagnosis list route', () => {
  it('reports the real total and pages with offset', async () => {
    const seed = new MemoryDiagnosisStore();
    for (let i = 0; i < 5; i++) await seed.put({ ...diagnosis(`d${i}`), createdAt: `2026-11-18T05:00:0${i}.000Z` });
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent', dataDir: dir, models: models() };
    const server = await startServer(config, 'test', { store: seed });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const get = async (q: string) => (await (await realFetch(`${base}/api/diagnoses${q}`)).json()) as { total: number; diagnoses: Array<{ id: string }> };
      const first = await get('?limit=2');
      expect(first.total).toBe(5);
      expect(first.diagnoses.map(d => d.id)).toEqual(['d4', 'd3']);
      expect((await get('?limit=2&offset=2')).diagnoses.map(d => d.id)).toEqual(['d2', 'd1']);
      expect((await get('?limit=2&offset=4')).diagnoses.map(d => d.id)).toEqual(['d0']);
      expect((await get('?limit=2&offset=-3')).diagnoses.map(d => d.id)).toEqual(['d4', 'd3']);
      expect((await get('?offset=99')).diagnoses).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
