import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUSH_SETTINGS,
  deviceLabel,
  ID_MARK,
  parseConfig,
  parseSettings,
  parseView,
  presenceChat,
  pushSupport,
  subscriptionId,
  template,
  urlBase64ToBytes,
} from './push-model';

describe('push model', () => {
  it('computes the same subscription id as the agent', async () => {
    // The agent test computes the same value with node:crypto: sha256 of the endpoint, first 32 hex digits.
    expect(await subscriptionId('https://fcm.googleapis.com/fcm/send/test-one')).toBe(
      'a4d364375df9521b3855dae1e643eb8b'
    );
  });

  it('reads settings with defaults and keeps severities in a fixed order', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_PUSH_SETTINGS);
    expect(parseSettings({ chat: false, severities: ['other', 'critical', 'bogus'] })).toEqual({
      diagnosis: true,
      chat: false,
      severities: ['critical', 'other'],
    });
    expect(parseSettings({ severities: [] }).severities).toEqual([]);
  });

  it('reads the view of a device, without keys', () => {
    expect(parseView({ id: 'x', label: 'Phone', settings: { diagnosis: false }, lastSentAt: null })).toEqual({
      id: 'x',
      label: 'Phone',
      settings: { diagnosis: false, chat: true, severities: ['warning', 'critical'] },
      lastSentAt: null,
      lastResult: null,
    });
    expect(parseView({})).toBeNull();
  });

  it('treats a config without a key as off', () => {
    expect(parseConfig({ enabled: true, publicKey: 'abc' })).toEqual({ enabled: true, publicKey: 'abc' });
    expect(parseConfig({ enabled: true, publicKey: null }).enabled).toBe(false);
    expect(parseConfig({ enabled: false, publicKey: null })).toEqual({ enabled: false, publicKey: null });
  });

  it('decodes a VAPID key', () => {
    expect(Array.from(urlBase64ToBytes('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToBytes('-_8'))).toEqual([251, 255]);
  });

  it('asks an iPhone to install the app first', () => {
    const base = { ua: 'x', standalone: false, hasServiceWorker: true, hasPushManager: true, hasNotification: true };
    expect(pushSupport(base)).toBe('ok');
    expect(pushSupport({ ...base, hasPushManager: false })).toBe('unsupported');
    expect(pushSupport({ ...base, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', hasPushManager: false })).toBe('needs-install');
    expect(pushSupport({ ...base, ua: 'Mozilla/5.0 (iPhone)', standalone: true })).toBe('ok');
  });

  it('labels a device', () => {
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36')).toBe('Chrome on Linux');
  });

  it('reports a chat only while the page is visible', () => {
    expect(presenceChat('visible', 'c1')).toBe('c1');
    expect(presenceChat('hidden', 'c1')).toBeNull();
    expect(presenceChat('visible', undefined)).toBeNull();
  });

  it('makes a template from a built path', () => {
    expect(template(`/c/main/incidents/${ID_MARK}`)).toBe('/c/main/incidents/{id}');
  });
});
