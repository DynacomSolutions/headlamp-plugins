import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { SKIPPED_REASON, type Diagnosis } from '../src/agent/report.js';
import { MemoryDiagnosisStore, type DiagnosisStore } from '../src/store.js';
import { AUTOMATIC_INVESTIGATIONS_EVENT, AutomaticInvestigations, getAutomaticInvestigations } from '../src/settings.js';
import { pgliteDb, podStore } from './helpers/pglite.js';

// Every test here starts a real PostgreSQL (PGlite). On a busy CI runner it takes about 10 s, so these tests get a long timeout.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const engine = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, started: 0, ids: [] as string[] }));

vi.mock('../src/agent/engine.js', () => ({
  diagnose: vi.fn(async (opts: { id: string; alert: unknown; source: string; host: string; model?: { name: string } }) => {
    engine.started++;
    engine.ids.push(opts.id);
    if (engine.hold) await engine.hold;
    return { id: opts.id, createdAt: 'x', source: opts.source, host: opts.host, alert: opts.alert, evidence: [], toolCalls: 0, model: opts.model?.name ?? 'm', a2ui: [], status: 'done' };
  }),
}));

const { startServer, Runner } = await import('../src/server.js');

const route = (id: string, models: string[]) => ({ id, style: 'openai' as const, baseUrl: 'http://127.0.0.1:1', apiKey: 'k', headers: {}, systemPrefix: '', models, maxTokens: 10, timeoutMs: 500 });

let dir: string;
let db: ReturnType<typeof pgliteDb>;
let reader: DiagnosisStore;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-auto-'));
  db = pgliteDb();
  reader = await podStore(db, { owner: 'reader' });
  engine.started = 0;
  engine.ids = [];
  engine.hold = undefined;
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

const JSON_HEADERS = { 'content-type': 'application/json' };
const base = (port: number) => `http://127.0.0.1:${port}`;
const getSetting = (port: number) => fetch(`${base(port)}/api/settings/automatic-investigations`);
const putSetting = (port: number, body: unknown, headers: Record<string, string> = JSON_HEADERS, method = 'PUT') =>
  fetch(`${base(port)}/api/settings/automatic-investigations`, { method, headers, body: JSON.stringify(body) });
const fire = (port: number, node: string, startsAt = new Date().toISOString(), extra: Record<string, string> = {}) =>
  fetch(`${base(port)}/api/v2/alerts`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify([{ labels: { alertname: 'NodeNotReady', severity: 'critical', node, ...extra }, annotations: { summary: `${node} is not ready` }, startsAt }]),
  });
const metricsText = async (port: number) => (await fetch(`${base(port)}/metrics`)).text();

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await check()); i++) await new Promise(r => setTimeout(r, 10));
  expect(await check()).toBe(true);
};
const settle = () => new Promise(r => setTimeout(r, 120));
const all = async () => (await reader.page()).diagnoses;

function stale(id: string, extra: Partial<Diagnosis> = {}): Diagnosis {
  return {
    id,
    createdAt: '2026-11-18T05:00:00.000Z',
    status: 'running',
    source: 'webhook',
    host: 'cluster',
    alert: { name: 'NodeNotReady', severity: 'critical', labels: { alertname: 'NodeNotReady' }, annotations: {}, startsAt: '2026-11-18T04:59:00Z', fingerprint: `f-${id}` },
    evidence: [],
    toolCalls: 0,
    model: 'one/a',
    attempts: 1,
    owner: 'dead-pod',
    leaseUntil: '2026-11-18T05:01:00.000Z',
    a2ui: [],
    ...extra,
  };
}

