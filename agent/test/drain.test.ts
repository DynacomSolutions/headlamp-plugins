import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DiagnosisStore } from '../src/store.js';
import type { Diagnosis } from '../src/agent/report.js';

const gate = vi.hoisted(() => ({
  release: undefined as undefined | (() => void),
  started: 0,
  ids: [] as string[],
  fail: false,
  progress: false,
  signal: undefined as undefined | AbortSignal,
  hook: undefined as undefined | ((id: string) => void),
}));

vi.mock('../src/agent/engine.js', () => ({
  diagnose: vi.fn(async (opts: { id: string; alert: unknown; source: string; host: string; budget: number; signal?: AbortSignal; model?: { name: string }; onEvent?: (e: unknown) => void }) => {
    gate.started++;
    gate.ids.push(opts.id);
    gate.signal = opts.signal;
    if (gate.fail) throw new Error('boom');
    const done = { id: opts.id, createdAt: 'x', status: 'done', source: opts.source, host: opts.host, alert: opts.alert, evidence: [], toolCalls: 0, toolBudget: opts.budget, model: opts.model?.name ?? 'm', a2ui: [] };
    if (gate.progress) {
      gate.hook?.(opts.id);
      opts.onEvent?.({ type: 'progress', diagnosis: { ...done, status: 'running' } });
      return done;
    }
    await new Promise<void>(resolve => (gate.release = resolve));
    return done;
  }),
}));

const legacyModels = () => ({
  routes: [{ id: 'gateway', style: 'openai' as const, baseUrl: 'http://127.0.0.1:1', apiKey: 'k', headers: {}, systemPrefix: '', maxTokens: 10, timeoutMs: 500 }],
  defaultModel: 'm',
  skipped: [],
});

const { Runner, startServer } = await import('../src/server.js');

