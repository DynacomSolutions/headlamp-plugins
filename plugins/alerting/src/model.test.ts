/// <reference types="@kinvolk/headlamp-plugin" />
import { describe, expect, it } from 'vitest';
import {
  channelFromResource,
  channelResource,
  DEFAULT_SETTINGS,
  emptyChannel,
  emptyRoute,
  manifestFileName,
  parseList,
  parseState,
  parseStatePayload,
  resolveEndpoint,
  resolveSettings,
  routeFromResource,
  routeResource,
  secretListingFailed,
  stateSeverity,
  testRequestPatch,
  testState,
  toYaml,
  validateChannel,
  validateRoute,
} from './model';

const S = DEFAULT_SETTINGS;

describe('settings', () => {
  it('uses generic defaults', () => {
    const s = resolveSettings(undefined);
    expect(s.group).toBe('alerting.example.com');
    expect(s.version).toBe('v1alpha1');
    expect(s.namespace).toBe('monitoring');
    expect(s.stateApiUrl).toBe('');
    expect(Object.keys(s).sort()).toEqual(['group', 'namespace', 'stateApiUrl', 'version']);
  });
  it('lets stored values win but ignores blanks for required fields', () => {
    const s = resolveSettings({
      group: ' alerts.example.org ',
      namespace: '',
      gitops: true,
    } as any);
    expect(s.group).toBe('alerts.example.org');
    expect(s.namespace).toBe('monitoring');
    expect('gitops' in s).toBe(false);
  });
  it('layers browser overrides over deployment defaults over built-ins', () => {
    const deployment = {
      namespace: 'alerts',
      stateApiUrl: 'service/a/b:80/state',
      group: 'g.example.com',
    };
    const s = resolveSettings({ namespace: 'mine', group: '' }, deployment);
    expect(s.namespace).toBe('mine');
    expect(s.group).toBe('g.example.com');
    expect(s.stateApiUrl).toBe('service/a/b:80/state');
    expect(s.version).toBe('v1alpha1');
  });
  it('lets a stored blank state API URL hide the status page', () => {
    expect(
      resolveSettings({ stateApiUrl: '' }, { stateApiUrl: 'https://x.example.com/s' }).stateApiUrl
    ).toBe('');
  });
  it('ignores malformed deployment defaults', () => {
    expect(resolveSettings(undefined, 'nope' as any)).toEqual(resolveSettings(undefined));
    expect(resolveSettings(undefined, { namespace: 5, other: 'x' } as any).namespace).toBe(
      'monitoring'
    );
  });
});

describe('secret listing fallback', () => {
  it('detects a failed or forbidden listing', () => {
    expect(secretListingFailed(null)).toBe(false);
    expect(secretListingFailed(undefined)).toBe(false);
    expect(secretListingFailed({ status: 403 })).toBe(true);
    expect(secretListingFailed(new Error('boom'))).toBe(true);
  });
});