describe('the setting "Automatic investigations": API', () => {
  it('is on by default and shows no change yet', async () => {
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    const res = await getSetting(server.port);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, changes: [] });
    await server.close();
  });

  it('changes with PUT, shows who and when, and keeps every change in the audit', async () => {
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    const off = await putSetting(server.port, { enabled: false }, { ...JSON_HEADERS, 'x-remote-user': 'alice' });
    expect(off.status).toBe(200);
    const state = await off.json();
    expect(state).toMatchObject({ enabled: false, changed: true, updatedBy: 'alice' });
    expect(Date.parse(state.updatedAt)).toBeGreaterThan(Date.now() - 60_000);
    await putSetting(server.port, { enabled: true }, { ...JSON_HEADERS, 'x-remote-user': 'bob' });
    const read = await (await getSetting(server.port)).json();
    expect(read).toMatchObject({ enabled: true, updatedBy: 'bob' });
    expect(read.changes.map((c: { by: string; old: boolean; new: boolean; kind: string }) => [c.by, c.old, c.new, c.kind])).toEqual([
      ['bob', false, true, AUTOMATIC_INVESTIGATIONS_EVENT],
      ['alice', true, false, AUTOMATIC_INVESTIGATIONS_EVENT],
    ]);
    await server.close();
  });

  it('accepts POST with the same effect, because the service proxy maps POST to the create right', async () => {
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    const res = await putSetting(server.port, { enabled: false }, JSON_HEADERS, 'POST');
    expect(res.status).toBe(200);
    expect((await (await getSetting(server.port)).json()).enabled).toBe(false);
    await server.close();
  });

  it('writes nothing and records nothing when the value does not change', async () => {
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    const same = await (await putSetting(server.port, { enabled: true })).json();
    expect(same).toMatchObject({ enabled: true, changed: false, changes: [] });
    expect(await reader.getSetting('automatic-investigations')).toBeUndefined();
    await server.close();
  });

  it('refuses a write from a foreign origin, a wrong content type and a bad body, and changes nothing', async () => {
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    expect((await putSetting(server.port, { enabled: false }, { ...JSON_HEADERS, origin: 'https://evil.example.org' })).status).toBe(403);
    expect((await putSetting(server.port, { enabled: false }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await putSetting(server.port, { enabled: 'no' })).status).toBe(400);
    expect((await putSetting(server.port, { enabled: false, extra: 1 })).status).toBe(400);
    expect((await putSetting(server.port, {}, JSON_HEADERS)).status).toBe(400);
    expect((await (await getSetting(server.port)).json()).enabled).toBe(true);
    expect(await reader.settingAudit('automatic-investigations', 10)).toEqual([]);
    // An allowed origin works.
    expect((await putSetting(server.port, { enabled: false }, { ...JSON_HEADERS, origin: 'https://headlamp.example.com' })).status).toBe(200);
    await server.close();
  });

  it('answers 405 for DELETE and lists the allowed methods', async () => {
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    const res = await fetch(`${base(server.port)}/api/settings/automatic-investigations`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, PUT, POST');
    await server.close();
  });
});