function diagnosis(id: string, status: Diagnosis['status'], extra: Partial<Diagnosis> = {}): Diagnosis {
  return {
    id,
    createdAt: '2026-11-18T05:00:00.000Z',
    status,
    source: 'webhook',
    host: 'cluster',
    alert: { name: 'NodeNotReady', severity: 'critical', labels: {}, annotations: {}, startsAt: '2026-11-18T04:59:00Z', fingerprint: `f-${id}` },
    evidence: [{ id: 'e1', tool: 't', reason: 'r', summary: 's', ok: true }],
    toolCalls: 1,
    toolBudget: 5,
    model: 'm',
    a2ui: [],
    ...extra,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-drain-'));
  gate.release = undefined;
  gate.started = 0;
  gate.ids = [];
  gate.fail = false;
  gate.progress = false;
  gate.signal = undefined;
  gate.hook = undefined;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  expect(check()).toBe(true);
};

const past = '2020-01-01T00:00:00.000Z';
const files = (d: string) => readdirSync(join(d, 'diagnoses')).sort();
const read = (d: string, id: string) => JSON.parse(readFileSync(join(d, 'diagnoses', `${id}.json`), 'utf8')) as Diagnosis;

describe('DiagnosisStore files', () => {
  it('writes one file per diagnosis and reads it back, newest first', () => {
    const store = new DiagnosisStore(dir, 50);
    store.put(diagnosis('a', 'done', { createdAt: '2026-11-18T01:00:00.000Z' }));
    store.put(diagnosis('b', 'done', { createdAt: '2026-11-18T02:00:00.000Z' }));
    expect(files(dir)).toEqual(['a.json', 'b.json']);
    const other = new DiagnosisStore(dir, 50);
    expect(other.list().map(d => d.id)).toEqual(['b', 'a']);
    expect(other.get('a')).toMatchObject({ id: 'a', status: 'done' });
    expect(other.findByFingerprint('f-a', '2026-11-18T04:59:00Z')?.id).toBe('a');
  });

  it('prunes only finished files, oldest first', () => {
    const store = new DiagnosisStore(dir, 2);
    store.put(diagnosis('old', 'running', { createdAt: '2026-11-18T01:00:00.000Z' }));
    store.put(diagnosis('mid', 'done', { createdAt: '2026-11-18T02:00:00.000Z' }));
    store.put(diagnosis('new', 'done', { createdAt: '2026-11-18T03:00:00.000Z' }));
    expect(files(dir)).toEqual(['new.json', 'old.json']);
  });

  it('migrates diagnoses.json once', () => {
    writeFileSync(join(dir, 'diagnoses.json'), JSON.stringify([diagnosis('a', 'done'), diagnosis('b', 'running')]));
    const store = new DiagnosisStore(dir, 50);
    expect(files(dir)).toEqual(['a.json', 'b.json']);
    expect(existsSync(join(dir, 'diagnoses.json'))).toBe(false);
    expect(existsSync(join(dir, 'diagnoses.json.migrated'))).toBe(true);
    expect(store.get('b')?.status).toBe('running');
  });
});

describe('two stores on one directory', () => {
  const live = () => new Date(Date.now() + 60_000).toISOString();

  it('does not overwrite a record that another owner holds with a live lease', () => {
    const a = new DiagnosisStore(dir, 50, { owner: 'A' });
    const b = new DiagnosisStore(dir, 50, { owner: 'B' });
    expect(a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: live() }))).toBe(true);
    expect(b.put(diagnosis('x', 'queued', { owner: 'B', leaseUntil: live() }))).toBe(false);
    expect(read(dir, 'x')).toMatchObject({ owner: 'A', status: 'running' });
  });

  it('markResolved by B survives a later put by A', () => {
    const a = new DiagnosisStore(dir, 50, { owner: 'A' });
    const b = new DiagnosisStore(dir, 50, { owner: 'B' });
    a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: live() }));
    b.markResolved('f-x', '2026-11-18T06:00:00Z');
    a.put(diagnosis('x', 'done', { owner: 'A' }));
    expect(read(dir, 'x')).toMatchObject({ status: 'done', resolvedAt: '2026-11-18T06:00:00Z' });
  });

  it('B takes over only after the lease ends, keeping the id', async () => {
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), dataDir: dir };
    config.models = legacyModels();
    const a = new DiagnosisStore(dir, 50, { owner: 'A' });
    a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: live() }));
    const b = new DiagnosisStore(dir, 50, { owner: 'B' });
    const runner = new Runner({ toolHost: () => ({}) } as never, b, config);
    runner.scan();
    expect(gate.started).toBe(0);
    expect(read(dir, 'x').owner).toBe('A');

    a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: past }));
    runner.scan();
    await until(() => gate.started === 1);
    expect(gate.ids).toEqual(['x']);
    expect(read(dir, 'x')).toMatchObject({ owner: 'B', createdAt: '2026-11-18T05:00:00.000Z' });
    gate.release?.();
    await runner.drain();
    expect(read(dir, 'x').status).toBe('done');
  });

  it('marks an expired record failed without a model, or when resolved', () => {
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), dataDir: dir };
    const a = new DiagnosisStore(dir, 50, { owner: 'A' });
    a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: past }));
    const b = new DiagnosisStore(dir, 50, { owner: 'B' });
    new Runner({ toolHost: () => ({}) } as never, b, config).scan();
    expect(read(dir, 'x')).toMatchObject({ status: 'failed', error: 'Interrupted by a restart' });
  });

  it('drain releases the lease of items that have not started', async () => {
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), dataDir: dir };
    config.models = legacyModels();
    const a = new DiagnosisStore(dir, 50, { owner: 'A' });
    const runner = new Runner({ toolHost: () => ({}) } as never, a, config);
    const alert = diagnosis('x', 'queued').alert;
    const first = runner.enqueue(alert, 'api');
    const second = runner.enqueue({ ...alert, fingerprint: 'two' }, 'api');
    await until(() => gate.started === 1);
    const draining = runner.drain();
    expect(read(dir, second.id)).toMatchObject({ owner: 'A', status: 'queued', leaseUntil: new Date(0).toISOString() });
    expect(Date.parse(read(dir, first.id).leaseUntil ?? '')).toBeGreaterThan(Date.now());
    gate.release?.();
    await draining;
  });
});

