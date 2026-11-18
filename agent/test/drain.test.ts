import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DiagnosisStore } from '../src/store.js';
import type { Diagnosis } from '../src/agent/report.js';

const gate = vi.hoisted(() => ({ release: undefined as undefined | (() => void), started: 0, ids: [] as string[] }));

vi.mock('../src/agent/engine.js', () => ({
  diagnose: vi.fn(async (opts: { id: string; alert: unknown; source: string; host: string; budget: number }) => {
    gate.started++;
    gate.ids.push(opts.id);
    await new Promise<void>(resolve => (gate.release = resolve));
    return { id: opts.id, createdAt: 'x', status: 'done', source: opts.source, host: opts.host, alert: opts.alert, evidence: [], toolCalls: 0, toolBudget: opts.budget, model: 'm', a2ui: [] };
  }),
}));

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
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe('DiagnosisStore.interrupted', () => {
  it('keeps queued and running items and lists them', () => {
    writeFileSync(join(dir, 'diagnoses.json'), JSON.stringify([diagnosis('a', 'running'), diagnosis('b', 'queued'), diagnosis('c', 'done'), diagnosis('d', 'running', { resolvedAt: 'z' })]));
    const store = new DiagnosisStore(dir, 50);
    expect(store.interrupted().map(d => d.id)).toEqual(['a', 'b']);
    expect(store.get('a')?.status).toBe('running');
    expect(store.get('d')?.status).toBe('failed');
    expect(store.findByFingerprint('f-a', '2026-11-18T04:59:00Z')?.id).toBe('a');
  });
});

describe('restart and shutdown', () => {
  const base = () => ({ ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent', dataDir: dir });

  it('marks an interrupted diagnosis failed when no model is configured', async () => {
    writeFileSync(join(dir, 'diagnoses.json'), JSON.stringify([diagnosis('a', 'running')]));
    const server = await startServer(base(), 'test');
    await server.close();
    const saved = JSON.parse(readFileSync(join(dir, 'diagnoses.json'), 'utf8')) as Diagnosis[];
    expect(saved[0]).toMatchObject({ id: 'a', status: 'failed', error: 'Interrupted by a restart' });
  });

  it('runs an interrupted diagnosis again with the same id, and close waits for it', async () => {
    writeFileSync(join(dir, 'diagnoses.json'), JSON.stringify([diagnosis('a', 'running')]));
    const config = base();
    config.model = { ...config.model, baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm' };
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
    const saved = JSON.parse(readFileSync(join(dir, 'diagnoses.json'), 'utf8')) as Diagnosis[];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: 'a', status: 'done', createdAt: '2026-11-18T05:00:00.000Z' });
    await expect(fetch(`${url}/readyz`)).rejects.toThrow();
  });
});

describe('Runner.drain', () => {
  it('waits for the running task and leaves later ones queued', async () => {
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), dataDir: '' };
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
