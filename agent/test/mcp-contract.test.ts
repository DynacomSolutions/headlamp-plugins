import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MemoryDiagnosisStore } from '../src/store.js';
import type { Diagnosis } from '../src/agent/report.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const engine = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, started: [] as string[] }));
vi.mock('../src/agent/engine.js', () => ({
  diagnose: vi.fn(async (opts: { id: string; alert: unknown; source: string; host: string; model?: { name: string } }) => {
    engine.started.push(opts.id);
    if (engine.hold) await engine.hold;
    return {
      id: opts.id,
      createdAt: 'x',
      status: 'done',
      source: opts.source,
      host: opts.host,
      alert: opts.alert,
      result: { summary: 's', likelyCause: 'c', confidence: 'high', signals: [], fixes: [{ title: 't', detail: 'd', recommended: true }], verify: 'v' },
      evidence: [{ id: 'e1', tool: 't', reason: 'r', summary: 's', ok: true }],
      toolCalls: 1,
      model: 'm',
      a2ui: [],
    };
  }),
}));

const { startServer } = await import('../src/server.js');

const ALL = 'registry:read incidents:read incidents:write incidents:resolve agent:investigate storage:read settings:read';
const TOKENS = { full: ['t-full-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ALL], reader: ['t-read-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'incidents:read'], writer: ['t-writ-cccccccccccccccccccccccccccccccc', 'incidents:read incidents:write'], badscope: ['t-badd-dddddddddddddddddddddddddddddddd', 'bogus:scope'] } as const;

let dir: string;
let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let store: MemoryDiagnosisStore;
let clock = Date.parse('2026-11-28T00:00:00Z');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-contract-'));
  writeFileSync(join(dir, 'tokens.json'), JSON.stringify(Object.entries(TOKENS).map(([name, [token, scopes]]) => ({ name, token, scopes: scopes.split(' ') }))));
  const config = { ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent' };
  config.models = { routes: [{ id: 'one', style: 'openai' as const, baseUrl: 'http://127.0.0.1:1', apiKey: 'k', headers: {}, systemPrefix: '', models: ['a'], maxTokens: 10, timeoutMs: 500 }], defaultModel: 'one/a', skipped: [] };
  config.diagnosis = { ...config.diagnosis, maxPerHour: 10_000 };
  config.mcp = { tokensFile: join(dir, 'tokens.json'), auth: 'optional' };
  store = new MemoryDiagnosisStore({ now: () => clock });
  server = await startServer(config, 'test', { store });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  await server.close();
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (name: keyof typeof TOKENS) => ({ authorization: `Bearer ${TOKENS[name][0]}` });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (check: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !check(); t += 10) await sleep(10);
  expect(check()).toBe(true);
};

async function connect(name: keyof typeof TOKENS) {
  const client = new Client({ name: `test-${name}`, version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth(name) } });
  await client.connect(transport);
  const seen: Array<{ method: string; params: any }> = [];
  client.setNotificationHandler('notifications/resources/updated', n => void seen.push({ method: n.method, params: n.params }));
  client.setNotificationHandler('notifications/resources/list_changed', n => void seen.push({ method: n.method, params: n.params }));
  return { client, transport, seen };
}