describe('review fixes', () => {
  const modelConfig = () => {
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), dataDir: dir };
    config.models = legacyModels();
    return config;
  };
  const host = () => ({ toolHost: () => ({}) }) as never;

  it('renewal keeps a running lease alive past the lease time', async () => {
    let t = Date.parse('2026-11-18T06:00:00Z');
    const a = new DiagnosisStore(dir, 50, { owner: 'A', now: () => t });
    const b = new DiagnosisStore(dir, 50, { owner: 'B', now: () => t });
    const runnerA = new Runner(host(), a, modelConfig());
    const runnerB = new Runner(host(), b, modelConfig());
    const d = runnerA.enqueue(diagnosis('x', 'queued').alert, 'api');
    await until(() => gate.started === 1);
    t += 50_000;
    (runnerA as unknown as { renew(): void }).renew();
    t += 50_000; // 100 s after the start: the first lease is over, the renewed one is not.
    runnerB.scan();
    expect(gate.started).toBe(1);
    expect(read(dir, d.id).owner).toBe('A');
    gate.release?.();
    await runnerA.drain();
  });

  it('a crash does not loop: the record fails and no scan runs it again', async () => {
    let t = Date.parse('2026-11-18T06:00:00Z');
    const a = new DiagnosisStore(dir, 50, { owner: 'A', now: () => t });
    gate.fail = true;
    const runner = new Runner(host(), a, modelConfig());
    const d = runner.enqueue(diagnosis('x', 'queued').alert, 'api');
    await until(() => read(dir, d.id).status === 'failed');
    expect(read(dir, d.id).error).toBe('boom');
    t += 10 * 60_000;
    runner.scan();
    runner.scan();
    await new Promise(r => setTimeout(r, 50));
    expect(gate.started).toBe(1);
  });

  it('gives up after 3 attempts', () => {
    const a = new DiagnosisStore(dir, 50, { owner: 'A' });
    a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: past, attempts: 3 }));
    new Runner(host(), new DiagnosisStore(dir, 50, { owner: 'B' }), modelConfig()).scan();
    expect(gate.started).toBe(0);
    expect(read(dir, 'x')).toMatchObject({ status: 'failed', error: 'Gave up after 3 attempts' });
  });

  it('counts an attempt on each takeover', async () => {
    const a = new DiagnosisStore(dir, 50, { owner: 'A' });
    a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: past, attempts: 1 }));
    const runner = new Runner(host(), new DiagnosisStore(dir, 50, { owner: 'B' }), modelConfig());
    runner.scan();
    await until(() => gate.started === 1);
    expect(read(dir, 'x').attempts).toBe(2);
    gate.release?.();
    await runner.drain();
  });

  it('pod B takes over what pod A released on drain, A keeps the running one', async () => {
    const a = new DiagnosisStore(dir, 50, { owner: 'A' });
    const b = new DiagnosisStore(dir, 50, { owner: 'B' });
    const runnerA = new Runner(host(), a, modelConfig());
    const runnerB = new Runner(host(), b, modelConfig());
    const alert = diagnosis('x', 'queued').alert;
    const first = runnerA.enqueue(alert, 'api');
    const second = runnerA.enqueue({ ...alert, fingerprint: 'two' }, 'api');
    await until(() => gate.started === 1);
    const releaseA = gate.release;
    const draining = runnerA.drain();
    runnerB.scan();
    await until(() => gate.started === 2);
    expect(gate.ids).toEqual([first.id, second.id]);
    expect(read(dir, first.id).owner).toBe('A');
    expect(read(dir, second.id)).toMatchObject({ owner: 'B', id: second.id });
    gate.release?.();
    releaseA?.();
    await draining;
    await runnerB.drain();
    expect(read(dir, second.id).status).toBe('done');
    expect(read(dir, first.id).status).toBe('done');
  });

  it('aborts the run when a progress write says ownership is lost', async () => {
    const a = new DiagnosisStore(dir, 50, { owner: 'A' });
    const b = new DiagnosisStore(dir, 50, { owner: 'B' });
    gate.progress = true;
    // Before A's first progress write, B takes the record over.
    gate.hook = id => b.update(id, c => (c ? { ...c, owner: 'B', leaseUntil: b.lease() } : undefined), { force: true });
    const runner = new Runner(host(), a, modelConfig());
    const d = runner.enqueue(diagnosis('x', 'queued').alert, 'api');
    await until(() => gate.started === 1);
    await runner.drain();
    expect(gate.signal?.aborted).toBe(true);
    expect(read(dir, d.id)).toMatchObject({ owner: 'B', status: 'queued' });
  });

  it('one diagnosis for a duplicate webhook alert on two stores', async () => {
    const runnerA = new Runner(host(), new DiagnosisStore(dir, 50, { owner: 'A' }), modelConfig());
    const runnerB = new Runner(host(), new DiagnosisStore(dir, 50, { owner: 'B' }), modelConfig());
    const alert = diagnosis('x', 'queued').alert;
    const one = runnerA.enqueue(alert, 'webhook');
    const two = runnerB.enqueue(alert, 'webhook');
    expect(two.id).toBe(one.id);
    expect(one.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(files(dir)).toEqual([`${one.id}.json`]);
    await until(() => gate.started === 1);
    expect(read(dir, one.id).owner).toBe('A');
    gate.release?.();
    await runnerA.drain();
    await runnerB.drain();
    expect(gate.started).toBe(1);
  });
});

