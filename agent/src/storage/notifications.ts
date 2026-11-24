import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PushService } from '../push/service.js';
import type { Metrics } from '../metrics.js';
import { itemViews, type StorageNotice } from './inventory.js';
import type { StorageQueries, StorageStore } from './store.js';
import { StorageError, type Decision, type DriveState } from './types.js';

const GRANT_MS = 30 * 24 * 60 * 60_000;
const RETRY_MS = 5 * 60_000;
const ATTEMPT_MS = 60_000;
const MAX_ATTEMPTS = 3;
export const subscriptionSchema = z.string().regex(/^[0-9a-f]{32}$/);
const authSchema = z.string().min(22).max(64).regex(/^[A-Za-z0-9_-]+$/);
const pathSchema = z.string().max(220).regex(/^\/(?:[A-Za-z0-9_-][A-Za-z0-9_.~%-]*\/)*incidents\/storage\/drives\/\{driveId\}\/(questions|findings)\/\{id\}$/);
export const enrolSchema = z.object({
  subscriptionId: subscriptionSchema,
  enabled: z.boolean(),
  auth: authSchema.optional(),
  urls: z.object({
    question: pathSchema.refine(path => path.endsWith('/questions/{id}')),
    cleanup: pathSchema.refine(path => path.endsWith('/findings/{id}')),
  }).strict().optional(),
}).strict().refine(body => !body.enabled || Boolean(body.auth && body.urls), 'Enabling needs the device key and both action URLs');

export type NotificationUrls = NonNullable<z.infer<typeof enrolSchema>['urls']>;
export type Registration = { subscriptionId: string; actor: string; grant: string; key: string; urls: NotificationUrls; until: string };
export type Delivery = {
  noticeId: string;
  subscriptionId: string;
  grant: string;
  status: 'pending' | 'sending' | 'accepted' | 'failed';
  attempts: number;
  at: string;
  result?: string;
};
export type CoverageStatus = 'private' | 'disabled' | 'no_recipients' | 'pending' | 'accepted' | 'failed' | 'partial';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const keyOf = (device: { endpoint: string; auth: string; p256dh: string }) => digest(JSON.stringify([device.endpoint, device.auth, device.p256dh]));

export class StorageNotifications {
  private running: Promise<void> | undefined;
  private rerun = false;

  constructor(private readonly deps: { store: StorageStore; push: PushService; now: () => number }) {}

  private get enabled() {
    return this.deps.push.enabled;
  }

  async enrol(request: z.infer<typeof enrolSchema>, actor: string) {
    const { store, push, now } = this.deps;
    const { subscriptionId, enabled, auth, urls } = request;
    const device = enabled && await push.storageDevice(subscriptionId);
    await store.transaction(async tx => {
      await tx.lock(`recipient:${subscriptionId}`);
      const previous = await tx.registration(subscriptionId);
      if (!enabled) {
        if (previous?.actor === actor) await tx.removeRegistration(subscriptionId);
        return;
      }
      if (!this.enabled) throw new StorageError(503, 'Storage notifications are disabled');
      if (!device || !auth || !urls || !timingSafeEqual(Buffer.from(digest(device.auth)), Buffer.from(digest(auth)))) {
        throw new StorageError(403, 'Device subscription could not be verified');
      }
      const key = keyOf(device);
      const sameDevice = previous?.key === key && Date.parse(previous.until) > now();
      if (sameDevice && previous.actor !== actor) throw new StorageError(409, 'Device already has an operator enrolment');
      await tx.saveRegistration({
        subscriptionId, actor, grant: sameDevice ? previous.grant : randomUUID(),
        key, urls, until: new Date(now() + GRANT_MS).toISOString(),
      });
    });
    if (enabled) this.kick();
    return { subscriptionId, enabled };
  }

  async device(subscriptionId: string, actor: string) {
    const current = await this.deps.store.registration(subscriptionId);
    const device = current?.actor === actor && await this.deps.push.storageDevice(subscriptionId);
    return {
      subscriptionId,
      enabled: Boolean(this.enabled && device && current && current.key === keyOf(device) && Date.parse(current.until) > this.deps.now()),
    };
  }

  private async recipients(tx: StorageQueries): Promise<Registration[]> {
    const now = this.deps.now();
    const candidates = await tx.registrations(now);
    const devices = await this.deps.push.storageDevices();
    const keys = new Map(devices.map(device => [device.id, keyOf(device)]));
    return candidates.filter(row => keys.get(row.subscriptionId) === row.key);
  }

  async coverage() {
    return { enabled: this.enabled, registeredRecipients: this.enabled ? (await this.recipients(this.deps.store)).length : 0 };
  }

  async project(notices: StorageNotice[], chatId: string) {
    const { store } = this.deps;
    const deliveryById = new Map((await store.deliverySummaries(notices.map(notice => notice.id))).map(row => [row.id, row]));
    return notices.map(({ external, externalItemId: _externalItemId, critical: _critical, ...notice }) => {
      const totals = deliveryById.get(notice.id);
      const providerAccepted = totals?.accepted ?? 0;
      const failed = totals?.failed ?? 0;
      const pending = totals?.pending ?? 0;
      const targetedRecipients = providerAccepted + failed + pending;
      const status: CoverageStatus = !external ? 'private' : !this.enabled ? 'disabled'
        : pending ? 'pending' : providerAccepted && failed ? 'partial' : providerAccepted ? 'accepted'
          : failed ? 'failed' : totals?.evaluated ? 'no_recipients' : 'pending';
      return {
        ...notice,
        action: { driveId: notice.driveId, kind: notice.kind, id: notice.questionId ?? notice.id, chatId },
        delivery: { status, targetedRecipients, providerAccepted, failed, pending, clientReceived: null },
      };
    });
  }

