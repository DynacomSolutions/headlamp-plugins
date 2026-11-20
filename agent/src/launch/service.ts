import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { maskText } from '../mask.js';
import type { LaunchConfig } from '../config.js';
import type { DiagnosisStore } from '../store.js';
import { T3Error, type T3Client } from '../t3/client.js';
import { buildBrief } from './brief.js';
import { ACTIVE_STATUSES, FINAL_STATUSES, type Launch, type LaunchFix, type LaunchStore } from './store.js';
import { mapProjection } from './timeline.js';

/** An error with the HTTP status the route answers. */
export class LaunchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface LaunchRequest {
  purpose: string;
  diagnosisId?: string;
  chatId?: string;
  /** Index into the fixes of the diagnosis. The server looks the fix up. */
  fix?: number;
  projectKey?: string;
}

export interface LaunchesPublicConfig {
  enabled: boolean;
  reason?: string;
  projects: Array<{ key: string; title: string }>;
  model: { instanceId: string; model: string };
  threadUrlTemplate: string;
}

export interface LaunchServiceOptions {
  store: LaunchStore;
  diagnoses: DiagnosisStore;
  config: LaunchConfig;
  /** Absent when T3_URL is not set. */
  t3?: T3Client;
  /** Identity of this process. Defaults to the pod name. */
  owner?: string;
  pollMs?: number;
  /** The longest wait between two polls after errors. */
  maxBackoffMs?: number;
  /** How long a process keeps the claim on a launch it polls. */
  leaseMs?: number;
  /** A pending request older than this expires. */
  expireMs?: number;
  scanMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
}

/** How long after a message the old final state of the thread is not trusted. */
const REVIVE_GRACE_MS = 30_000;
const HOUR_MS = 3_600_000;

/**
 * Launches T3 Code agents when an operator approves a request. A launch is
 * created as `pending_approval` and starts only through `approve`. Nothing in
 * the model tool set can call `approve`.
 *
 * Every change goes through `LaunchStore.update`, which reads the record from disk and
 * writes it under a lock, so two pods that share the data directory never overwrite each
 * other. The pod that polls a launch holds a lease on it (`owner`, `leaseUntil`). Another pod
 * takes over only after the lease ran out.
 */
export class LaunchService {
  readonly owner: string;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly errors = new Map<string, number>();
  /** Launches this process is starting right now, so the scan does not take them. */
  private readonly inflight = new Set<string>();
  private scanTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly pollMs: number;
  private readonly maxBackoffMs: number;
  private readonly leaseMs: number;
  private readonly expireMs: number;
  private readonly log: NonNullable<LaunchServiceOptions['log']>;

  constructor(private readonly o: LaunchServiceOptions) {
    this.owner = o.owner ?? process.env.HOSTNAME ?? `pid-${process.pid}`;
    this.pollMs = o.pollMs ?? 3000;
    this.maxBackoffMs = o.maxBackoffMs ?? 60_000;
    this.leaseMs = o.leaseMs ?? 120_000;
    this.expireMs = o.expireMs ?? 24 * HOUR_MS;
    this.log = o.log ?? (() => undefined);
  }

  /** Why launching is off, or undefined when it is on. */
  disabledReason(): string | undefined {
    const c = this.o.config;
    if (!c.t3Url) return 'T3_URL is not set';
    if (!c.t3TokenFile) return 'T3_TOKEN_FILE is not set';
    if (!existsSync(c.t3TokenFile)) return 'The T3 token file does not exist';
    if (c.settingsError) return c.settingsError;
    if (!Object.hasOwn(c.settings.projects, 'default')) return 'The launch settings have no default project';
    if (!c.settings.model.instanceId || !c.settings.model.model) return 'The launch settings have no model';
    if (!this.o.t3) return 'The T3 client is not available';
    return undefined;
  }

  get enabled(): boolean {
    return this.disabledReason() === undefined;
  }