describe('YAML generation', () => {
  it('generates an email channel', () => {
    const f = {
      ...emptyChannel(),
      name: 'ops-mail',
      emailTo: ['oncall@example.com', 'team@example.com'],
    };
    expect(toYaml(channelResource(f, S))).toBe(
      [
        'apiVersion: alerting.example.com/v1alpha1',
        'kind: NotificationChannel',
        'metadata:',
        '  name: ops-mail',
        '  namespace: monitoring',
        'spec:',
        '  type: email',
        '  enabled: true',
        '  email:',
        '    to:',
        '      - oncall@example.com',
        '      - team@example.com',
        '',
      ].join('\n')
    );
  });

  it('generates an ntfy channel with optional fields only when set', () => {
    const f = { ...emptyChannel(), name: 'phone', type: 'ntfy' as const, ntfyTopic: 'alerts' };
    const plain = channelResource(f, S).spec.ntfy;
    expect(plain).toEqual({ server: 'https://ntfy.example.com', topic: 'alerts' });
    f.ntfyPriority = '4';
    f.ntfyTokenSecret = { name: 'ntfy-auth', key: 'token' };
    expect(channelResource(f, S).spec.ntfy).toEqual({
      server: 'https://ntfy.example.com',
      topic: 'alerts',
      priority: 4,
      tokenSecretRef: { name: 'ntfy-auth', key: 'token' },
    });
  });

  it('generates pushover and webhook channels', () => {
    const p = {
      ...emptyChannel(),
      name: 'push',
      type: 'pushover' as const,
      pushoverUserKeySecret: { name: 'po', key: 'user' },
      pushoverTokenSecret: { name: 'po', key: 'token' },
    };
    expect(channelResource(p, S).spec.pushover.userKeySecretRef).toEqual({
      name: 'po',
      key: 'user',
    });
    const w = {
      ...emptyChannel(),
      name: 'hook',
      type: 'webhook' as const,
      webhookUrl: 'https://hooks.example.com/x',
    };
    expect(channelResource(w, S).spec.webhook).toEqual({ url: 'https://hooks.example.com/x' });
    w.webhookHeadersSecret = { name: 'hdrs', key: 'headers' };
    expect(channelResource(w, S).spec.webhook.headersSecretRef).toEqual({
      name: 'hdrs',
      key: 'headers',
    });
  });

  it('honours configured group, version and namespace', () => {
    const r = channelResource(
      { ...emptyChannel(), name: 'a', emailTo: ['a@example.com'] },
      {
        ...S,
        group: 'alerts.example.org',
        version: 'v1',
        namespace: 'ops',
      }
    );
    expect(r.apiVersion).toBe('alerts.example.org/v1');
    expect(r.metadata.namespace).toBe('ops');
  });

  it('round-trips channel and route resources through the form', () => {
    const f = {
      ...emptyChannel(),
      name: 'phone',
      type: 'ntfy' as const,
      ntfyTopic: 'alerts',
      ntfyPriority: '3',
      enabled: false,
      ntfyTokenSecret: { name: 's', key: 'k' },
    };
    expect(channelFromResource(channelResource(f, S))).toEqual(f);
    const r = {
      ...emptyRoute(),
      name: 'night',
      channels: ['phone'],
      targets: ['web'],
      kinds: ['urgent' as const],
      quietEnabled: true,
      quietAllowUrgent: false,
    };
    expect(routeFromResource(routeResource(r, S))).toEqual(r);
  });

  it('generates a route with quiet hours and omits empty match lists', () => {
    const r = { ...emptyRoute(), name: 'all', channels: ['phone', 'ops-mail'] };
    expect(routeResource(r, S).spec).toEqual({ channels: ['phone', 'ops-mail'], match: {} });
    const q = {
      ...r,
      kinds: ['urgent' as const, 'summary' as const],
      quietEnabled: true,
      quietTimezone: 'Europe/London',
    };
    const yaml = toYaml(routeResource(q, S));
    expect(yaml).toContain('  match:\n    kinds:\n      - urgent\n      - summary\n');
    expect(yaml).toContain('  quietHours:\n    start: "22:00"');
    expect(yaml).toContain('    timezone: Europe/London\n    allowUrgent: true\n');
  });

  it('quotes ambiguous scalars', () => {
    const y = toYaml({ a: 'yes', b: '07:00', c: '', d: 'https://x.example.com', e: 5, f: [] });
    expect(y).toBe('a: "yes"\nb: "07:00"\nc: ""\nd: "https://x.example.com"\ne: 5\nf: []\n');
  });

  it('serialises lists of objects', () => {
    expect(toYaml({ l: [{ a: 1, b: { c: 2 } }, 'x'] })).toBe(
      'l:\n  - a: 1\n    b:\n      c: 2\n  - x\n'
    );
  });
});

describe('manifest file name', () => {
  it('names downloads by kind and resource', () => {
    expect(manifestFileName('NotificationChannel', 'a')).toBe('notificationchannel-a.yaml');
    expect(manifestFileName('AlertRoute', 'r')).toBe('alertroute-r.yaml');
  });
});

describe('validation', () => {
  it('requires fields per type', () => {
    expect(validateChannel(emptyChannel()).length).toBeGreaterThan(1);
    const ok = { ...emptyChannel(), name: 'a', emailTo: ['a@example.com'] };
    expect(validateChannel(ok)).toEqual([]);
    expect(validateChannel({ ...ok, emailTo: ['nope'] })).toHaveLength(1);
    expect(validateChannel({ ...ok, type: 'pushover' })).toHaveLength(2);
    expect(validateChannel({ ...ok, type: 'webhook', webhookUrl: 'ftp://x' })).toHaveLength(1);
    expect(
      validateChannel({
        ...ok,
        type: 'ntfy',
        ntfyTopic: 't',
        ntfyTokenSecret: { name: 's', key: '' },
      })
    ).toHaveLength(1);
  });
  it('validates routes', () => {
    expect(validateRoute(emptyRoute())).toHaveLength(2);
    expect(validateRoute({ ...emptyRoute(), name: 'r', channels: ['a'] })).toEqual([]);
    expect(
      validateRoute({
        ...emptyRoute(),
        name: 'r',
        channels: ['a'],
        quietEnabled: true,
        quietStart: '25:00',
      })
    ).toHaveLength(1);
  });
  it('parses lists', () => {
    expect(parseList('a, b\nb ,, c')).toEqual(['a', 'b', 'c']);
  });
});