describe('restart and shutdown', () => {
  const base = () => ({ ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent', dataDir: dir });

  it('marks an interrupted diagnosis failed when no model is configured', async () => {
    writeFileSync(join(dir, 'diagnoses.json'), JSON.stringify([diagnosis('a', 'running')]));
    const server = await startServer(base(), 'test');
    await server.close();
    expect(read(dir, 'a')).toMatchObject({ id: 'a', status: 'failed', error: 'Interrupted by a restart' });
  });

  it('runs an interrupted diagnosis again with the same id, and close waits for it', async () => {
    writeFileSync(join(dir, 'diagnoses.json'), JSON.stringify([diagnosis('a', 'running')]));
    const config = base();
    config.models = legacyModels();
    const server = await startServer(config, 'test');
    await until(() => gate.started === 1);
    expect(gate.ids).toEqual(['a']);
    const url = `http://127.0.0.1:${server.port}`;

    let closed = false;
    const closing = server.close().then(() => (closed = true));
    await new Promise(r => setTimeout(r, 50));
    expect(closed).toBe(false);
    gate.release?.();
    await closing;
    expect(files(dir)).toEqual(['a.json']);
    expect(read(dir, 'a')).toMatchObject({ id: 'a', status: 'done', createdAt: '2026-11-18T05:00:00.000Z' });
    await expect(fetch(`${url}/readyz`)).rejects.toThrow();
  });
});

describe('Runner.drain', () => {
  it('waits for the running task and leaves later ones queued', async () => {
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), dataDir: '' };
    config.models = legacyModels();
    const store = new DiagnosisStore('', 50);
    const runner = new Runner({ toolHost: () => ({}) } as never, store, config);
    const alert = diagnosis('x', 'queued').alert;
    runner.enqueue(alert, 'api');
    const second = runner.enqueue({ ...alert, fingerprint: 'other' }, 'api');
    await until(() => gate.started === 1);
    let drained = false;
    const draining = runner.drain().then(() => (drained = true));
    await new Promise(r => setTimeout(r, 30));
    expect(drained).toBe(false);
    const late = runner.enqueue({ ...alert, fingerprint: 'late' }, 'api');
    gate.release?.();
    await draining;
    expect(gate.started).toBe(1);
    expect(store.get(second.id)?.status).toBe('queued');
    expect(store.get(late.id)?.status).toBe('queued');
  });
});

describe('hourly cap across pods', () => {
  it('counts webhook diagnoses from the shared store, so a new pod does not reset it', async () => {
    const { AlertGate } = await import('../src/alerts.js');
    const a = new DiagnosisStore(dir, 50);
    const b = new DiagnosisStore(dir, 50);
    const config = { toolBudget: 5, severities: ['critical'], maxPerHour: 2, ignoreAlerts: [] as string[] };
    const counter = (s: DiagnosisStore) => (since: number) => s.list().filter(d => d.source === 'webhook' && Date.parse(d.createdAt) >= since).length;
    const recent = new Date().toISOString();
    a.put(diagnosis('one', 'done', { createdAt: recent }));
    a.put(diagnosis('two', 'done', { createdAt: recent }));
    a.put(diagnosis('old', 'done', { createdAt: '2026-01-01T00:00:00.000Z' }));
    a.put(diagnosis('api', 'done', { createdAt: recent, source: 'api' }));
    const alert = { name: 'X', severity: 'critical', labels: {}, annotations: {}, startsAt: '', fingerprint: 'f' };
    // Pod B starts fresh but sees pod A's two webhook diagnoses from the last hour.
    expect(new AlertGate(config, counter(b)).wants(alert)).toEqual({ ok: false, reason: 'hourly diagnosis limit reached' });
    expect(new AlertGate({ ...config, maxPerHour: 3 }, counter(b)).wants(alert).ok).toBe(true);
  });
});