  publicConfig(): LaunchesPublicConfig {
    const reason = this.disabledReason();
    const s = this.o.config.settings;
    return {
      enabled: reason === undefined,
      ...(reason ? { reason } : {}),
      projects: Object.entries(s.projects).map(([key, p]) => ({ key, title: p.title })),
      model: { instanceId: s.model.instanceId, model: s.model.model },
      threadUrlTemplate: s.threadUrlTemplate,
    };
  }

  /** Throws a 503 with the reason when launching is off. */
  requireEnabled(): void {
    const reason = this.disabledReason();
    if (reason) throw new LaunchError(503, `Launching agents is off: ${reason}`);
  }

  private project(key: string | undefined): { key: string; projectId: string } {
    const k = key || 'default';
    const projects = this.o.config.settings.projects;
    if (!Object.hasOwn(projects, k)) throw new LaunchError(400, `Unknown project ${k}. Valid keys: ${Object.keys(projects).join(', ')}`);
    return { key: k, projectId: projects[k].projectId };
  }

  /** The brief and the fix for a request. `preview` and `create` both use it, so they give the same text. */
  private prepare(req: LaunchRequest): { brief: string; fix?: LaunchFix } {
    const diagnosis = req.diagnosisId ? this.o.diagnoses.get(req.diagnosisId) : undefined;
    if (req.diagnosisId && !diagnosis) throw new LaunchError(404, `No diagnosis ${req.diagnosisId}`);
    let fix: LaunchFix | undefined;
    if (req.fix !== undefined) {
      if (!diagnosis) throw new LaunchError(400, 'A fix needs a diagnosisId');
      const f = diagnosis.result?.fixes[req.fix];
      if (!f) throw new LaunchError(400, `The diagnosis has no fix ${req.fix}`);
      fix = { index: req.fix, title: f.title, detail: f.detail, ...(f.command ? { command: f.command } : {}) };
    }
    return { brief: buildBrief({ preamble: this.o.config.settings.briefPreamble, purpose: req.purpose, diagnosis, fix }), fix };
  }

  brief(req: LaunchRequest): string {
    return this.prepare(req).brief;
  }

  /** Marks pending requests older than the limit as expired. */
  expireStale(): void {
    const cutoff = new Date(Date.now() - this.expireMs).toISOString();
    for (const l of this.o.store.list()) {
      if (l.status === 'pending_approval' && l.requestedAt < cutoff) {
        this.o.store.update(l.id, c => (c.status === 'pending_approval' && c.requestedAt < cutoff ? { ...c, status: 'expired', finishedAt: new Date().toISOString() } : undefined));
      }
    }
  }

  /** Creates a request. Nothing starts until `approve`. */
  create(req: LaunchRequest, by: string): Launch {
    this.requireEnabled();
    this.expireStale();
    const project = this.project(req.projectKey);
    const { brief, fix } = this.prepare(req);
    const open = this.o.store.list().filter(l => !FINAL_STATUSES.has(l.status)).length;
    if (open >= this.o.store.capacity) throw new LaunchError(429, `${open} requests and launches are open (the limit). Approve, reject or wait.`);
    const m = this.o.config.settings.model;
    return this.o.store.create({
      id: randomUUID(),
      purpose: req.purpose,
      source: { ...(req.diagnosisId ? { diagnosisId: req.diagnosisId } : {}), ...(req.chatId ? { chatId: req.chatId } : {}), ...(fix ? { fix } : {}) },
      brief,
      projectKey: project.key,
      model: { instanceId: m.instanceId, model: m.model },
      status: 'pending_approval',
      requestedBy: by,
      requestedAt: new Date().toISOString(),
      timeline: [],
    });
  }

  private lease(): string {
    return new Date(Date.now() + this.leaseMs).toISOString();
  }

  /** True when another process holds a live lease on the record. */
  private foreign(l: Launch): boolean {
    return !!l.owner && l.owner !== this.owner && !!l.leaseUntil && Date.parse(l.leaseUntil) > Date.now();
  }

  private link(threadId: string): string | undefined {
    const t = this.o.config.settings.threadUrlTemplate;
    return t ? t.split('{threadId}').join(encodeURIComponent(threadId)) : undefined;
  }

