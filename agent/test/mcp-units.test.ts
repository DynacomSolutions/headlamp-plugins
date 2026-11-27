import { describe, expect, it, vi } from 'vitest';
import type { Diagnosis } from '../src/agent/report.js';
import { keepIncident } from '../src/incidents/changes.js';
import { MemoryEventLog } from '../src/incidents/events.js';
import { canSee, parseUri } from '../src/incidents/model.js';
import type { TimelineEntry } from '../src/incidents/types.js';
import { PvWatch } from '../src/mcp/pv-watch.js';
import { TokenStore } from '../src/mcp/auth.js';
import { parseTokens } from '../src/auth/scopes.js';

const entries = (from: number, to: number): TimelineEntry[] => Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i, at: 'x', kind: 'note', actor: 'a', text: `n${from + i}`, data: null }));
const record = (timeline: TimelineEntry[], noteCount: number): Diagnosis => ({ id: 'a', createdAt: 'x', status: 'done', source: 'webhook', host: 'c', alert: { name: 'A', severity: 'critical', labels: {}, annotations: {}, startsAt: 'x', fingerprint: 'f' }, evidence: [], toolCalls: 0, model: 'm', a2ui: [], incident: { timeline, noteCount } }) as Diagnosis;

describe('keepIncident at the timeline cap (security L5)', () => {
  it('keeps the newer incident state when an older copy has the same number of entries', () => {
    const current = record(entries(2, 501), 501);
    const older = record(entries(1, 500), 500);
    expect(keepIncident(current, older).incident).toBe(current.incident);
    // A copy that adds a new unnumbered entry on top of the current state is kept.
    const next = record([...entries(2, 501), { seq: 0, at: 'y', kind: 'note', actor: 'a', text: 'new', data: null }], 502);
    expect(keepIncident(current, next)).toBe(next);
  });
});

describe('event URIs (security S3)', () => {
  it('refuses an unknown query key, so a subscription cannot repeat one query 100 times', () => {
    expect(parseUri('headlamp://events?x=1')).toBeUndefined();
    expect(parseUri('headlamp://incidents?bogus=1')).toBeUndefined();
    expect(parseUri('headlamp://incidents/abc?x=1')).toBeUndefined();
    expect(parseUri('headlamp://storage/volumes?x=1')).toBeUndefined();
    expect(parseUri('headlamp://events?after=1&logId=00000000-0000-4000-8000-000000000000&limit=5&kind=incident.&label=a%3Db')).toMatchObject({ type: 'events', after: '1' });
    expect(parseUri('headlamp://incidents?state=open&severity=critical&severity=warning&label=a%3Db&test=true')).toMatchObject({ type: 'incidents' });
  });

  it('gives each event kind the scope of its primary URI', () => {
    const s = (...names: string[]) => new Set(names);
    expect(canSee(s('incidents:read'), 'incident.created')).toBe(true);
    expect(canSee(s('incidents:read'), 'investigation.done')).toBe(false);
    expect(canSee(s('incidents:read'), 'settings.changed')).toBe(false);
    expect(canSee(s('storage:read'), 'incident.created')).toBe(false);
    expect(canSee(s('storage:read'), 'storage.updated')).toBe(true);
    expect(canSee(s('registry:read'), 'incident.created')).toBe(false);
    expect(canSee(s(), 'reset')).toBe(true);
    expect(canSee(s('incidents:read', 'agent:investigate', 'storage:read', 'settings:read'), 'something.new')).toBe(false);
  });
});