describe('test send state', () => {
  const T = '2026-01-02T03:04:05.000Z';
  it('patches the requested annotation under the configured group', () => {
    expect(testRequestPatch(S, new Date(T))).toEqual({
      metadata: { annotations: { 'alerting.example.com/test-requested': T } },
    });
    expect(
      Object.keys(testRequestPatch({ group: 'x.example.org' }, new Date(T)).metadata.annotations)[0]
    ).toBe('x.example.org/test-requested');
  });
  it('is none, then pending, then handled with the status result', () => {
    expect(testState({ metadata: {} }, S).state).toBe('none');
    const cr: any = { metadata: { annotations: { 'alerting.example.com/test-requested': T } } };
    expect(testState(cr, S)).toEqual({ state: 'pending', requested: T });
    cr.metadata.annotations['alerting.example.com/test-handled'] = '2026-01-01T00:00:00Z';
    expect(testState(cr, S).state).toBe('pending');
    cr.metadata.annotations['alerting.example.com/test-handled'] = T;
    cr.status = { lastResult: 'failed', lastError: 'boom', lastSendTime: T };
    expect(testState(cr, S)).toEqual({
      state: 'handled',
      requested: T,
      result: 'failed',
      error: 'boom',
      sentAt: T,
    });
  });
});

describe('endpoint and state API', () => {
  it('proxies service references', () => {
    expect(resolveEndpoint('service/monitoring/alert-state:8080/state')).toEqual({
      url: '/api/v1/namespaces/monitoring/services/alert-state:8080/proxy/state',
      proxied: true,
    });
    expect(resolveEndpoint('service/ns/svc')).toEqual({
      url: '/api/v1/namespaces/ns/services/svc/proxy/',
      proxied: true,
    });
    expect(resolveEndpoint(' https://state.example.com/s ')).toEqual({
      url: 'https://state.example.com/s',
      proxied: false,
    });
  });
  it('parses targets and episodes tolerantly', () => {
    const t = parseState({
      targets: [
        {
          name: 'web',
          state: 'down',
          since: T0(),
          episodes: [{ start: 'a', end: 'b', state: 'down', reason: 'timeout' }],
        },
        { target: 'db' },
      ],
    });
    expect(t[0].episodes[0]).toEqual({ start: 'a', end: 'b', state: 'down', detail: 'timeout' });
    expect(t[1]).toEqual({
      name: 'db',
      state: 'unknown',
      episodes: [],
      kind: undefined,
      since: undefined,
      detail: undefined,
    });
    expect(parseState(null)).toEqual([]);
    expect(stateSeverity('Up')).toBe('success');
    expect(stateSeverity('firing')).toBe('error');
    expect(stateSeverity('flapping')).toBe('warning');
  });
});

describe('backend state shape', () => {
  it('groups top-level episodes by target and exposes routing and channels', () => {
    const p = parseStatePayload({
      generated_at: '2026-01-01T00:10:00Z',
      routing: 'crds',
      channels: [{ name: 'phone', type: 'ntfy' }, 'ops-mail'],
      targets: [
        { target: 'web', state: 'down' },
        { target: 'db', state: 'up' },
      ],
      episodes: [
        {
          id: 1,
          target: 'web',
          started: '2026-01-01T00:00:00Z',
          ended: '2026-01-01T00:05:00Z',
          alerted: true,
          recoverySent: true,
        },
        {
          id: 2,
          target: 'web',
          started: '2026-01-01T00:08:00Z',
          ended: null,
          alerted: true,
          recoverySent: false,
        },
        { id: 3, target: 'other', started: 'x', ended: null },
      ],
    });
    expect(p.routing).toBe('crds');
    expect(p.generatedAt).toBe('2026-01-01T00:10:00Z');
    expect(p.channels).toEqual([{ name: 'phone', detail: 'ntfy' }, { name: 'ops-mail' }]);
    expect(p.targets.map(t => t.name)).toEqual(['web', 'db']);
    expect(p.targets[0].episodes).toHaveLength(2);
    expect(p.targets[0].episodes[0]).toMatchObject({
      start: '2026-01-01T00:08:00Z',
      end: undefined,
    });
    expect(p.targets[0].episodes[1].end).toBe('2026-01-01T00:05:00Z');
    expect(p.targets[1].episodes).toEqual([]);
    expect(parseStatePayload({ routing: 'legacy-alert_to', targets: [] }).routing).toBe(
      'legacy-alert_to'
    );
  });
});

function T0() {
  return '2026-01-01T00:00:00Z';
}