  private notFoundOrWrongState(id: string, what: string): LaunchError {
    const l = this.o.store.get(id);
    return l ? new LaunchError(409, `The launch is ${l.status}, ${what}`) : new LaunchError(404, 'not found');
  }

  /** The approval. This is the only way a launch starts. */
  async approve(id: string, by: string): Promise<Launch> {
    this.requireEnabled();
    this.expireStale();
    const t3 = this.o.t3 as T3Client;
    const threadId = t3.newId();
    const max = this.o.config.settings.maxRunning;
    const perHour = this.o.config.maxApprovalsPerHour;
    // One lock for the checks and the state change, so two requests (or two pods) cannot both pass the limit.
    const launching = this.o.store.withLock('capacity', () => {
      const cur = this.o.store.get(id);
      if (!cur) throw new LaunchError(404, 'not found');
      if (cur.status !== 'pending_approval') throw new LaunchError(409, `The launch is ${cur.status}, not pending approval`);
      if (this.o.store.active().length >= max) throw new LaunchError(409, `${max} launches are active already (the limit). Wait for one to end.`);
      const since = new Date(Date.now() - HOUR_MS).toISOString();
      const approved = this.o.store.list().filter(l => l.decidedAt && l.decidedAt >= since && !['pending_approval', 'rejected', 'expired'].includes(l.status)).length;
      if (approved >= perHour) throw new LaunchError(429, `${perHour} approvals in the last hour (the limit). Try again later.`);
      const project = this.project(cur.projectKey);
      const next = this.o.store.update(id, c => (c.status === 'pending_approval' ? { ...c, status: 'launching', threadId, decidedAt: new Date().toISOString(), decidedBy: by, owner: this.owner, leaseUntil: this.lease() } : undefined));
      if (!next) throw this.notFoundOrWrongState(id, 'not pending approval');
      return { launch: next, projectId: project.projectId };
    });
    const l = launching.launch;
    this.inflight.add(id);
    try {
      try {
        await t3.launchThread({
          threadId,
          projectId: launching.projectId,
          title: `Incident agent: ${l.purpose}`.slice(0, 200),
          modelSelection: { instanceId: l.model.instanceId, model: l.model.model, ...(this.o.config.settings.model.options ? { options: this.o.config.settings.model.options } : {}) },
          text: l.brief,
        });
        return this.started(id, threadId);
      } catch (error) {
        // The call may have reached T3 before it failed. Only a missing thread proves the launch did not happen.
        const message = maskText(error instanceof Error ? error.message : String(error));
        if ((await this.exists(threadId)) === 'missing') {
          this.log('error', 'agent launch failed', { id, error: message });
          return this.o.store.update(id, c => ({ ...c, status: 'failed', error: message, finishedAt: new Date().toISOString() })) ?? l;
        }
        this.log('warn', 'agent launch call failed but the thread exists or is unknown, tracking it', { id, error: message });
        return this.started(id, threadId);
      }
    } finally {
      this.inflight.delete(id);
    }
  }

  private started(id: string, threadId: string): Launch {
    const link = this.link(threadId);
    const running = this.o.store.update(id, c => ({ ...c, status: 'running', threadId, startedAt: c.startedAt ?? new Date().toISOString(), owner: this.owner, leaseUntil: this.lease(), ...(link ? { threadLink: link } : {}) })) as Launch;
    this.track(id);
    this.log('info', 'agent launched', { id, threadId });
    return running;
  }

  /** `missing` only when T3 answers 404. Any other answer or error means the thread may exist. */
  private async exists(threadId: string): Promise<'exists' | 'missing'> {
    try {
      await (this.o.t3 as T3Client).thread(threadId);
      return 'exists';
    } catch (error) {
      return error instanceof T3Error && error.status === 404 ? 'missing' : 'exists';
    }
  }