let counter = 0;
async function fire(labels: Record<string, string> = {}, severity = 'critical'): Promise<{ id: string; name: string }> {
  const name = `Alert${++counter}`;
  const startsAt = new Date(Date.parse('2026-11-28T00:00:00Z') + counter * 1000).toISOString();
  const res = await fetch(`${base}/api/v2/alerts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ labels: { alertname: name, severity, ...labels }, startsAt }]) });
  expect(res.status).toBe(200);
  await until(() => [...engine.started].length >= 0);
  const page = await store.page({ alert: name });
  return { id: page.diagnoses[0]!.id, name };
}

const structured = (r: any) => r.structuredContent as any;

describe('auth', () => {
  it('serves anonymous callers the registry tools only, and no session', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'a', version: '1' } } }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('refuses an invalid token and counts the failure', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
    expect(((await res.json()) as any).error.code).toBe('unauthenticated');
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(/headlamp_agent_mcp_auth_failures_total\{reason="invalid"\} [1-9]/);
  });

  it('refuses a token whose entry names an unknown scope', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...auth('badscope'), 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(await (await fetch(`${base}/metrics`)).text()).toMatch(/headlamp_agent_mcp_auth_failures_total\{reason="bad_scopes"\} [1-9]/);
  });

  it('opens a session for a token and declares the contract', async () => {
    const { client, transport } = await connect('full');
    expect(transport.sessionId).toBeTruthy();
    const caps = client.getServerCapabilities() as any;
    expect(caps.resources).toMatchObject({ subscribe: true, listChanged: true });
    expect(caps.experimental['dev.dynacom.headlamp'].contract).toBe('1.0.0');
    await client.close();
  });

  it('lists only the tools that the scopes allow', async () => {
    const reader = await connect('reader');
    const names = (await reader.client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_incidents', 'get_incident', 'get_incident_timeline']));
    expect(names).not.toContain('acknowledge_incident');
    expect(names).not.toContain('start_investigation');
    expect(names).not.toContain('list_storage_volumes');
    await reader.client.close();
    const full = await connect('full');
    const all = (await full.client.listTools()).tools.map(t => t.name);
    for (const n of ['list_incidents', 'get_incident', 'get_incident_timeline', 'acknowledge_incident', 'add_incident_note', 'resolve_incident', 'escalate_incident', 'start_investigation', 'get_investigation_status', 'get_investigation_result', 'list_storage_volumes', 'list_storage_disks', 'get_storage_smart', 'get_storage_capacity', 'list_nodes', 'list_workloads', 'get_automatic_investigations']) expect(all).toContain(n);
    await full.client.close();
  });

  it('denies a tool, a resource read and a subscription outside the scopes', async () => {
    const { id } = await fire();
    const reader = await connect('reader');
    await expect(reader.client.callTool({ name: 'acknowledge_incident', arguments: { incidentId: id } })).rejects.toThrow(/disabled/);
    await expect(reader.client.readResource({ uri: 'headlamp://storage/volumes' })).rejects.toThrow(/disabled/);
    await expect(reader.client.subscribeResource({ uri: 'headlamp://storage/volumes' })).rejects.toThrow(/storage:read/);
    await expect(reader.client.subscribeResource({ uri: `headlamp://investigations/${id}` })).rejects.toThrow(/agent:investigate/);
    await reader.client.close();
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(/headlamp_agent_mcp_auth_failures_total\{reason="scope"\} [1-9]/);
  });

  it('answers 404 for an unknown session and refuses a session of another client', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...auth('full'), 'mcp-session-id': 'nope', 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
    const a = await connect('full');
    const stolen = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...auth('writer'), 'mcp-session-id': a.transport.sessionId!, 'content-type': 'application/json' }, body: '{}' });
    expect(stolen.status).toBe(403);
    await a.client.close();
  });
});

describe('subscribe, event, read', () => {
  it('delivers an incident that the alert webhook creates, with only a URI and small meta', async () => {
    const { client, seen } = await connect('full');
    await client.subscribeResource({ uri: 'headlamp://incidents?label=test%3Dtrue' });
    await fire({ test: 'false' });
    const test = await fire({ test: 'true', source: 'contract-test' });
    await until(() => seen.some(s => s.method === 'notifications/resources/updated' && s.params._meta?.['dev.dynacom.headlamp/event']?.incidentId === test.id));
    const updated = seen.filter(s => s.method === 'notifications/resources/updated');
    // Only the test incident matched the filtered subscription.
    for (const u of updated) {
      expect(u.params.uri).toBe('headlamp://incidents?label=test%3Dtrue');
      expect(u.params._meta['dev.dynacom.headlamp/event'].labels.test).toBe('true');
      expect(JSON.stringify(u.params)).not.toContain('annotations');
    }
    const created = updated.find(u => u.params._meta['dev.dynacom.headlamp/event'].kind === 'incident.created')!;
    const meta = created.params._meta['dev.dynacom.headlamp/event'];
    expect(meta).toMatchObject({ kind: 'incident.created', incidentId: test.id });
    expect(meta.eventId).toMatch(/^\d+$/);
    // The list changed too.
    await until(() => seen.some(s => s.method === 'notifications/resources/list_changed'));
    // Read the resource for the content.
    const read = await client.readResource({ uri: `headlamp://incidents/${test.id}` });
    const incident = JSON.parse((read.contents[0] as any).text).incident;
    expect(incident).toMatchObject({ id: test.id, name: test.name, state: 'open', test: true });
    // Event ids grow.
    const ids = updated.map(u => BigInt(u.params._meta['dev.dynacom.headlamp/event'].eventId));
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    await client.close();
  });

  it('does not tell a session of events it did not subscribe to, and unsubscribe stops them', async () => {
    const { client, seen } = await connect('full');
    const a = await fire();
    await client.subscribeResource({ uri: `headlamp://incidents/${a.id}` });
    const b = await fire();
    await sleep(100);
    expect(seen.filter(s => s.method === 'notifications/resources/updated')).toHaveLength(0);
    const svc = await client.callTool({ name: 'add_incident_note', arguments: { incidentId: a.id, text: 'hello' } });
    expect(svc.isError).toBeFalsy();
    await until(() => seen.some(s => s.method === 'notifications/resources/updated' && s.params._meta['dev.dynacom.headlamp/event'].kind === 'incident.note_added'));
    await client.unsubscribeResource({ uri: `headlamp://incidents/${a.id}` });
    const before = seen.length;
    await client.callTool({ name: 'add_incident_note', arguments: { incidentId: a.id, text: 'again' } });
    await client.callTool({ name: 'add_incident_note', arguments: { incidentId: b.id, text: 'other' } });
    await sleep(150);
    expect(seen.length).toBe(before);
    await client.close();
  });

  it('rejects a subscription in a stateless call and for an unknown incident', async () => {
    const { client } = await connect('full');
    await expect(client.subscribeResource({ uri: 'headlamp://incidents/does-not-exist' })).rejects.toThrow(/not found/);
    await expect(client.subscribeResource({ uri: 'headlamp://nonsense' })).rejects.toThrow(/not found/);
    await client.close();
  });
});

