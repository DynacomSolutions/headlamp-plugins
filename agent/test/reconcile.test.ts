import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprint } from '../src/alerts.js';
import { loadConfig } from '../src/config.js';
import { Metrics } from '../src/metrics.js';
import { GRACE_MS, Reconciler, isPresent, readVmalert, resolvedTime, type VmalertSnapshot } from '../src/reconcile.js';
import { MemoryDiagnosisStore, type DiagnosisStore } from '../src/store.js';
import type { Diagnosis } from '../src/agent/report.js';
import { pgliteDb, podStore } from './helpers/pglite.js';

// The PostgreSQL tests start PGlite. On a busy CI runner it takes about 10 s.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const engine = vi.hoisted(() => ({ started: 0 }));

vi.mock('../src/agent/engine.js', () => ({
  diagnose: vi.fn(async (opts: { id: string; alert: unknown; source: string; host: string; budget: number }) => {
    engine.started++;
    return { id: opts.id, createdAt: 'x', status: 'done', source: opts.source, host: opts.host, alert: opts.alert, evidence: [], toolCalls: 0, toolBudget: opts.budget, model: 'm', a2ui: [] };
  }),
}));

const { startServer } = await import('../src/server.js');

const NOW = Date.parse('2026-11-23T08:30:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function labelsOf(name: string, extra: Record<string, string> = {}): Record<string, string> {
  return { alertname: name, severity: 'critical', namespace: 'waltai', deployment: name.toLowerCase(), ...extra };
}

function diagnosis(id: string, extra: Partial<Diagnosis> & { name?: string; labels?: Record<string, string>; startsAt?: string } = {}): Diagnosis {
  const { name = 'KubeDeploymentDown', labels = labelsOf(name), startsAt = iso(NOW - 2 * HOUR), ...rest } = extra;
  return {
    id,
    createdAt: startsAt,
    status: 'done',
    source: 'webhook',
    host: 'cluster',
    alert: { name, severity: labels.severity ?? 'critical', labels, annotations: {}, startsAt, endsAt: iso(Date.parse(startsAt) + 300_000), fingerprint: fingerprint(labels) },
    evidence: [],
    toolCalls: 0,
    toolBudget: 5,
    model: 'm',
    a2ui: [],
    ...rest,
  };
}

const snapshot = (alerts: Array<{ name: string; labels?: Record<string, string>; state?: string }>, unevaluated: string[] = []): VmalertSnapshot => ({
  alerts: alerts.map(a => ({ name: a.name, labels: a.labels ?? labelsOf(a.name), state: a.state ?? 'firing' })),
  unevaluated: new Set(unevaluated),
});

function reconciler(store: DiagnosisStore, snap: () => Promise<VmalertSnapshot>, metrics = new Metrics()) {
  return { metrics, r: new Reconciler({ store, snapshot: snap, metrics, intervalMs: 60_000 }) };
}

describe('readVmalert', () => {
  const answer = (alerts: unknown, groups: unknown): typeof fetch =>
    (async (url: string) => {
      const data = String(url).endsWith('/api/v1/alerts') ? { alerts } : { groups };
      return new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
    }) as never;

  it('keeps pending and firing alerts and reads the group evaluation', async () => {
    const snap = await readVmalert(
      'http://vm',
      NOW,
      answer(
        [
          { name: 'A', state: 'firing', labels: { alertname: 'A', severity: 'critical' } },
          { name: 'B', state: 'pending', labels: { alertname: 'B' } },
          { name: 'C', state: 'inactive', labels: { alertname: 'C' } },
        ],
        [
          { name: 'fresh', interval: 60, lastEvaluation: iso(NOW - 30_000), rules: [{ name: 'A' }] },
          { name: 'never', interval: 3600, lastEvaluation: '0001-01-01T00:00:00Z', rules: [{ name: 'U' }] },
          { name: 'stuck', interval: 60, lastEvaluation: iso(NOW - HOUR), rules: [{ name: 'S' }] },
        ],
      ),
    );
    expect(snap.alerts.map(a => a.name)).toEqual(['A', 'B']);
    expect([...snap.unevaluated].sort()).toEqual(['S', 'U']);
  });

  it('throws when vmalert lists no rule group, so nothing is resolved from an empty answer', async () => {
    await expect(readVmalert('http://vm', NOW, answer([], []))).rejects.toThrow('no rule group');
  });

  it('throws on an error status', async () => {
    const failing = (async () => new Response('no', { status: 503 })) as never;
    await expect(readVmalert('http://vm', NOW, failing)).rejects.toThrow('503');
  });
});

