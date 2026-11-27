import { maskText } from '../mask.js';
import type { Diagnosis } from '../agent/report.js';
import { DEFAULT_PUSH_SETTINGS, SEVERITY_GROUPS, type PushSettings, type PushStore, type PushSubscriptionRecord, type PushUrls, type SeverityGroup } from './store.js';
import { endpointAllowed, fromB64url, sendWebPush, subscriptionId, validPublicKey, vapidKeysMatch, type SendResult, type VapidKeys } from './webpush.js';

/** An error with the HTTP status the route answers. */
export class PushError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** How long a page that reported itself visible keeps "watching" without a new report. A hidden page clears it at once. */
export const PRESENCE_MS = 75_000;
const MAX_SUBSCRIPTIONS = 50;
const BODY_CHARS = 140;
const TITLE_CHARS = 100;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export interface PushDeps {
  store: PushStore;
  /** Without keys the service is off: it answers `enabled: false` and sends nothing. */
  keys?: VapidKeys;
  /** Extra exact push-service host names (tests). */
  extraHosts?: string[];
  fetch?: typeof fetch;
  now?: () => number;
  log?: (level: 'info' | 'warn', message: string, extra?: Record<string, unknown>) => void;
  /** Pushes one device may get in `windowMs`. More are dropped. */
  maxPerWindow?: number;
  windowMs?: number;
}

export function severityGroup(severity: string): SeverityGroup {
  const s = severity.toLowerCase();
  return s === 'critical' || s === 'warning' ? s : 'other';
}

/** Does this device want a push for a diagnosis of this severity? */
export function wantsDiagnosis(settings: PushSettings, severity: string): boolean {
  return settings.diagnosis && settings.severities.includes(severityGroup(severity));
}

/**
 * Does this device want a push for the answer in `chatId`? Only when the chat switch is on and the page is not
 * showing that chat now. A page shows a chat while it is visible and reports it before `watchingUntil`.
 */
export function wantsChatAnswer(record: Pick<PushSubscriptionRecord, 'settings' | 'watchingChat' | 'watchingUntil'>, chatId: string, nowMs: number): boolean {
  if (!record.settings.chat) return false;
  const watching = record.watchingChat === chatId && record.watchingUntil !== undefined && Date.parse(record.watchingUntil) > nowMs;
  return !watching;
}

/** Parses settings from a request. A missing field keeps `base`. Throws a 400 on a wrong value. */
export function parseSettings(raw: unknown, base: PushSettings = DEFAULT_PUSH_SETTINGS): PushSettings {
  if (raw === undefined) return { ...base, severities: [...base.severities] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PushError(400, 'settings must be an object');
  const r = raw as Record<string, unknown>;
  const out: PushSettings = { ...base, severities: [...base.severities] };
  for (const key of ['diagnosis', 'chat'] as const) {
    if (r[key] === undefined) continue;
    if (typeof r[key] !== 'boolean') throw new PushError(400, `settings.${key} must be true or false`);
    out[key] = r[key] as boolean;
  }
  if (r.severities !== undefined) {
    if (!Array.isArray(r.severities) || r.severities.some(s => !SEVERITY_GROUPS.includes(s as SeverityGroup))) throw new PushError(400, `settings.severities must list ${SEVERITY_GROUPS.join(', ')}`);
    out.severities = SEVERITY_GROUPS.filter(g => (r.severities as string[]).includes(g));
  }
  return out;
}

/** A path template: it starts with one slash, holds only path characters, and has `{id}` once. */
function parseTemplate(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 200 || !/^\/(?!\/)[A-Za-z0-9/_\-.~%]*\{id\}[A-Za-z0-9/_\-.~%]*$/.test(value) || value.split('{id}').length !== 2) {
    throw new PushError(400, `urls.${name} must be a path that holds {id} once`);
  }
  return value;
}

export function parseUrls(raw: unknown): PushUrls {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PushError(400, 'urls must be an object');
  const r = raw as Record<string, unknown>;
  return { incident: parseTemplate(r.incident, 'incident'), chat: parseTemplate(r.chat, 'chat') };
}