describe('persistence and audit', () => {
  it('survives a restart and shows on a second pod of the same database', async () => {
    const first = await startServer(config(), 'test', { store: await podStore(db, { owner: 'one' }) });
    await putSetting(first.port, { enabled: false }, { ...JSON_HEADERS, 'x-remote-user': 'alice' });
    await first.close();
    const second = await startServer(config(), 'test', { store: await podStore(db, { owner: 'two' }) });
    const third = await startServer(config(), 'test', { store: await podStore(db, { owner: 'three' }) });
    for (const server of [second, third]) expect(await (await getSetting(server.port)).json()).toMatchObject({ enabled: false, updatedBy: 'alice' });
    // A change on one pod shows on the other at once.
    await putSetting(second.port, { enabled: true });
    expect((await (await getSetting(third.port)).json()).enabled).toBe(true);
    await second.close();
    await third.close();
  });

  it('keeps the audit in the store and in the log', async () => {
    const lines: string[] = [];
    const real = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: never[]) => {
      lines.push(String(chunk));
      return real(chunk, ...rest);
    }) as typeof process.stdout.write);
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    await putSetting(server.port, { enabled: false }, { ...JSON_HEADERS, 'x-remote-user': 'alice' });
    const [entry] = await reader.settingAudit('automatic-investigations', 10);
    expect(entry).toMatchObject({ key: 'automatic-investigations', by: 'alice', old: true, new: false });
    expect(Date.parse(entry!.at)).toBeGreaterThan(Date.now() - 60_000);
    const logged = lines.map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean).find(l => l.message === 'setting changed');
    expect(logged).toMatchObject({ level: 'info', setting: 'automatic-investigations', by: 'alice', old: true, new: false });
    await server.close();
  });

  it('works the same on the in-memory store, and the service tells listeners about a change', async () => {
    const store = new MemoryDiagnosisStore();
    const setting = new AutomaticInvestigations(store);
    const seen: unknown[] = [];
    const stop = setting.onChange(change => seen.push(change));
    expect(await getAutomaticInvestigations(store)).toEqual({ enabled: true });
    await setting.set(false, 'alice');
    await setting.set(false, 'alice');
    stop();
    await setting.set(true, 'bob');
    expect(seen).toEqual([{ kind: 'settings.automatic_investigations.changed', at: expect.any(String), by: 'alice', old: true, new: false }]);
    expect(await getAutomaticInvestigations(store)).toMatchObject({ enabled: true, updatedBy: 'bob' });
    expect((await setting.audit()).map(c => c.by)).toEqual(['bob', 'alice']);
  });
});