describe('isPresent', () => {
  it('matches by fingerprint', () => {
    const d = diagnosis('a');
    expect(isPresent(d, snapshot([{ name: 'KubeDeploymentDown' }]), new Set([d.alert.fingerprint]))).toBe(true);
  });

  it('matches by name and labels when the fingerprints differ (an extra or a missing label)', () => {
    const d = diagnosis('a');
    const withExtra = snapshot([{ name: 'KubeDeploymentDown', labels: labelsOf('KubeDeploymentDown', { cluster: 'main' }) }]);
    expect(isPresent(d, withExtra, new Set())).toBe(true);
    const fewer = diagnosis('b', { labels: { alertname: 'KubeDeploymentDown', severity: 'critical', namespace: 'waltai' } });
    expect(isPresent(fewer, snapshot([{ name: 'KubeDeploymentDown' }]), new Set())).toBe(true);
  });

  it('does not match another deployment of the same alert', () => {
    const d = diagnosis('a');
    const other = snapshot([{ name: 'KubeDeploymentDown', labels: labelsOf('KubeDeploymentDown', { deployment: 'walt-api' }) }]);
    expect(isPresent(d, other, new Set())).toBe(false);
  });
});

describe('resolvedTime', () => {
  it('uses the last expected end when it lies after the last fire and before now', () => {
    const d = diagnosis('a', { startsAt: iso(NOW - 5 * HOUR) });
    expect(resolvedTime(d, NOW)).toBe(d.alert.endsAt);
  });

  it('uses now when a later fire passed the stored end', () => {
    const d = diagnosis('a', { startsAt: iso(NOW - 5 * HOUR), lastFiredAt: iso(NOW - HOUR) });
    expect(resolvedTime(d, NOW)).toBe(iso(NOW));
  });
});

describe('Reconciler', () => {
  let store: MemoryDiagnosisStore;
  beforeEach(() => {
    store = new MemoryDiagnosisStore({ owner: 'A', now: () => NOW });
  });
  const isOpen = async (id: string) => !(await store.get(id))?.resolvedAt;

  it('resolves an open diagnosis whose alert is gone and keeps one that is firing or pending', async () => {
    await store.put(diagnosis('gone', { name: 'Gone' }));
    await store.put(diagnosis('firing', { name: 'Firing' }));
    await store.put(diagnosis('pending', { name: 'Pending' }));
    const { r, metrics } = reconciler(store, async () => snapshot([{ name: 'Firing' }, { name: 'Pending', state: 'pending' }]));
    const result = await r.runOnce();
    expect(result).toMatchObject({ result: 'ok', resolved: 1, open: 2 });
    expect(await isOpen('gone')).toBe(false);
    expect((await store.get('gone'))?.resolvedNote).toContain('vmalert has no firing or pending alert');
    expect(await isOpen('firing')).toBe(true);
    expect(await isOpen('pending')).toBe(true);
    expect(metrics.get('headlamp_agent_reconcile_resolved_total')).toBe(1);
    expect(metrics.get('headlamp_agent_reconcile_runs_total', { result: 'ok' })).toBe(1);
    expect(metrics.get('headlamp_agent_reconcile_vmalert_alerts')).toBe(2);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await store.put(diagnosis('gone', { name: 'Gone' }));
    const { r } = reconciler(store, async () => snapshot([]));
    await r.runOnce();
    const first = await store.get('gone');
    const again = await r.runOnce();
    expect(again).toMatchObject({ result: 'ok', resolved: 0, open: 0 });
    expect(await store.get('gone')).toEqual(first);
  });

  it('leaves a diagnosis that a person or an outside agent reported', async () => {
    await store.put(diagnosis('api', { name: 'Reported', source: 'api' }));
    const { r } = reconciler(store, async () => snapshot([]));
    await r.runOnce();
    expect(await isOpen('api')).toBe(true);
  });

  it('leaves a diagnosis inside the grace window and one whose rule group is not evaluated', async () => {
    const recent = iso(NOW - GRACE_MS + 10_000);
    await store.put(diagnosis('fresh', { name: 'Fresh', startsAt: recent }));
    await store.put(diagnosis('unknown', { name: 'Unevaluated' }));
    const { r } = reconciler(store, async () => snapshot([], ['Unevaluated']));
    const result = await r.runOnce();
    expect(result.resolved).toBe(0);
    expect(await isOpen('fresh')).toBe(true);
    expect(await isOpen('unknown')).toBe(true);
  });

  it('resolves nothing when vmalert cannot be read, and counts the error', async () => {
    await store.put(diagnosis('gone', { name: 'Gone' }));
    const { r, metrics } = reconciler(store, async () => {
      throw new Error('vmalert answered 503');
    });
    const result = await r.runOnce();
    expect(result).toMatchObject({ result: 'error' });
    expect(await isOpen('gone')).toBe(true);
    expect(metrics.get('headlamp_agent_reconcile_runs_total', { result: 'error' })).toBe(1);
  });

  it('folds duplicate open diagnoses in the same run', async () => {
    const labels = labelsOf('Repeats');
    await store.put(diagnosis('old', { name: 'Repeats', labels, startsAt: iso(NOW - 3 * HOUR) }));
    await store.put(diagnosis('new', { name: 'Repeats', labels, startsAt: iso(NOW - 2 * HOUR) }));
    const { r, metrics } = reconciler(store, async () => snapshot([{ name: 'Repeats', labels }]));
    const result = await r.runOnce();
    expect(result.folded).toBe(1);
    expect(await isOpen('old')).toBe(false);
    expect(await isOpen('new')).toBe(true);
    expect(metrics.get('headlamp_agent_reconcile_folded_total')).toBe(1);
  });

  it('skips the run while another pod holds the lease, and takes over when it ends', async () => {
    let clock = NOW;
    const a = new MemoryDiagnosisStore({ owner: 'A', now: () => clock });
    await a.put(diagnosis('gone', { name: 'Gone' }));
    expect(await a.acquireLease('reconcile', 90_000)).toBe(true);
    // A second process on the same state: the in-memory store has one owner, so the lease is checked on `a` itself.
    const taken = new MemoryDiagnosisStore({ owner: 'B', now: () => clock });
    (taken as unknown as { leases: unknown }).leases = (a as unknown as { leases: unknown }).leases;
    const { r, metrics } = reconciler(taken, async () => snapshot([]));
    expect((await r.runOnce()).result).toBe('skipped');
    expect(metrics.get('headlamp_agent_reconcile_runs_total', { result: 'skipped' })).toBe(1);
    clock += 91_000;
    expect((await r.runOnce()).result).toBe('ok');
  });

  it('stops: no run after stop()', async () => {
    const { r } = reconciler(store, async () => snapshot([]));
    await r.stop();
    expect((await r.runOnce()).result).toBe('skipped');
  });
});

