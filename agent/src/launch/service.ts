import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { maskText } from '../mask.js';
import type { LaunchConfig } from '../config.js';
import type { DiagnosisStore } from '../store.js';
import { T3Error, type T3Client } from '../t3/client.js';
import { buildBrief, MAX_BRIEF_CHARS } from './brief.js';
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
  fix?: LaunchFix;
  brief?: string;
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
  pollMs?: number;
  /** Polling stops and the launch is marked failed after this many errors in a row. */
  maxErrors?: number;
  maxBackoffMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
}

/** How long after a follow-up the old final state of the thread is not trusted. */
const REVIVE_GRACE_MS = 30_000;

/**
 * Launches T3 Code agents when an operator approves a request. A launch is
 * created as `pending_approval` and starts only through `approve`. Nothing in
 * the model tool set can call `approve`.
 */
export class LaunchService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly errors = new Map<string, number>();
  /** Launches that got a follow-up: the run count before it and the time to wait for a new run. */
  private readonly revived = new Map<string, { runs: number; until: number }>();
  private stopped = false;
  private readonly pollMs: number;
  private readonly maxErrors: number;
  private readonly maxBackoffMs: number;
  private readonly log: NonNullable<LaunchServiceOptions['log']>;

  constructor(private readonly o: LaunchServiceOptions) {
    this.pollMs = o.pollMs ?? 3000;
    this.maxErrors = o.maxErrors ?? 6;
    this.maxBackoffMs = o.maxBackoffMs ?? 30_000;
    this.log = o.log ?? (() => undefined);
  }

  /** Why launching is off, or undefined when it is on. */
  disabledReason(): string | undefined {
    const c = this.o.config;
    if (!c.t3Url) return 'T3_URL is not set';
    if (!c.t3TokenFile) return 'T3_TOKEN_FILE is not set';
    if (!existsSync(c.t3TokenFile)) return 'The T3 token file does not exist';
    if (c.settingsError) return c.settingsError;
    if (!c.settings.projects.default) return 'The launch settings have no default project';
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
    const p = this.o.config.settings.projects[k];
    if (!p) throw new LaunchError(400, `Unknown project ${k}. Valid keys: ${Object.keys(this.o.config.settings.projects).join(', ')}`);
    return { key: k, projectId: p.projectId };
  }

  /** The brief for a request. Used by `create` and by the preview route. */
  brief(req: LaunchRequest): string {
    const diagnosis = req.diagnosisId ? this.o.diagnoses.get(req.diagnosisId) : undefined;
    if (req.diagnosisId && !diagnosis) throw new LaunchError(404, `No diagnosis ${req.diagnosisId}`);
    if (req.brief !== undefined && req.brief.trim() !== '') return maskText(req.brief.trim().slice(0, MAX_BRIEF_CHARS));
    return buildBrief({ preamble: this.o.config.settings.briefPreamble, purpose: req.purpose, diagnosis, fix: req.fix, chatId: req.chatId });
  }

  /** Creates a request. Nothing starts until `approve`. */
  create(req: LaunchRequest, by: string): Launch {
    this.requireEnabled();
    const project = this.project(req.projectKey);
    const brief = this.brief(req);
    const m = this.o.config.settings.model;
    return this.o.store.put({
      id: randomUUID(),
      purpose: req.purpose,
      source: { ...(req.diagnosisId ? { diagnosisId: req.diagnosisId } : {}), ...(req.chatId ? { chatId: req.chatId } : {}), ...(req.fix ? { fix: req.fix } : {}) },
      brief,
      projectKey: project.key,
      model: { instanceId: m.instanceId, model: m.model },
      status: 'pending_approval',
      requestedBy: by,
      requestedAt: new Date().toISOString(),
      timeline: [],
    });
  }

  private get(id: string): Launch {
    const l = this.o.store.get(id);
    if (!l) throw new LaunchError(404, 'not found');
    return l;
  }

  private checkCapacity(): void {
    const max = this.o.config.settings.maxRunning;
    if (this.o.store.active().length >= max) throw new LaunchError(409, `${max} launches are active already (the limit). Wait for one to end.`);
  }

  private link(threadId: string): string | undefined {
    const t = this.o.config.settings.threadUrlTemplate;
    return t ? t.split('{threadId}').join(encodeURIComponent(threadId)) : undefined;
  }

  /** The approval. This is the only way a launch starts. */
  async approve(id: string, by: string): Promise<Launch> {
    this.requireEnabled();
    const t3 = this.o.t3 as T3Client;
    const current = this.get(id);
    if (current.status !== 'pending_approval') throw new LaunchError(409, `The launch is ${current.status}, not pending approval`);
    this.checkCapacity();
    const project = this.project(current.projectKey);
    const launching = this.o.store.put({ ...current, status: 'launching', decidedAt: new Date().toISOString(), decidedBy: by });
    try {
      const out = await t3.launchThread({
        threadId: t3.newId(),
        projectId: project.projectId,
        title: `Incident agent: ${launching.purpose}`.slice(0, 200),
        modelSelection: { instanceId: launching.model.instanceId, model: launching.model.model, ...(this.o.config.settings.model.options ? { options: this.o.config.settings.model.options } : {}) },
        text: launching.brief,
      });
      const link = this.link(out.threadId);
      const running = this.o.store.put({ ...launching, threadId: out.threadId, status: 'running', startedAt: new Date().toISOString(), ...(link ? { threadLink: link } : {}) });
      this.track(running.id);
      this.log('info', 'agent launched', { id: running.id, threadId: out.threadId });
      return running;
    } catch (error) {
      const message = maskText(error instanceof Error ? error.message : String(error));
      this.log('error', 'agent launch failed', { id, error: message });
      return this.o.store.put({ ...launching, status: 'failed', error: message, finishedAt: new Date().toISOString() });
    }
  }

  reject(id: string, by: string): Launch {
    const current = this.get(id);
    if (current.status !== 'pending_approval') throw new LaunchError(409, `The launch is ${current.status}, not pending approval`);
    return this.o.store.put({ ...current, status: 'rejected', decidedAt: new Date().toISOString(), decidedBy: by });
  }

  /** A follow-up message for the agent in the thread. It also restarts tracking of an ended launch. */
  async message(id: string, text: string): Promise<Launch> {
    this.requireEnabled();
    const t3 = this.o.t3 as T3Client;
    const current = this.get(id);
    if (!current.threadId || !['running', 'waiting', 'completed', 'failed'].includes(current.status)) throw new LaunchError(409, `The launch is ${current.status}: it has no thread to message`);
    const wasActive = ACTIVE_STATUSES.has(current.status);
    if (!wasActive) this.checkCapacity();
    try {
      await t3.sendMessage(current.threadId, text, wasActive ? 'queue_after_active' : 'start_immediately');
    } catch (error) {
      throw new LaunchError(502, maskText(error instanceof Error ? error.message : String(error)));
    }
    let next = this.get(id);
    if (!wasActive) {
      const { finishedAt: _finished, error: _error, ...rest } = next;
      next = this.o.store.put({ ...rest, status: 'running' });
      this.revived.set(id, { runs: next.timeline.filter(e => e.kind === 'run').length, until: Date.now() + REVIVE_GRACE_MS });
      this.errors.delete(id);
      this.track(id);
    }
    return next;
  }

  /** After a restart: track launches that have a thread, fail the ones that were still starting. */
  resume(): void {
    for (const l of this.o.store.list()) {
      if (l.status === 'launching' && !l.threadId) {
        this.o.store.put({ ...l, status: 'failed', error: 'interrupted by restart before T3 confirmed the launch', finishedAt: new Date().toISOString() });
      } else if (ACTIVE_STATUSES.has(l.status) && l.threadId) {
        if (l.status === 'launching') this.o.store.put({ ...l, status: 'running' });
        this.track(l.id);
      }
    }
  }

  /** Stops all polling. */
  shutdown(): void {
    this.stopped = true;
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
    if (!l?.threadId || !ACTIVE_STATUSES.has(l.status)) return;
    try {
      const snap = await (this.o.t3 as T3Client).thread(l.threadId);
      this.errors.delete(id);
      const t = mapProjection(snap.projection);
      const revived = this.revived.get(id);
      let final = t.final;
      if (revived) {
        // The follow-up may not have created its run yet: the old final run is not the answer.
        if (snap.projection.runs.length > revived.runs || Date.now() > revived.until) this.revived.delete(id);
        else final = false;
      }
      const status = final ? t.status : t.final ? 'running' : t.status;
      const fresh = this.o.store.get(id) as Launch;
      this.o.store.put({
        ...fresh,
        status,
        timeline: t.timeline,
        ...(t.lastReply ? { lastReply: t.lastReply } : {}),
        ...(final && t.error ? { error: t.error } : {}),
        ...(final ? { finishedAt: t.finishedAt ?? new Date().toISOString() } : {}),
      });
      if (!final) this.track(id, this.pollMs);
    } catch (error) {
      const n = (this.errors.get(id) ?? 0) + 1;
      this.errors.set(id, n);
      const message = maskText(error instanceof Error ? error.message : String(error));
      const permanent = error instanceof T3Error && error.status === 404;
      if (permanent || n >= this.maxErrors) {
        this.errors.delete(id);
        const fresh = this.o.store.get(id) as Launch;
        this.o.store.put({ ...fresh, status: 'failed', error: permanent ? 'T3 no longer has this thread' : `Tracking stopped after ${n} errors in a row. Last error: ${message}`, finishedAt: new Date().toISOString() });
        this.log('error', 'launch tracking stopped', { id, error: message });
        return;
      }
      this.log('warn', 'launch tracking error', { id, attempt: n, error: message });
      this.track(id, Math.min(this.pollMs * 2 ** n, this.maxBackoffMs));
    }
  }

  isFinal(l: Launch): boolean {
    return FINAL_STATUSES.has(l.status);
  }
}