describe('automatic paths when the setting is off', () => {
  it('the alert webhook opens the incident with a marker, starts no investigation and counts the skip', async () => {
    const store = await podStore(db, { owner: 'S' });
    const server = await startServer(config(), 'test', { store });
    await putSetting(server.port, { enabled: false });
    expect((await fire(server.port, 'n1')).status).toBe(200);
    const [d] = await all();
    expect(d).toMatchObject({ status: 'skipped', source: 'webhook', alert: { name: 'NodeNotReady', severity: 'critical' }, skipped: { reason: SKIPPED_REASON } });
    expect(d!.skipped?.at).toBeTruthy();
    const full = (await store.get(d!.id))!;
    expect(JSON.stringify(full.a2ui)).toContain(SKIPPED_REASON);
    await settle();
    expect(engine.started).toBe(0);
    const text = await metricsText(server.port);
    expect(text).toContain('headlamp_agent_automatic_investigations_enabled 0');
    expect(text).toContain('headlamp_agent_automatic_investigations_skipped_total{path="webhook"} 1');
    // The incident is listed as open.
    expect((await store.openSummaries()).map(o => o.id)).toEqual([d!.id]);
    await server.close();
  });

  it('the incident still notifies', async () => {
    const notified: Diagnosis[] = [];
    const store = new MemoryDiagnosisStore({ owner: 'S' });
    const runner = new Runner({ toolHost: () => ({}) } as never, store, config(), undefined, undefined, { automatic: async () => false, onSkipped: d => notified.push(d) });
    const alert = { name: 'NodeNotReady', severity: 'critical', labels: {}, annotations: {}, startsAt: '2026-11-18T04:59:00Z', fingerprint: 'fp1' };
    const d = await runner.openSkipped(alert, 'webhook');
    expect(notified.map(n => n.id)).toEqual([d.id]);
    // The same alert again finds the record and does not notify twice.
    await runner.openSkipped(alert, 'webhook');
    expect(notified).toHaveLength(1);
    await runner.drain();
  });

  it('does not use the hourly limit of the investigations', async () => {
    const store = await podStore(db, { owner: 'S' });
    const server = await startServer(config(1), 'test', { store });
    await putSetting(server.port, { enabled: false });
    for (const node of ['n1', 'n2', 'n3']) await fire(server.port, node);
    expect((await all()).map(d => d.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(await store.countStartedSince(Date.now() - 3600_000)).toBe(0);
    // Back on: the one slot of the hour is free for a new alert.
    await putSetting(server.port, { enabled: true });
    await fire(server.port, 'n4');
    await until(async () => (await all()).some(d => d.status === 'done'));
    await server.close();
  });

  it('opens no incident for an alert that the filter drops, also when the setting is off', async () => {
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    await putSetting(server.port, { enabled: false });
    await fetch(`${base(server.port)}/api/v2/alerts`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify([{ labels: { alertname: 'Noise', severity: 'none' }, annotations: {}, startsAt: new Date().toISOString() }]) });
    expect(await all()).toEqual([]);
    await server.close();
  });

  it('a repeat of the alert joins the skipped incident while the setting is off, and starts the investigation once it is on', async () => {
    const store = await podStore(db, { owner: 'S' });
    const server = await startServer(config(), 'test', { store });
    await putSetting(server.port, { enabled: false });
    await fire(server.port, 'n1', '2026-11-18T05:00:00Z');
    await fire(server.port, 'n1', '2026-11-18T05:10:00Z');
    const list = await all();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'skipped', fires: 2 });
    await putSetting(server.port, { enabled: true });
    await fire(server.port, 'n1', '2026-11-18T05:20:00Z');
    await until(async () => (await all()).some(d => d.status === 'done'));
    expect(engine.started).toBe(1);
    await server.close();
  });

  it('a lease resume after a restart does not start an automatic diagnosis', async () => {
    await reader.put(stale('a1'));
    const store = await podStore(db, { owner: 'S' });
    await new AutomaticInvestigations(store).set(false, 'alice');
    const skipped: string[] = [];
    const runner = new Runner({ toolHost: () => ({}) } as never, store, config(), undefined, undefined, { automatic: () => new AutomaticInvestigations(store).enabled(), onSkipped: (d, path) => skipped.push(`${d.id}:${path}`) });
    await runner.scan();
    const d = (await reader.get('a1'))!;
    expect(d).toMatchObject({ status: 'skipped', skipped: { reason: SKIPPED_REASON } });
    expect(d.leaseUntil).toBeUndefined();
    expect(skipped).toEqual(['a1:resume']);
    expect(engine.started).toBe(0);
    await runner.drain();
  });

  it('the scan inside the server skips a stale automatic diagnosis at start-up and counts it', async () => {
    await reader.put(stale('a1'));
    await new AutomaticInvestigations(reader).set(false, 'alice');
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    await until(async () => (await reader.get('a1'))?.status === 'skipped');
    expect(engine.started).toBe(0);
    expect(await metricsText(server.port)).toContain('headlamp_agent_automatic_investigations_skipped_total{path="resume"} 1');
    await server.close();
  });

  it('a lease resume still runs a diagnosis that a person started, and runs an automatic one when the setting is on', async () => {
    await reader.put(stale('manual-api', { source: 'api' }));
    await reader.put(stale('manual-rerun', { rerunAt: '2026-11-18T05:00:30.000Z' }));
    await reader.put(stale('auto'));
    const store = await podStore(db, { owner: 'S' });
    await new AutomaticInvestigations(store).set(false, 'alice');
    const runner = new Runner({ toolHost: () => ({}) } as never, store, config(), undefined, undefined, { automatic: () => new AutomaticInvestigations(store).enabled() });
    await runner.scan();
    await until(async () => (await reader.get('manual-api'))?.status === 'done' && (await reader.get('manual-rerun'))?.status === 'done');
    expect((await reader.get('auto'))?.status).toBe('skipped');
    expect(engine.ids.sort()).toEqual(['manual-api', 'manual-rerun']);
    await runner.drain();
    // On again: a new stale automatic record runs.
    await new AutomaticInvestigations(store).set(true, 'alice');
    await reader.put(stale('auto2'));
    const again = new Runner({ toolHost: () => ({}) } as never, store, config(), undefined, undefined, { automatic: () => new AutomaticInvestigations(store).enabled() });
    await again.scan();
    await until(async () => (await reader.get('auto2'))?.status === 'done');
    await again.drain();
  });

  it('an automatic diagnosis that waits in the queue does not start when the setting turns off meanwhile', async () => {
    const store = await podStore(db, { owner: 'S' });
    const setting = new AutomaticInvestigations(store);
    const runner = new Runner({ toolHost: () => ({}) } as never, store, config(), undefined, undefined, { automatic: () => setting.enabled() });
    let release!: () => void;
    engine.hold = new Promise<void>(r => (release = r));
    const alert = (node: string) => ({ name: 'NodeNotReady', severity: 'critical', labels: { node }, annotations: {}, startsAt: '2026-11-18T04:59:00Z', fingerprint: `fp-${node}` });
    const first = await runner.enqueue(alert('n1'), 'webhook');
    const second = await runner.enqueue(alert('n2'), 'webhook');
    const manual = await runner.enqueue(alert('n3'), 'api');
    await until(() => engine.started === 1);
    await setting.set(false, 'alice');
    engine.hold = undefined;
    release();
    await until(async () => (await reader.get(first.id))?.status === 'done' && (await reader.get(manual.id))?.status === 'done');
    expect((await reader.get(second.id))?.status).toBe('skipped');
    expect(engine.ids).toEqual([first.id, manual.id]);
    await runner.drain();
  });
});

