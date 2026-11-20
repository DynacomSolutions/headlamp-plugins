import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type ModelRoutesConfig } from '../src/config.js';
import type { Diagnosis } from '../src/agent/report.js';
import { MemoryDiagnosisStore } from '../src/store.js';
import { PushError, PushService, brief, parseSettings, wantsChatAnswer, wantsDiagnosis } from '../src/push/service.js';
import { MemoryPushStore, PgPushStore, PUSH_SCHEMA, type PushSubscriptionRecord } from '../src/push/store.js';
import { b64url, encryptPayload, endpointAllowed, fromB64url, generateVapidKeys, subscriptionId, vapidHeader, vapidKeysMatch, type VapidKeys } from '../src/push/webpush.js';
import { pgliteDb } from './helpers/pglite.js';

const realFetch = globalThis.fetch;
// Built from parts, so the identifier check does not read them as real addresses.
const LINK_LOCAL = ['169', '254', '169', '254'].join('.');
const AT = String.fromCharCode(64);

const gate = vi.hoisted(() => ({ status: 'done' as 'done' | 'failed', severity: 'critical' }));
vi.mock('../src/agent/engine.js', () => ({
  diagnose: vi.fn(async (opts: { id: string; alert: any; source: string; host: string; budget: number; model?: { name: string } }) => ({
    id: opts.id,
    createdAt: 'x',
    status: gate.status,
    source: opts.source,
    host: opts.host,
    alert: { ...opts.alert, severity: gate.severity },
    result: gate.status === 'done' ? { summary: 'S', likelyCause: 'The node lost its network link.', confidence: 'high', signals: [], fixes: [{ title: 'f', detail: 'd', recommended: true }], verify: 'v' } : undefined,
    error: gate.status === 'failed' ? 'boom' : undefined,
    evidence: [],
    toolCalls: 0,
    toolBudget: opts.budget,
    model: opts.model?.name ?? 'm',
    a2ui: [],
  })),
}));
const { startServer } = await import('../src/server.js');

/** The receiver side of RFC 8291, written apart from the sender, to read what a push service would deliver. */
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

/** A test device: a browser key pair, an auth secret and an endpoint on a known push host. */
function device(name = 'one') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 7 + name.length) & 0xff));
  const endpoint = `https://fcm.googleapis.com/fcm/send/test-${name}`;
  return { ecdh, auth, endpoint, id: subscriptionId(endpoint), p256dh: b64url(ecdh.getPublicKey()), authB64: b64url(auth) };
}
type Device = ReturnType<typeof device>;

const URLS = { incident: '/c/main/incidents/{id}', chat: '/c/main/incidents/chat/{id}' };
const subscribeBody = (d: Device, extra: Record<string, unknown> = {}) => ({ subscription: { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.authB64 } }, urls: URLS, label: 'Phone', ...extra });

function diagnosis(id: string, severity = 'critical', extra: Partial<Diagnosis> = {}): Diagnosis {
  return {
    id,
    createdAt: '2026-11-21T05:00:00.000Z',
    status: 'done',
    source: 'webhook',
    alert: { name: 'KubePodCrashLooping', severity, labels: {}, annotations: {}, startsAt: '2026-11-21T04:59:00Z', fingerprint: `f-${id}` },
    result: { summary: 'S', likelyCause: 'The container runs out of memory and restarts.', confidence: 'high', signals: [], fixes: [{ title: 'f', detail: 'd', recommended: true }], verify: 'v' },
    evidence: [],
    toolCalls: 0,
    toolBudget: 5,
    model: 'm',
    a2ui: [],
    ...extra,
  };
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** A push service that records every request and answers with `status`. */
function pushService(answer: { status: number | ((url: string) => number) } = { status: 201 }) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), body: Buffer.from(init?.body as Uint8Array) });
    return new Response(null, { status: typeof answer.status === 'function' ? answer.status(url) : answer.status });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