describe('incident tools', () => {
  it('lists, gets and filters incidents', async () => {
    const { client } = await connect('full');
    const t = await fire({ test: 'true', zone: 'lab' }, 'warning');
    const list = structured(await client.callTool({ name: 'list_incidents', arguments: { test: true, labels: { zone: 'lab' }, severity: ['warning'] } }));
    expect(list.incidents.map((i: any) => i.id)).toContain(t.id);
    const none = structured(await client.callTool({ name: 'list_incidents', arguments: { labels: { zone: 'nowhere' } } }));
    expect(none.incidents).toEqual([]);
    const page = structured(await client.callTool({ name: 'list_incidents', arguments: { limit: 1 } }));
    expect(page.incidents).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const next = structured(await client.callTool({ name: 'list_incidents', arguments: { limit: 1, cursor: page.nextCursor } }));
    expect(next.incidents[0].id).not.toBe(page.incidents[0].id);
    const bad = await client.callTool({ name: 'list_incidents', arguments: { cursor: 'garbage' } });
    expect(bad.isError).toBe(true);
    expect(structured(bad).error.code).toBe('cursor_expired');
    const notFound = await client.callTool({ name: 'get_incident', arguments: { incidentId: 'missing' } });
    expect(structured(notFound).error.code).toBe('not_found');
    await client.close();
  });

  it('acknowledges, notes, escalates and resolves, with a timeline and idempotency', async () => {
    const { client } = await connect('full');
    const { id } = await fire();
    const ack = structured(await client.callTool({ name: 'acknowledge_incident', arguments: { incidentId: id, note: 'looking', requestId: 'r1' } }));
    expect(ack).toMatchObject({ changed: true, replayed: false });
    expect(ack.incident).toMatchObject({ state: 'acknowledged', acknowledgedBy: 'full' });
    const again = structured(await client.callTool({ name: 'acknowledge_incident', arguments: { incidentId: id } }));
    expect(again.changed).toBe(false);
    const replay = structured(await client.callTool({ name: 'acknowledge_incident', arguments: { incidentId: id, note: 'looking', requestId: 'r1' } }));
    expect(replay.replayed).toBe(true);
    const conflict = await client.callTool({ name: 'acknowledge_incident', arguments: { incidentId: id, note: 'different', requestId: 'r1' } });
    expect(structured(conflict).error.code).toBe('conflict');
    const note = structured(await client.callTool({ name: 'add_incident_note', arguments: { incidentId: id, text: 'a note', requestId: 'n1' } }));
    expect(note.entry).toMatchObject({ kind: 'note', actor: 'full', text: 'a note' });
    const noteAgain = structured(await client.callTool({ name: 'add_incident_note', arguments: { incidentId: id, text: 'a note', requestId: 'n1' } }));
    expect(noteAgain.replayed).toBe(true);
    expect(noteAgain.entry.seq).toBe(note.entry.seq);
    expect(noteAgain.incident.noteCount).toBe(1);
    const esc = structured(await client.callTool({ name: 'escalate_incident', arguments: { incidentId: id, reason: 'pager' } }));
    expect(esc.incident.escalated).toBe(true);
    const res = structured(await client.callTool({ name: 'resolve_incident', arguments: { incidentId: id, resolution: 'fixed' } }));
    expect(res).toMatchObject({ changed: true });
    expect(res.incident).toMatchObject({ state: 'resolved', resolvedBy: 'full', resolution: 'fixed' });
    const resAgain = structured(await client.callTool({ name: 'resolve_incident', arguments: { incidentId: id } }));
    expect(resAgain.changed).toBe(false);
    const escLate = await client.callTool({ name: 'escalate_incident', arguments: { incidentId: id, reason: 'late' } });
    expect(structured(escLate).error.code).toBe('conflict');
    const tl = structured(await client.callTool({ name: 'get_incident_timeline', arguments: { incidentId: id } }));
    const kinds = tl.entries.map((e: any) => e.kind);
    expect(kinds[0]).toBe('fired');
    expect(kinds).toEqual(expect.arrayContaining(['investigation_queued', 'investigation_done', 'acknowledged', 'note', 'escalated', 'resolved']));
    expect(tl.entries.map((e: any) => e.seq)).toEqual(tl.entries.map((_: unknown, i: number) => i + 1));
    const part = structured(await client.callTool({ name: 'get_incident_timeline', arguments: { incidentId: id, limit: 2 } }));
    expect(part.entries).toHaveLength(2);
    expect(part.nextAfterSeq).toBe(2);
    const listActive = structured(await client.callTool({ name: 'list_incidents', arguments: {} }));
    expect(listActive.incidents.map((i: any) => i.id)).not.toContain(id);
    const listResolved = structured(await client.callTool({ name: 'list_incidents', arguments: { state: 'resolved' } }));
    expect(listResolved.incidents.map((i: any) => i.id)).toContain(id);
    await client.close();
  });

  it('keeps the note count and acknowledgement when the runner writes its older copy', async () => {
    engine.hold = new Promise<void>(r => setTimeout(r, 200));
    const { client } = await connect('full');
    const { id } = await fire();
    await client.callTool({ name: 'add_incident_note', arguments: { incidentId: id, text: 'during the run' } });
    await client.callTool({ name: 'acknowledge_incident', arguments: { incidentId: id } });
    for (let i = 0; i < 100 && (await store.get(id))?.status !== 'done'; i++) await sleep(20);
    engine.hold = undefined;
    const d = (await store.get(id)) as Diagnosis;
    expect(d.status).toBe('done');
    expect(d.incident?.noteCount).toBe(1);
    expect(d.incident?.acknowledgedAt).toBeTruthy();
    await client.close();
  });

  it('starts, reads and reports the investigation', async () => {
    const { client } = await connect('full');
    const { id } = await fire();
    for (let i = 0; i < 100 && (await store.get(id))?.status !== 'done'; i++) await sleep(20);
    const status = structured(await client.callTool({ name: 'get_investigation_status', arguments: { incidentId: id } }));
    expect(status.investigation).toMatchObject({ status: 'done', automatic: true, attempt: 1 });
    const result = structured(await client.callTool({ name: 'get_investigation_result', arguments: { incidentId: id } }));
    expect(result.result).toMatchObject({ likelyCause: 'c', confidence: 'high' });
    expect(result.result.evidence[0]).toMatchObject({ id: 'e1' });
    const noForce = structured(await client.callTool({ name: 'start_investigation', arguments: { incidentId: id } }));
    expect(noForce.started).toBe(false);
    const before = engine.started.length;
    const forced = structured(await client.callTool({ name: 'start_investigation', arguments: { incidentId: id, force: true } }));
    expect(forced.started).toBe(true);
    expect(forced.investigation.automatic).toBe(false);
    for (let i = 0; i < 100 && engine.started.length === before; i++) await sleep(20);
    expect(engine.started.length).toBe(before + 1);
    const badModel = await client.callTool({ name: 'start_investigation', arguments: { incidentId: id, force: true, model: 'nope/none' } });
    expect(structured(badModel).error.code).toBe('invalid_argument');
    await client.close();
  });

  it('reports the automatic investigations setting', async () => {
    const { client } = await connect('full');
    const s = structured(await client.callTool({ name: 'get_automatic_investigations', arguments: {} }));
    expect(s.enabled).toBe(true);
    const r = await client.readResource({ uri: 'headlamp://settings/automatic-investigations' });
    expect(JSON.parse((r.contents[0] as any).text).enabled).toBe(true);
    await client.close();
  });

  it('serves the storage and extra tools through the registry', async () => {
    const { client } = await connect('full');
    // The test server has no cluster and no metrics backend: the tools fail with a contract code, not a crash.
    for (const name of ['list_storage_volumes', 'list_storage_disks', 'get_storage_smart', 'get_storage_capacity', 'list_nodes', 'list_workloads']) {
      const r = await client.callTool({ name, arguments: {} });
      expect(r.isError).toBe(true);
      expect(['unavailable', 'internal']).toContain(structured(r).error.code);
    }
    await client.close();
  });
});

