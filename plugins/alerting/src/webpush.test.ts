import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  channelFromResource,
  channelResource,
  DEFAULT_SETTINGS,
  deviceLabel,
  emptyChannel,
  parseStatePayload,
  pushSupport,
  subscriptionName,
  subscriptionParts,
  subscriptionResource,
  urlBase64ToBytes,
  validateChannel,
} from './model';

const S = DEFAULT_SETTINGS;

describe('webpush channel', () => {
  it('round-trips ttl and urgency', () => {
    const f = {
      ...emptyChannel(),
      alertKinds: ['urgent' as const],
      name: 'push',
      type: 'webpush' as const,
      webpushTtl: '600',
      webpushUrgency: 'high',
    };
    const cr = channelResource(f, S);
    expect(cr.spec).toEqual({
      type: 'webpush',
      enabled: true,
      alertKinds: ['urgent'],
      webpush: { ttl: 600, urgency: 'high' },
    });
    const back = channelFromResource(cr);
    expect([back.type, back.webpushTtl, back.webpushUrgency]).toEqual(['webpush', '600', 'high']);
  });
  it('emits an empty webpush object and validates ttl', () => {
    const f = {
      ...emptyChannel(),
      alertKinds: ['urgent' as const],
      name: 'push',
      type: 'webpush' as const,
    };
    expect(channelResource(f, S).spec.webpush).toEqual({});
    expect(validateChannel(f)).toEqual([]);
    expect(validateChannel({ ...f, webpushTtl: 'abc' })).toHaveLength(1);
  });
  it('reads the public key from the state payload', () => {
    expect(parseStatePayload({ webpush: { publicKey: 'abc' } }).webpushPublicKey).toBe('abc');
    expect(parseStatePayload({ webpush: { publicKey: null } }).webpushPublicKey).toBeUndefined();
    expect(parseStatePayload({}).webpushPublicKey).toBeUndefined();
  });
});

describe('device helpers', () => {
  it('decodes base64url keys', () => {
    expect(Array.from(urlBase64ToBytes('AQID_w'))).toEqual([1, 2, 3, 255]);
  });
  it('extracts subscription parts as base64url', () => {
    const buf = (...n: number[]) => Uint8Array.from(n).buffer;
    const sub = {
      endpoint: 'https://push.example.com/x',
      getKey: (k: string) => (k === 'auth' ? buf(251, 255) : buf(1, 2, 3)),
    };
    expect(subscriptionParts(sub as any)).toEqual({
      endpoint: 'https://push.example.com/x',
      keys: { p256dh: 'AQID', auth: '-_8' },
    });
  });
  it('derives a stable resource name', async () => {
    const a = await subscriptionName('https://push.example.com/a');
    expect(a).toMatch(/^push-[0-9a-f]{20}$/);
    expect(await subscriptionName('https://push.example.com/a')).toBe(a);
    expect(await subscriptionName('https://push.example.com/b')).not.toBe(a);
  });
  it('labels devices', () => {
    expect(
      deviceLabel('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36')
    ).toBe('Chrome on Linux');
    expect(
      deviceLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17 Mobile Safari/604'
      )
    ).toBe('Safari on iOS');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/120.0')).toBe(
      'Firefox on Windows'
    );
  });
  it('builds the PushSubscription resource', () => {
    const r = subscriptionResource(
      'push',
      { endpoint: 'https://push.example.com/x', keys: { p256dh: 'k', auth: 'a' } },
      'push-1',
      'Chrome on Linux',
      'UA',
      S
    );
    expect(r).toMatchObject({
      apiVersion: 'alerting.example.com/v1alpha1',
      kind: 'PushSubscription',
      metadata: { name: 'push-1', namespace: 'monitoring' },
      spec: {
        channel: 'push',
        label: 'Chrome on Linux',
        userAgent: 'UA',
        keys: { p256dh: 'k', auth: 'a' },
      },
    });
  });
  it('detects iOS install requirement', () => {
    const base = {
      standalone: false,
      hasServiceWorker: true,
      hasPushManager: false,
      hasNotification: false,
    };
    const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
    expect(pushSupport({ ...base, ua: ios })).toBe('needs-install');
    expect(
      pushSupport({
        ...base,
        ua: ios,
        standalone: true,
        hasPushManager: true,
        hasNotification: true,
      })
    ).toBe('ok');
    expect(pushSupport({ ...base, ua: 'Chrome Linux' })).toBe('unsupported');
    expect(
      pushSupport({ ...base, ua: 'Chrome Linux', hasPushManager: true, hasNotification: true })
    ).toBe('ok');
  });
});

describe('service worker', () => {
  function load() {
    const handlers: Record<string, (e: any) => void> = {};
    const shown: any[] = [];
    const self: any = {
      location: { origin: 'https://dash.example.com' },
      skipWaiting: vi.fn(),
      addEventListener: (n: string, h: any) => (handlers[n] = h),
      registration: {
        showNotification: (t: string, o: any) => (shown.push([t, o]), Promise.resolve()),
      },
      clients: { claim: vi.fn(), matchAll: vi.fn(), openWindow: vi.fn(() => Promise.resolve()) },
    };
    new Function('self', readFileSync('sw.js', 'utf8'))(self);
    return { handlers, shown, self };
  }
  const pushEvent = (payload: any) => {
    const waits: Promise<any>[] = [];
    return {
      data: { json: () => payload, text: () => 'raw' },
      waitUntil: (p: Promise<any>) => waits.push(p),
      waits,
    };
  };
  it('shows urgent notifications that require interaction', async () => {
    const { handlers, shown } = load();
    const e = pushEvent({ title: 'Down', body: 'b', kind: 'urgent', url: '/x', tag: 't' });
    handlers.push(e);
    await Promise.all(e.waits);
    expect(shown[0][0]).toBe('Down');
    expect(shown[0][1]).toMatchObject({
      body: 'b',
      tag: 't',
      requireInteraction: true,
      data: { url: '/x' },
    });
  });
  it('does not require interaction for recoveries', async () => {
    const { handlers, shown } = load();
    const e = pushEvent({ title: 'Up', kind: 'recovery' });
    handlers.push(e);
    await Promise.all(e.waits);
    expect(shown[0][1].requireInteraction).toBe(false);
  });
  it('opens a window on click when none exists, never off-origin', async () => {
    const { handlers, self } = load();
    self.clients.matchAll.mockResolvedValue([]);
    const waits: Promise<any>[] = [];
    handlers.notificationclick({
      notification: { close: vi.fn(), data: { url: 'https://evil.example.org/' } },
      waitUntil: (p: Promise<any>) => waits.push(p),
    });
    await Promise.all(waits);
    expect(self.clients.openWindow).toHaveBeenCalledWith('https://dash.example.com/');
  });
  it('focuses an existing window', async () => {
    const { handlers, self } = load();
    const focus = vi.fn(() => Promise.resolve());
    const navigate = vi.fn(() => Promise.resolve());
    self.clients.matchAll.mockResolvedValue([
      { url: 'https://dash.example.com/c', focus, navigate },
    ]);
    const waits: Promise<any>[] = [];
    handlers.notificationclick({
      notification: { close: vi.fn(), data: { url: '/alerting/status' } },
      waitUntil: (p: Promise<any>) => waits.push(p),
    });
    await Promise.all(waits);
    expect(focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('https://dash.example.com/alerting/status');
  });
});
