import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MemoryDiagnosisStore } from '../src/store.js';
import { MemoryEventLog } from '../src/incidents/events.js';
import { eventLabels, eventMatches, parseUri } from '../src/incidents/model.js';
import { fromSetting } from '../src/incidents/settings.js';
import { SETTINGS_URI } from '../src/incidents/types.js';
import { PvWatch } from '../src/mcp/pv-watch.js';

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
  dir = mkdtempSync(join(tmpdir(), 'mcp-review2-'));
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


async function put(path: string, body: unknown, method = 'PUT') {
  return fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('a filtered collection matches before or after the event (N1)', () => {
  it('tells a subscriber of the active list that an incident left it', async () => {
    const t = await fire({ source: 'n1' });
    const s = await session('full', ['headlamp://incidents?label=source%3Dn1', 'headlamp://incidents?state=open&label=source%3Dn1', 'headlamp://incidents?state=resolved&label=source%3Dn1', 'headlamp://incidents?label=source%3Dother']);
    const live = await stream(s);
    const { client } = await connect('full');
    // Acknowledge: the incident leaves `open` and stays `active`.
    await client.callTool({ name: 'acknowledge_incident', arguments: { incidentId: t.id } });
    await until(() => live.frames.some(f => meta(f)?.kind === 'incident.acknowledged'));
    const ack = live.frames.filter(f => meta(f)?.kind === 'incident.acknowledged').map(f => f.data.params.uri);
    expect(ack).toContain('headlamp://incidents?state=open&label=source%3Dn1');
    expect(ack).toContain('headlamp://incidents?label=source%3Dn1');
    // Resolve: the incident leaves `active` and enters `resolved`.
    await client.callTool({ name: 'resolve_incident', arguments: { incidentId: t.id } });
    await until(() => live.frames.some(f => meta(f)?.kind === 'incident.resolved'));
    const res = live.frames.filter(f => meta(f)?.kind === 'incident.resolved').map(f => f.data.params.uri);
    expect(res).toContain('headlamp://incidents?label=source%3Dn1');
    expect(res).toContain('headlamp://incidents?state=resolved&label=source%3Dn1');
    expect(res).not.toContain('headlamp://incidents?label=source%3Dother');
    live.close();
    await client.close();
  });
});

describe('skipped is a known status (N2)', () => {
  it('shows skipped, and starts a run without force', async () => {
    expect((await put('/api/settings/automatic-investigations', { enabled: false, by: 'ops' })).status).toBe(200);
    try {
      const t = await fire({ source: 'n2' });
      const { client } = await connect('full');
      let status: any;
      for (let i = 0; i < 100; i++) {
        status = (await client.callTool({ name: 'get_investigation_status', arguments: { incidentId: t.id } })) as any;
        if (status.structuredContent?.investigation.status === 'skipped') break;
        await sleep(20);
      }
      expect(status.structuredContent.investigation).toMatchObject({ status: 'skipped', attempt: 0, model: null, automatic: false });
      const incident: any = await client.callTool({ name: 'get_incident', arguments: { incidentId: t.id } });
      expect(incident.structuredContent.incident.investigation.status).toBe('skipped');
      const result: any = await client.callTool({ name: 'get_investigation_result', arguments: { incidentId: t.id } });
      expect(result.isError).toBe(true);
      expect(result._meta['headlamp-agent/error'].code).toBe('not_found');
      const started: any = await client.callTool({ name: 'start_investigation', arguments: { incidentId: t.id } });
      expect(started.isError).toBeFalsy();
      expect(started.structuredContent.started).toBe(true);
      expect(started.structuredContent.investigation.automatic).toBe(false);
      await client.close();
    } finally {
      await put('/api/settings/automatic-investigations', { enabled: true, by: 'ops' });
    }
  });
});

describe('POST answers are JSON (N3), GET without a session is 405 (S11)', () => {
  it('answers every POST of a stateful session with application/json', async () => {
    const init = await initialize('full');
    expect(init.headers.get('content-type')).toMatch(/^application\/json/);
    const sid = init.headers.get('mcp-session-id')!;
    await init.text();
    await rpc(sid, 'full', 'notifications/initialized', {});
    const list = await rpc(sid, 'full', 'tools/list', {}, 2);
    expect(list.headers.get('content-type')).toMatch(/^application\/json/);
    const sub = await rpc(sid, 'full', 'resources/subscribe', { uri: 'headlamp://incidents' }, 3);
    expect(sub.headers.get('content-type')).toMatch(/^application\/json/);
    // A push stream is still SSE.
    const push = await stream({ sid, who: 'full' });
    expect(push.status).toBe(200);
    push.close();
  });

  it('answers a GET without Mcp-Session-Id with HTTP 405', async () => {
    const res = await fetch(`${base}/mcp`, { headers: { ...bearer('full'), accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toMatch(/POST/);
  });
});

describe('reset frames and catch-up pages (S4, S5, S6)', () => {
  it('gives the reset frame the event id 0, so it never matches a real event', async () => {
    const s = await session('full', ['headlamp://events']);
    const live = await stream(s, 'p999');
    await until(() => live.frames.some(f => meta(f)?.kind === 'reset'));
    const reset = live.frames.find(f => meta(f)?.kind === 'reset')!;
    expect(meta(reset).eventId).toBe('0');
    expect(meta(reset).latest).toMatch(/^\d+$/);
    live.close();
  });

  it('starts the page at the oldest retained event when reset is true, in every case', async () => {
    await fire({ source: 's5' });
    await fire({ source: 's5' });
    const { client } = await connect('full');
    const head = text(await client.readResource({ uri: 'headlamp://events' }));
    const ahead = text(await client.readResource({ uri: 'headlamp://events?after=999999999999' }));
    expect(ahead.reset).toBe(true);
    expect(ahead.events[0].id).toBe(head.oldestRetained);
    const other = text(await client.readResource({ uri: `headlamp://events?after=${head.latest}&logId=00000000-0000-4000-8000-000000000000` }));
    expect(other.reset).toBe(true);
    expect(other.events[0].id).toBe(head.oldestRetained);
    const fine = text(await client.readResource({ uri: `headlamp://events?after=${head.oldestRetained}&logId=${head.logId}` }));
    expect(fine.reset).toBe(false);
    expect(fine.events[0].id).not.toBe(head.oldestRetained);
    await client.close();
  });

  it('does not reset a stored cursor when retention removed every event (latest keeps the last id)', async () => {
    let clock = Date.parse('2026-11-28T00:00:00Z');
    const log = new MemoryEventLog(() => clock);
    await log.append([{ kind: 'storage.updated', uri: 'headlamp://storage/volumes' }, { kind: 'storage.updated', uri: 'headlamp://storage/volumes' }]);
    clock += 8 * 24 * 3600_000;
    expect(await log.prune()).toBe(2);
    const head = await log.head();
    expect(head).toMatchObject({ latest: '2', oldestRetained: null });
    expect((await log.readAfter(2n, 10)).reset).toBe(false); // a client that is up to date
    const old = await log.readAfter(1n, 10);
    expect(old.reset).toBe(true); // events 2 was removed after this cursor
    expect(old.nextAfter).toBe('2');
    expect((await log.readAfter(3n, 10)).reset).toBe(true); // ahead of every id ever stored
  });
});

describe('live events are not lost when a replay ends early (S12)', () => {
  it('sends the events that came during a replay that ends with a reset', async () => {
    const s = await session('full', ['headlamp://incidents?label=source%3Ds12']);
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const original = store.events.head.bind(store.events);
    const spy = vi.spyOn(store.events, 'head').mockImplementationOnce(async () => {
      const snapshot = await original(); // the head from before the event
      await gate;
      return snapshot;
    });
    const pending = stream(s, 'p4242'); // an id that the session does not know: the replay ends with a reset
    await sleep(100);
    const t = await fire({ source: 's12' }); // arrives while the replay waits
    release();
    const live = await pending;
    expect(live.status).toBe(200);
    await until(() => live.frames.some(f => meta(f)?.incidentId === t.id));
    expect(live.frames.some(f => meta(f)?.kind === 'reset')).toBe(true);
    spy.mockRestore();
    live.close();
  });
});

describe('tool input errors use the Error shape (S10)', () => {
  it('returns invalid_argument in _meta for an input that does not match the schema', async () => {
    const { client } = await connect('full');
    const r: any = await client.callTool({ name: 'get_incident', arguments: { incidentId: 'x', extra: 1 } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r._meta['headlamp-agent/error']).toMatchObject({ code: 'invalid_argument' });
    expect(JSON.parse(r.content[0].text).code).toBe('invalid_argument');
    const missing: any = await client.callTool({ name: 'add_incident_note', arguments: {} });
    expect(missing._meta['headlamp-agent/error'].code).toBe('invalid_argument');
    await client.close();
  });
});

describe('event labels and filters (S9)', () => {
  it('keeps the 32 smallest keys in byte order', () => {
    const labels: Record<string, string> = {};
    for (let i = 0; i < 40; i++) labels[`k${String(39 - i).padStart(2, '0')}`] = 'v'.repeat(300);
    labels.zlast = '1';
    const cut = eventLabels(labels);
    expect(Object.keys(cut)).toHaveLength(32);
    expect(Object.keys(cut)).toEqual(Array.from({ length: 32 }, (_, i) => `k${String(i).padStart(2, '0')}`));
    expect(cut.k00).toHaveLength(256);
    expect(cut.zlast).toBeUndefined();
  });

  it('matches a subscription filter against the full labels, and the catch-up filter too', async () => {
    const extra: Record<string, string> = { zz_late: 'yes', source: 's9' };
    for (let i = 0; i < 40; i++) extra[`a${String(i).padStart(2, '0')}`] = 'x';
    const s = await session('full', ['headlamp://incidents?label=zz_late%3Dyes', 'headlamp://events?label=zz_late%3Dyes']);
    const live = await stream(s);
    const t = await fire(extra);
    await until(() => live.frames.some(f => meta(f)?.incidentId === t.id && f.data.params.uri === 'headlamp://incidents?label=zz_late%3Dyes'));
    const frame = live.frames.find(f => meta(f)?.incidentId === t.id)!;
    expect(meta(frame).labels.zz_late).toBeUndefined(); // the event carries 32 labels, without this one
    expect(Object.keys(meta(frame).labels)).toHaveLength(32);
    expect(live.frames.some(f => meta(f)?.incidentId === t.id && f.data.params.uri === 'headlamp://events?label=zz_late%3Dyes')).toBe(true);
    const { client } = await connect('full');
    const page = text(await client.readResource({ uri: 'headlamp://events?after=0&label=zz_late%3Dyes&limit=500' }));
    expect(page.events.some((e: any) => e.incidentId === t.id)).toBe(true);
    expect(page.events.every((e: any) => e.fullLabels === undefined && e.state === undefined && e.stateBefore === undefined)).toBe(true);
    await client.close();
    live.close();
  });

  it('matches nothing for two label parameters with the same key and different values', () => {
    const parsed = parseUri('headlamp://incidents?label=a%3D1&label=a%3D2');
    expect(parsed).toMatchObject({ type: 'incidents', filter: { never: true } });
    const e = { id: '1', at: 'x', kind: 'incident.created', uri: 'u', incidentId: 'i', labels: { a: '1' }, actor: null, state: 'open' as const };
    expect(eventMatches(e, parsed!)).toBe(false);
    expect(eventMatches(e, parseUri('headlamp://incidents?label=a%3D1')!)).toBe(true);
  });
});

describe('storage events carry the node (S8)', () => {
  const stream2 = (lines: unknown[]) => new Response(new ReadableStream({ start: c => { for (const l of lines) c.enqueue(new TextEncoder().encode(`${JSON.stringify(l)}\n`)); c.close(); } }));
  const pv = (name: string, size: string, node: string, claim?: string) => ({
    metadata: { name, resourceVersion: '1' },
    spec: { capacity: { storage: size }, storageClassName: 'fast', nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [node] }] }] } }, ...(claim ? { claimRef: { namespace: 'ns', name: claim } } : {}) },
    status: { phase: 'Bound' },
  });

  it('raises an event for a resize and a rebind, with node and volume, and pages the list with continue', async () => {
    const log = new MemoryEventLog();
    const raised: Array<{ uri: string; labels: Record<string, string> }> = [];
    log.listen(e => raised.push({ uri: e.uri, labels: e.labels }));
    const urls: string[] = [];
    const watch = new PvWatch(
      {
        getJson: async (path: string) => {
          urls.push(path);
          if (!path.includes('continue=')) return { metadata: { resourceVersion: '5', continue: 'tok' }, items: [pv('a', '1Gi', 'n1')] } as never;
          return { metadata: { resourceVersion: '5' }, items: [pv('b', '1Gi', 'n2')] } as never;
        },
        request: async () =>
          stream2([
            { type: 'MODIFIED', object: pv('a', '1Gi', 'n1') }, // nothing changed
            { type: 'MODIFIED', object: pv('a', '2Gi', 'n1') }, // resize: the phase is the same
            { type: 'MODIFIED', object: pv('b', '1Gi', 'n2', 'claim') }, // a rebind: only the claim changed
            { type: 'MODIFIED', object: pv('b', '1Gi', 'n3', 'claim') }, // the node changed
          ]),
      },
      log,
      () => {},
      20,
    );
    watch.start();
    for (let i = 0; i < 300 && raised.length < 4; i++) await new Promise(r => setTimeout(r, 10));
    await watch.stop();
    expect(urls[0]).toContain('limit=500');
    expect(urls[1]).toContain('continue=tok');
    // A resize of a, a rebind of b (claim), and a move of b from n2 to n3 (one event for each node).
    expect(raised.slice(0, 4).map(r => `${r.labels.volume}@${r.labels.node}`)).toEqual(['a@n1', 'b@n2', 'b@n2', 'b@n3']);
    expect(raised.every(r => r.uri === 'headlamp://storage/volumes')).toBe(true);
  });

  it('gives a node URI only the events of its node', () => {
    const e = (node: string) => ({ id: '1', at: 'x', kind: 'storage.updated', uri: 'headlamp://storage/volumes', incidentId: null, labels: { volume: 'a', node }, actor: null });
    expect(eventMatches(e('n1'), parseUri('headlamp://storage/volumes')!)).toBe(true);
    expect(eventMatches(e('n1'), parseUri('headlamp://storage/volumes/n1')!)).toBe(true);
    expect(eventMatches(e('n1'), parseUri('headlamp://storage/volumes/n2')!)).toBe(false);
  });
});