describe('event log', () => {
  it('pages the catch-up resource, filters by label and kind, and starts a cursor', async () => {
    const { client } = await connect('full');
    const head = JSON.parse(((await client.readResource({ uri: 'headlamp://events' })).contents[0] as any).text);
    expect(head.latest).toMatch(/^\d+$/);
    const cursor = JSON.parse(((await client.readResource({ uri: 'headlamp://events?limit=5' })).contents[0] as any).text);
    expect(cursor.events).toEqual([]);
    const t = await fire({ test: 'true', source: 'log-test' });
    await client.callTool({ name: 'add_incident_note', arguments: { incidentId: t.id, text: 'x' } });
    const page = JSON.parse(((await client.readResource({ uri: `headlamp://events?after=${head.latest}&limit=2` })).contents[0] as any).text);
    expect(page.events).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.reset).toBe(false);
    const rest = JSON.parse(((await client.readResource({ uri: `headlamp://events?after=${page.nextAfter}&limit=100&label=source%3Dlog-test` })).contents[0] as any).text);
    expect(rest.events.every((e: any) => e.labels.source === 'log-test')).toBe(true);
    expect(rest.events.map((e: any) => e.kind)).toContain('incident.note_added');
    const onlyNotes = JSON.parse(((await client.readResource({ uri: `headlamp://events?after=${head.latest}&kind=incident.note_added&limit=100` })).contents[0] as any).text);
    expect(onlyNotes.events.every((e: any) => e.kind === 'incident.note_added')).toBe(true);
    const prefix = JSON.parse(((await client.readResource({ uri: `headlamp://events?after=${head.latest}&kind=investigation.&limit=100` })).contents[0] as any).text);
    expect(prefix.events.length).toBeGreaterThan(0);
    expect(prefix.events.every((e: any) => e.kind.startsWith('investigation.'))).toBe(true);
    // Internal fields never reach a client.
    expect(JSON.stringify(page)).not.toContain('"state"');
    await client.close();
  });

  it('reports reset when the cursor is older than the retained window', async () => {
    const { client } = await connect('full');
    const old = JSON.parse(((await client.readResource({ uri: 'headlamp://events' })).contents[0] as any).text).oldestRetained;
    await fire();
    clock += 8 * 24 * 3600_000;
    const removed = await store.events.prune();
    expect(removed).toBeGreaterThan(0);
    const page = JSON.parse(((await client.readResource({ uri: `headlamp://events?after=${old}` })).contents[0] as any).text);
    expect(page.reset).toBe(true);
    const fromStart = JSON.parse(((await client.readResource({ uri: 'headlamp://events?after=0' })).contents[0] as any).text);
    expect(fromStart.reset).toBe(false);
    clock -= 8 * 24 * 3600_000;
    await client.close();
  });
});

