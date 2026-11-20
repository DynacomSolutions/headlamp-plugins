import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MemoryDiagnosisStore, type DiagnosisStore } from '../src/store.js';
import { pgliteDb, podStore } from './helpers/pglite.js';
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
let db: ReturnType<typeof pgliteDb>;
let reader: DiagnosisStore;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-drain-'));
  db = pgliteDb();
  reader = await podStore(db, { owner: 'reader' });
  gate.release = undefined;
  gate.started = 0;
  gate.ids = [];
  gate.fail = false;
  gate.progress = false;
  gate.signal = undefined;
  gate.hook = undefined;
});
afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await check()); i++) await new Promise(r => setTimeout(r, 10));
  expect(await check()).toBe(true);
};

const past = '2020-01-01T00:00:00.000Z';
const read = async (id: string) => (await reader.get(id)) as Diagnosis;
const ids = async () => (await reader.page()).diagnoses.map(d => d.id).sort();
/** One pod: a store on the shared database. */
const pod = (owner: string, now?: () => number) => podStore(db, { owner, now });

describe('PgDiagnosisStore', () => {
  it('stores one row per diagnosis and pages them newest first', async () => {
    const store = await pod('A');
    await store.put(diagnosis('a', 'done', { createdAt: '2026-11-18T01:00:00.000Z' }));
    await store.put(diagnosis('b', 'done', { createdAt: '2026-11-18T02:00:00.000Z' }));
    const other = await pod('B');
    const page = await other.page();
    expect(page.total).toBe(2);
    expect(page.diagnoses.map(d => d.id)).toEqual(['b', 'a']);
    expect(page.diagnoses[0]).toMatchObject({ evidenceCount: 1 });
    expect(page.diagnoses[0]).not.toHaveProperty('evidence');
    expect(page.diagnoses[0]).not.toHaveProperty('a2ui');
    expect(await other.get('a')).toMatchObject({ id: 'a', status: 'done' });
    expect((await other.findByFingerprint('f-a', '2026-11-18T04:59:00Z'))?.id).toBe('a');
  });

  it('keeps every diagnosis: nothing is pruned past 200, and the pages cover them all', async () => {
    const store = await pod('A');
    for (let i = 0; i < 250; i++) {
      const n = String(i).padStart(3, '0');
      await store.put(diagnosis(`d${n}`, i % 2 ? 'failed' : 'done', { createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString() }));
    }
    const first = await store.page({ limit: 100 });
    expect(first.total).toBe(250);
    expect(first.diagnoses).toHaveLength(100);
    expect(first.diagnoses[0]!.id).toBe('d249');
    const last = await store.page({ offset: 200, limit: 100 });
    expect(last.total).toBe(250);
    expect(last.diagnoses.map(d => d.id)).toEqual(Array.from({ length: 50 }, (_, i) => `d${String(49 - i).padStart(3, '0')}`));
    expect(await store.get('d000')).toMatchObject({ id: 'd000', status: 'done' });
    const all = new Set<string>();
    for (let offset = 0; offset < 250; offset += 60) for (const d of (await store.page({ offset, limit: 60 })).diagnoses) all.add(d.id);
    expect(all.size).toBe(250);
  });

  it('filters the page by alert name and counts the matches', async () => {
    const store = await pod('A');
    await store.put(diagnosis('a', 'done'));
    await store.put(diagnosis('b', 'done', { alert: { ...diagnosis('b', 'done').alert, name: 'DiskFull' } }));
    const r = await store.page({ alert: 'disk' });
    expect(r.total).toBe(1);
    expect(r.diagnoses.map(d => d.id)).toEqual(['b']);
  });

  it('keeps the records when the process restarts', async () => {
    const dbDir = join(dir, 'pg');
    const first = pgliteDb(dbDir);
    const a = await podStore(first, { owner: 'A' });
    for (let i = 0; i < 230; i++) await a.put(diagnosis(`r${i}`, 'done', { createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString() }));
    await a.put(diagnosis('open', 'running', { owner: 'A', leaseUntil: past }));
    await first.close();
    const second = pgliteDb(dbDir);
    const b = await podStore(second, { owner: 'B' });
    expect((await b.page()).total).toBe(231);
    expect(await b.get('r0')).toMatchObject({ status: 'done' });
    expect((await b.stale()).map(d => d.id)).toEqual(['open']);
    await second.close();
  });

  it('imports the old JSON files once and leaves them in place', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'diagnoses'));
    writeFileSync(join(dir, 'diagnoses', 'a.json'), JSON.stringify(diagnosis('a', 'done')));
    writeFileSync(join(dir, 'diagnoses', 'broken.json'), '{ not json');
    writeFileSync(join(dir, 'diagnoses.json.migrated'), JSON.stringify([diagnosis('a', 'running'), diagnosis('b', 'running')]));
    const store = await podStore(db, { owner: 'A' }, dir);
    expect(await ids()).toEqual(['a', 'b']);
    expect((await read('a')).status).toBe('done'); // The first copy wins.
    // A new start imports nothing again and does not overwrite what the database holds.
    await store.update('b', d => (d ? { ...d, status: 'failed' } : undefined), { force: true });
    await podStore(db, { owner: 'B' }, dir);
    expect((await read('b')).status).toBe('failed');
    expect(await ids()).toEqual(['a', 'b']);
  });

  it('only one of two parallel creates of the same id wins', async () => {
    const a = await pod('A');
    const b = await pod('B');
    const results = await Promise.all([a.putNew(diagnosis('x', 'queued', { owner: 'A' })), b.putNew(diagnosis('x', 'queued', { owner: 'B' }))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await reader.page()).total).toBe(1);
  });

  it('counts webhook diagnoses since a time', async () => {
    const a = await pod('A');
    await a.put(diagnosis('one', 'done', { createdAt: new Date().toISOString() }));
    await a.put(diagnosis('old', 'done', { createdAt: '2026-01-01T00:00:00.000Z' }));
    await a.put(diagnosis('api', 'done', { createdAt: new Date().toISOString(), source: 'api' }));
    expect(await a.countStartedSince(Date.now() - 3600_000)).toBe(1);
  });
});