/** One line of plain text: Markdown marks removed, white space collapsed, cut at `max` characters. */
export function brief(text: string, max = BODY_CHARS): string {
  const plain = maskText(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 3).trimEnd()}...` : plain;
}

/** What the page may see of a subscription. Keys never leave the store. */
export function publicView(r: PushSubscriptionRecord) {
  return { id: r.id, label: r.label, settings: r.settings, createdAt: r.createdAt, updatedAt: r.updatedAt, lastSentAt: r.lastSentAt ?? null, lastResult: r.lastResult ?? null };
}

export class PushService {
  private readonly now: () => number;
  private readonly sent = new Map<string, number[]>();
  private readonly storageSent = new Map<string, number[]>();
  private readonly keys?: VapidKeys;
  private readonly maxPerWindow: number;
  private readonly windowMs: number;

  constructor(private readonly deps: PushDeps) {
    this.now = deps.now ?? Date.now;
    this.maxPerWindow = deps.maxPerWindow ?? 10;
    this.windowMs = deps.windowMs ?? 10 * 60_000;
    if (deps.keys && vapidKeysMatch(deps.keys)) this.keys = deps.keys;
    else if (deps.keys) this.log('warn', 'push is off: the VAPID private key does not match the public key');
  }

  private log(level: 'info' | 'warn', message: string, extra?: Record<string, unknown>): void {
    this.deps.log?.(level, message, extra);
  }

  get enabled(): boolean {
    return Boolean(this.keys);
  }

  publicConfig(): { enabled: boolean; publicKey: string | null } {
    return { enabled: this.enabled, publicKey: this.keys?.publicKey ?? null };
  }

  private requireEnabled(): void {
    if (!this.enabled) throw new PushError(503, 'Push notifications are not set up on this agent');
  }

  private checkId(id: string): void {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new PushError(404, 'not found');
  }

  async get(id: string): Promise<ReturnType<typeof publicView>> {
    this.checkId(id);
    const r = await this.deps.store.get(id);
    if (!r) throw new PushError(404, 'not found');
    return publicView(r);
  }

  /** Creates or replaces the subscription of one device. A re-subscribe keeps the history of sends. */
  async subscribe(id: string, body: unknown): Promise<ReturnType<typeof publicView>> {
    this.requireEnabled();
    this.checkId(id);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PushError(400, 'The body must be an object');
    const b = body as Record<string, unknown>;
    const sub = b.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
    const endpoint = sub?.endpoint;
    const p256dh = sub?.keys?.p256dh;
    const auth = sub?.keys?.auth;
    if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') throw new PushError(400, 'subscription needs endpoint, keys.p256dh and keys.auth');
    if (endpoint.length > 1000 || subscriptionId(endpoint) !== id) throw new PushError(400, 'The id does not match the endpoint');
    if (!endpointAllowed(endpoint, this.deps.extraHosts)) throw new PushError(400, 'The endpoint is not a known push service');
    if (!validPublicKey(p256dh) || fromB64url(auth).length < 16 || auth.length > 64) throw new PushError(400, 'The subscription keys are not valid');
    const existing = await this.deps.store.get(id);
    if (!existing && (await this.deps.store.list()).length >= MAX_SUBSCRIPTIONS) throw new PushError(429, 'Too many devices are subscribed');
    const label = typeof b.label === 'string' ? maskText(b.label).replace(/\s+/g, ' ').trim().slice(0, 80) : (existing?.label ?? '');
    const at = new Date(this.now()).toISOString();
    const record: PushSubscriptionRecord = {
      id,
      endpoint,
      p256dh,
      auth,
      label,
      settings: parseSettings(b.settings, existing?.settings ?? DEFAULT_PUSH_SETTINGS),
      urls: parseUrls(b.urls),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    await this.deps.store.upsert(record);
    return publicView((await this.deps.store.get(id)) ?? record);
  }

  /** Changes the switches, the severity filter or the label of a device. */
  async update(id: string, body: unknown): Promise<ReturnType<typeof publicView>> {
    this.checkId(id);
    const r = await this.deps.store.get(id);
    if (!r) throw new PushError(404, 'not found');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PushError(400, 'The body must be an object');
    const b = body as Record<string, unknown>;
    const next: PushSubscriptionRecord = {
      ...r,
      settings: parseSettings(b.settings, r.settings),
      urls: b.urls === undefined ? r.urls : parseUrls(b.urls),
      label: typeof b.label === 'string' ? maskText(b.label).replace(/\s+/g, ' ').trim().slice(0, 80) : r.label,
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.deps.store.upsert(next);
    return publicView(next);
  }

  async unsubscribe(id: string): Promise<void> {
    this.checkId(id);
    await this.deps.store.delete(id);
    this.sent.delete(id);
    this.storageSent.delete(id);
  }

  /** The page reports the chat it shows (visible), or null (hidden or left the chat). */
  async presence(id: string, chatId: unknown): Promise<void> {
    this.checkId(id);
    if (chatId !== null && (typeof chatId !== 'string' || !ID_PATTERN.test(chatId))) throw new PushError(400, 'chatId must be a chat id or null');
    if (!(await this.deps.store.setPresence(id, chatId as string | null, this.now() + PRESENCE_MS))) throw new PushError(404, 'not found');
  }

  /** A diagnosis reached `done`: push to every device that wants this severity. Never throws. */
  async notifyDiagnosis(d: Diagnosis): Promise<number> {
    if (!this.enabled || d.status !== 'done') return 0;
    try {
      const title = brief(`Diagnosis ready: ${d.alert.name} (${d.alert.severity || 'no severity'})`, TITLE_CHARS);
      const body = brief(d.result?.likelyCause ?? d.result?.summary ?? 'Open the incident to read the diagnosis.');
      let sent = 0;
      for (const r of await this.deps.store.list()) {
        if (!wantsDiagnosis(r.settings, d.alert.severity)) continue;
        if (await this.send(r, { kind: 'diagnosis', title, body, tag: `diagnosis-${d.id}`, url: r.urls.incident.replace('{id}', encodeURIComponent(d.id)) })) sent++;
      }
      return sent;
    } catch (error) {
      this.log('warn', 'diagnosis push failed', { id: d.id, error: String(error) });
      return 0;
    }
  }

  /**
   * An incident opened and no investigation started, because the setting "Automatic investigations" is off.
   * It reaches the same devices as a ready diagnosis, so the incident is not missed. Never throws.
   */
  async notifyIncident(d: Diagnosis): Promise<number> {
    if (!this.enabled || d.status !== 'skipped') return 0;
    try {
      const title = brief(`Incident opened: ${d.alert.name} (${d.alert.severity || 'no severity'})`, TITLE_CHARS);
      const body = brief(d.alert.annotations.summary || d.alert.annotations.description || 'Automatic investigations are off. Open the incident to start one.');
      let sent = 0;
      for (const r of await this.deps.store.list()) {
        if (!wantsDiagnosis(r.settings, d.alert.severity)) continue;
        if (await this.send(r, { kind: 'diagnosis', title, body, tag: `incident-${d.id}`, url: r.urls.incident.replace('{id}', encodeURIComponent(d.id)) })) sent++;
      }
      return sent;
    } catch (error) {
      this.log('warn', 'incident push failed', { id: d.id, error: String(error) });
      return 0;
    }
  }

  /** The agent finished a chat answer for the device `subscription`. Never throws. */
  async notifyChatAnswer(subscription: string, chatId: string, answer: string): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const r = await this.deps.store.get(subscription);
      if (!r || !wantsChatAnswer(r, chatId, this.now())) return false;
      return await this.send(r, { kind: 'chat', title: 'Incident chat', body: brief(answer), tag: `chat-${chatId}`, url: r.urls.chat.replace('{id}', encodeURIComponent(chatId)) });
    } catch (error) {
      this.log('warn', 'chat push failed', { chat: chatId, error: String(error) });
      return false;
    }
  }

  storageDevice(id: string): Promise<PushSubscriptionRecord | undefined> {
    return this.deps.store.get(id);
  }

  storageDevices(): Promise<PushSubscriptionRecord[]> {
    return this.deps.store.list();
  }

  /** Send an unsolicited storage notice independently of chat state. */
  async sendStorageNotice(r: Pick<PushSubscriptionRecord, 'id' | 'endpoint' | 'auth' | 'p256dh'>, payload: Record<string, unknown>, topic: string): Promise<
    { outcome: 'http'; status: number } | { outcome: 'disabled' | 'rate_limited' | 'delivery_unverified' }
  > {
    if (!this.keys) return { outcome: 'disabled' };
    if (!endpointAllowed(r.endpoint, this.deps.extraHosts)) return { outcome: 'delivery_unverified' };
    if (!this.allow(r.id, this.storageSent)) return { outcome: 'rate_limited' };
    try {
      const result = await sendWebPush(r, payload, this.keys, { fetch: this.deps.fetch, now: this.now(), topic });
      return { outcome: 'http', status: result.status };
    } catch {
      return { outcome: 'delivery_unverified' };
    }
  }

  /** The device is inside its rate limit: counts this push when it is. */
  private allow(id: string, sent = this.sent): boolean {
    const t = this.now();
    const recent = (sent.get(id) ?? []).filter(at => t - at < this.windowMs);
    if (recent.length >= this.maxPerWindow) {
      sent.set(id, recent);
      return false;
    }
    recent.push(t);
    sent.set(id, recent);
    return true;
  }

  /** Sends once. No retry. A 404 or 410 deletes the subscription. True when the push service accepted the message. */
  private async send(r: PushSubscriptionRecord, payload: Record<string, unknown>): Promise<boolean> {
    if (!this.keys) return false;
    if (!this.allow(r.id)) {
      this.log('warn', 'push dropped: rate limit', { subscription: r.id });
      return false;
    }
    let result: SendResult;
    try {
      result = await sendWebPush(r, payload, this.keys, { fetch: this.deps.fetch, now: this.now() });
    } catch (error) {
      await this.deps.store.recordResult(r.id, this.now(), 'error').catch(() => undefined);
      this.log('warn', 'push failed', { subscription: r.id, kind: payload.kind, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
    if (result.gone) {
      await this.deps.store.delete(r.id).catch(() => undefined);
      this.sent.delete(r.id);
      this.log('info', 'push subscription removed: the push service says it is gone', { subscription: r.id, status: result.status });
      return false;
    }
    const ok = result.status >= 200 && result.status < 300;
    await this.deps.store.recordResult(r.id, this.now(), ok ? 'ok' : String(result.status)).catch(() => undefined);
    this.log(ok ? 'info' : 'warn', ok ? 'push sent' : 'push refused', { subscription: r.id, kind: payload.kind, tag: payload.tag, status: result.status });
    return ok;
  }
}
