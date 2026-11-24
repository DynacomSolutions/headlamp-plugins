import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PushService } from '../push/service.js';
import type { Metrics } from '../metrics.js';
import type { KubernetesIdentity, Operator } from './auth.js';
import { recipientKey, type Entitlement, type NotificationAuthority, type Recipient } from './notification-authority.js';
import { itemViews, pressureStage, scanIsFresh, type StorageNotice } from './inventory.js';
import type { StorageStore } from './store.js';
import { StorageError, type Decision, type DriveState } from './types.js';

const GRANT_MS = 30 * 24 * 60 * 60_000;
const POLL_MS = 30_000;
const AUTHORITY_RETRY_MS = 60_000;
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
type RecipientGrant = { recipient: Recipient; version: string };
export type Registration = { subscriptionId: string; grant: string; key: string; urls: NotificationUrls; until: string; entitlement?: RecipientGrant };
export type Delivery = {
  noticeId: string;
  subscriptionId: string;
  grant: string;
  status: 'pending' | 'sending' | 'accepted' | 'failed';
  attempts: number;
  at: string;
  result?: string;
};
const coverageStatuses = ['private', 'disabled', 'authority_unavailable', 'no_recipients', 'revoked', 'pending', 'accepted', 'failed', 'partial'] as const;
export type CoverageStatus = typeof coverageStatuses[number];

const authorityStatuses = ['disabled', 'ready', 'unavailable'] as const;
type AuthorityStatus = typeof authorityStatuses[number];
type Coverage = { enabled: boolean; status: AuthorityStatus; registeredRecipients: number | null; revokedRecipients: number | null };
type Recipients =
  | { status: 'disabled' | 'unavailable' }
  | { status: 'ready'; eligible: Registration[]; revoked: number };

export const disabledCoverage: Coverage = { enabled: false, status: 'disabled', registeredRecipients: null, revokedRecipients: null };