describe('MemoryDiagnosisStore', () => {
  it('never prunes and pages like the database store', async () => {
    const store = new MemoryDiagnosisStore();
    for (let i = 0; i < 300; i++) await store.put(diagnosis(`m${i}`, 'done', { createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString() }));
    const page = await store.page({ offset: 250, limit: 100 });
    expect(page.total).toBe(300);
    expect(page.diagnoses).toHaveLength(50);
    expect(await store.stale()).toEqual([]);
  });
});

describe('two stores on one database', () => {
  const live = () => new Date(Date.now() + 60_000).toISOString();

  it('does not overwrite a record that another owner holds with a live lease', async () => {
    const a = await pod('A');
    const b = await pod('B');
    expect(await a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: live() }))).toBe(true);
    expect(await b.put(diagnosis('x', 'queued', { owner: 'B', leaseUntil: live() }))).toBe(false);
    expect(await read('x')).toMatchObject({ owner: 'A', status: 'running' });
  });

  it('markResolved by B survives a later put by A', async () => {
    const a = await pod('A');
    const b = await pod('B');
    await a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: live() }));
    await b.markResolved('f-x', '2026-11-18T06:00:00Z');
    await a.put(diagnosis('x', 'done', { owner: 'A' }));
    expect(await read('x')).toMatchObject({ status: 'done', resolvedAt: '2026-11-18T06:00:00Z' });
  });

  it('B takes over only after the lease ends, keeping the id', async () => {
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), dataDir: dir };
    config.models = legacyModels();
    const a = await pod('A');
    await a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: live() }));
    const b = await pod('B');
    const runner = new Runner({ toolHost: () => ({}) } as never, b, config);
    await runner.scan();
    expect(gate.started).toBe(0);
    expect((await read('x')).owner).toBe('A');

    await a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: past }));
    await runner.scan();
    await until(() => gate.started === 1);
    expect(gate.ids).toEqual(['x']);
    expect(await read('x')).toMatchObject({ owner: 'B', createdAt: '2026-11-18T05:00:00.000Z' });
    gate.release?.();
    await runner.drain();
    expect((await read('x')).status).toBe('done');
  });

  it('marks an expired record failed without a model, or when resolved', async () => {
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), dataDir: dir };
    const a = await pod('A');
    await a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: past }));
    const b = await pod('B');
    await new Runner({ toolHost: () => ({}) } as never, b, config).scan();
    expect(await read('x')).toMatchObject({ status: 'failed', error: 'Interrupted by a restart' });
  });

  it('drain releases the lease of items that have not started', async () => {
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), dataDir: dir };
    config.models = legacyModels();
    const a = await pod('A');
    const runner = new Runner({ toolHost: () => ({}) } as never, a, config);
    const alert = diagnosis('x', 'queued').alert;
    const first = await runner.enqueue(alert, 'api');
    const second = await runner.enqueue({ ...alert, fingerprint: 'two' }, 'api');
    await until(() => gate.started === 1);
    const draining = runner.drain();
    await until(async () => (await read(second.id)).leaseUntil === new Date(0).toISOString());
    expect(await read(second.id)).toMatchObject({ owner: 'A', status: 'queued' });
    expect(Date.parse((await read(first.id)).leaseUntil ?? '')).toBeGreaterThan(Date.now());
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
    const a = await pod('A', () => t);
    const b = await pod('B', () => t);
    const runnerA = new Runner(host(), a, modelConfig());
    const runnerB = new Runner(host(), b, modelConfig());
    const d = await runnerA.enqueue(diagnosis('x', 'queued').alert, 'api');
    await until(() => gate.started === 1);
    t += 50_000;
    await (runnerA as unknown as { renew(): Promise<void> }).renew();
    t += 50_000; // 100 s after the start: the first lease is over, the renewed one is not.
    await runnerB.scan();
    expect(gate.started).toBe(1);
    expect((await read(d.id)).owner).toBe('A');
    gate.release?.();
    await runnerA.drain();
  });

  it('a crash does not loop: the record fails and no scan runs it again', async () => {
    let t = Date.parse('2026-11-18T06:00:00Z');
    const a = await pod('A', () => t);
    gate.fail = true;
    const runner = new Runner(host(), a, modelConfig());
    const d = await runner.enqueue(diagnosis('x', 'queued').alert, 'api');
    await until(async () => (await read(d.id)).status === 'failed');
    expect((await read(d.id)).error).toBe('boom');
    t += 10 * 60_000;
    await runner.scan();
    await runner.scan();
    await new Promise(r => setTimeout(r, 50));
    expect(gate.started).toBe(1);
  });

  it('gives up after 3 attempts', async () => {
    const a = await pod('A');
    await a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: past, attempts: 3 }));
    await new Runner(host(), await pod('B'), modelConfig()).scan();
    expect(gate.started).toBe(0);
    expect(await read('x')).toMatchObject({ status: 'failed', error: 'Gave up after 3 attempts' });
  });

  it('counts an attempt on each takeover', async () => {
    const a = await pod('A');
    await a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: past, attempts: 1 }));
    const runner = new Runner(host(), await pod('B'), modelConfig());
    await runner.scan();
    await until(() => gate.started === 1);
    expect((await read('x')).attempts).toBe(2);
    gate.release?.();
    await runner.drain();
  });

  it('pod B takes over what pod A released on drain, A keeps the running one', async () => {
    const a = await pod('A');
    const b = await pod('B');
    const runnerA = new Runner(host(), a, modelConfig());
    const runnerB = new Runner(host(), b, modelConfig());
    const alert = diagnosis('x', 'queued').alert;
    const first = await runnerA.enqueue(alert, 'api');
    const second = await runnerA.enqueue({ ...alert, fingerprint: 'two' }, 'api');
    await until(() => gate.started === 1);
    const releaseA = gate.release;
    const draining = runnerA.drain();
    await until(async () => (await read(second.id)).leaseUntil === new Date(0).toISOString());
    await runnerB.scan();
    await until(() => gate.started === 2);
    expect(gate.ids).toEqual([first.id, second.id]);
    expect((await read(first.id)).owner).toBe('A');
    expect(await read(second.id)).toMatchObject({ owner: 'B', id: second.id });
    gate.release?.();
    releaseA?.();
    await draining;
    await runnerB.drain();
    expect((await read(second.id)).status).toBe('done');
    expect((await read(first.id)).status).toBe('done');
  });

  it('aborts the run when a progress write says ownership is lost', async () => {
    const a = await pod('A');
    const b = await pod('B');
    gate.progress = true;
    // Before A's first progress write, B takes the record over.
    let taken: Promise<boolean> | undefined;
    gate.hook = id => {
      taken = b.update(id, c => (c ? { ...c, owner: 'B', leaseUntil: b.lease() } : undefined), { force: true });
    };
    const runner = new Runner(host(), a, modelConfig());
    const d = await runner.enqueue(diagnosis('x', 'queued').alert, 'api');
    await until(() => gate.started === 1);
    await runner.drain();
    await taken;
    expect(gate.signal?.aborted).toBe(true);
    expect(await read(d.id)).toMatchObject({ owner: 'B', status: 'queued' });
  });

  it('one diagnosis for a duplicate webhook alert on two stores', async () => {
    const runnerA = new Runner(host(), await pod('A'), modelConfig());
    const runnerB = new Runner(host(), await pod('B'), modelConfig());
    const alert = diagnosis('x', 'queued').alert;
    const one = await runnerA.enqueue(alert, 'webhook');
    const two = await runnerB.enqueue(alert, 'webhook');
    expect(two.id).toBe(one.id);
    expect(one.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await ids()).toEqual([one.id]);
    await until(() => gate.started === 1);
    expect((await read(one.id)).owner).toBe('A');
    gate.release?.();
    await runnerA.drain();
    await runnerB.drain();
    expect(gate.started).toBe(1);
  });
});