describe('manual starts when the setting is off', () => {
  it('POST /api/diagnoses with an alert starts an investigation', async () => {
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    await putSetting(server.port, { enabled: false });
    const res = await fetch(`${base(server.port)}/api/diagnoses`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ alert: { name: 'ByHand', severity: 'critical', labels: { alertname: 'ByHand' }, annotations: {}, startsAt: new Date().toISOString() } }) });
    expect(res.status).toBe(202);
    const { id } = await res.json();
    await until(async () => (await reader.get(id))?.status === 'done');
    expect(engine.ids).toEqual([id]);
    await server.close();
  });

  it('a person can run a skipped incident, and the marker goes away', async () => {
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    await putSetting(server.port, { enabled: false });
    await fire(server.port, 'n1');
    const [skipped] = await all();
    expect(skipped!.status).toBe('skipped');
    const res = await fetch(`${base(server.port)}/api/diagnoses/${skipped!.id}/rerun`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    expect(res.status).toBe(202);
    await until(async () => (await reader.get(skipped!.id))?.status === 'done');
    const d = (await reader.get(skipped!.id))!;
    expect(d.skipped).toBeUndefined();
    expect(d.rerunAt).toBeTruthy();
    expect(d.previousAttempts ?? []).toEqual([]);
    expect(engine.ids).toEqual([skipped!.id]);
    expect((await metricsText(server.port))).toContain('headlamp_agent_automatic_investigations_skipped_total{path="webhook"} 1');
    await server.close();
  });

  it('a run by hand of a skipped incident survives a restart while the setting is off', async () => {
    const store = await podStore(db, { owner: 'S' });
    await new AutomaticInvestigations(store).set(false, 'alice');
    await reader.put(stale('manual', { rerunAt: '2026-11-18T05:00:30.000Z', status: 'queued' }));
    const runner = new Runner({ toolHost: () => ({}) } as never, store, config(), undefined, undefined, { automatic: () => new AutomaticInvestigations(store).enabled() });
    await runner.scan();
    await until(async () => (await reader.get('manual'))?.status === 'done');
    await runner.drain();
  });

  it('still answers 409 for a done diagnosis and says what can run again', async () => {
    await reader.put(stale('d1', { status: 'done', owner: 'other', leaseUntil: undefined }));
    const server = await startServer(config(), 'test', { store: await podStore(db, { owner: 'S' }) });
    const res = await fetch(`${base(server.port)}/api/diagnoses/d1/rerun`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Only a failed or skipped diagnosis can run again. This one is done.');
    await server.close();
  });
});
