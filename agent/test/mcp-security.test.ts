import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MemoryDiagnosisStore } from '../src/store.js';
import { SETTINGS_URI } from '../src/incidents/types.js';
import { MAX_REPLAY, MAX_SESSIONS_PER_CLIENT } from '../src/mcp/endpoint.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

vi.mock('../src/agent/engine.js', () => ({
  diagnose: vi.fn(async (opts: { id: string; alert: unknown; source: string; host: string }) => ({
    id: opts.id,
    createdAt: 'x',
    status: 'done',
    source: opts.source,
    host: opts.host,
    alert: opts.alert,
    result: { summary: 's', likelyCause: 'c', confidence: 'high', signals: [], fixes: [], verify: 'v' },
    evidence: [],
    toolCalls: 1,
    model: 'm',
    a2ui: [],
  })),
}));

const { startServer } = await import('../src/server.js');

const ALL = 'registry:read incidents:read incidents:write incidents:resolve agent:investigate storage:read settings:read';
const T = {
  full: ['full', 't-full-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ALL],
  reader: ['reader', 't-read-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'incidents:read'],
  stor: ['stor', 't-stor-cccccccccccccccccccccccccccccccc', 'storage:read'],
  regonly: ['regonly', 't-regn-dddddddddddddddddddddddddddddddd', 'registry:read'],
  twinA: ['twin', 't-twna-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', ALL],
  twinB: ['twin', 't-twnb-ffffffffffffffffffffffffffffffff', ALL],
  many: ['many', 't-many-gggggggggggggggggggggggggggggggg', ALL],
  gone: ['gone', 't-gone-hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh', 'incidents:read'],
  shrink: ['shrink', 't-shrk-iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii', 'incidents:read agent:investigate'],
  invest: ['invest', 't-invt-jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj', 'agent:investigate'],
} as const;
type Who = keyof typeof T;

let dir: string;
let file: string;
let stamp = Date.now();
let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let store: MemoryDiagnosisStore;

function writeTokens(names: Array<Who | { name: string; token: string; scopes: string[] }>, override: Partial<Record<Who, string>> = {}) {
  const list = names.map(n => (typeof n === 'string' ? { name: T[n][0], token: T[n][1], scopes: (override[n] ?? T[n][2]).split(' ') } : n));
  writeFileSync(file, JSON.stringify(list));
  // A new modification time on every write: the token store reads the file again when the time changes.
  stamp += 2000;
  utimesSync(file, new Date(stamp), new Date(stamp));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-security-'));
  file = join(dir, 'tokens.json');
  writeTokens(Object.keys(T) as Who[]);
  const config = { ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent' };
  config.models = { routes: [{ id: 'one', style: 'openai' as const, baseUrl: 'http://127.0.0.1:1', apiKey: 'k', headers: {}, systemPrefix: '', models: ['a'], maxTokens: 10, timeoutMs: 500 }], defaultModel: 'one/a', skipped: [] };
  config.diagnosis = { ...config.diagnosis, maxPerHour: 100_000 };
  config.mcp = { tokensFile: file, auth: 'optional' };
  store = new MemoryDiagnosisStore();
  server = await startServer(config, 'test', { store, watchVolumes: false });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  await server.close();
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (check: () => boolean, ms = 4000) => {
  for (let t = 0; t < ms && !check(); t += 10) await sleep(10);
  expect(check()).toBe(true);
};
const bearer = (who: Who) => ({ authorization: `Bearer ${T[who][1]}` });
const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

let counter = 0;
async function fire(labels: Record<string, string> = {}): Promise<{ id: string; name: string }> {
  const name = `Sec${++counter}`;
  const startsAt = new Date(Date.parse('2026-11-28T00:00:00Z') + counter * 1000).toISOString();
  const res = await fetch(`${base}/api/v2/alerts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ labels: { alertname: name, severity: 'critical', ...labels }, startsAt }]) });
  expect(res.status).toBe(200);
  await until(() => true);
  for (let i = 0; i < 200; i++) {
    const found = (await store.page({ alert: name })).diagnoses[0];
    if (found) return { id: found.id, name };
    await sleep(10);
  }
  throw new Error('no incident');
}

async function connect(who?: Who) {
  const client = new Client({ name: `t-${who ?? 'anonymous'}`, version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: who ? bearer(who) : {} } });
  await client.connect(transport);
  return { client, transport };
}

async function initialize(who: Who): Promise<Response> {
  return fetch(`${base}/mcp`, { method: 'POST', headers: { ...bearer(who), ...HEADERS }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }) });
}

async function rpc(session: string, who: Who, method: string, params: unknown, id?: number) {
  return fetch(`${base}/mcp`, { method: 'POST', headers: { ...bearer(who), ...HEADERS, 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) });
}

interface Frame {
  id?: string;
  data?: any;
}

/** A raw session with its push stream. `open` waits for the response headers, which come after a replay. */
async function session(who: Who, subscribe: string[] = []) {
  const init = await initialize(who);
  const sid = init.headers.get('mcp-session-id')!;
  await init.text();
  await rpc(sid, who, 'notifications/initialized', {});
  let n = 10;
  for (const uri of subscribe) expect((await rpc(sid, who, 'resources/subscribe', { uri }, ++n)).status).toBe(200);
  return { sid, who };
}

async function stream(s: { sid: string; who: Who }, lastEventId?: string) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/mcp`, { headers: { ...bearer(s.who), accept: 'text/event-stream', 'mcp-session-id': s.sid, 'mcp-protocol-version': '2025-11-25', ...(lastEventId ? { 'last-event-id': lastEventId } : {}) }, signal: ctl.signal });
  const frames: Frame[] = [];
  let ended = false;
  if (res.status === 200) {
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
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
        // aborted
      }
      ended = true;
    })();
  }
  return { status: res.status, frames, close: () => ctl.abort(), ended: () => ended };
}

const meta = (f: Frame) => f.data?.params?._meta?.['headlamp-agent/event'];
const text = (r: { contents: any[] }) => JSON.parse(r.contents[0]!.text as string);

describe('anonymous and low scopes read no incident, agent or storage data (security B1, B2)', () => {
  it('hides the diagnosis, launch and disk tools from a caller without their scope', async () => {
    const hidden = ['list_diagnoses', 'get_diagnosis', 'list_agent_launches', 'disk_health_smart', 'disk_health_performance', 'disk_health_capacity'];
    for (const who of [undefined, 'regonly'] as const) {
      const { client } = await connect(who);
      const names = (await client.listTools()).tools.map(t => t.name);
      for (const h of hidden) expect(names).not.toContain(h);
      for (const h of hidden) await expect(client.callTool({ name: h, arguments: {} })).rejects.toThrow(/disabled/);
      await client.close();
    }
    const reader = await connect('reader');
    const names = (await reader.client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_diagnoses', 'get_diagnosis']));
    expect(names).not.toContain('list_agent_launches');
    expect(names).not.toContain('disk_health_smart');
    await reader.client.close();
    const stor = await connect('stor');
    expect((await stor.client.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(['disk_health_smart', 'disk_health_capacity']));
    await stor.client.close();
  });

  it('does not return the incident notes in get_diagnosis', async () => {
    const t = await fire();
    const full = await connect('full');
    expect((await full.client.callTool({ name: 'add_incident_note', arguments: { incidentId: t.id, text: 'private operator note' } })).isError).toBeFalsy();
    const got: any = await full.client.callTool({ name: 'get_diagnosis', arguments: { id: t.id } });
    expect(got.structuredContent.diagnosis.alert.name).toBe(t.name);
    expect(got.structuredContent.diagnosis.incident).toBeUndefined();
    expect(JSON.stringify(got)).not.toContain('private operator note');
    await full.client.close();
  });

  it('lists no incident or diagnosis URI to a caller without incidents:read', async () => {
    const t = await fire();
    for (const who of [undefined, 'stor', 'regonly'] as const) {
      const { client } = await connect(who);
      const uris = (await client.listResources()).resources.map(r => r.uri);
      expect(uris.filter(u => u.includes(t.id) || /diagnoses\/|incidents\//.test(u))).toEqual([]);
      await client.close();
    }
    const reader = await connect('reader');
    const uris = (await reader.client.listResources()).resources.map(r => r.uri);
    expect(uris).toContain(`headlamp://incidents/${t.id}`);
    await reader.client.close();
  });
});

describe('SSE ids (contract section 7.3 and 8.4)', () => {
  it('gives each notification its own id, <eventId>.<n>, and resumes strictly after an id', async () => {
    const s = await session('full', ['headlamp://incidents?label=source%3Dids', 'headlamp://events?label=source%3Dids']);
    const first = await stream(s);
    const a = await fire({ source: 'ids' });
    await until(() => first.frames.filter(f => meta(f)?.incidentId === a.id).length >= 4);
    const ids = first.frames.filter(f => f.id).map(f => f.id!);
    expect(ids.every(id => /^(\d+\.\d+|p\d+)$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length); // no id twice in a session
    const ofA = first.frames.filter(f => meta(f)?.eventId === meta(first.frames.find(g => meta(g)?.incidentId === a.id)!).eventId);
    expect(ofA.map(f => f.id)).toEqual([...new Set(ofA.map(f => f.id))]);
    expect(ofA.length).toBeGreaterThanOrEqual(3); // two URIs and list_changed
    expect(ofA.map(f => f.data.params.uri ?? 'list')).toEqual([...ofA.map(f => f.data.params.uri ?? 'list')].sort((x, y) => (x === 'list' ? 1 : y === 'list' ? -1 : x < y ? -1 : 1)));
    // The server writes a notification once. Resume after the first id of that event: the rest follows, that id does not.
    const firstId = ofA[0]!.id!;
    const [eid] = firstId.split('.');
    first.close();
    await sleep(50);
    const again = await stream(s, firstId);
    expect(again.status).toBe(200);
    await until(() => again.frames.length >= ofA.length - 1);
    expect(again.frames.map(f => f.id)).not.toContain(firstId);
    expect(again.frames.map(f => f.id)).toContain(ofA[1]!.id);
    expect(again.frames.filter(f => f.id?.startsWith(`${eid}.`)).length).toBe(ofA.length - 1);
    again.close();
  });

  it('puts the unique id of a priming or reset frame in the form p<k>, and sends a reset for an id that it does not know', async () => {
    const s = await session('full', ['headlamp://events?label=source%3Dunknown']);
    const live = await stream(s, 'p999');
    expect(live.status).toBe(200);
    await until(() => live.frames.some(f => meta(f)?.kind === 'reset'));
    const reset = live.frames.find(f => meta(f)?.kind === 'reset')!;
    expect(reset.id).toMatch(/^p\d+$/);
    expect(meta(reset)).toMatchObject({ kind: 'reset', uri: 'headlamp://events', incidentId: null });
    expect(meta(reset).logId).toMatch(/^[0-9a-f-]{36}$/);
    // After the reset the stream goes live.
    const t = await fire({ source: 'unknown' });
    await until(() => live.frames.some(f => meta(f)?.incidentId === t.id));
    live.close();
    // An id that cannot be an id is refused.
    const bad = await stream(s, 'no way!');
    expect(bad.status).toBe(400);
  });
});

describe('who sees which event (contract section 8.7)', () => {
  it('filters the catch-up resource and the push by the scope of the primary URI', async () => {
    const readerHead = await connect('reader');
    const head = text(await readerHead.client.readResource({ uri: 'headlamp://events' }));
    expect(head.logId).toMatch(/^[0-9a-f-]{36}$/);
    // Events of three kinds.
    const t = await fire({ source: 'scopes' });
    await store.events.committed(await store.events.append([{ kind: 'settings.changed', uri: SETTINGS_URI, labels: { source: 'scopes' } }, { kind: 'storage.updated', uri: 'headlamp://storage/volumes', labels: { source: 'scopes' } }]));
    const kindsFor = async (who: Who) => {
      const c = await connect(who);
      const page = text(await c.client.readResource({ uri: `headlamp://events?after=${head.latest ?? 0}&limit=500` }));
      await c.client.close();
      return new Set((page.events as Array<{ kind: string }>).map(e => e.kind));
    };
    const reader = await kindsFor('reader');
    expect([...reader].every(k => k.startsWith('incident.'))).toBe(true);
    expect(reader.has('incident.created')).toBe(true);
    expect([...(await kindsFor('stor'))]).toEqual(['storage.updated']);
    const full = await kindsFor('full');
    expect(full.has('investigation.done') && full.has('settings.changed') && full.has('storage.updated') && full.has('incident.created')).toBe(true);
    const inv = await kindsFor('invest');
    expect(inv.has('investigation.done')).toBe(true);
    expect(inv.has('storage.updated')).toBe(false);
    expect([...(await kindsFor('regonly'))]).toEqual([]);
    // Anonymous callers have no event log.
    const anon = await connect();
    await expect(anon.client.readResource({ uri: 'headlamp://events' })).rejects.toThrow(/disabled/);
    await anon.client.close();
    // The same rule on the push stream: a storage-only session hears no incident, and gets no list_changed with incident meta.
    const s = await session('stor', ['headlamp://events']);
    const push = await stream(s);
    const t2 = await fire({ source: 'scopes' });
    await store.events.committed(await store.events.append([{ kind: 'storage.updated', uri: 'headlamp://storage/volumes', labels: {} }]));
    await until(() => push.frames.some(f => meta(f)?.kind === 'storage.updated'));
    await sleep(150);
    expect(push.frames.filter(f => meta(f)?.incidentId)).toEqual([]);
    expect(JSON.stringify(push.frames)).not.toContain(t2.id);
    push.close();
    // An incidents:read session hears the incident event with the kind incident.updated for an investigation, not investigation.*.
    const r = await session('reader', [`headlamp://incidents/${t.id}`]);
    const rp = await stream(r);
    await rpc(t.id ? (await session('full')).sid : '', 'full', 'ping', {}, 1).catch(() => undefined);
    await readerHead.client.close();
    rp.close();
  });

  it('does not send list_changed with incident meta to a session without incidents:read', async () => {
    const s = await session('invest', ['headlamp://events']);
    const push = await stream(s);
    await fire({ source: 'listchanged' });
    await until(() => push.frames.some(f => meta(f)?.kind?.startsWith('investigation.')));
    expect(push.frames.some(f => f.data?.method === 'notifications/resources/list_changed' && meta(f)?.kind === 'incident.created')).toBe(false);
    push.close();
    const s2 = await session('stor', []);
    const push2 = await stream(s2);
    await fire({ source: 'listchanged' });
    await sleep(200);
    expect(push2.frames.filter(f => f.data?.method === 'notifications/resources/list_changed')).toEqual([]);
    push2.close();
  });

  it('refuses a subscription to a URI without an event source, and to unknown query keys', async () => {
    const { client } = await connect('full');
    for (const uri of ['headlamp://storage/smart', 'headlamp://storage/capacity', 'headlamp://storage/disks', 'headlamp://contract']) await expect(client.subscribeResource({ uri })).rejects.toThrow(/no event source/);
    await client.subscribeResource({ uri: 'headlamp://storage/volumes' });
    for (const uri of ['headlamp://events?x=1', 'headlamp://incidents?bogus=1', 'headlamp://incidents/abc?x=1']) await expect(client.subscribeResource({ uri })).rejects.toThrow(/not found/);
    await client.close();
  });
});

describe('sessions and tokens (security S1, S2, S4)', () => {
  it('ties a session to its token, not to the client name, and refuses a token named anonymous', async () => {
    const a = await initialize('twinA');
    const sid = a.headers.get('mcp-session-id')!;
    await a.text();
    const own = await rpc(sid, 'twinA', 'ping', {}, 5);
    expect(own.status).toBe(200);
    const other = await rpc(sid, 'twinB', 'ping', {}, 6);
    expect(other.status).toBe(403);
    writeTokens([...(Object.keys(T) as Who[]), { name: 'anonymous', token: 't-anon-kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk', scopes: ['incidents:read'] }]);
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer t-anon-kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk', ...HEADERS }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(res.status).toBe(401);
    writeTokens(Object.keys(T) as Who[]);
  });

  it('ends the session and its push stream when the token leaves the file', async () => {
    const s = await session('gone', ['headlamp://incidents']);
    const push = await stream(s);
    writeTokens((Object.keys(T) as Who[]).filter(k => k !== 'gone'));
    await fire(); // an event triggers the check
    await until(() => push.ended());
    expect((await rpc(s.sid, 'gone', 'ping', {}, 3)).status).toBe(401);
    writeTokens(Object.keys(T) as Who[]);
  });

  it('ends the session when the token has fewer scopes, then answers 404', async () => {
    const s = await session('shrink', ['headlamp://incidents']);
    const push = await stream(s);
    writeTokens(Object.keys(T) as Who[], { shrink: 'incidents:read' });
    await fire();
    await until(() => push.ended());
    const after = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${T.shrink[1]}`, ...HEADERS, 'mcp-session-id': s.sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) });
    expect(after.status).toBe(404);
    writeTokens(Object.keys(T) as Who[]);
  });

  it('limits the sessions of one client, also for parallel initialize requests', async () => {
    const open: string[] = [];
    const results = await Promise.all(Array.from({ length: MAX_SESSIONS_PER_CLIENT + 8 }, () => initialize('many')));
    for (const r of results) {
      await r.text();
      if (r.status === 200) open.push(r.headers.get('mcp-session-id')!);
    }
    expect(open).toHaveLength(MAX_SESSIONS_PER_CLIENT);
    const refused = results.filter(r => r.status === 429);
    expect(refused).toHaveLength(8);
    expect(refused[0]!.headers.get('retry-after')).toBe('30');
    // Another client is not affected.
    expect((await initialize('full')).status).toBe(200);
    for (const sid of open) await fetch(`${base}/mcp`, { method: 'DELETE', headers: { ...bearer('many'), 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' } });
    expect((await initialize('many')).status).toBe(200);
  });

  it('answers a subscription in stateless mode with session_required', async () => {
    for (const method of ['resources/subscribe', 'resources/unsubscribe']) {
      const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...bearer('full'), ...HEADERS }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: { uri: 'headlamp://incidents' } }) });
      const body: any = await res.json();
      expect(body.error).toMatchObject({ code: -32601, data: { code: 'session_required' } });
      expect(body.id).toBe(7);
    }
  });
});

describe('replay (security S3, S5, L1, L8)', () => {
  it('replaces the old push stream with a new one instead of a 409', async () => {
    const s = await session('full', ['headlamp://events?label=source%3Dreplace']);
    const one = await stream(s);
    const two = await stream(s);
    expect(two.status).toBe(200);
    await until(() => one.ended());
    const t = await fire({ source: 'replace' });
    await until(() => two.frames.some(f => meta(f)?.incidentId === t.id));
    expect(one.frames.some(f => meta(f)?.incidentId === t.id)).toBe(false);
    two.close();
  });

  it('stops a replay at the cap and sends a reset', async () => {
    const s = await session('full', ['headlamp://events?label=source%3Dcap']);
    const head = await store.events.head();
    const events = Array.from({ length: MAX_REPLAY + 100 }, () => ({ kind: 'settings.changed' as const, uri: SETTINGS_URI, labels: { source: 'cap' } }));
    await store.events.committed(await store.events.append(events));
    const replay = await stream(s, `${head.latest ?? 0}.1`);
    expect(replay.status).toBe(200);
    await until(() => replay.frames.some(f => meta(f)?.kind === 'reset'), 15_000);
    const data = replay.frames.filter(f => meta(f) && meta(f).kind !== 'reset');
    expect(data).toHaveLength(MAX_REPLAY);
    expect(replay.frames.at(-1)).toMatchObject({ data: { params: { _meta: { 'headlamp-agent/event': { kind: 'reset' } } } } });
    replay.close();
  });

  it('keeps a live event that arrives while a replay runs', async () => {
    const s = await session('full', ['headlamp://events?label=source%3Dlive']);
    const before = await store.events.head();
    await fire({ source: 'live' });
    const read = store.events.readAfter.bind(store.events);
    let release: () => void = () => {};
    const gate = new Promise<void>(r => (release = r));
    let entered: () => void = () => {};
    const inReplay = new Promise<void>(r => (entered = r));
    store.events.readAfter = async (...args) => {
      const page = await read(...args);
      store.events.readAfter = read;
      entered();
      await gate; // the replay has read its page and waits
      return page;
    };
    try {
      const pending = stream(s, `${before.latest}.9`);
      await inReplay;
      const during = await fire({ source: 'live' });
      release();
      const replay = await pending;
      expect(replay.status).toBe(200);
      await until(() => replay.frames.some(f => meta(f)?.incidentId === during.id && meta(f).kind === 'incident.created'));
      const ids = replay.frames.map(f => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(replay.frames.filter(f => f.data?.method === 'notifications/resources/updated' && meta(f)?.incidentId === during.id && meta(f).kind === 'incident.created')).toHaveLength(1);
      replay.close();
    } finally {
      release();
      store.events.readAfter = read;
    }
  });

  it('reports a reset when the id is ahead of the log (a restored database)', async () => {
    const s = await session('full', ['headlamp://events?label=source%3Dahead']);
    const replay = await stream(s, '999999999.1');
    expect(replay.status).toBe(200);
    await until(() => replay.frames.some(f => meta(f)?.kind === 'reset'));
    const { client } = await connect('full');
    const head = text(await client.readResource({ uri: 'headlamp://events' }));
    const page = text(await client.readResource({ uri: 'headlamp://events?after=999999999' }));
    expect(page.reset).toBe(true);
    const other = text(await client.readResource({ uri: `headlamp://events?after=${head.latest}&logId=00000000-0000-4000-8000-000000000000` }));
    expect(other.reset).toBe(true); // a different logId: a new log
    expect(text(await client.readResource({ uri: `headlamp://events?after=${head.latest}&logId=${head.logId}` })).reset).toBe(false);
    await client.close();
    replay.close();
  });
});

describe('failed tool calls and open enumerations (contract sections 3.8 and 5)', () => {
  it('returns no structuredContent on an error, and the Error in _meta', async () => {
    const { client } = await connect('full');
    const r: any = await client.callTool({ name: 'get_incident', arguments: { incidentId: 'missing' } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r._meta['headlamp-agent/error']).toMatchObject({ code: 'not_found' });
    expect(JSON.parse(r.content[0].text)).toEqual(r._meta['headlamp-agent/error']);
    // A generic client validates structuredContent against the output schema: this call must not throw.
    await client.close();
  });

  it('types the open enumerations as strings in the output schemas and keeps state closed', async () => {
    const { client } = await connect('full');
    const tool = (await client.listTools()).tools.find(t => t.name === 'list_incidents')!;
    const incident = (tool.outputSchema as any).properties.incidents.items.properties;
    expect(incident.severity.type).toBe('string');
    expect(incident.investigation.properties.status.type).toBe('string');
    expect(incident.state.enum).toEqual(['open', 'acknowledged', 'resolved']);
    const timeline = (await client.listTools()).tools.find(t => t.name === 'get_incident_timeline')!;
    expect((timeline.outputSchema as any).properties.entries.items.properties.kind.type).toBe('string');
    await client.close();
  });

  it('retries an escalation after the incident resolved and gets the first result', async () => {
    const t = await fire();
    const { client } = await connect('full');
    const first: any = await client.callTool({ name: 'escalate_incident', arguments: { incidentId: t.id, reason: 'disk full', requestId: 'esc1' } });
    expect(first.isError).toBeFalsy();
    await client.callTool({ name: 'resolve_incident', arguments: { incidentId: t.id } });
    const again: any = await client.callTool({ name: 'escalate_incident', arguments: { incidentId: t.id, reason: 'disk full', requestId: 'esc1' } });
    expect(again.isError).toBeFalsy();
    expect(again.structuredContent.replayed).toBe(true);
    const other: any = await client.callTool({ name: 'escalate_incident', arguments: { incidentId: t.id, reason: 'other', requestId: 'esc1' } });
    expect(other._meta['headlamp-agent/error'].code).toBe('request_conflict');
    const fresh: any = await client.callTool({ name: 'escalate_incident', arguments: { incidentId: t.id, reason: 'new' } });
    expect(fresh._meta['headlamp-agent/error'].code).toBe('conflict');
    await client.close();
  });

  it('lists the template parameters with the explode modifier', async () => {
    const { client } = await connect('full');
    const templates = (await client.listResourceTemplates()).resourceTemplates.map(t => t.uriTemplate);
    expect(templates).toContain('headlamp://incidents{?state,severity*,label*,test}');
    expect(templates).toContain('headlamp://events{?after,logId,limit,kind*,label*}');
    await client.close();
  });
});