describe('restart and shutdown', () => {
  const base = () => ({ ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent', dataDir: dir });

  it('marks an interrupted diagnosis failed when no model is configured', async () => {
    await (await pod('old')).put(diagnosis('a', 'running'));
    const server = await startServer(base(), 'test', { store: await pod('new') });
    await server.close();
    expect(await read('a')).toMatchObject({ id: 'a', status: 'failed', error: 'Interrupted by a restart' });
  });

  it('runs an interrupted diagnosis again with the same id, and close waits for it', async () => {
    await (await pod('old')).put(diagnosis('a', 'running'));
    const config = base();
    config.models = legacyModels();
    const server = await startServer(config, 'test', { store: await pod('new') });
    await until(() => gate.started === 1);
    expect(gate.ids).toEqual(['a']);
    const url = `http://127.0.0.1:${server.port}`;

    let closed = false;
    const closing = server.close().then(() => (closed = true));
    await new Promise(r => setTimeout(r, 50));
    expect(closed).toBe(false);
    gate.release?.();
    await closing;
    expect(await ids()).toEqual(['a']);
    expect(await read('a')).toMatchObject({ id: 'a', status: 'done', createdAt: '2026-11-18T05:00:00.000Z' });
    await expect(fetch(`${url}/readyz`)).rejects.toThrow();
  });

  it('GET /api/diagnoses pages over more than 200 records and reports the total', async () => {
    const store = await pod('seed');
    for (let i = 0; i < 230; i++) await store.put(diagnosis(`p${i}`, 'done', { createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString() }));
    const server = await startServer(base(), 'test', { store: await pod('new') });
    const get = async (query: string) => (await fetch(`http://127.0.0.1:${server.port}/api/diagnoses?${query}`)).json();
    const first = await get('limit=200');
    expect(first.total).toBe(230);
    expect(first.diagnoses).toHaveLength(200);
    expect(first.diagnoses[0]).toMatchObject({ id: 'p229', evidenceCount: 1 });
    const rest = await get('offset=200&limit=200');
    expect(rest.total).toBe(230);
    expect(rest.diagnoses.map((d: { id: string }) => d.id)).toHaveLength(30);
    expect(rest.diagnoses.at(-1).id).toBe('p0');
    await server.close();
  });
});

describe('Runner.drain', () => {
  it('waits for the running task and leaves later ones queued', async () => {
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), dataDir: '' };
    config.models = legacyModels();
    const store = new MemoryDiagnosisStore();
    const runner = new Runner({ toolHost: () => ({}) } as never, store, config);
    const alert = diagnosis('x', 'queued').alert;
    await runner.enqueue(alert, 'api');
    const second = await runner.enqueue({ ...alert, fingerprint: 'other' }, 'api');
    await until(() => gate.started === 1);
    let drained = false;
    const draining = runner.drain().then(() => (drained = true));
    await new Promise(r => setTimeout(r, 30));
    expect(drained).toBe(false);
    const late = await runner.enqueue({ ...alert, fingerprint: 'late' }, 'api');
    gate.release?.();
    await draining;
    expect(gate.started).toBe(1);
    expect((await store.get(second.id))?.status).toBe('queued');
    expect((await store.get(late.id))?.status).toBe('queued');
  });
});