describe('foldDuplicates (the start migration)', () => {
  const labels = labelsOf('KubeDeploymentDown', { deployment: 'walt-engine' });
  const eight = (store: DiagnosisStore) =>
    Promise.all(Array.from({ length: 8 }, (_, i) => store.put(diagnosis(`d${i}`, { labels, startsAt: iso(NOW - (10 - i) * HOUR) }))));

  it('keeps the newest open, resolves the rest at the time each was replaced, and sums the fires', async () => {
    const store = new MemoryDiagnosisStore({ now: () => NOW });
    await eight(store);
    await store.put(diagnosis('other', { labels: labelsOf('KubeDeploymentDown', { deployment: 'walt-api' }) }));
    await store.put(diagnosis('manual', { labels, source: 'api', startsAt: iso(NOW - HOUR) }));
    expect(await store.foldDuplicates()).toEqual({ groups: 1, folded: 7 });
    const open = (await store.openSummaries()).map(d => d.id).sort();
    expect(open).toEqual(['d7', 'manual', 'other']);
    const kept = await store.get('d7');
    expect(kept?.fires).toBe(8);
    expect(kept?.lastFiredAt).toBe(iso(NOW - 3 * HOUR));
    const folded = await store.get('d3');
    expect(folded?.resolvedAt).toBe((await store.get('d4'))?.createdAt);
    expect(folded?.resolvedNote).toBe('Folded into d7: the same alert fired again.');
  });

  it('is idempotent and does not count twice', async () => {
    const store = new MemoryDiagnosisStore({ now: () => NOW });
    await eight(store);
    await store.foldDuplicates();
    expect(await store.foldDuplicates()).toEqual({ groups: 0, folded: 0 });
    expect((await store.get('d7'))?.fires).toBe(8);
  });

  it('folds only one fingerprint when asked', async () => {
    const store = new MemoryDiagnosisStore({ now: () => NOW });
    const other = labelsOf('KubeDeploymentDown', { deployment: 'walt-api' });
    await store.put(diagnosis('a1', { labels, startsAt: iso(NOW - 3 * HOUR) }));
    await store.put(diagnosis('a2', { labels, startsAt: iso(NOW - 2 * HOUR) }));
    await store.put(diagnosis('b1', { labels: other, startsAt: iso(NOW - 3 * HOUR) }));
    await store.put(diagnosis('b2', { labels: other, startsAt: iso(NOW - 2 * HOUR) }));
    expect(await store.foldDuplicates(fingerprint(labels))).toEqual({ groups: 1, folded: 1 });
    expect((await store.openSummaries()).map(d => d.id).sort()).toEqual(['a2', 'b1', 'b2']);
  });

  it('keeps fires and the resolved mark when the runner writes an older copy', async () => {
    const store = new MemoryDiagnosisStore({ now: () => NOW });
    await store.put(diagnosis('x', { labels }));
    await store.attachFire('x', iso(NOW - HOUR));
    await store.put(diagnosis('x', { labels })); // a stale copy without fires
    expect(await store.get('x')).toMatchObject({ fires: 2, lastFiredAt: iso(NOW - HOUR) });
    await store.resolveOpen('x', iso(NOW), 'note');
    await store.put(diagnosis('x', { labels }));
    expect(await store.get('x')).toMatchObject({ resolvedAt: iso(NOW), resolvedNote: 'note' });
  });
});

