import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import type { Diagnosis } from '../src/agent/report.js';
import { MemoryDiagnosisStore, type DiagnosisStore } from '../src/store.js';
import { pgliteDb, podStore } from './helpers/pglite.js';

const engine = vi.hoisted(() => ({ started: 0, ids: [] as string[], models: [] as string[], fail: undefined as string | undefined, alerts: [] as unknown[] }));

vi.mock('../src/agent/engine.js', () => ({
  diagnose: vi.fn(async (opts: { id: string; alert: unknown; source: string; host: string; budget: number; model?: { name: string } }) => {
    engine.started++;
    engine.ids.push(opts.id);
    engine.models.push(opts.model?.name ?? '');
    engine.alerts.push(opts.alert);
    const base = { id: opts.id, createdAt: 'x', source: opts.source, host: opts.host, alert: opts.alert, evidence: [], toolCalls: 0, toolBudget: opts.budget, model: opts.model?.name ?? 'm', a2ui: [] };
    return engine.fail ? { ...base, status: 'failed', error: engine.fail } : { ...base, status: 'done' };
  }),
}));

const { startServer } = await import('../src/server.js');

const route = (id: string, models: string[]) => ({ id, style: 'openai' as const, baseUrl: 'http://127.0.0.1:1', apiKey: 'k', headers: {}, systemPrefix: '', models, maxTokens: 10, timeoutMs: 500 });

let dir: string;
let db: ReturnType<typeof pgliteDb>;
let reader: DiagnosisStore;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-rerun-'));
  db = pgliteDb();
  reader = await podStore(db, { owner: 'reader' });
  engine.started = 0;
  engine.ids = [];
  engine.models = [];
  engine.alerts = [];
  engine.fail = undefined;
});
afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