describe('replay with Last-Event-ID', () => {
  async function rpc(session: string, who: keyof typeof TOKENS, method: string, params: unknown, id?: number) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...auth(who), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
    });
    return res;
  }

  async function open(who: keyof typeof TOKENS, lastEventId?: string, session?: string) {
    let sid = session;
    if (!sid) {
      const init = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { ...auth(who), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }),
      });
      sid = init.headers.get('mcp-session-id')!;
      await init.text();
      await rpc(sid, who, 'notifications/initialized', {});
    }
    const ctl = new AbortController();
    const res = await fetch(`${base}/mcp`, {
      headers: { ...auth(who), accept: 'text/event-stream', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25', ...(lastEventId ? { 'last-event-id': lastEventId } : {}) },
      signal: ctl.signal,
    });
    expect(res.status).toBe(200);
    const frames: Array<{ id?: string; data?: any }> = [];
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          for (let at = buf.indexOf('\n\n'); at >= 0; at = buf.indexOf('\n\n')) {
            const block = buf.slice(0, at);
            buf = buf.slice(at + 2);
            const id = /^id: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (data) frames.push({ id, data: JSON.parse(data) });
          }
        }
      } catch {
        // The stream was aborted.
      }
    })();
    return { sid, frames, close: () => ctl.abort() };
  }

  it('sends the notifications that came while the stream was closed, again from the last id', async () => {
    const first = await open('full');
    expect((await rpc(first.sid, 'full', 'resources/subscribe', { uri: 'headlamp://events?label=source%3Dreplay-test' }, 2)).status).toBe(200);
    const t = await fire({ test: 'true', source: 'replay-test' });
    await until(() => first.frames.some(f => f.data?.method === 'notifications/resources/updated'));
    const lastSeen = first.frames.filter(f => f.data?.method === 'notifications/resources/updated').at(-1)!.id!;
    expect(lastSeen).toMatch(/^\d+$/);
    first.close();
    await sleep(50);
    // Events while no stream is open.
    await fire({ test: 'true', source: 'replay-test' });
    await fire({ test: 'true', source: 'other-source' });
    await store.update(t.id, d => (d ? { ...d, incident: { ...(d.incident ?? { timeline: [] }), timeline: [...(d.incident?.timeline ?? []), { seq: 0, at: 'x', kind: 'note', actor: 'raw', text: 'late', data: null }], noteCount: 1 } } : undefined), { force: true });
    const second = await open('full', lastSeen, first.sid);
    await until(() => second.frames.filter(f => f.data?.method === 'notifications/resources/updated').length >= 3);
    const ids = second.frames.filter(f => f.id && /^\d+$/.test(f.id)).map(f => BigInt(f.id!));
    expect(ids[0]).toBe(BigInt(lastSeen)); // from the last id, inclusive: at least once.
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    const sources = second.frames.filter(f => f.data?.method === 'notifications/resources/updated').map(f => f.data.params._meta['dev.dynacom.headlamp/event'].labels.source);
    expect(sources.every((s: string) => s === 'replay-test')).toBe(true);
    // Live events continue after the replay.
    const live = await fire({ test: 'true', source: 'replay-test' });
    await until(() => second.frames.some(f => f.data?.params?._meta?.['dev.dynacom.headlamp/event']?.incidentId === live.id));
    second.close();
    await rpc(first.sid, 'full', 'ping', {}, 9);
  });

  it('sends a reset when the id is older than the window', async () => {
    const first = await open('full');
    await rpc(first.sid, 'full', 'resources/subscribe', { uri: 'headlamp://events' }, 2);
    first.close();
    await fire();
    clock += 8 * 24 * 3600_000;
    await store.events.prune();
    clock -= 8 * 24 * 3600_000;
    await fire();
    const again = await open('full', '2', first.sid);
    await until(() => again.frames.some(f => f.data?.params?._meta?.['dev.dynacom.headlamp/event']?.kind === 'reset'));
    again.close();
  });
});

