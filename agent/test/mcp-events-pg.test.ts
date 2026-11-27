import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Diagnosis } from '../src/agent/report.js';
import type { EventRecord } from '../src/incidents/types.js';
import { pgliteDb, podStore } from './helpers/pglite.js';

// A real PostgreSQL (PGlite) starts here, so these tests get a long timeout.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let db: ReturnType<typeof pgliteDb>;
let clock = Date.parse('2026-11-28T00:00:00Z');
beforeEach(() => {
  db = pgliteDb();
  clock = Date.parse('2026-11-28T00:00:00Z');
});
afterEach(async () => {
  await db.close();
});

function record(id: string, extra: Partial<Diagnosis> = {}): Diagnosis {
  return { id, createdAt: '2026-11-28T00:00:00.000Z', status: 'queued', source: 'webhook', host: 'cluster', alert: { name: 'A', severity: 'critical', labels: { alertname: 'A', test: 'true' }, annotations: {}, startsAt: '2026-11-28T00:00:00Z', fingerprint: `f-${id}` }, evidence: [], toolCalls: 0, model: 'm', a2ui: [], ...extra };
}

describe('the event log in PostgreSQL', () => {
  it('writes events in the same transaction as the record and numbers them in order', async () => {
    const store = await podStore(db, { now: () => clock });
    await store.putNew(record('a'));
    await store.update('a', d => (d ? { ...d, status: 'running' } : undefined));
    await store.update('a', d => (d ? { ...d, status: 'done', finishedAt: '2026-11-28T00:01:00.000Z' } : undefined));
    await store.markResolved('f-a', '2026-11-28T00:02:00.000Z');
    const page = await store.events.readAfter(0n, 100);
    expect(page.events.map(e => e.kind)).toEqual(['incident.created', 'investigation.queued', 'investigation.started', 'investigation.done', 'incident.resolved']);
    const ids = page.events.map(e => BigInt(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : 1)));
    expect(page.events[0]).toMatchObject({ uri: 'headlamp://incidents/a', incidentId: 'a', labels: { alertname: 'A', test: 'true' }, state: 'open' });
    expect(page.events.at(-1)).toMatchObject({ state: 'resolved' });
    const d = (await store.get('a'))!;
    expect(d.incident?.timeline.map(t => t.kind)).toEqual(['fired', 'investigation_queued', 'investigation_started', 'investigation_done', 'alert_resolved']);
    expect(d.incident?.timeline.map(t => t.seq)).toEqual([1, 2, 3, 4, 5]);
    await store.events.close();
  });

  it('writes no event when the write is refused', async () => {
    const store = await podStore(db);
    await store.putNew(record('a'));
    const before = (await store.events.head()).latest;
    expect(await store.putNew(record('a'))).toBe(false);
    expect(await store.update('a', () => undefined)).toBe(false);
    expect((await store.events.head()).latest).toBe(before);
    await store.events.close();
  });

  it('sends an event to the listeners of every pod, once and in order', async () => {
    const a = await podStore(db, { owner: 'a' });
    const b = await podStore(db, { owner: 'b' });
    const onA: EventRecord[] = [];
    const onB: EventRecord[] = [];
    a.events.listen(e => onA.push(e));
    b.events.listen(e => onB.push(e));
    await a.putNew(record('x'));
    await b.putNew(record('y', { alert: { ...record('y').alert, fingerprint: 'f-y' } }));
    await a.update('x', d => (d ? { ...d, resolvedAt: '2026-11-28T00:05:00.000Z' } : undefined), { force: true });
    for (let i = 0; i < 300 && (onA.length < 5 || onB.length < 5); i++) await new Promise(r => setTimeout(r, 10));
    const kinds = (l: EventRecord[]) => l.map(e => `${e.incidentId}:${e.kind}`);
    expect(kinds(onA)).toEqual(['x:incident.created', 'x:investigation.queued', 'y:incident.created', 'y:investigation.queued', 'x:incident.resolved']);
    expect(kinds(onB)).toEqual(kinds(onA));
    expect(new Set(onA.map(e => e.id)).size).toBe(onA.length);
    await a.events.close();
    await b.events.close();
  });

  it('keeps the incident state when a writer holds an older copy', async () => {
    const store = await podStore(db);
    await store.putNew(record('a'));
    await store.update('a', d => (d ? { ...d, incident: { acknowledgedAt: 'now', acknowledgedBy: 'me', timeline: [...(d.incident?.timeline ?? []), { seq: 0, at: 'now', kind: 'acknowledged', actor: 'me', text: null, data: null }] } } : undefined), { force: true });
    await store.put(record('a', { status: 'done' })); // the runner's older copy has no incident state
    const d = (await store.get('a'))!;
    expect(d.incident?.acknowledgedBy).toBe('me');
    expect(d.incident?.timeline.map(t => t.kind)).toEqual(['fired', 'investigation_queued', 'acknowledged', 'investigation_done']);
    await store.events.close();
  });

  it('removes old events, remembers the highest removed id and reports a reset', async () => {
    const store = await podStore(db, { now: () => clock });
    await store.putNew(record('a'));
    clock += 8 * 24 * 3600_000;
    await store.putNew(record('b', { alert: { ...record('b').alert, fingerprint: 'f-b' } }));
    const removed = await store.events.prune();
    expect(removed).toBe(2);
    expect((await store.events.head()).oldestRetained).toBe('3');
    expect(await store.events.count()).toBe(2);
    expect((await store.events.readAfter(1n, 10)).reset).toBe(true);
    expect((await store.events.readAfter(2n, 10)).reset).toBe(false);
    expect((await store.events.readAfter(0n, 10)).reset).toBe(false);
    await store.events.close();
  });
});
