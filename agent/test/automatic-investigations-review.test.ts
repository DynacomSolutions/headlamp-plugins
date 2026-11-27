import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import type { Diagnosis } from '../src/agent/report.js';
import { MemoryDiagnosisStore, type DiagnosisStore } from '../src/store.js';
import { AutomaticInvestigations, getAutomaticInvestigations } from '../src/settings.js';
import { pgliteDb, podStore } from './helpers/pglite.js';

// Every test here starts a real PostgreSQL (PGlite). On a busy CI runner it takes about 10 s, so these tests get a long timeout.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

vi.mock('../src/agent/engine.js', () => ({
  diagnose: vi.fn(async (opts: { id: string; alert: unknown; source: string; host: string }) => ({ id: opts.id, createdAt: 'x', source: opts.source, host: opts.host, alert: opts.alert, evidence: [], toolCalls: 0, model: 'm', a2ui: [], status: 'done' })),
}));

const { startServer, Runner } = await import('../src/server.js');

const route = (id: string, models: string[]) => ({ id, style: 'openai' as const, baseUrl: 'http://127.0.0.1:1', apiKey: 'k', headers: {}, systemPrefix: '', models, maxTokens: 10, timeoutMs: 500 });

let dir: string;
let db: ReturnType<typeof pgliteDb>;
let reader: DiagnosisStore;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-auto-review-'));
  db = pgliteDb();
  reader = await podStore(db, { owner: 'reader' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

function config(maxPerHour = 6) {
  const c = { ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent', dataDir: dir, allowedOrigins: ['https://headlamp.example.com'] };
  c.models = { routes: [route('one', ['a'])], defaultModel: 'one/a', skipped: [] };
  c.diagnosis = { ...c.diagnosis, maxPerHour };
  return c;
}

const J = { 'content-type': 'application/json' };
const base = (port: number) => `http://127.0.0.1:${port}`;
const put = (port: number, body: unknown, headers: Record<string, string> = J) => fetch(`${base(port)}/api/settings/automatic-investigations`, { method: 'PUT', headers, body: JSON.stringify(body) });
const fire = (port: number, node: string, startsAt = new Date().toISOString()) =>
  fetch(`${base(port)}/api/v2/alerts`, { method: 'POST', headers: J, body: JSON.stringify([{ labels: { alertname: 'NodeNotReady', severity: 'critical', node }, annotations: {}, startsAt }]) });
const metricsText = async (port: number) => (await fetch(`${base(port)}/metrics`)).text();
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await check()); i++) await new Promise(r => setTimeout(r, 10));
  expect(await check()).toBe(true);
};

function record(id: string, extra: Partial<Diagnosis> = {}): Diagnosis {
  return {
    id,
    createdAt: '2026-11-18T05:00:00.000Z',
    status: 'failed',
    source: 'webhook',
    host: 'cluster',
    alert: { name: 'NodeNotReady', severity: 'critical', labels: { alertname: 'NodeNotReady' }, annotations: {}, startsAt: '2026-11-18T04:59:00Z', fingerprint: 'fp-shared' },
    evidence: [],
    toolCalls: 0,
    model: 'one/a',
    a2ui: [],
    ...extra,
  };
}