function config(maxPerHour = 6) {
  const c = { ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent', dataDir: dir };
  c.models = { routes: [route('one', ['a', 'b']), route('two', ['c'])], defaultModel: 'one/a', skipped: [] };
  c.diagnosis = { ...c.diagnosis, maxPerHour };
  return c;
}

function failed(id: string, extra: Partial<Diagnosis> = {}): Diagnosis {
  return {
    id,
    createdAt: '2026-11-18T05:00:00.000Z',
    finishedAt: '2026-11-18T05:01:00.000Z',
    status: 'failed',
    source: 'webhook',
    host: 'cluster',
    alert: { name: 'NodeNotReady', severity: 'critical', labels: { alertname: 'NodeNotReady' }, annotations: {}, startsAt: '2026-11-18T04:59:00Z', fingerprint: `f-${id}` },
    evidence: [],
    toolCalls: 2,
    toolBudget: 5,
    model: 'zai/glm-5.3',
    error: 'Model request failed: 429',
    attempts: 2,
    a2ui: [],
    ...extra,
  };
}

const read = async (id: string) => (await reader.get(id)) as Diagnosis;
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await check()); i++) await new Promise(r => setTimeout(r, 10));
  expect(await check()).toBe(true);
};
const rerun = (port: number, id: string, body: unknown = {}, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  fetch(`http://127.0.0.1:${port}/api/diagnoses/${id}/rerun`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('POST /api/diagnoses/:id/rerun', () => {
  it('runs a failed diagnosis again under its own id with the default model, and keeps the failed attempt', async () => {
    await reader.put(failed('f1'));
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    const res = await rerun(server.port, 'f1');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: 'f1', status: 'queued', model: 'one/a' });
    await until(async () => (await read('f1')).status === 'done');
    const d = await read('f1');
    expect(d).toMatchObject({ id: 'f1', createdAt: '2026-11-18T05:00:00.000Z', model: 'one/a', attempts: 1 });
    expect(d.error).toBeUndefined();
    expect(d.previousAttempts).toEqual([{ at: '2026-11-18T05:01:00.000Z', model: 'zai/glm-5.3', error: 'Model request failed: 429' }]);
    expect(Date.parse(d.rerunAt as string)).toBeGreaterThan(Date.now() - 60_000);
    expect(engine.ids).toEqual(['f1']);
    expect(engine.models).toEqual(['one/a']);
    expect((await reader.page()).total).toBe(1);
    await server.close();
  });

  it('uses the model that the body names', async () => {
    await reader.put(failed('f1'));
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    const res = await rerun(server.port, 'f1', { model: 'two/c' });
    expect(res.status).toBe(202);
    await until(async () => (await read('f1')).status === 'done');
    expect((await read('f1')).model).toBe('two/c');
    await server.close();
  });

  it('answers 400 for an unknown model and starts nothing', async () => {
    await reader.put(failed('f1'));
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    const res = await rerun(server.port, 'f1', { model: 'two/zzz' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('one/a');
    expect(engine.started).toBe(0);
    expect((await read('f1')).status).toBe('failed');
    await server.close();
  });

  it('answers 404 for an unknown id', async () => {
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    expect((await rerun(server.port, 'nope')).status).toBe(404);
    await server.close();
  });

  it.each(['done', 'queued', 'running'] as const)('answers 409 for a %s diagnosis', async status => {
    await reader.put(failed('x1', { status, error: undefined, owner: 'other', leaseUntil: new Date(Date.now() + 60_000).toISOString() }));
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    const res = await rerun(server.port, 'x1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain(status);
    expect(engine.started).toBe(0);
    await server.close();
  });

  it('answers 409 to the second of two requests for the same id', async () => {
    await reader.put(failed('f1'));
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    const [a, b] = await Promise.all([rerun(server.port, 'f1'), rerun(server.port, 'f1')]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    await until(async () => (await read('f1')).status === 'done');
    expect(engine.started).toBe(1);
    await server.close();
  });

  it('works for a resolved alert and diagnoses the alert as it was', async () => {
    await reader.put(failed('r1', { resolvedAt: '2026-11-18T06:00:00.000Z' }));
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    expect((await rerun(server.port, 'r1')).status).toBe(202);
    await until(async () => (await read('r1')).status === 'done');
    expect(await read('r1')).toMatchObject({ resolvedAt: '2026-11-18T06:00:00.000Z', status: 'done' });
    expect(engine.alerts[0]).toMatchObject({ name: 'NodeNotReady', startsAt: '2026-11-18T04:59:00Z' });
    await server.close();
  });

  it('keeps the history of every failed attempt over several re-runs', async () => {
    await reader.put(failed('f1'));
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    engine.fail = 'second failure';
    await rerun(server.port, 'f1');
    await until(async () => (await read('f1')).error === 'second failure');
    engine.fail = undefined;
    expect((await rerun(server.port, 'f1')).status).toBe(202);
    await until(async () => (await read('f1')).status === 'done');
    expect((await read('f1')).previousAttempts?.map(p => p.error)).toEqual(['Model request failed: 429', 'second failure']);
    await server.close();
  });

  it('answers 429 when the hourly limit is used, and counts re-runs against it', async () => {
    await reader.put(failed('f1'));
    await reader.put(failed('f2'));
    await reader.put(failed('f3'));
    const server = await startServer(config(2), 'test', { store: await podStore(db, { owner: 'S' }) });
    expect((await rerun(server.port, 'f1')).status).toBe(202);
    expect((await rerun(server.port, 'f2')).status).toBe(202);
    const res = await rerun(server.port, 'f3');
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain('hourly limit');
    await until(async () => (await read('f2')).status === 'done');
    expect((await read('f3')).status).toBe('failed');
    await server.close();
  });

  it('counts webhook diagnoses of the last hour against the limit', async () => {
    await reader.put(failed('f1'));
    await reader.put(failed('w1', { status: 'done', createdAt: new Date().toISOString(), error: undefined }));
    const server = await startServer(config(1), 'test', { store: await podStore(db, { owner: 'S' }) });
    expect((await rerun(server.port, 'f1')).status).toBe(429);
    await server.close();
  });

  it('needs the JSON content type like the other write routes', async () => {
    await reader.put(failed('f1'));
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    expect((await rerun(server.port, 'f1', {}, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await rerun(server.port, 'f1', {}, { 'content-type': 'application/json', origin: 'https://evil.example' })).status).toBe(403);
    expect((await read('f1')).status).toBe('failed');
    await server.close();
  });

  it('answers 400 for an unknown field in the body', async () => {
    await reader.put(failed('f1'));
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    expect((await rerun(server.port, 'f1', { alert: {} })).status).toBe(400);
    await server.close();
  });

  it('is not failed again by a restart scan because the alert is resolved', async () => {
    // A re-run that a restart interrupted: its lease ran out, the alert is resolved.
    await reader.put(failed('r2', { status: 'running', error: undefined, owner: 'old', leaseUntil: '2020-01-01T00:00:00.000Z', resolvedAt: '2026-11-18T06:00:00.000Z', rerunAt: new Date().toISOString(), attempts: 1, model: 'one/a' }));
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    await until(async () => (await read('r2')).status === 'done');
    expect(engine.ids).toEqual(['r2']);
    await server.close();
  });

  it('still fails an interrupted run of a resolved alert that no person re-ran', async () => {
    await reader.put(failed('r3', { status: 'running', error: undefined, owner: 'old', leaseUntil: '2020-01-01T00:00:00.000Z', resolvedAt: '2026-11-18T06:00:00.000Z', attempts: 1 }));
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    await until(async () => (await read('r3')).status === 'failed' && (await read('r3')).error === 'Interrupted by a restart');
    expect(engine.started).toBe(0);
    await server.close();
  });
});

describe('countStartedSince', () => {
  it('counts a webhook creation or a re-run in the window, once each, in both stores', async () => {
    const recent = new Date().toISOString();
    const old = '2026-01-01T00:00:00.000Z';
    for (const store of [reader, new MemoryDiagnosisStore({ owner: 'm' })]) {
      await store.put(failed('a', { createdAt: recent }));
      await store.put(failed('b', { createdAt: old, rerunAt: recent }));
      await store.put(failed('c', { createdAt: recent, rerunAt: recent }));
      await store.put(failed('d', { createdAt: old, rerunAt: old }));
      await store.put(failed('e', { createdAt: recent, source: 'api' }));
      expect(await store.countStartedSince(Date.now() - 3600_000)).toBe(3);
    }
  });
});
