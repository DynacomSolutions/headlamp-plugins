/*
 * Pure parts of the incident notifications: the settings of one device, the id of a subscription,
 * what the browser can do. The browser and network parts are in push.ts and push-data.ts.
 */

export const WORKER_URL = '/plugins/incidents/sw.js';
export const WORKER_SCOPE = '/plugins/incidents/';

export type SeverityGroup = 'critical' | 'warning' | 'other';

export const SEVERITY_OPTIONS: { value: SeverityGroup; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'other', label: 'Other (info and no severity)' },
];

export interface PushSettings {
  /** Notify when a diagnosis is ready. */
  diagnosis: boolean;
  /** Notify when the agent answers a chat question and this page is not visible. */
  chat: boolean;
  /** Only diagnoses of these severities notify. */
  severities: SeverityGroup[];
}

export const DEFAULT_PUSH_SETTINGS: PushSettings = {
  diagnosis: true,
  chat: true,
  severities: ['warning', 'critical'],
};

/** What the agent says about this device. The keys never come back. */
export interface PushView {
  id: string;
  label: string;
  settings: PushSettings;
  lastSentAt: string | null;
  lastResult: string | null;
}

export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

export function parseSettings(json: unknown): PushSettings {
  const r = rec(json);
  const severities = Array.isArray(r.severities)
    ? SEVERITY_OPTIONS.map(o => o.value).filter(v => (r.severities as unknown[]).includes(v))
    : DEFAULT_PUSH_SETTINGS.severities;
  return {
    diagnosis: typeof r.diagnosis === 'boolean' ? r.diagnosis : DEFAULT_PUSH_SETTINGS.diagnosis,
    chat: typeof r.chat === 'boolean' ? r.chat : DEFAULT_PUSH_SETTINGS.chat,
    severities,
  };
}

export function parseView(json: unknown): PushView | null {
  const r = rec(json);
  if (typeof r.id !== 'string' || !r.id) return null;
  return {
    id: r.id,
    label: typeof r.label === 'string' ? r.label : '',
    settings: parseSettings(r.settings),
    lastSentAt: typeof r.lastSentAt === 'string' ? r.lastSentAt : null,
    lastResult: typeof r.lastResult === 'string' ? r.lastResult : null,
  };
}

export function parseConfig(json: unknown): PushConfig {
  const r = rec(json);
  const key = typeof r.publicKey === 'string' && r.publicKey ? r.publicKey : null;
  return { enabled: r.enabled === true && key !== null, publicKey: key };
}

/** The same id the agent computes: the first 32 hex digits of the SHA-256 of the endpoint. */
export async function subscriptionId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/** Decodes a base64url VAPID public key into the bytes pushManager.subscribe expects. */
export function urlBase64ToBytes(value: string): Uint8Array {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function bytesToUrlBase64(buf: ArrayBuffer | null | undefined): string {
  if (!buf) return '';
  let bin = '';
  new Uint8Array(buf).forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface DeviceSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Reads the endpoint and keys out of a browser PushSubscription. */
export function subscriptionParts(sub: {
  endpoint: string;
  getKey: (name: 'p256dh' | 'auth') => ArrayBuffer | null;
}): DeviceSubscription {
  return {
    endpoint: sub.endpoint,
    keys: {
      p256dh: bytesToUrlBase64(sub.getKey('p256dh')),
      auth: bytesToUrlBase64(sub.getKey('auth')),
    },
  };
}

/** Short human label such as "Chrome on Linux" from a user agent string. */
export function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
    ? 'Opera'
    : /Firefox\//.test(ua)
    ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua)
    ? 'Chrome'
    : /Safari\//.test(ua)
    ? 'Safari'
    : 'Browser';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
    ? 'Android'
    : /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua)
    ? 'macOS'
    : /CrOS/.test(ua)
    ? 'ChromeOS'
    : /Linux/.test(ua)
    ? 'Linux'
    : 'unknown OS';
  return `${browser} on ${os}`;
}

export type PushSupport = 'ok' | 'needs-install' | 'unsupported';

/**
 * iOS and iPadOS only deliver web push to a web app added to the Home Screen,
 * and expose PushManager only in that mode, so a missing PushManager on iOS
 * means "install first" rather than "unsupported".
 */
export function pushSupport(env: {
  ua: string;
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
}): PushSupport {
  const ios = /iPhone|iPad|iPod/.test(env.ua);
  if (ios && !env.standalone) return 'needs-install';
  if (env.hasServiceWorker && env.hasPushManager && env.hasNotification) return 'ok';
  return 'unsupported';
}

/** The chat a device reports to the agent: the open chat while the page is visible, else none. */
export function presenceChat(visibility: string, chatId: string | undefined): string | null {
  return chatId && visibility === 'visible' ? chatId : null;
}

/** Placeholder the path builders use for an id. It becomes `{id}` in the templates the agent stores. */
export const ID_MARK = 'ID-MARK';

/** Turns `/c/main/incidents/ID-MARK` into `/c/main/incidents/{id}`. */
export function template(path: string): string {
  return path.replace(ID_MARK, '{id}');
}