describe('model choice per run', () => {
  const two = () => {
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent', dataDir: dir };
    const route = (id: string, models: string[]) => ({ id, style: 'openai' as const, baseUrl: 'http://127.0.0.1:1', apiKey: 'k', headers: {}, systemPrefix: '', models, maxTokens: 10, timeoutMs: 500 });
    config.models = { routes: [route('one', ['a', 'b']), route('two', ['c'])], defaultModel: 'one/a', skipped: [] };
    return config;
  };
  const post = (port: number, path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const alert = { name: 'NodeNotReady', severity: 'critical', labels: { alertname: 'NodeNotReady' }, annotations: {}, startsAt: '2026-11-18T04:59:00Z' };

  it('lists the models on /api/models and counts them on /', async () => {
    const server = await startServer(two(), 'test');
    const res = await (await fetch(`http://127.0.0.1:${server.port}/api/models`)).json();
    expect(res.default).toBe('one/a');
    expect(res.models.map((m: { id: string }) => m.id)).toEqual(['one/a', 'one/b', 'two/c']);
    const root = await (await fetch(`http://127.0.0.1:${server.port}/`)).json();
    expect(root.diagnosis).toMatchObject({ model: 'one/a', models: 3, configured: true });
    await server.close();
  });

  it('runs a diagnosis with the model that POST /api/diagnoses names, and records the full id', async () => {
    gate.progress = true;
    const server = await startServer(two(), 'test');
    const res = await post(server.port, '/api/diagnoses', { alert, model: 'two/c' });
    expect(res.status).toBe(202);
    const { id } = await res.json();
    await until(() => read(dir, id).status === 'done');
    expect(read(dir, id).model).toBe('two/c');
    await server.close();
  });

  it('answers 400 with the valid ids for an unknown model', async () => {
    const server = await startServer(two(), 'test');
    const res = await post(server.port, '/api/diagnoses', { alert, model: 'two/zzz' });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain('one/a');
    expect(error).toContain('two/c');
    expect(gate.started).toBe(0);
    await server.close();
  });

  it('uses the agent_model label of a webhook alert, and the default when it is unknown', async () => {
    gate.progress = true;
    const server = await startServer(two(), 'test');
    const labels = (n: string, m: string) => ({ alertname: 'NodeNotReady', severity: 'critical', node: n, agent_model: m });
    await post(server.port, '/api/v2/alerts', [{ labels: labels('n1', 'two/c'), startsAt: '2026-11-18T04:59:00Z' }]);
    await post(server.port, '/api/v2/alerts', [{ labels: labels('n2', 'nope'), startsAt: '2026-11-18T04:59:00Z' }]);
    await until(() => gate.started === 2);
    await server.close();
    const models = readdirSync(join(dir, 'diagnoses')).map(f => read(dir, f.replace(/\.json$/, '')).model).sort();
    expect(models).toEqual(['one/a', 'two/c']);
  });

  it('runs an interrupted diagnosis again with its recorded model', async () => {
    gate.progress = true;
    const a = new DiagnosisStore(dir, 50, { owner: 'A' });
    a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: past, model: 'two/c' }));
    const runner = new Runner(host2(), new DiagnosisStore(dir, 50, { owner: 'B' }), two());
    runner.scan();
    await until(() => gate.started === 1);
    await runner.drain();
    expect(read(dir, 'x').model).toBe('two/c');
  });
});

const host2 = () => ({ toolHost: () => ({}) }) as never;