  kick(): void {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = this.deliver().catch(() => undefined).finally(() => {
      this.running = undefined;
      if (this.rerun) {
        this.rerun = false;
        this.kick();
      }
    });
  }

  async drain(): Promise<void> {
    while (this.running) await this.running;
  }

  private async deliver(): Promise<void> {
    const { store, now } = this.deps;
    const at = now();
    const recipients = this.enabled ? await this.recipients(store) : [];
    await store.transaction(async tx => {
      await tx.lock('notification-coverage');
      const noticeRows = await tx.unresolvedCoverage(recipients.length > 0);
      for (const notice of noticeRows) {
        const status = !notice.external ? 'private' : !this.enabled ? 'disabled' : !recipients.length ? 'no_recipients' : 'pending';
        await tx.evaluateNotice(notice.id, status, at);
        if (status === 'pending') await tx.addTargets(notice.id, recipients, at);
      }
      await tx.expireAttempts(at - ATTEMPT_MS);
    });
    if (!this.enabled) return;
    const deliveries = await store.dueDeliveries(at);
    await Promise.allSettled(deliveries.map(delivery => this.send(delivery)));
  }

  private async send(old: Delivery): Promise<void> {
    const { store, push, now } = this.deps;
    const at = now();
    const attempt = await store.claimDelivery(old, at);
    if (!attempt) return;
    let status: Delivery['status'] = 'failed';
    let result = 'authorisation_or_notice_withdrawn';
    let next = at;
    try {
      const [notice, registration, device] = await Promise.all([
        store.get<StorageNotice>('notice', attempt.noticeId), store.registration(attempt.subscriptionId),
        push.storageDevice(attempt.subscriptionId),
      ]);
      if (notice?.external && registration?.grant === attempt.grant && Date.parse(registration.until) > at && device && registration.key === keyOf(device)) {
        const current = await store.drive(notice.driveId);
        const decisions = notice.kind === 'cleanup' ? await store.list<Decision>('decision', notice.driveId) : [];
        if (!current || !this.externalStillAllowed(current, notice, decisions, at)) {
          await store.finishDelivery(attempt, status, result, next);
          return;
        }
        const id = notice.questionId ?? notice.id;
        const url = registration.urls[notice.kind].replace('{driveId}', notice.driveId).replace('{id}', id);
        const provider = await push.sendStorageNotice(device, {
          kind: 'storage',
          title: notice.kind === 'question' ? 'Storage incident question' : 'Storage cleanup available',
          body: notice.kind === 'question' ? 'Open the incident to answer the question.' : 'Open the incident to review the cleanup finding.',
          url,
          tag: `storage-${id}`,
        }, digest(id).slice(0, 30));
        result = provider.outcome === 'http' ? String(provider.status) : provider.outcome;
        if (provider.outcome === 'http' && provider.status >= 200 && provider.status < 300) status = 'accepted';
        if (attempt.attempts < MAX_ATTEMPTS && (provider.outcome === 'rate_limited'
            || (provider.outcome === 'http' && (provider.status === 429 || provider.status >= 500)))) {
          status = 'pending';
          next = now() + RETRY_MS * attempt.attempts;
        }
      }
    } catch {
      result = 'delivery_unverified';
    }
    await store.finishDelivery(attempt, status, result, next);
  }

  private externalStillAllowed(state: DriveState, notice: StorageNotice, decisions: Decision[], now: number): boolean {
    if (!state.current.complete) return false;
    if (notice.kind === 'question') return state.items.some(item => item.visibility === 'jev' && item.id === notice.externalItemId);
    const eligible = new Set(itemViews(state, decisions, now).filter(item => item.eligible).map(item => item.id));
    return state.items.some(item => item.visibility === 'jev' && eligible.has(item.id));
  }

  async metrics(metrics: Metrics) {
    const { registeredRecipients } = await this.coverage();
    metrics.set('headlamp_agent_storage_push_registered_recipients', {}, registeredRecipients);
    const views = await this.project(await this.deps.store.list<StorageNotice>('notice'), '');
    const statusCounts = new Map<CoverageStatus, number>();
    for (const view of views) statusCounts.set(view.delivery.status, (statusCounts.get(view.delivery.status) ?? 0) + 1);
    for (const status of ['private', 'disabled', 'no_recipients', 'pending', 'accepted', 'failed', 'partial'] as const) {
      metrics.set('headlamp_agent_storage_push_notices', { status }, statusCounts.get(status) ?? 0);
    }
    const totals = await this.deps.store.deliveryCounts();
    for (const status of ['pending', 'sending', 'accepted', 'failed']) {
      metrics.set('headlamp_agent_storage_push_deliveries', { status }, totals.get(status) ?? 0);
    }
  }
}
