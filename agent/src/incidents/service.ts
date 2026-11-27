import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Diagnosis, DiagnosisResult } from '../agent/report.js';
import { maskText } from '../mask.js';
import type { DiagnosisStore } from '../store.js';
import { matchesFilter, toIncident, toInvestigation, type Incident, type IncidentFilter, type Investigation, type Rec } from './model.js';
import type { IncidentState, TimelineEntry } from './types.js';

export type ErrorCode = 'invalid_argument' | 'not_found' | 'conflict' | 'not_ready' | 'cursor_expired' | 'session_required' | 'rate_limited' | 'unavailable' | 'internal' | 'forbidden';

/** An error with a contract code. The MCP layer turns it into a tool result or a JSON-RPC error. */
export class IncidentError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: { requiredScope?: string; retryAfterSeconds?: number } = {},
  ) {
    super(message);
  }
}

/** The part of the runner that investigations use. */
export interface InvestigationRunner {
  readonly configured: boolean;
  rerun(id: string, model?: string): Promise<Diagnosis>;
  enqueue(alert: Diagnosis['alert'], source: Diagnosis['source'], existingId?: string, model?: string): Promise<Diagnosis>;
  /** Checks a model id. Returns the canonical `<route>/<model>`. Throws an Error with `unknown` true for a model that does not exist. */
  resolveModel(model: string): Promise<string>;
}

export interface IncidentDeps {
  store: DiagnosisStore;
  runner?: InvestigationRunner;
  /** Sends the escalation push. Must not throw. */
  onEscalate?: (d: Diagnosis, reason: string) => void;
  maxConcurrentReruns?: number;
  now?: () => number;
}

const CURSOR_TTL_MS = 3600_000;
const REQUEST_TTL_MS = 24 * 3600_000;
const SCAN_CAP = 5000;
const MAX_REQUESTS = 100;

export const requestIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