describe('who changed the setting', () => {
  it('a direct call has a claimed name, from the header or the body, and no name stays empty', async () => {
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    expect(await (await put(server.port, { enabled: false }, { ...J, 'x-remote-user': 'mallory' })).json()).toMatchObject({ updatedBy: 'mallory', updatedVia: 'direct' });
    expect(await (await put(server.port, { enabled: true, by: 'alice' })).json()).toMatchObject({ updatedBy: 'alice', updatedVia: 'direct' });
    const none = await (await put(server.port, { enabled: false })).json();
    expect(none).toMatchObject({ updatedBy: '', updatedVia: 'direct' });
    expect(none.changes.map((c: { by: string; via: string }) => [c.by, c.via])).toEqual([['', 'direct'], ['alice', 'direct'], ['mallory', 'direct']]);
    await server.close();
  });

  it('a call through the service proxy takes the name from the body only, and a missing name stays empty', async () => {
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    const proxy = { ...J, 'x-forwarded-uri': '/api/v1/namespaces/headlamp/services/headlamp-agent:8080/proxy/api/settings/automatic-investigations', 'x-remote-user': 'mallory' };
    const named = await (await put(server.port, { enabled: false, by: 'alice' }, proxy)).json();
    expect(named).toMatchObject({ updatedBy: 'alice', updatedVia: 'proxy' });
    const unnamed = await (await put(server.port, { enabled: true }, proxy)).json();
    expect(unnamed).toMatchObject({ updatedBy: '', updatedVia: 'proxy' });
    expect((await reader.getSetting('automatic-investigations'))?.updatedVia).toBe('proxy');
    await server.close();
  });

  it('the memory store keeps the way too', async () => {
    const store = new MemoryDiagnosisStore();
    await new AutomaticInvestigations(store).set(false, 'alice', 'proxy');
    expect(await getAutomaticInvestigations(store)).toMatchObject({ enabled: false, updatedBy: 'alice', updatedVia: 'proxy' });
  });
});

describe('the hourly limit and manual runs', () => {
  it('a manual Investigate of a skipped incident does not take the hourly slot of an automatic one', async () => {
    const store = await podStore(db, { owner: 'S' });
    const server = await startServer(config(1), 'test', { store });
    await put(server.port, { enabled: false });
    await fire(server.port, 'n1');
    const [skipped] = (await reader.page()).diagnoses;
    expect(skipped!.status).toBe('skipped');
    const res = await fetch(`${base(server.port)}/api/diagnoses/${skipped!.id}/rerun`, { method: 'POST', headers: J, body: '{}' });
    expect(res.status).toBe(202);
    await until(async () => (await reader.get(skipped!.id))?.status === 'done');
    expect(await store.countStartedSince(Date.now() - 3600_000)).toBe(0);
    await put(server.port, { enabled: true });
    await fire(server.port, 'n2');
    await until(async () => (await reader.page()).diagnoses.some(d => d.alert.labels.node === 'n2' && d.status === 'done'));
    await server.close();
  });

  it('the memory store does not count a manual run either', async () => {
    const store = new MemoryDiagnosisStore();
    const now = new Date().toISOString();
    await store.put(record('auto', { status: 'done', createdAt: now }));
    await store.put(record('manual', { status: 'done', createdAt: now, rerunAt: now, wasSkipped: true }));
    // An automatic one that a person ran again took its slot when it started, and keeps it.
    await store.put(record('again', { status: 'done', createdAt: now, rerunAt: now }));
    expect(await store.countStartedSince(Date.now() - 3600_000)).toBe(2);
  });
});