  reject(id: string, by: string): Launch {
    const done = this.o.store.update(id, c => (c.status === 'pending_approval' ? { ...c, status: 'rejected', decidedAt: new Date().toISOString(), decidedBy: by } : undefined));
    if (!done) throw this.notFoundOrWrongState(id, 'not pending approval');
    return done;
  }

  /**
   * A follow-up message for the agent in the thread. The record becomes active before the call,
   * so a second request sees it in the capacity count. When the call fails the record goes back.
   */
  async message(id: string, text: string): Promise<Launch> {
    this.requireEnabled();
    const t3 = this.o.t3 as T3Client;
    const max = this.o.config.settings.maxRunning;
    const marker = new Date(Date.now() + REVIVE_GRACE_MS).toISOString();
    const { before, wasActive } = this.o.store.withLock('capacity', () => {
      const cur = this.o.store.get(id);
      if (!cur) throw new LaunchError(404, 'not found');
      if (!cur.threadId || !['running', 'waiting', 'tracking_lost', 'completed', 'failed'].includes(cur.status)) throw new LaunchError(409, `The launch is ${cur.status}: it has no thread to message`);
      const active = ACTIVE_STATUSES.has(cur.status);
      if (!active && this.o.store.active().length >= max) throw new LaunchError(409, `${max} launches are active already (the limit). Wait for one to end.`);
      const runs = cur.runsSeen ?? cur.timeline.filter(e => e.kind === 'run').length;
      this.o.store.update(id, c => {
        const { finishedAt: _f, error: _e, ...rest } = c;
        return active ? { ...c, reviveRuns: runs, reviveUntil: marker } : { ...rest, status: 'running', reviveRuns: runs, reviveUntil: marker, owner: this.owner, leaseUntil: this.lease() };
      });
      return { before: cur, wasActive: active };
    });
    try {
      await t3.sendMessage(before.threadId as string, text, wasActive ? 'queue_after_active' : 'start_immediately');
    } catch (error) {
      this.o.store.update(id, c => {
        if (c.reviveUntil !== marker) return undefined;
        const { reviveRuns: _r, reviveUntil: _u, ...rest } = c;
        return { ...rest, status: before.status, ...(before.finishedAt ? { finishedAt: before.finishedAt } : {}), ...(before.error ? { error: before.error } : {}), ...(before.reviveUntil ? { reviveRuns: before.reviveRuns, reviveUntil: before.reviveUntil } : {}) };
      });
      throw new LaunchError(502, maskText(error instanceof Error ? error.message : String(error)));
    }
    this.errors.delete(id);
    if (!this.timers.has(id) && !this.foreign(this.o.store.get(id) as Launch)) this.track(id);
    return this.o.store.get(id) as Launch;
  }

  /**
   * Looks for work this process should do: expires old requests, takes over launches whose
   * lease ran out (a pod that stopped), probes launches that were still starting, and fails a
   * launch that has no thread.
   */
  async scan(): Promise<void> {
    if (this.stopped) return;
    this.expireStale();
    for (const l of this.o.store.list()) {
      if (!ACTIVE_STATUSES.has(l.status) || this.timers.has(l.id) || this.inflight.has(l.id)) continue;
      if (this.foreign(l)) continue;
      const taken = this.o.store.update(l.id, c => (ACTIVE_STATUSES.has(c.status) && !this.foreign(c) ? { ...c, owner: this.owner, leaseUntil: this.lease() } : undefined));
      if (!taken) continue;
      if (!taken.threadId) {
        this.o.store.update(l.id, c => ({ ...c, status: 'failed', error: 'interrupted by restart before T3 confirmed the launch', finishedAt: new Date().toISOString() }));
      } else if (taken.status === 'launching') {
        // The call may or may not have reached T3. A missing thread means it did not.
        if ((await this.exists(taken.threadId)) === 'missing') {
          this.o.store.update(l.id, c => ({ ...c, status: 'failed', error: 'interrupted by restart before T3 confirmed the launch', finishedAt: new Date().toISOString() }));
        } else this.started(l.id, taken.threadId);
      } else this.track(l.id);
    }
  }