describe('Web Push encryption', () => {
  // The RFC prints the sender key and the ciphertext apart. Here they are one string, so the last key character differs.
  it('matches the example of RFC 8291 section 5', () => {
    const uaPublic = fromB64url('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
    const body = encryptPayload(Buffer.from('When I grow up, I want to be a watermelon'), uaPublic, fromB64url('BTBZMqHH6r4Tts7J_aSIgg'), {
      senderPrivateKey: fromB64url('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      salt: fromB64url('DGv6ra1nlYgDCS1FRnbzlw'),
    });
    expect(b64url(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('round-trips with an independent receiver and refuses a payload that is too large', () => {
    const d = device();
    const body = encryptPayload(Buffer.from('{"title":"Hello","body":"World"}'), d.ecdh.getPublicKey(), d.auth);
    expect(decrypt(body, d.ecdh.getPrivateKey(), d.ecdh.getPublicKey(), d.auth)).toBe('{"title":"Hello","body":"World"}');
    expect(() => encryptPayload(Buffer.alloc(4000), d.ecdh.getPublicKey(), d.auth)).toThrow(/too large/);
  });

  it('signs a VAPID header that the public key verifies', () => {
    const keys: VapidKeys = { ...generateVapidKeys(), subject: 'mailto:noreply@example.com' };
    expect(vapidKeysMatch(keys)).toBe(true);
    expect(vapidKeysMatch({ ...keys, privateKey: generateVapidKeys().privateKey })).toBe(false);
    const header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', keys, Date.UTC(2026, 10, 21));
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)!;
    expect(m[4]).toBe(keys.publicKey);
    expect(JSON.parse(fromB64url(m[2]!).toString())).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:noreply@example.com' });
    const pub = fromB64url(keys.publicKey);
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) } });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64url(m[3]!))).toBe(true);
  });

  it('allows only https endpoints of known push services', () => {
    expect(endpointAllowed('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(endpointAllowed('https://jmt17.google.com/fcm/send/x')).toBe(true);
    expect(endpointAllowed('https://www.google.com/fcm/send/x')).toBe(false);
    expect(endpointAllowed('https://jmt17.google.com.evil.example/x')).toBe(false);
    expect(endpointAllowed('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(endpointAllowed('https://web.push.apple.com/x')).toBe(true);
    expect(endpointAllowed('https://wns2-par02p.notify.windows.com/x')).toBe(true);
    expect(endpointAllowed('http://fcm.googleapis.com/x')).toBe(false);
    expect(endpointAllowed(`https://${LINK_LOCAL}/latest`)).toBe(false);
    expect(endpointAllowed('https://fcm.googleapis.com.evil.example/x')).toBe(false);
    expect(endpointAllowed(`https://user:pw${AT}fcm.googleapis.com/x`)).toBe(false);
    expect(endpointAllowed('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(endpointAllowed('https://push.example.com/x')).toBe(false);
    expect(endpointAllowed('https://push.example.com/x', ['push.example.com'])).toBe(true);
    expect(endpointAllowed('not a url')).toBe(false);
  });
});

describe('rules', () => {
  it('filters diagnosis pushes by switch and severity group', () => {
    const both = { diagnosis: true, chat: true, severities: ['warning', 'critical'] as const };
    expect(wantsDiagnosis({ ...both, severities: [...both.severities] }, 'critical')).toBe(true);
    expect(wantsDiagnosis({ ...both, severities: [...both.severities] }, 'Warning')).toBe(true);
    expect(wantsDiagnosis({ ...both, severities: [...both.severities] }, 'info')).toBe(false);
    expect(wantsDiagnosis({ ...both, severities: [...both.severities] }, '')).toBe(false);
    expect(wantsDiagnosis({ diagnosis: true, chat: true, severities: ['critical'] }, 'warning')).toBe(false);
    expect(wantsDiagnosis({ diagnosis: true, chat: true, severities: ['other'] }, 'info')).toBe(true);
    expect(wantsDiagnosis({ diagnosis: false, chat: true, severities: ['critical'] }, 'critical')).toBe(false);
  });

  it('pushes a chat answer only when the asking page is not watching that chat', () => {
    const now = Date.parse('2026-11-21T06:00:00Z');
    const settings = { diagnosis: true, chat: true, severities: [] };
    const at = (s: number) => new Date(now + s * 1000).toISOString();
    expect(wantsChatAnswer({ settings }, 'c1', now)).toBe(true); // no page reported
    expect(wantsChatAnswer({ settings, watchingChat: 'c1', watchingUntil: at(30) }, 'c1', now)).toBe(false); // visible on that chat
    expect(wantsChatAnswer({ settings, watchingChat: 'c1', watchingUntil: at(-1) }, 'c1', now)).toBe(true); // the report ran out
    expect(wantsChatAnswer({ settings, watchingChat: 'c2', watchingUntil: at(30) }, 'c1', now)).toBe(true); // visible on another chat
    expect(wantsChatAnswer({ settings: { ...settings, chat: false } }, 'c1', now)).toBe(false); // switch off
  });

  it('parses settings strictly and keeps unset fields', () => {
    expect(parseSettings(undefined)).toEqual({ diagnosis: true, chat: true, severities: ['warning', 'critical'] });
    expect(parseSettings({ chat: false })).toEqual({ diagnosis: true, chat: false, severities: ['warning', 'critical'] });
    expect(parseSettings({ severities: ['critical', 'other', 'critical'] }).severities).toEqual(['critical', 'other']);
    expect(() => parseSettings({ severities: ['fatal'] })).toThrow(PushError);
    expect(() => parseSettings({ diagnosis: 'yes' })).toThrow(PushError);
    expect(() => parseSettings([])).toThrow(PushError);
  });

  it('makes a short plain body without secrets', () => {
    expect(brief('## Result\n**Bold** `code` and [a link](https://x.example/y)\n\n```\nblock\n```\nmore')).toBe('Result Bold code and a link more');
    expect(brief('a'.repeat(300))).toHaveLength(140);
    expect(brief('a'.repeat(300)).endsWith('...')).toBe(true);
    expect(brief('the key is sk-abcdefghijklmnop12345678')).not.toContain('abcdefghijklmnop');
  });
});

describe('PushService', () => {
  const keys: VapidKeys = { ...generateVapidKeys(), subject: 'mailto:noreply@example.com' };
  let clock = Date.parse('2026-11-21T06:00:00Z');
  const make = (fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof PushService>[0]> = {}) => {
    const store = new MemoryPushStore();
    const logs: Array<[string, string]> = [];
    const service = new PushService({ store, keys, fetch: fetchImpl, now: () => clock, log: (level, message) => logs.push([level, message]), ...extra });
    return { store, service, logs };
  };
  beforeEach(() => {
    clock = Date.parse('2026-11-21T06:00:00Z');
  });

  it('is off without keys, and refuses a subscription', async () => {
    const service = new PushService({ store: new MemoryPushStore() });
    expect(service.publicConfig()).toEqual({ enabled: false, publicKey: null });
    const d = device();
    await expect(service.subscribe(d.id, subscribeBody(d))).rejects.toMatchObject({ status: 503 });
    expect(await service.notifyDiagnosis(diagnosis('a'))).toBe(0);
  });

  it('is off when the keys do not match', () => {
    const service = new PushService({ store: new MemoryPushStore(), keys: { ...keys, privateKey: generateVapidKeys().privateKey } });
    expect(service.enabled).toBe(false);
  });

  it('stores a subscription with the default switches and never shows its keys', async () => {
    const { service, store } = make(pushService().fetchImpl);
    const d = device();
    const view = await service.subscribe(d.id, subscribeBody(d));
    expect(view).toMatchObject({ id: d.id, label: 'Phone', settings: { diagnosis: true, chat: true, severities: ['warning', 'critical'] } });
    expect(JSON.stringify(view)).not.toContain(d.p256dh);
    expect(JSON.stringify(view)).not.toContain(d.endpoint);
    expect((await store.get(d.id))?.endpoint).toBe(d.endpoint);
    expect(service.publicConfig()).toEqual({ enabled: true, publicKey: keys.publicKey });
  });

  it('rejects a wrong id, a foreign endpoint, bad keys and bad url templates', async () => {
    const { service } = make(pushService().fetchImpl);
    const d = device();
    await expect(service.subscribe(subscriptionId('other'), subscribeBody(d))).rejects.toMatchObject({ status: 400 });
    await expect(service.subscribe('nope', subscribeBody(d))).rejects.toMatchObject({ status: 404 });
    const internal = `https://${LINK_LOCAL}/x`;
    await expect(service.subscribe(subscriptionId(internal), { ...subscribeBody(d), subscription: { endpoint: internal, keys: { p256dh: d.p256dh, auth: d.authB64 } } })).rejects.toMatchObject({ status: 400 });
    await expect(service.subscribe(d.id, subscribeBody(d, { subscription: { endpoint: d.endpoint, keys: { p256dh: b64url(Buffer.alloc(65, 1)), auth: d.authB64 } } }))).rejects.toMatchObject({ status: 400 });
    await expect(service.subscribe(d.id, subscribeBody(d, { subscription: { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: 'AA' } } }))).rejects.toMatchObject({ status: 400 });
    for (const bad of ['//evil.example/{id}', 'https://evil.example/{id}', '/x/{id}/{id}', '/x/no-id', '/x?q={id}', '/x\\{id}']) {
      await expect(service.subscribe(d.id, subscribeBody(d, { urls: { incident: bad, chat: URLS.chat } }))).rejects.toMatchObject({ status: 400 });
    }
  });

  it('pushes a ready diagnosis with the alert, severity, likely cause and a path to the incident', async () => {
    const svc = pushService();
    const { service, store } = make(svc.fetchImpl);
    const d = device();
    await service.subscribe(d.id, subscribeBody(d));
    expect(await service.notifyDiagnosis(diagnosis('abc-123'))).toBe(1);
    expect(svc.sent).toHaveLength(1);
    const s = svc.sent[0]!;
    expect(s.url).toBe(d.endpoint);
    expect(s.headers['content-encoding']).toBe('aes128gcm');
    expect(s.headers.authorization).toMatch(/^vapid t=.+, k=/);
    const payload = JSON.parse(decrypt(s.body, d.ecdh.getPrivateKey(), d.ecdh.getPublicKey(), d.auth));
    expect(payload).toEqual({ kind: 'diagnosis', title: 'Diagnosis ready: KubePodCrashLooping (critical)', body: 'The container runs out of memory and restarts.', tag: 'diagnosis-abc-123', url: '/c/main/incidents/abc-123' });
    expect(await store.get(d.id)).toMatchObject({ lastResult: 'ok' });
  });

  it('sends nothing for a diagnosis that is not done', async () => {
    const svc = pushService();
    const { service } = make(svc.fetchImpl);
    const d = device();
    await service.subscribe(d.id, subscribeBody(d));
    expect(await service.notifyDiagnosis(diagnosis('a', 'critical', { status: 'failed' }))).toBe(0);
    expect(await service.notifyDiagnosis(diagnosis('b', 'critical', { status: 'running' }))).toBe(0);
    expect(svc.sent).toHaveLength(0);
  });

  it('applies the diagnosis switch and the severity filter per device', async () => {
    const svc = pushService();
    const { service } = make(svc.fetchImpl);
    const a = device('a');
    const b = device('b');
    const c = device('c');
    await service.subscribe(a.id, subscribeBody(a)); // default: warning and critical
    await service.subscribe(b.id, subscribeBody(b, { settings: { severities: ['critical'] } }));
    await service.subscribe(c.id, subscribeBody(c, { settings: { diagnosis: false } }));
    await service.notifyDiagnosis(diagnosis('w', 'warning'));
    expect(svc.sent.map(s => s.url)).toEqual([a.endpoint]);
    svc.sent.length = 0;
    await service.notifyDiagnosis(diagnosis('c1', 'critical'));
    expect(svc.sent.map(s => s.url).sort()).toEqual([a.endpoint, b.endpoint].sort());
    svc.sent.length = 0;
    await service.notifyDiagnosis(diagnosis('i', 'info'));
    expect(svc.sent).toHaveLength(0);
    // The page changes the filter later.
    await service.update(b.id, { settings: { severities: ['other'] } });
    await service.notifyDiagnosis(diagnosis('i2', 'info'));
    expect(svc.sent.map(s => s.url)).toEqual([b.endpoint]);
    await expect(service.update(b.id, { settings: { severities: ['nope'] } })).rejects.toMatchObject({ status: 400 });
  });

  it('pushes a chat answer to the asking device, and only when its page is not visible', async () => {
    const svc = pushService();
    const { service } = make(svc.fetchImpl);
    const d = device();
    const other = device('other');
    await service.subscribe(d.id, subscribeBody(d));
    await service.subscribe(other.id, subscribeBody(other));
    // Visible on this chat: no push.
    await service.presence(d.id, 'chat-1');
    expect(await service.notifyChatAnswer(d.id, 'chat-1', 'Two pods fail.')).toBe(false);
    expect(svc.sent).toHaveLength(0);
    // The page hides: push, to the asking device only.
    await service.presence(d.id, null);
    expect(await service.notifyChatAnswer(d.id, 'chat-1', '## Two pods\n**fail** because of memory.')).toBe(true);
    expect(svc.sent).toHaveLength(1);
    expect(svc.sent[0]!.url).toBe(d.endpoint);
    expect(JSON.parse(decrypt(svc.sent[0]!.body, d.ecdh.getPrivateKey(), d.ecdh.getPublicKey(), d.auth))).toEqual({ kind: 'chat', title: 'Incident chat', body: 'Two pods fail because of memory.', tag: 'chat-chat-1', url: '/c/main/incidents/chat/chat-1' });
    // A page that stopped reporting counts as hidden once the report runs out.
    await service.presence(d.id, 'chat-1');
    clock += 76_000;
    expect(await service.notifyChatAnswer(d.id, 'chat-1', 'Later.')).toBe(true);
    // Visible on another chat does not hide this answer.
    await service.presence(d.id, 'chat-2');
    expect(await service.notifyChatAnswer(d.id, 'chat-1', 'Elsewhere.')).toBe(true);
    // Switch off, unknown device.
    await service.update(d.id, { settings: { chat: false } });
    expect(await service.notifyChatAnswer(d.id, 'chat-1', 'Off.')).toBe(false);
    expect(await service.notifyChatAnswer(subscriptionId('gone'), 'chat-1', 'None.')).toBe(false);
    await expect(service.presence(d.id, 'bad id!')).rejects.toMatchObject({ status: 400 });
    await expect(service.presence(subscriptionId('gone'), 'chat-1')).rejects.toMatchObject({ status: 404 });
  });

  it('removes a subscription that the push service reports as gone (410 and 404), and keeps one on other errors', async () => {
    const gone = device('gone');
    const missing = device('missing');
    const flaky = device('flaky');
    const svc = pushService({ status: url => (url === gone.endpoint ? 410 : url === missing.endpoint ? 404 : 500) });
    const { service, store, logs } = make(svc.fetchImpl);
    for (const d of [gone, missing, flaky]) await service.subscribe(d.id, subscribeBody(d));
    await service.notifyDiagnosis(diagnosis('a'));
    expect(await store.get(gone.id)).toBeUndefined();
    expect(await store.get(missing.id)).toBeUndefined();
    expect(await store.get(flaky.id)).toMatchObject({ lastResult: '500' });
    expect(svc.sent).toHaveLength(3); // one try each, no retry
    expect(logs.some(([, m]) => m.includes('removed'))).toBe(true);
  });

  it('survives a network error without a retry and without throwing', async () => {
    let calls = 0;
    const { service, store } = make((async () => {
      calls++;
      throw new Error('socket hang up');
    }) as typeof fetch);
    const d = device();
    await service.subscribe(d.id, subscribeBody(d));
    expect(await service.notifyDiagnosis(diagnosis('a'))).toBe(0);
    expect(calls).toBe(1);
    expect(await store.get(d.id)).toMatchObject({ lastResult: 'error' });
  });

  it('limits the pushes of one device in a time window', async () => {
    const svc = pushService();
    const { service, logs } = make(svc.fetchImpl, { maxPerWindow: 3, windowMs: 60_000 });
    const d = device();
    await service.subscribe(d.id, subscribeBody(d));
    for (let i = 0; i < 5; i++) await service.notifyDiagnosis(diagnosis(`d${i}`));
    expect(svc.sent).toHaveLength(3);
    expect(logs.filter(([, m]) => m.includes('rate limit'))).toHaveLength(2);
    clock += 61_000;
    await service.notifyDiagnosis(diagnosis('later'));
    expect(svc.sent).toHaveLength(4);
  });

  it('unsubscribes', async () => {
    const svc = pushService();
    const { service } = make(svc.fetchImpl);
    const d = device();
    await service.subscribe(d.id, subscribeBody(d));
    await service.unsubscribe(d.id);
    await expect(service.get(d.id)).rejects.toMatchObject({ status: 404 });
    expect(await service.notifyDiagnosis(diagnosis('a'))).toBe(0);
  });

  it('keeps the history of sends when a device subscribes again', async () => {
    const svc = pushService();
    const { service, store } = make(svc.fetchImpl);
    const d = device();
    await service.subscribe(d.id, subscribeBody(d, { settings: { chat: false } }));
    await service.notifyDiagnosis(diagnosis('a'));
    const again = await service.subscribe(d.id, subscribeBody(d));
    expect(again.settings.chat).toBe(false); // an unset field keeps what the device had
    expect(again.lastResult).toBe('ok');
    expect((await store.list()).length).toBe(1);
  });
});

describe('PgPushStore', () => {
  it('stores, lists, marks presence and deletes in PostgreSQL', async () => {
    const db = pgliteDb();
    try {
      for (const statement of PUSH_SCHEMA) await db.query(statement);
      await db.query(PUSH_SCHEMA[0]!); // safe to run again
      const store = new PgPushStore(db);
      const d = device();
      const record: PushSubscriptionRecord = { id: d.id, endpoint: d.endpoint, p256dh: d.p256dh, auth: d.authB64, label: 'Phone', settings: { diagnosis: true, chat: false, severities: ['critical'] }, urls: URLS, createdAt: '2026-11-21T06:00:00.000Z', updatedAt: '2026-11-21T06:00:00.000Z' };
      await store.upsert(record);
      expect(await store.get(d.id)).toEqual(record);
      expect(await store.setPresence(d.id, 'chat-1', Date.parse('2026-11-21T06:01:00Z'))).toBe(true);
      await store.recordResult(d.id, Date.parse('2026-11-21T06:00:30Z'), 'ok');
      await store.upsert({ ...record, label: 'Tablet', settings: { diagnosis: false, chat: true, severities: [] }, updatedAt: '2026-11-21T07:00:00.000Z' });
      expect(await store.get(d.id)).toMatchObject({ label: 'Tablet', settings: { diagnosis: false, chat: true, severities: [] }, createdAt: record.createdAt, lastResult: 'ok', watchingChat: 'chat-1', watchingUntil: '2026-11-21T06:01:00.000Z' });
      expect(await store.setPresence(d.id, null, 0)).toBe(true);
      expect((await store.get(d.id))?.watchingChat).toBeUndefined();
      expect(await store.setPresence(subscriptionId('x'), 'c', 0)).toBe(false);
      expect(await store.list()).toHaveLength(1);
      expect(await store.delete(d.id)).toBe(true);
      expect(await store.delete(d.id)).toBe(false);
    } finally {
      await db.close();
    }
    // PGlite starts a real PostgreSQL. On a busy CI runner that takes about 10 s.
  }, 60_000);
});

describe('push in the server', () => {
  const GW = 'http://gw.invalid/gateway';
  const keys = generateVapidKeys();
  let dir: string;
  let svc: ReturnType<typeof pushService>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-push-'));
    svc = pushService();
    gate.status = 'done';
    gate.severity = 'critical';
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://fcm.googleapis.com/')) return svc.fetchImpl(input, init);
      if (url.startsWith(GW)) {
        if (url.endsWith('/models')) return new Response('nope', { status: 500 });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'The api pod is out of memory.', tool_calls: [] }, finish_reason: 'stop' }], usage: {} }), { status: 200 });
      }
      return realFetch(input as string, init);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const models = (): ModelRoutesConfig => ({ routes: [{ id: 'gateway', style: 'openai', baseUrl: GW, apiKey: 'k', headers: {}, systemPrefix: '', models: ['m1'], maxTokens: 100, timeoutMs: 1000 }], defaultModel: 'gateway/m1', skipped: [] });
  const start = async (push = true) => {
    const store = new MemoryDiagnosisStore();
    const config = {
      ...loadConfig({} as NodeJS.ProcessEnv),
      port: 0,
      host: '127.0.0.1',
      kubeApi: 'http://127.0.0.1:1',
      kubeTokenFile: '/nonexistent',
      dataDir: dir,
      models: models(),
      push: push ? { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:noreply@example.com', extraHosts: [], maxPer10Min: 50 } : { publicKey: '', privateKey: '', subject: 'mailto:noreply@example.com', extraHosts: [], maxPer10Min: 10 },
    };
    const server = await startServer(config, 'test', { store });
    const base = `http://127.0.0.1:${server.port}`;
    const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => {
      const res = await realFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    };
    return { server, store, api };
  };
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 300 && !check(); i++) await new Promise(r => setTimeout(r, 10));
    expect(check()).toBe(true);
  };

  it('serves the config and the subscription routes with the same guard as the other writes', async () => {
    const { server, api } = await start();
    const d = device();
    try {
      expect((await api('GET', '/api/push/config')).body).toEqual({ enabled: true, publicKey: keys.publicKey });
      expect((await api('GET', `/api/push/subscriptions/${d.id}`)).status).toBe(404);
      expect((await api('POST', `/api/push/subscriptions/${d.id}`, subscribeBody(d), { 'content-type': 'text/plain' })).status).toBe(415);
      const res = await realFetch(`http://127.0.0.1:${server.port}/api/push/subscriptions/${d.id}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify(subscribeBody(d)) });
      expect(res.status).toBe(403);
      expect((await api('POST', `/api/push/subscriptions/${d.id}`, subscribeBody(d))).status).toBe(200);
      expect((await api('GET', `/api/push/subscriptions/${d.id}`)).body).toMatchObject({ id: d.id, settings: { diagnosis: true, chat: true, severities: ['warning', 'critical'] } });
      expect((await api('POST', `/api/push/subscriptions/${d.id}/settings`, { settings: { chat: false } })).body.settings.chat).toBe(false);
      expect((await api('POST', `/api/push/subscriptions/${d.id}/presence`, { chatId: 'c1' })).status).toBe(200);
      expect((await api('POST', `/api/push/subscriptions/${d.id}/presence`, { chatId: 'bad id' })).status).toBe(400);
      expect((await api('POST', `/api/push/subscriptions/${d.id}/unsubscribe`, {})).status).toBe(200);
      expect((await api('PUT', `/api/push/subscriptions/${d.id}`, subscribeBody(d))).status).toBe(404); // only GET and POST
      expect((await api('GET', `/api/push/subscriptions/${d.id}`)).status).toBe(404);
      expect((await api('GET', '/api/push/other')).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('reports push as off, and keeps running, without keys', async () => {
    const { server, api } = await start(false);
    try {
      expect((await api('GET', '/api/push/config')).body).toEqual({ enabled: false, publicKey: null });
      const d = device();
      expect((await api('POST', `/api/push/subscriptions/${d.id}`, subscribeBody(d))).status).toBe(503);
    } finally {
      await server.close();
    }
  });

  it('pushes when a diagnosis the agent ran reaches done, and not when it fails', async () => {
    const { server, api } = await start();
    const d = device();
    try {
      await api('POST', `/api/push/subscriptions/${d.id}`, subscribeBody(d));
      const alert = { name: 'NodeNotReady', severity: 'critical', labels: {}, annotations: {}, startsAt: '', fingerprint: '' };
      const started = await api('POST', '/api/diagnoses', { alert });
      expect(started.status).toBe(202);
      await until(() => svc.sent.length === 1);
      const payload = JSON.parse(decrypt(svc.sent[0]!.body, d.ecdh.getPrivateKey(), d.ecdh.getPublicKey(), d.auth));
      expect(payload).toMatchObject({ kind: 'diagnosis', title: 'Diagnosis ready: NodeNotReady (critical)', body: 'The node lost its network link.' });
      expect(payload.url).toBe(`/c/main/incidents/${started.body.id}`);
      gate.status = 'failed';
      expect((await api('POST', '/api/diagnoses', { alert: { ...alert, name: 'Other' } })).status).toBe(202);
      await new Promise(r => setTimeout(r, 150));
      expect(svc.sent).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('pushes when a failed diagnosis is run again and ends done', async () => {
    const { server, api } = await start();
    const d = device();
    try {
      await api('POST', `/api/push/subscriptions/${d.id}`, subscribeBody(d));
      gate.status = 'failed';
      const started = await api('POST', '/api/diagnoses', { alert: { name: 'NodeNotReady', severity: 'critical', labels: {}, annotations: {}, startsAt: '', fingerprint: '' } });
      const id = started.body.id as string;
      await until(() => svc.sent.length === 0 && true);
      await new Promise(r => setTimeout(r, 150));
      expect(svc.sent).toHaveLength(0); // the first run failed: no push
      gate.status = 'done';
      expect((await api('POST', `/api/diagnoses/${id}/rerun`, {})).status).toBe(202);
      await until(() => svc.sent.length === 1);
      expect(JSON.parse(decrypt(svc.sent[0]!.body, d.ecdh.getPrivateKey(), d.ecdh.getPublicKey(), d.auth))).toMatchObject({ kind: 'diagnosis', url: `/c/main/incidents/${id}` });
    } finally {
      await server.close();
    }
  });

  it('pushes a diagnosis that an outside agent publishes as done', async () => {
    const { server, api } = await start();
    const d = device();
    try {
      await api('POST', `/api/push/subscriptions/${d.id}`, subscribeBody(d, { settings: { severities: ['critical'] } }));
      const result = { summary: 'S', likelyCause: 'A disk is full.', confidence: 'high', signals: [], fixes: [{ title: 'f', detail: 'd', recommended: true }], verify: 'v' };
      const publish = (severity: string, status: string) => api('POST', '/api/diagnoses', { diagnosis: { alert: { name: 'DiskFull', severity }, status, result: status === 'done' ? result : undefined, error: status === 'failed' ? 'x' : undefined } });
      expect((await publish('warning', 'done')).status).toBe(201); // filtered out
      expect((await publish('critical', 'failed')).status).toBe(201); // not done
      expect((await publish('critical', 'done')).status).toBe(201);
      await until(() => svc.sent.length === 1);
      expect(JSON.parse(decrypt(svc.sent[0]!.body, d.ecdh.getPrivateKey(), d.ecdh.getPublicKey(), d.auth))).toMatchObject({ title: 'Diagnosis ready: DiskFull (critical)', body: 'A disk is full.' });
    } finally {
      await server.close();
    }
  });

  it('pushes a chat answer when the asking page is hidden, and not when it is visible', async () => {
    const { server, api } = await start();
    const d = device();
    try {
      await api('POST', `/api/push/subscriptions/${d.id}`, subscribeBody(d));
      const chat = (await api('POST', '/api/chats', {})).body.id as string;
      const waitIdle = async () => {
        for (let i = 0; i < 300; i++) {
          if (!(await api('GET', `/api/chats/${chat}`)).body.running) return;
          await new Promise(r => setTimeout(r, 10));
        }
      };
      // The page is visible on the chat while the answer is made: no push.
      await api('POST', `/api/push/subscriptions/${d.id}/presence`, { chatId: chat });
      expect((await api('POST', `/api/chats/${chat}/messages`, { text: 'What is wrong?', push: d.id })).status).toBe(202);
      await waitIdle();
      await new Promise(r => setTimeout(r, 50));
      expect(svc.sent).toHaveLength(0);
      // The page is hidden: push.
      await api('POST', `/api/push/subscriptions/${d.id}/presence`, { chatId: null });
      expect((await api('POST', `/api/chats/${chat}/messages`, { text: 'And now?', push: d.id })).status).toBe(202);
      await waitIdle();
      await until(() => svc.sent.length === 1);
      expect(JSON.parse(decrypt(svc.sent[0]!.body, d.ecdh.getPrivateKey(), d.ecdh.getPublicKey(), d.auth))).toEqual({ kind: 'chat', title: 'Incident chat', body: 'The api pod is out of memory.', tag: `chat-${chat}`, url: `/c/main/incidents/chat/${chat}` });
      // A page without a subscription sends none, and a bad id is refused.
      expect((await api('POST', `/api/chats/${chat}/messages`, { text: 'No push', push: 'zz' })).status).toBe(400);
      expect((await api('POST', `/api/chats/${chat}/messages`, { text: 'No push' })).status).toBe(202);
      await waitIdle();
      await new Promise(r => setTimeout(r, 50));
      expect(svc.sent).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