describe('a setting that cannot be read', () => {
  class Broken extends MemoryDiagnosisStore {
    override async getSetting(): Promise<undefined> {
      throw new Error('settings read failed');
    }
  }

  it('the alert still opens an incident and pushes, and the read error is counted', async () => {
    const store = new Broken();
    const server = await startServer(config(), 'test', { store });
    const res = await fire(server.port, 'n1');
    expect(res.status).toBe(200);
    const [d] = (await store.page()).diagnoses;
    expect(d).toMatchObject({ status: 'skipped', source: 'webhook' });
    const text = await metricsText(server.port);
    expect(text).toContain('headlamp_agent_automatic_investigations_skipped_total{path="webhook"} 1');
    expect(text).toMatch(/headlamp_agent_automatic_investigations_read_errors_total [1-9]/);
    await server.close();
  });

  it('/metrics still answers 200', async () => {
    const server = await startServer(config(), 'test', { store: new Broken() });
    const res = await fetch(`${base(server.port)}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('headlamp_agent_automatic_investigations_enabled ');
    expect(text).toMatch(/headlamp_agent_automatic_investigations_read_errors_total [1-9]/);
    await server.close();
  });

  it('a queued automatic diagnosis becomes skipped, not failed', async () => {
    const store = new Broken({ owner: 'S' });
    const runner = new Runner({ toolHost: () => ({}) } as never, store, config(), undefined, undefined, { automatic: async () => false });
    const alert = { name: 'NodeNotReady', severity: 'critical', labels: {}, annotations: {}, startsAt: '2026-11-18T04:59:00Z', fingerprint: 'fp-q' };
    const queued = await runner.enqueue(alert, 'webhook');
    await until(async () => (await store.get(queued.id))?.status === 'skipped');
    await runner.drain();
  });

  it('a stored value that is not a boolean gives the default and one warning', async () => {
    const store = new MemoryDiagnosisStore();
    await store.setSetting('automatic-investigations', 'yes', 'x', true);
    const lines: string[] = [];
    const setting = new AutomaticInvestigations(store, (level, message) => lines.push(`${level}:${message}`));
    expect((await setting.get()).enabled).toBe(true);
    expect((await setting.get()).enabled).toBe(true);
    expect(lines).toEqual(['warn:setting has a value that is not a boolean, using the default']);
  });
});

describe('a skipped record under a live lease of another pod', () => {
  it('is not overwritten when the setting turns off during the start', async () => {
    const store = await podStore(db, { owner: 'S' });
    const lease = new Date(Date.now() + 600_000).toISOString();
    const runner = new Runner({ toolHost: () => ({}) } as never, store, config(), undefined, undefined, {
      // The other pod takes the record while this one reads the setting.
      automatic: async () => {
        for (const d of (await reader.page()).diagnoses) await reader.update(d.id, c => (c ? { ...c, owner: 'other', leaseUntil: lease } : undefined), { force: true });
        return false;
      },
    });
    const alert = { name: 'NodeNotReady', severity: 'critical', labels: {}, annotations: {}, startsAt: '2026-11-18T04:59:00Z', fingerprint: 'fp-lease' };
    const queued = await runner.enqueue(alert, 'webhook');
    await until(async () => (await reader.get(queued.id))?.owner === 'other');
    await new Promise(r => setTimeout(r, 300));
    const now = await reader.get(queued.id);
    expect(now?.owner).toBe('other');
    expect(now?.status).not.toBe('skipped');
    await runner.drain();
  });
});

describe('a skipped incident folds older open duplicates', () => {
  it('the webhook keeps only the newest open incident of one fingerprint', async () => {
    const store = await podStore(db, { owner: 'S' });
    const server = await startServer(config(), 'test', { store });
    await put(server.port, { enabled: false });
    await fire(server.port, 'n1', '2026-11-18T05:00:00.000Z');
    const [first] = (await reader.page()).diagnoses;
    const fingerprint = first!.alert.fingerprint;
    // The first incident failed, and an older failed duplicate of the same alert is still open.
    await reader.update(first!.id, d => (d ? { ...d, status: 'failed' } : undefined), { force: true });
    await reader.put(record('old', { createdAt: '2026-11-17T05:00:00.000Z', alert: { ...first!.alert, startsAt: '2026-11-17T05:00:00.000Z' } }));
    expect((await reader.openSummaries()).filter(d => d.alert.fingerprint === fingerprint)).toHaveLength(2);
    // The same alert fires again: a new skipped incident opens, and the two older ones fold into it.
    await fire(server.port, 'n1', new Date().toISOString());
    const open = (await reader.openSummaries()).filter(d => d.alert.fingerprint === fingerprint);
    expect(open).toHaveLength(1);
    expect(open[0]!.status).toBe('skipped');
    expect(await metricsText(server.port)).toContain('headlamp_agent_reconcile_folded_total 2');
    await server.close();
  });
});