describe('metrics', () => {
  it('exposes sessions, subscriptions, events and tool calls', async () => {
    const { client } = await connect('full');
    await client.subscribeResource({ uri: 'headlamp://incidents' });
    await client.callTool({ name: 'list_incidents', arguments: {} });
    await client.callTool({ name: 'get_incident', arguments: { incidentId: 'missing' } });
    await fire();
    await sleep(100);
    const m = await (await fetch(`${base}/metrics`)).text();
    expect(m).toMatch(/headlamp_agent_mcp_sessions_active [1-9]/);
    expect(m).toMatch(/headlamp_agent_mcp_subscriptions_active [1-9]/);
    expect(m).toMatch(/headlamp_agent_mcp_events_sent_total\{kind="incident.created"\} [1-9]/);
    expect(m).toMatch(/headlamp_agent_mcp_events_recorded_total\{kind="incident.created"\} [1-9]/);
    expect(m).toMatch(/headlamp_agent_mcp_tool_calls_total\{client="full",tool="list_incidents"\} [1-9]/);
    expect(m).toMatch(/headlamp_agent_mcp_tool_errors_total\{code="not_found",tool="get_incident"\} [1-9]/);
    expect(m).toMatch(/headlamp_agent_mcp_event_log_events [1-9]/);
    await client.close();
    await sleep(50);
  });
});