  /** After a start: scan once now, then every 30 s. */
  async resume(): Promise<void> {
    await this.scan();
    if (!this.scanTimer && !this.stopped) {
      this.scanTimer = setInterval(() => void this.scan().catch(e => this.log('error', 'launch scan failed', { error: String(e) })), this.o.scanMs ?? 30_000);
      this.scanTimer.unref();
    }
  }

  /** Stops all polling. */
  shutdown(): void {
    this.stopped = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = undefined;
    // Give the claims back, so the next pod takes the launches over at once.
    for (const id of this.timers.keys()) {
      try {
        this.o.store.update(id, c => (c.owner === this.owner ? { ...c, leaseUntil: new Date(0).toISOString() } : undefined));
      } catch {
        // The lease ends on its own.
      }
    }
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Number of launches that are polled now. */
  get tracking(): number {
    return this.timers.size;
  }

  private track(id: string, delayMs = 0): void {
    if (this.stopped) return;
    const old = this.timers.get(id);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => void this.poll(id), delayMs);
    timer.unref();
    this.timers.set(id, timer);
  }

  /** One polling step. Public so tests can run it without waiting. */
  async poll(id: string): Promise<void> {
    this.timers.delete(id);
    if (this.stopped) return;
    const l = this.o.store.get(id);
    if (!l?.threadId || !ACTIVE_STATUSES.has(l.status) || l.status === 'launching' || this.foreign(l)) return;
    try {
      const snap = await (this.o.t3 as T3Client).thread(l.threadId);
      const t = mapProjection(snap.projection);
      const runs = snap.projection.runs.length;
      const next = this.o.store.update(id, cur => {
        if (!ACTIVE_STATUSES.has(cur.status) || cur.status === 'launching' || this.foreign(cur)) return undefined;
        const { error: _e, finishedAt: _f, reviveRuns, reviveUntil, ...rest } = cur;
        let final = t.final;
        let keepRevive = false;
        if (reviveUntil) {
          // A message was sent. Its run may not exist yet, so the old final run is not the answer.
          if (runs > (reviveRuns ?? 0) || Date.parse(reviveUntil) <= Date.now()) keepRevive = false;
          else {
            keepRevive = true;
            final = false;
          }
        }
        const status = final ? t.status : t.final ? 'running' : t.status;
        return {
          ...rest,
          status,
          timeline: t.timeline,
          runsSeen: runs,
          owner: this.owner,
          leaseUntil: this.lease(),
          ...(t.lastReply ? { lastReply: t.lastReply } : {}),
          ...(keepRevive ? { reviveRuns, reviveUntil } : {}),
          ...(final && t.error ? { error: t.error } : {}),
          ...(final ? { finishedAt: t.finishedAt ?? new Date().toISOString() } : {}),
        };
      });
      this.errors.delete(id);
      if (next && ACTIVE_STATUSES.has(next.status)) this.track(id, this.pollMs);
    } catch (error) {
      const n = (this.errors.get(id) ?? 0) + 1;
      this.errors.set(id, n);
      const message = maskText(error instanceof Error ? error.message : String(error));
      if (error instanceof T3Error && error.status === 404) {
        this.errors.delete(id);
        this.o.store.update(id, c => (ACTIVE_STATUSES.has(c.status) && !this.foreign(c) ? { ...c, status: 'failed', error: 'T3 no longer has this thread', finishedAt: new Date().toISOString() } : undefined));
        this.log('error', 'launch thread is gone', { id });
        return;
      }
      // Any other error is not proof that the agent stopped. Keep the launch active and try again, slower each time.
      this.o.store.update(id, c => (ACTIVE_STATUSES.has(c.status) && c.status !== 'launching' && !this.foreign(c) ? { ...c, status: 'tracking_lost', error: `Lost contact with T3: ${message}`, owner: this.owner, leaseUntil: this.lease() } : undefined));
      this.log('warn', 'launch tracking error', { id, attempt: n, error: message });
      this.track(id, Math.min(this.pollMs * 2 ** n, this.maxBackoffMs));
    }
  }
}