export function coverageMetrics(metrics: Metrics, coverage: Coverage) {
  for (const status of authorityStatuses) {
    metrics.set('headlamp_agent_storage_push_authority', { status }, Number(coverage.status === status));
  }
  metrics.set('headlamp_agent_storage_push_registered_recipients', {}, coverage.registeredRecipients ?? NaN);
  metrics.set('headlamp_agent_storage_push_revoked_recipients', {}, coverage.revokedRecipients ?? NaN);
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const keyOf = (device: { endpoint: string; auth: string; p256dh: string }) => digest(JSON.stringify([device.endpoint, device.auth, device.p256dh]));
const ownsDevice = (device: { auth: string }, proof: string) =>
  timingSafeEqual(Buffer.from(digest(device.auth)), Buffer.from(digest(proof)));
const matches = (grant: RecipientGrant, decision: Entitlement | undefined) =>
  decision?.status === 'allowed' && grant.version === decision.version;

export class StorageNotifications {
  private running: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private rerun = false;
  private stopping = false;

  constructor(private readonly deps: {
    store: StorageStore;
    push: PushService;
    now: () => number;
    authority?: NotificationAuthority;
  }) {}

  private get enabled() {
    return this.deps.push.enabled && Boolean(this.deps.authority);
  }

  start(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => this.kick(), POLL_MS).unref();
    this.kick();
  }

  async enrol(request: z.infer<typeof enrolSchema>, operator: Operator) {
    const { store, now, authority } = this.deps;
    const { subscriptionId, enabled, auth, urls } = request;
    if (!enabled) {
      await store.transaction(async tx => {
        await tx.lock(`recipient:${subscriptionId}`);
        const previous = await tx.registration(subscriptionId);
        if (!previous) return;
        const device = await tx.notificationDevice(subscriptionId);
        if (device && auth && ownsDevice(device, auth)) {
          await tx.removeRegistration(subscriptionId);
          return;
        }
        // Previous clients can opt out using the mapped identity.
        if (!previous.entitlement || auth) throw new StorageError(403, 'Device subscription could not be verified');
        const resolved = await authority?.resolve(operator.identity);
        if (!resolved) throw new StorageError(503, 'Storage notification authority is unavailable');
        if (resolved.recipient && recipientKey(resolved.recipient) === recipientKey(previous.entitlement.recipient)) {
          await tx.removeRegistration(subscriptionId);
        }
      });
      return { subscriptionId, enabled };
    }

    if (!this.enabled || !authority) throw new StorageError(503, 'Storage notification authority is unavailable');
    await operator.requireRead();
    await store.transaction(async tx => {
      await tx.lock(`recipient:${subscriptionId}`);
      const device = await tx.notificationDevice(subscriptionId);
      if (!device || !auth || !urls || !ownsDevice(device, auth)) {
        throw new StorageError(403, 'Device subscription could not be verified');
      }
      const resolved = await authority.resolve(operator.identity);
      if (!resolved) throw new StorageError(503, 'Storage notification authority is unavailable');
      if (resolved.entitlement.status !== 'allowed' || !resolved.recipient) {
        throw new StorageError(403, 'Current storage notification entitlement is required');
      }

      const entitlement = { recipient: resolved.recipient, version: resolved.entitlement.version };
      const previous = await tx.registration(subscriptionId);
      const key = keyOf(device);
      const at = now();
      const sameDevice = previous?.key === key && Date.parse(previous.until) > at;
      const existing = sameDevice ? previous.entitlement : undefined;
      if (existing && recipientKey(existing.recipient) !== recipientKey(entitlement.recipient)) {
        throw new StorageError(409, 'Device already has an operator enrolment');
      }
      const grant = previous && existing?.version === entitlement.version ? previous.grant : randomUUID();
      await tx.saveRegistration({ subscriptionId, grant, key, urls, entitlement, until: new Date(at + GRANT_MS).toISOString() });
    });
    this.kick();
    return { subscriptionId, enabled };
  }

  async device(subscriptionId: string, identity: KubernetesIdentity) {
    const { store, push, authority, now } = this.deps;
    const disabled = { subscriptionId, enabled: false };
    if (!this.enabled || !authority) return disabled;
    const current = await store.registration(subscriptionId);
    if (!current?.entitlement || Date.parse(current.until) <= now()) return disabled;
    const device = await push.storageDevice(subscriptionId);
    if (!device || current.key !== keyOf(device)) return disabled;
    const resolved = await authority.resolve(identity);
    if (!resolved) throw new StorageError(503, 'Storage notification authority is unavailable');
    return {
      subscriptionId,
      enabled: Boolean(resolved.recipient
        && recipientKey(resolved.recipient) === recipientKey(current.entitlement.recipient)
        && matches(current.entitlement, resolved.entitlement)),
    };
  }

  private async recipients(): Promise<Recipients> {
    const { store, push, authority, now } = this.deps;
    if (!this.enabled || !authority) return { status: 'disabled' };
    const [grants, devices] = await Promise.all([store.registrations(now()), push.storageDevices()]);
    const keys = new Map(devices.map(device => [device.id, keyOf(device)]));
    const candidates = grants.flatMap(row => row.entitlement && keys.get(row.subscriptionId) === row.key
      ? [{ row, entitlement: row.entitlement }] : []);
    const identities = [...new Map(candidates.map(({ entitlement: { recipient } }) => [recipientKey(recipient), recipient])).values()];
    const checks = [];
    for (let i = 0; i < Math.max(1, identities.length); i += 50) checks.push(authority.check(identities.slice(i, i + 50)));
    const batches = await Promise.all(checks);
    const verified = new Map<string, Entitlement>();
    for (const batch of batches) {
      if (!batch) return { status: 'unavailable' };
      for (const [key, decision] of batch) verified.set(key, decision);
    }
    const eligible = candidates.filter(({ entitlement }) => matches(entitlement, verified.get(recipientKey(entitlement.recipient))));
    return { status: 'ready', eligible: eligible.map(({ row }) => row), revoked: candidates.length - eligible.length };
  }

  async coverage(): Promise<Coverage> {
    const checked = await this.recipients();
    if (checked.status === 'disabled') return disabledCoverage;
    return {
      enabled: true,
      status: checked.status,
      registeredRecipients: checked.status === 'ready' ? checked.eligible.length : null,
      revokedRecipients: checked.status === 'ready' ? checked.revoked : null,
    };
  }

  async project(notices: StorageNotice[], chatId: string) {
    const { store } = this.deps;
    const deliveryById = new Map((await store.deliverySummaries(notices.map(notice => notice.id))).map(row => [row.id, row]));
    return notices.map(({ external, externalItemId: _externalItemId, stage: _stage, critical: _legacyCritical, ...notice }) => {
      const totals = deliveryById.get(notice.id);
      const providerAccepted = totals?.accepted ?? 0;
      const failed = totals?.failed ?? 0;
      const pending = totals?.pending ?? 0;
      const targetedRecipients = providerAccepted + failed + pending;
      let status: CoverageStatus = totals?.coverage ?? 'pending';
      if (!external) status = 'private';
      else if (!this.enabled) status = 'disabled';
      else if (pending) status = totals?.authorityUnavailable ? 'authority_unavailable' : 'pending';
      else if (providerAccepted) status = failed ? 'partial' : 'accepted';
      else if (failed) status = totals?.revoked === failed ? 'revoked' : 'failed';
      return {
        ...notice,
        action: { driveId: notice.driveId, kind: notice.kind, id: notice.questionId ?? notice.id, chatId },
        delivery: { status, targetedRecipients, providerAccepted, failed, pending, clientReceived: null },
      };
    });
  }

  kick(): void {
    if (this.stopping) return;
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
    this.stopping = true;
    clearInterval(this.timer);
    await this.running;
  }

  private async deliver(): Promise<void> {
    const { store, now } = this.deps;
    const checked = await this.recipients();
    const at = now();
    const coverage = checked.status === 'ready'
      ? checked.eligible.length ? 'pending' : checked.revoked ? 'revoked' : 'no_recipients'
      : checked.status === 'unavailable' ? 'authority_unavailable' : 'disabled';
    await store.transaction(async tx => {
      await tx.lock('notification-coverage');
      const noticeRows = await tx.unresolvedCoverage(coverage);
      for (const notice of noticeRows) {
        await tx.evaluateNotice(notice.id, notice.external ? coverage : 'private', at);
        if (notice.external && checked.status === 'ready' && coverage === 'pending') {
          await tx.addTargets(notice.id, checked.eligible, at);
        }
      }
    });
    await store.expireAttempts(at - ATTEMPT_MS);
    if (!this.enabled) return;
    for (const delivery of await store.dueDeliveries(at)) {
      if (this.stopping) return;
      await this.send(delivery);
    }
  }

  private async send(old: Delivery): Promise<void> {
    const { store, push, now, authority } = this.deps;
    if (!authority) return;
    const attempt = await store.claimDelivery(old, now());
    if (!attempt) return;
    try {
      await store.transaction(async tx => {
        await tx.lock(`recipient:${attempt.subscriptionId}`);
        if (!await tx.lockAttempt(attempt, now() - ATTEMPT_MS)) return;
        const registration = await tx.registration(attempt.subscriptionId);
        if (registration?.grant !== attempt.grant || !registration.entitlement || Date.parse(registration.until) <= now()) {
          return tx.finishDelivery(attempt, 'failed', 'authorisation_or_notice_withdrawn', now());
        }
        const { recipient } = registration.entitlement;
        const checked = await authority.check([recipient]);
        if (!checked) return tx.deferDelivery(attempt, now() + AUTHORITY_RETRY_MS);
        if (!matches(registration.entitlement, checked.get(recipientKey(recipient)))) {
          return tx.finishDelivery(attempt, 'failed', 'revoked', now());
        }

        const device = await tx.notificationDevice(attempt.subscriptionId);
        const notice = await tx.get<StorageNotice>('notice', attempt.noticeId);
        if (!notice?.external || !device || registration.key !== keyOf(device) || Date.parse(registration.until) <= now()) {
          return tx.finishDelivery(attempt, 'failed', 'authorisation_or_notice_withdrawn', now());
        }
        const current = await tx.drive(notice.driveId);
        const decisions = notice.kind === 'cleanup' ? await tx.list<Decision>('decision', notice.driveId) : [];
        if (!current || !this.externalStillAllowed(current, notice, decisions, now())) {
          return tx.finishDelivery(attempt, 'failed', 'authorisation_or_notice_withdrawn', now());
        }

        const id = notice.questionId ?? notice.id;
        const url = registration.urls[notice.kind].replace('{driveId}', notice.driveId).replace('{id}', id);
        const provider = await push.sendStorageNotice(device, {
          kind: 'storage',
          title: notice.kind === 'question' ? 'Storage incident question' : 'Storage cleanup available',
          body: notice.kind === 'question' ? 'Open the incident to answer the question.' : 'Open the incident to review the cleanup finding.',
          url,
          tag: `storage-${notice.id}`,
        }, digest(notice.id).slice(0, 30));
        const result = provider.outcome === 'http' ? String(provider.status) : provider.outcome;
        if (provider.outcome === 'http' && provider.status >= 200 && provider.status < 300) {
          return tx.finishDelivery(attempt, 'accepted', result, now());
        }
        if (provider.outcome === 'http' && [404, 410].includes(provider.status)) {
          await tx.removeRegistration(attempt.subscriptionId);
        }
        if (attempt.attempts < MAX_ATTEMPTS && (provider.outcome === 'rate_limited'
            || (provider.outcome === 'http' && (provider.status === 429 || provider.status >= 500)))) {
          return tx.finishDelivery(attempt, 'pending', result, now() + RETRY_MS * attempt.attempts);
        }
        await tx.finishDelivery(attempt, 'failed', result, now());
      });
    } catch {
      // A committed claim without a result prevents resending an uncertain provider request.
      await store.finishDelivery(attempt, 'failed', 'delivery_unverified', now());
    }
  }

  private externalStillAllowed(state: DriveState, notice: StorageNotice, decisions: Decision[], now: number): boolean {
    if (!scanIsFresh(state, now)) return false;
    if (notice.stage && notice.stage !== pressureStage(state)) return false;
    if (notice.kind === 'cleanup' && notice.stage !== pressureStage(state)) return false;
    if (notice.kind === 'question') return state.items.some(item => item.visibility === 'jev' && item.id === notice.externalItemId);
    const eligible = new Set(itemViews(state, decisions, now).filter(item => item.eligible).map(item => item.id));
    return state.items.some(item => item.visibility === 'jev' && eligible.has(item.id));
  }

  async metrics(metrics: Metrics) {
    coverageMetrics(metrics, await this.coverage());
    const views = await this.project(await this.deps.store.list<StorageNotice>('notice'), '');
    const statusCounts = new Map<CoverageStatus, number>();
    for (const view of views) statusCounts.set(view.delivery.status, (statusCounts.get(view.delivery.status) ?? 0) + 1);
    for (const status of coverageStatuses) {
      metrics.set('headlamp_agent_storage_push_notices', { status }, statusCounts.get(status) ?? 0);
    }
    const totals = await this.deps.store.deliveryCounts();
    for (const status of ['pending', 'sending', 'accepted', 'failed']) {
      metrics.set('headlamp_agent_storage_push_deliveries', { status }, totals.get(status) ?? 0);
    }
  }
}