describe('the event log head (contract sections 6.1 and 8.3)', () => {
  it('has a logId, and a cursor ahead of the log is a reset', async () => {
    const log = new MemoryEventLog();
    const one = await new MemoryEventLog().head();
    expect(one.logId).toMatch(/^[0-9a-f-]{36}$/);
    expect(one.logId).not.toBe((await log.head()).logId);
    expect((await log.readAfter(5n, 10)).reset).toBe(true); // an empty log, a cursor ahead
    await log.append([{ kind: 'settings.changed', uri: 'headlamp://settings/automatic-investigations' }]);
    expect((await log.readAfter(1n, 10)).reset).toBe(false);
    expect((await log.readAfter(2n, 10)).reset).toBe(true);
    expect((await log.readAfter(0n, 10)).reset).toBe(false);
  });

  it('counts an event only after it committed', async () => {
    const log = new MemoryEventLog();
    const seen: string[] = [];
    log.onRecorded = k => seen.push(k);
    const stored = await log.append([{ kind: 'settings.changed', uri: 'headlamp://settings/automatic-investigations' }]);
    expect(seen).toEqual([]);
    await log.committed(stored);
    expect(seen).toEqual(['settings.changed']);
  });
});

describe('tokens (security S1, S2 and contract section 4.3)', () => {
  const file = [
    { name: 'a', token: 'a'.repeat(20), scopes: ['incidents:read', 'bogus:scope'] },
    { name: 'Anonymous', token: 'b'.repeat(20), scopes: ['incidents:read'] },
    { name: 'c', token: 'c'.repeat(20), scopes: ['registry:read'] },
  ];
  it('drops an entry named anonymous and accepts the object form', () => {
    expect(parseTokens(file).map(e => e.name)).toEqual(['a', 'c']);
    expect(parseTokens({ tokens: file }).map(e => e.name)).toEqual(['a', 'c']);
  });

  it('ignores unknown scopes, counts them once, and tells when a token is no longer valid', () => {
    let entries = parseTokens(file);
    const counted = vi.fn();
    const store = new TokenStore('', counted, () => entries);
    const who = store.lookup(`Bearer ${'a'.repeat(20)}`)!;
    expect([...who.scopes]).toEqual(['incidents:read']);
    store.lookup(`Bearer ${'a'.repeat(20)}`);
    expect(counted).toHaveBeenCalledTimes(1);
    expect(who.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(store.stillValid(who)).toBe(true);
    entries = parseTokens([{ ...file[0], scopes: [] as string[] }]);
    expect(store.stillValid(who)).toBe(false); // the entry has no scopes now (and an empty entry is dropped)
    entries = parseTokens([file[2]!]);
    expect(store.stillValid(who)).toBe(false);
    expect(store.lookup(`Bearer ${'z'.repeat(20)}`)).toBeUndefined();
  });
});

describe('PersistentVolume watch (contract section 7.1)', () => {
  const stream = (lines: unknown[]) => new Response(new ReadableStream({ start: c => { for (const l of lines) c.enqueue(new TextEncoder().encode(`${JSON.stringify(l)}\n`)); c.close(); } }));
  const pv = (name: string, phase: string, resourceVersion = '1') => ({ metadata: { name, resourceVersion }, status: { phase } });

  it('raises storage.updated when a volume appears, changes phase or disappears, and not for an unchanged one', async () => {
    const log = new MemoryEventLog();
    const raised: string[] = [];
    log.listen(e => raised.push(`${e.kind} ${e.uri}`));
    let calls = 0;
    const watch = new PvWatch(
      {
        getJson: async () => ({ metadata: { resourceVersion: '5' }, items: [pv('a', 'Bound'), pv('b', 'Available')] }) as never,
        request: async path => {
          calls++;
          expect(path).toContain('watch=true');
          return stream([
            { type: 'MODIFIED', object: pv('a', 'Bound') }, // same phase
            { type: 'BOOKMARK', object: { metadata: { resourceVersion: '6' } } },
            { type: 'MODIFIED', object: pv('b', 'Bound') },
            { type: 'ADDED', object: pv('c', 'Pending') },
            { type: 'DELETED', object: pv('a', 'Bound') },
          ]);
        },
      },
      log,
      () => {},
      20,
    );
    watch.start();
    for (let i = 0; i < 300 && raised.length < 3; i++) await new Promise(r => setTimeout(r, 10));
    await watch.stop();
    expect(raised.slice(0, 3)).toEqual(Array(3).fill('storage.updated headlamp://storage/volumes'));
    expect(calls).toBeGreaterThanOrEqual(1);
    expect((await log.head()).latest).not.toBeNull();
  });
});