describe('hourly cap across pods', () => {
  it('counts webhook diagnoses from the shared store, so a new pod does not reset it', async () => {
    const { AlertGate } = await import('../src/alerts.js');
    const a = await pod('A');
    const b = await pod('B');
    const config = { toolBudget: 5, severities: ['critical'], maxPerHour: 2, maxConcurrentReruns: 2, ignoreAlerts: [] as string[] };
    const recent = new Date().toISOString();
    await a.put(diagnosis('one', 'done', { createdAt: recent }));
    await a.put(diagnosis('two', 'done', { createdAt: recent }));
    await a.put(diagnosis('old', 'done', { createdAt: '2026-01-01T00:00:00.000Z' }));
    await a.put(diagnosis('api', 'done', { createdAt: recent, source: 'api' }));
    const alert = { name: 'X', severity: 'critical', labels: {}, annotations: {}, startsAt: '', fingerprint: 'f' };
    // Pod B starts fresh but sees pod A's two webhook diagnoses from the last hour.
    expect(await new AlertGate(config, since => b.countStartedSince(since)).wants(alert)).toEqual({ ok: false, reason: 'hourly diagnosis limit reached' });
    expect((await new AlertGate({ ...config, maxPerHour: 3 }, since => b.countStartedSince(since)).wants(alert)).ok).toBe(true);
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
    const server = await startServer(two(), 'test', { store: await pod('S') });
    const res = await (await fetch(`http://127.0.0.1:${server.port}/api/models`)).json();
    expect(res.default).toBe('one/a');
    expect(res.models.map((m: { id: string }) => m.id)).toEqual(['one/a', 'one/b', 'two/c']);
    const root = await (await fetch(`http://127.0.0.1:${server.port}/`)).json();
    expect(root.diagnosis).toMatchObject({ model: 'one/a', models: 3, configured: true });
    await server.close();
  });

  it('runs a diagnosis with the model that POST /api/diagnoses names, and records the full id', async () => {
    gate.progress = true;
    const server = await startServer(two(), 'test', { store: await pod('S') });
    const res = await post(server.port, '/api/diagnoses', { alert, model: 'two/c' });
    expect(res.status).toBe(202);
    const { id } = await res.json();
    await until(async () => (await read(id)).status === 'done');
    expect((await read(id)).model).toBe('two/c');
    await server.close();
  });

  it('answers 400 with the valid ids for an unknown model', async () => {
    const server = await startServer(two(), 'test', { store: await pod('S') });
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
    const server = await startServer(two(), 'test', { store: await pod('S') });
    const labels = (n: string, m: string) => ({ alertname: 'NodeNotReady', severity: 'critical', node: n, agent_model: m });
    await post(server.port, '/api/v2/alerts', [{ labels: labels('n1', 'two/c'), startsAt: '2026-11-18T04:59:00Z' }]);
    await post(server.port, '/api/v2/alerts', [{ labels: labels('n2', 'nope'), startsAt: '2026-11-18T04:59:00Z' }]);
    await until(() => gate.started === 2);
    await server.close();
    const models = (await Promise.all((await ids()).map(async id => (await read(id)).model))).sort();
    expect(models).toEqual(['one/a', 'two/c']);
  });

  it('runs an interrupted diagnosis again with its recorded model', async () => {
    gate.progress = true;
    const a = await pod('A');
    await a.put(diagnosis('x', 'running', { owner: 'A', leaseUntil: past, model: 'two/c' }));
    const runner = new Runner(host2(), await pod('B'), two());
    await runner.scan();
    await until(() => gate.started === 1);
    await runner.drain();
    expect((await read('x')).model).toBe('two/c');
  });
});

const host2 = () => ({ toolHost: () => ({}) }) as never;