describe('PostgreSQL store', () => {
  let db: ReturnType<typeof pgliteDb>;
  beforeEach(() => {
    db = pgliteDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it('folds, finds open records and shares the lease between two pods', async () => {
    let clock = NOW;
    const a = await podStore(db, { owner: 'A', now: () => clock });
    const b = await podStore(db, { owner: 'B', now: () => clock });
    const labels = labelsOf('KubeDeploymentDown', { deployment: 'walt-engine' });
    for (let i = 0; i < 4; i++) await a.put(diagnosis(`d${i}`, { labels, startsAt: iso(NOW - (6 - i) * HOUR) }));
    await a.put(diagnosis('done', { name: 'Other', resolvedAt: iso(NOW - HOUR) }));
    expect((await b.findOpenByFingerprint(fingerprint(labels)))?.id).toBe('d3');
    expect(await b.findOpenByFingerprint('none')).toBeUndefined();
    expect((await b.openSummaries()).map(d => d.id)).toEqual(['d3', 'd2', 'd1', 'd0']);

    // Two pods fold at the same time: the result is one open record with the right count.
    const [x, y] = await Promise.all([a.foldDuplicates(), b.foldDuplicates()]);
    expect(x.folded + y.folded).toBeGreaterThanOrEqual(3);
    expect((await a.openSummaries()).map(d => d.id)).toEqual(['d3']);
    expect((await a.get('d3'))?.fires).toBe(4);
    expect((await a.get('d0'))?.resolvedNote).toBe('Folded into d3: the same alert fired again.');
    expect(await a.foldDuplicates()).toEqual({ groups: 0, folded: 0 });

    expect(await a.acquireLease('reconcile', 90_000)).toBe(true);
    expect(await b.acquireLease('reconcile', 90_000)).toBe(false);
    expect(await a.acquireLease('reconcile', 90_000)).toBe(true);
    clock += 91_000;
    expect(await b.acquireLease('reconcile', 90_000)).toBe(true);
    expect(await a.acquireLease('reconcile', 90_000)).toBe(false);
  });

  it('attaches a fire once for each activation', async () => {
    const store = await podStore(db, { owner: 'A', now: () => NOW });
    await store.put(diagnosis('x', { startsAt: iso(NOW - 4 * HOUR) }));
    expect(await store.attachFire('x', iso(NOW - 4 * HOUR))).toBe(false); // the first activation itself
    expect(await store.attachFire('x', iso(NOW - HOUR))).toBe(true);
    expect(await store.attachFire('x', iso(NOW - HOUR))).toBe(false); // a re-send
    expect(await store.attachFire('x', iso(NOW - 2 * HOUR))).toBe(false); // older than the last one
    expect(await store.get('x')).toMatchObject({ fires: 2, lastFiredAt: iso(NOW - HOUR) });
  });
});

describe('the alert webhook', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-reconcile-'));
    engine.started = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function config() {
    const c = { ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent', dataDir: dir };
    c.models = { routes: [{ id: 'one', style: 'openai' as const, baseUrl: 'http://127.0.0.1:1', apiKey: 'k', headers: {}, systemPrefix: '', models: ['a'], maxTokens: 10, timeoutMs: 500 }], defaultModel: 'one/a', skipped: [] };
    c.diagnosis = { ...c.diagnosis, maxPerHour: 100 };
    return c;
  }

  const post = (port: number, alerts: unknown[]) => fetch(`http://127.0.0.1:${port}/api/v2/alerts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(alerts) });
  const labels = { alertname: 'KubeDeploymentDown', severity: 'critical', namespace: 'waltai', deployment: 'walt-engine' };
  const firing = (startsAt: string) => ({ labels, startsAt, endsAt: '2099-01-01T00:00:00Z' });
  const resolved = (startsAt: string) => ({ labels, startsAt, endsAt: '2026-01-01T00:00:00Z' });
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 300 && !(await check()); i++) await new Promise(r => setTimeout(r, 10));
    expect(await check()).toBe(true);
  };

  it('attaches a re-fire to the open diagnosis and counts it once', async () => {
    const store = new MemoryDiagnosisStore({ owner: 'S' });
    const server = await startServer(config(), 'test', { store });
    await post(server.port, [firing('2026-11-20T06:40:00Z')]);
    await until(async () => (await store.openSummaries()).length === 1 && (await store.openSummaries())[0]!.status === 'done');
    for (const startsAt of ['2026-11-21T06:40:00Z', '2026-11-21T06:40:00Z', '2026-11-22T06:40:00Z']) await post(server.port, [firing(startsAt)]);
    const open = await store.openSummaries();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ fires: 3, lastFiredAt: '2026-11-22T06:40:00Z' });
    expect((await store.page()).total).toBe(1);
    expect(engine.started).toBe(1);
    const text = await (await fetch(`http://127.0.0.1:${server.port}/metrics`)).text();
    expect(text).toContain('headlamp_agent_alert_repeats_merged_total 2');
    await server.close();
  });

  it('starts a new diagnosis after a resolve, and counts the resolve', async () => {
    const store = new MemoryDiagnosisStore({ owner: 'S' });
    const server = await startServer(config(), 'test', { store });
    await post(server.port, [firing('2026-11-20T06:40:00Z')]);
    await until(async () => (await store.page()).total === 1);
    await post(server.port, [resolved('2026-11-20T06:40:00Z')]);
    expect(await store.openSummaries()).toHaveLength(0);
    await post(server.port, [firing('2026-11-21T06:40:00Z')]);
    await until(async () => (await store.page()).total === 2);
    expect(await store.openSummaries()).toHaveLength(1);
    const text = await (await fetch(`http://127.0.0.1:${server.port}/metrics`)).text();
    expect(text).toContain('headlamp_agent_resolve_notifications_total 1');
    await server.close();
  });

  it('starts a new diagnosis when the open one failed, and folds the failed one', async () => {
    const store = new MemoryDiagnosisStore({ owner: 'S' });
    await store.put(diagnosis('failed', { labels, status: 'failed', startsAt: '2026-11-20T06:40:00.000Z', createdAt: '2026-11-20T06:40:00.000Z' }));
    const server = await startServer(config(), 'test', { store });
    await post(server.port, [firing('2026-11-21T06:40:00Z')]);
    await until(async () => (await store.page()).total === 2);
    await until(async () => (await store.openSummaries()).length === 1);
    expect((await store.get('failed'))?.resolvedNote).toContain('Folded into');
    expect((await store.openSummaries())[0]!.fires).toBe(2);
    await server.close();
  });

  it('exposes the open diagnoses by severity on /metrics', async () => {
    const store = new MemoryDiagnosisStore({ owner: 'S' });
    await store.put(diagnosis('c1', { name: 'A' }));
    await store.put(diagnosis('c2', { name: 'B' }));
    await store.put(diagnosis('w1', { name: 'C', labels: labelsOf('C', { severity: 'warning' }) }));
    await store.put(diagnosis('r1', { name: 'D', resolvedAt: '2026-11-22T00:00:00Z' }));
    const server = await startServer(config(), 'test', { store });
    const text = await (await fetch(`http://127.0.0.1:${server.port}/metrics`)).text();
    expect(text).toContain('headlamp_agent_diagnoses_open{severity="critical"} 2');
    expect(text).toContain('headlamp_agent_diagnoses_open{severity="warning"} 1');
    expect(text).toContain('# TYPE headlamp_agent_reconcile_runs_total counter');
    await server.close();
  });

  it('runs a reconcile at start: it folds the duplicates that the old data holds', async () => {
    const store = new MemoryDiagnosisStore({ owner: 'S' });
    await store.put(diagnosis('o1', { labels, startsAt: '2026-11-20T06:40:00.000Z' }));
    await store.put(diagnosis('o2', { labels, startsAt: '2026-11-21T06:40:00.000Z' }));
    const server = await startServer(config(), 'test', { store });
    await until(async () => (await store.openSummaries()).length === 1);
    expect((await store.openSummaries())[0]).toMatchObject({ id: 'o2', fires: 2 });
    await server.close();
  });
});