const hash = (...parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

export interface WriteResult<T> {
  value: T;
  changed: boolean;
  replayed: boolean;
}

export class IncidentService {
  private readonly now: () => number;

  constructor(private readonly deps: IncidentDeps) {
    this.now = deps.now ?? (() => deps.store.now());
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private async record(id: string): Promise<Diagnosis> {
    const d = await this.deps.store.get(id);
    if (!d) throw new IncidentError('not_found', `No incident ${id}`);
    return d;
  }

  async get(id: string): Promise<Incident> {
    return toIncident(await this.record(id));
  }

  async investigation(id: string): Promise<{ investigation: Investigation; result: (DiagnosisResult & { evidence: Array<{ id: string; tool: string; reason: string; summary: string; ok: boolean }> }) | null }> {
    const d = await this.record(id);
    const result = d.status === 'done' && d.result ? { ...d.result, evidence: d.evidence.map(({ id, tool, reason, summary, ok }) => ({ id, tool, reason, summary, ok })) } : null;
    return { investigation: toInvestigation(d), result };
  }

  async timeline(id: string, afterSeq = 0, limit = 200): Promise<{ incidentId: string; entries: TimelineEntry[]; nextAfterSeq: number | null }> {
    const d = await this.record(id);
    const all = (d.incident?.timeline ?? []).filter(e => e.seq > afterSeq);
    const entries = all.slice(0, limit);
    return { incidentId: id, entries, nextAfterSeq: all.length > entries.length ? entries[entries.length - 1]!.seq : null };
  }

  async list(filter: IncidentFilter, limit = 50, cursor?: string): Promise<{ incidents: Incident[]; nextCursor: string | null; total: number }> {
    const state = filter.state ?? 'active';
    let offset = 0;
    if (cursor) {
      let parsed: { o: number; t: number } | undefined;
      try {
        parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o: number; t: number };
      } catch {
        // Falls through to the error below.
      }
      if (!parsed || !Number.isInteger(parsed.o) || parsed.o < 0 || typeof parsed.t !== 'number' || this.now() - parsed.t > CURSOR_TTL_MS) throw new IncidentError('cursor_expired', 'The cursor is not valid or too old. Start again without a cursor.');
      offset = parsed.o;
    }
    let matches: Incident[];
    if (state === 'resolved') {
      matches = [];
      for (let o = 0; o < SCAN_CAP; o += 200) {
        const page = await this.deps.store.page({ offset: o, limit: 200 });
        for (const d of page.diagnoses) if (d.resolvedAt) {
          const i = toIncident(d);
          if (matchesFilter(i, filter)) matches.push(i);
        }
        if (o + 200 >= page.total) break;
      }
    } else {
      matches = (await this.deps.store.openSummaries()).map(d => toIncident(d)).filter(i => matchesFilter(i, filter));
    }
    const incidents = matches.slice(offset, offset + limit);
    const more = offset + limit < matches.length;
    return { incidents, nextCursor: more ? Buffer.from(JSON.stringify({ o: offset + limit, t: this.now() })).toString('base64url') : null, total: matches.length };
  }

  /**
   * One write under the record lock. `apply` returns the new state or undefined for "nothing to change".
   * A repeated `requestId` of the same client and tool returns the first result (contract section 5).
   */
  private async write(
    id: string,
    tool: string,
    actor: string,
    requestId: string | undefined,
    args: unknown,
    apply: (d: Diagnosis, state: IncidentState, at: string) => Diagnosis | undefined,
  ): Promise<{ record: Diagnosis; changed: boolean; replayed: boolean }> {
    const first = await this.record(id);
    const key = requestId ? `${actor}:${tool}:${requestId}` : undefined;
    const argsHash = hash(tool, id, args);
    let replayed = false;
    let conflict = false;
    let changed = false;
    await this.deps.store.update(
      id,
      d => {
        if (!d) return undefined;
        const at = this.iso();
        const requests = Object.fromEntries(Object.entries(d.incident?.requests ?? {}).filter(([, r]) => this.now() - Date.parse(r.at) < REQUEST_TTL_MS));
        const known = key ? requests[key] : undefined;
        if (known) {
          if (known.hash !== argsHash) conflict = true;
          else replayed = true;
          return undefined;
        }
        const state: IncidentState = { ...(d.incident ?? { timeline: [] }), timeline: [...(d.incident?.timeline ?? [])] };
        const next = apply(d, state, at);
        if (!next) return undefined;
        changed = true;
        const kept = Object.entries({ ...requests, ...(key ? { [key]: { hash: argsHash, at } } : {}) }).slice(-MAX_REQUESTS);
        return { ...next, incident: { ...(next.incident ?? state), requests: Object.fromEntries(kept) } };
      },
      { force: true },
    );
    if (conflict) throw new IncidentError('conflict', 'This requestId was used with other arguments.');
    return { record: changed ? ((await this.deps.store.get(id)) ?? first) : first, changed, replayed };
  }

  private entry(kind: TimelineEntry['kind'], actor: string, at: string, text: string | null, requestId?: string): TimelineEntry {
    return { seq: 0, at, kind, actor, text: text === null ? null : maskText(text), data: requestId ? { requestId } : null };
  }

  async acknowledge(id: string, actor: string, input: { note?: string; requestId?: string }): Promise<WriteResult<Incident>> {
    const r = await this.write(id, 'acknowledge_incident', actor, input.requestId, input.note, (d, state, at) => {
      if (d.resolvedAt || state.acknowledgedAt) return undefined;
      state.acknowledgedAt = at;
      state.acknowledgedBy = actor;
      state.timeline.push(this.entry('acknowledged', actor, at, input.note ?? null, input.requestId));
      return { ...d, incident: state };
    });
    return { value: toIncident(r.record), changed: r.changed, replayed: r.replayed };
  }

  async addNote(id: string, actor: string, input: { text: string; requestId?: string }): Promise<{ entry: TimelineEntry; incident: Incident; replayed: boolean }> {
    const r = await this.write(id, 'add_incident_note', actor, input.requestId, input.text, (d, state, at) => {
      state.noteCount = (state.noteCount ?? 0) + 1;
      state.timeline.push(this.entry('note', actor, at, input.text, input.requestId));
      return { ...d, incident: state };
    });
    const entries = r.record.incident?.timeline ?? [];
    const entry = (input.requestId ? [...entries].reverse().find(e => e.kind === 'note' && e.actor === actor && (e.data as { requestId?: string } | null)?.requestId === input.requestId) : undefined) ?? entries.filter(e => e.kind === 'note').at(-1);
    if (!entry) throw new IncidentError('internal', 'The note was not stored.');
    return { entry, incident: toIncident(r.record), replayed: r.replayed };
  }

  async resolve(id: string, actor: string, input: { resolution?: string; requestId?: string }): Promise<WriteResult<Incident>> {
    const r = await this.write(id, 'resolve_incident', actor, input.requestId, input.resolution, (d, state, at) => {
      if (d.resolvedAt) return undefined;
      state.resolvedBy = actor;
      if (input.resolution) state.resolution = maskText(input.resolution);
      state.timeline.push(this.entry('resolved', actor, at, input.resolution ?? null, input.requestId));
      return { ...d, resolvedAt: at, incident: state };
    });
    return { value: toIncident(r.record), changed: r.changed, replayed: r.replayed };
  }

  async escalate(id: string, actor: string, input: { reason: string; requestId?: string }): Promise<{ incident: Incident; replayed: boolean }> {
    const existing = await this.record(id);
    if (existing.resolvedAt) throw new IncidentError('conflict', 'The incident is resolved.');
    const r = await this.write(id, 'escalate_incident', actor, input.requestId, input.reason, (d, state, at) => {
      if (d.resolvedAt) return undefined;
      state.escalatedAt = at;
      state.timeline.push(this.entry('escalated', actor, at, input.reason, input.requestId));
      return { ...d, incident: state };
    });
    if (!r.changed && !r.replayed) throw new IncidentError('conflict', 'The incident is resolved.');
    if (r.changed) this.deps.onEscalate?.(r.record, input.reason);
    return { incident: toIncident(r.record), replayed: r.replayed };
  }

  /** Starts a run for a client or an operator. Works also when automatic investigations are off. */
  async startInvestigation(id: string, actor: string, input: { model?: string; force?: boolean; requestId?: string }): Promise<{ investigation: Investigation; started: boolean; replayed: boolean }> {
    const d = await this.record(id);
    const busy = d.status === 'queued' || d.status === 'running';
    const argsKey = hash(input.model, input.force);
    const known = (d.incident?.requests ?? {})[input.requestId ? `${actor}:start_investigation:${input.requestId}` : ''];
    if (known && known.hash === hash('start_investigation', id, argsKey)) return { investigation: toInvestigation(d), started: false, replayed: true };
    if (busy && !this.deps.store.expired(d)) return { investigation: toInvestigation(d), started: false, replayed: false };
    if (d.status === 'done' && !input.force) return { investigation: toInvestigation(d), started: false, replayed: false };
    const runner = this.deps.runner;
    if (!runner?.configured) throw new IncidentError('unavailable', 'No model is configured for in-cluster investigation.');
    let model: string | undefined;
    if (input.model) {
      try {
        model = await runner.resolveModel(input.model);
      } catch (error) {
        if ((error as { unknown?: boolean }).unknown) throw new IncidentError('invalid_argument', error instanceof Error ? error.message : 'Unknown model');
        throw error;
      }
    }
    if (this.deps.maxConcurrentReruns !== undefined && (await this.deps.store.countOpenReruns()) >= this.deps.maxConcurrentReruns) {
      throw new IncidentError('rate_limited', 'Too many investigations run now.', { retryAfterSeconds: 60 });
    }
    const w = await this.write(id, 'start_investigation', actor, input.requestId, argsKey, (cur, state, at) => {
      state.manualRun = true;
      return { ...cur, incident: state, rerunAt: cur.status === 'failed' ? cur.rerunAt : at };
    });
    if (w.replayed) return { investigation: toInvestigation(w.record), started: false, replayed: true };
    const fresh = w.record;
    const started = fresh.status === 'failed' ? await runner.rerun(id, model) : await runner.enqueue(fresh.alert, fresh.source, id, model);
    return { investigation: toInvestigation((await this.deps.store.get(id)) ?? started), started: true, replayed: false };
  }
}