describe('the setting module feeds MCP (S13)', () => {
  it('maps updatedAt and updatedBy, and turns an empty name into null', () => {
    expect(fromSetting({ enabled: true })).toEqual({ enabled: true, changedAt: null, changedBy: null });
    expect(fromSetting({ enabled: false, updatedAt: '2026-11-28T00:00:00.000Z', updatedBy: '' })).toEqual({ enabled: false, changedAt: '2026-11-28T00:00:00.000Z', changedBy: null });
    expect(fromSetting({ enabled: false, updatedAt: '2026-11-28T00:00:00.000Z', updatedBy: 'ops', updatedVia: 'direct' }).changedBy).toBe('ops');
  });

  it('raises settings.changed with the real setting, and the resource shows the change', async () => {
    const s = await session('full', [SETTINGS_URI]);
    const live = await stream(s);
    expect((await put('/api/settings/automatic-investigations', { enabled: false, by: 'opsname' })).status).toBe(200);
    await until(() => live.frames.some(f => meta(f)?.kind === 'settings.changed'));
    const frame = live.frames.find(f => meta(f)?.kind === 'settings.changed')!;
    expect(meta(frame)).toMatchObject({ uri: SETTINGS_URI, incidentId: null });
    const { client } = await connect('full');
    const view: any = await client.callTool({ name: 'get_automatic_investigations', arguments: {} });
    expect(view.structuredContent.enabled).toBe(false);
    expect(view.structuredContent.changedAt).toMatch(/^\d{4}-/);
    expect(typeof view.structuredContent.changedBy === 'string' || view.structuredContent.changedBy === null).toBe(true);
    const log = text(await client.readResource({ uri: 'headlamp://events?after=0&kind=settings.&limit=500' }));
    expect(log.events.at(-1)).toMatchObject({ kind: 'settings.changed' });
    // The same value again changes nothing and raises no event.
    const before = log.events.length;
    await put('/api/settings/automatic-investigations', { enabled: false, by: 'opsname' });
    expect(text(await client.readResource({ uri: 'headlamp://events?after=0&kind=settings.&limit=500' })).events).toHaveLength(before);
    await put('/api/settings/automatic-investigations', { enabled: true, by: 'opsname' });
    await client.close();
    live.close();
  });
});
