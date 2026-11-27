import { randomUUID } from 'node:crypto';
import type { Db } from '../store.js';
import type { EventRecord, NewEvent } from './types.js';
import { canSee, fullLabels, kindMatches } from './model.js';

/** Events are kept 7 days and at most 100 000 (contract section 8.2). */
export const RETENTION_MS = 7 * 24 * 3600_000;
export const MAX_EVENTS = 100_000;

export interface EventFilter {
  kinds?: string[];
  labels?: Record<string, string>;
  /** Two `label` parameters with the same key and different values: nothing matches. */
  never?: true;
  /** Only events whose primary URI needs one of these scopes (contract section 8.7). */
  scopes?: ReadonlySet<string>;
}

export interface EventPage {
  logId: string;
  events: EventRecord[];
  nextAfter: string;
  hasMore: boolean;
  latest: string | null;
  oldestRetained: string | null;
  reset: boolean;
}

export interface EventHead {
  logId: string;
  latest: string | null;
  oldestRetained: string | null;
}

export type EventListener = (event: EventRecord) => void;

type Tx = { query: Db['query'] };

/** Removes the internal fields before an event goes to a client. */
export function publicEvent({ state: _state, stateBefore: _before, fullLabels: _labels, ...e }: EventRecord): Omit<EventRecord, 'state' | 'stateBefore' | 'fullLabels'> {
  return e;
}

/**
 * Contract section 8.3: a cursor is a reset when events were removed after it, or when it is ahead of the log.
 * `latest` is the highest id the log ever stored, so a quiet log does not reset a stored cursor (section 8.3, rule 2).
 */
export function isReset(after: bigint, latest: string | null, floor: bigint): boolean {
  return (after !== 0n && after < floor) || after > BigInt(latest ?? '0');
}

/** The highest id ever stored: the newest retained id, or the high-water mark when retention removed every event. */
export function highest(newest: bigint | null, floor: bigint): string | null {
  const top = newest !== null && newest > floor ? newest : floor;
  return top > 0n ? String(top) : null;
}

export function passes(e: EventRecord, f: EventFilter): boolean {
  if (f.never) return false;
  if (f.scopes && !canSee(f.scopes, e.kind)) return false;
  if (f.kinds?.length && !kindMatches(f.kinds, e.kind)) return false;
  const labels = fullLabels(e);
  return Object.entries(f.labels ?? {}).every(([k, v]) => labels[k] === v);
}

/** Where a page starts. A reset page starts at the oldest retained event, in every case (contract section 8.3). */
export function pageStart(after: bigint, reset: boolean, oldest: string | null): bigint {
  return reset && oldest !== null ? BigInt(oldest) - 1n : after;
}

/**
 * The durable event log. `append` stores events; every stored event reaches every listener once, in id order,
 * on every pod. A listener never polls: delivery follows a commit.
 */
export abstract class EventLog {
  protected readonly listeners = new Set<EventListener>();
  /** Called for each event this process stores. */
  onRecorded?: (kind: string) => void;

  /** Called for each event in id order. Returns a function that removes the listener. */
  listen(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(events: EventRecord[]): void {
    for (const e of events) for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // A listener must not stop the others.
      }
    }
  }

  /** Stores events. Inside a transaction (`tx`) delivery waits for `committed`. */
  abstract append(events: NewEvent[], tx?: Tx): Promise<EventRecord[]>;
  /** Tells the log that the transaction of `append` committed: now the events are counted and delivered. */
  abstract committed(records: EventRecord[]): Promise<void>;
  abstract head(): Promise<EventHead>;
  abstract readAfter(after: bigint, limit: number, filter?: EventFilter): Promise<EventPage>;
  /** Events with an id at or after `from`, in order, for replay on a push stream. */
  abstract readFrom(from: bigint, limit: number): Promise<EventRecord[]>;
  abstract prune(): Promise<number>;
  abstract count(): Promise<number>;
  async close(): Promise<void> {}
}

/** A log in memory: tests and runs without a database. */
export class MemoryEventLog extends EventLog {
  private readonly rows: EventRecord[] = [];
  private next = 1n;
  private floor = 0n; // the highest id ever removed
  private readonly logId = randomUUID();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  async append(events: NewEvent[]): Promise<EventRecord[]> {
    const at = new Date(this.now()).toISOString();
    const records = events.map(e => ({ id: String(this.next++), at, kind: e.kind, uri: e.uri, incidentId: e.incidentId ?? null, labels: e.labels ?? {}, actor: e.actor ?? null, state: e.state, stateBefore: e.stateBefore, fullLabels: e.fullLabels }));
    this.rows.push(...records);
    return records;
  }

  async committed(records: EventRecord[]): Promise<void> {
    for (const r of records) this.onRecorded?.(r.kind);
    this.emit(records);
  }

  async head(): Promise<EventHead> {
    const newest = this.rows.at(-1);
    return { logId: this.logId, latest: highest(newest ? BigInt(newest.id) : null, this.floor), oldestRetained: this.rows[0]?.id ?? null };
  }

  async readAfter(after: bigint, limit: number, filter: EventFilter = {}): Promise<EventPage> {
    const head = await this.head();
    const reset = isReset(after, head.latest, this.floor);
    const start = pageStart(after, reset, head.oldestRetained);
    const rows = this.rows.filter(r => BigInt(r.id) > start);
    const page = rows.slice(0, limit);
    return {
      events: page.filter(e => passes(e, filter)),
      nextAfter: page.length ? page[page.length - 1]!.id : reset ? (head.latest ?? '0') : String(after),
      hasMore: rows.length > page.length,
      ...head,
      reset,
    };
  }

  async readFrom(from: bigint, limit: number): Promise<EventRecord[]> {
    return this.rows.filter(r => BigInt(r.id) >= from).slice(0, limit);
  }

  async prune(): Promise<number> {
    const cutoff = this.now() - RETENTION_MS;
    let n = 0;
    while (this.rows.length && (Date.parse(this.rows[0]!.at) < cutoff || this.rows.length > MAX_EVENTS)) {
      this.floor = BigInt(this.rows.shift()!.id);
      n++;
    }
    return n;
  }

  async count(): Promise<number> {
    return this.rows.length;
  }
}

export const EVENT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mcp_events (
    id bigserial PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    kind text NOT NULL,
    uri text NOT NULL,
    incident_id text,
    labels jsonb NOT NULL DEFAULT '{}'::jsonb,
    actor text,
    state text
  )`,
  'ALTER TABLE mcp_events ADD COLUMN IF NOT EXISTS state_before text',
  'ALTER TABLE mcp_events ADD COLUMN IF NOT EXISTS full_labels jsonb',
  'CREATE INDEX IF NOT EXISTS mcp_events_at_idx ON mcp_events (at)',
  'CREATE TABLE IF NOT EXISTS mcp_event_floor (one boolean PRIMARY KEY DEFAULT true CHECK (one), floor bigint NOT NULL DEFAULT 0)',
  'ALTER TABLE mcp_event_floor ADD COLUMN IF NOT EXISTS log_id uuid NOT NULL DEFAULT gen_random_uuid()',
  'INSERT INTO mcp_event_floor (one, floor) VALUES (true, 0) ON CONFLICT DO NOTHING',
];

/** Held by every transaction that writes events, so event ids commit in order (contract section 8.1). */
const EVENT_LOCK = 7_483_920_117;
export const NOTIFY_CHANNEL = 'headlamp_mcp_events';

interface Row {
  id: string;
  at: Date;
  kind: string;
  uri: string;
  incident_id: string | null;
  labels: Record<string, string>;
  actor: string | null;
  state: string | null;
  state_before: string | null;
  full_labels: Record<string, string> | null;
}

const COLUMNS = 'id::text AS id, at, kind, uri, incident_id, labels, actor, state, state_before, full_labels';

const toRecord = (r: Row): EventRecord => ({
  id: String(r.id),
  at: new Date(r.at).toISOString(),
  kind: r.kind,
  uri: r.uri,
  incidentId: r.incident_id,
  labels: r.labels ?? {},
  actor: r.actor,
  state: (r.state ?? undefined) as EventRecord['state'],
  stateBefore: (r.state_before ?? undefined) as EventRecord['stateBefore'],
  fullLabels: r.full_labels ?? undefined,
});

/** The log in PostgreSQL. A pod hears of events that another pod wrote through LISTEN/NOTIFY. */
export class PgEventLog extends EventLog {
  private delivered = 0n;
  private delivering: Promise<void> = Promise.resolve();
  private failures = 0;
  private retry: NodeJS.Timeout | undefined;
  private closed = false;
  private unlisten: (() => Promise<void>) | undefined;

  constructor(
    private readonly db: Db & { listen?: (channel: string, onNotify: () => void) => Promise<() => Promise<void>> },
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  /** Creates the tables. The caller holds the schema lock. */
  static schema(): string[] {
    return EVENT_SCHEMA;
  }

  /** Starts delivery from the newest event on. Events from before this start are never sent as live events. */
  async start(): Promise<void> {
    const head = await this.head();
    this.delivered = head.latest ? BigInt(head.latest) : 0n;
    if (this.db.listen) this.unlisten = await this.db.listen(NOTIFY_CHANNEL, () => void this.deliver());
  }

  async append(events: NewEvent[], tx?: Tx): Promise<EventRecord[]> {
    if (!events.length) return [];
    const run = async (t: Tx): Promise<EventRecord[]> => {
      await t.query('SELECT pg_advisory_xact_lock($1)', [EVENT_LOCK]);
      const out: EventRecord[] = [];
      for (const e of events) {
        const r = await t.query(
          // `at` is the database clock at the insert, after the lock: it grows with the id, so removal by age removes a prefix (contract section 8.1).
          `INSERT INTO mcp_events (at, kind, uri, incident_id, labels, actor, state, state_before, full_labels) VALUES (clock_timestamp(), $1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb) RETURNING ${COLUMNS}`,
          [e.kind, e.uri, e.incidentId ?? null, JSON.stringify(e.labels ?? {}), e.actor ?? null, e.state ?? null, e.stateBefore ?? null, e.fullLabels ? JSON.stringify(e.fullLabels) : null],
        );
        out.push(toRecord(r.rows[0] as Row));
      }
      await t.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, out[out.length - 1]!.id]);
      return out;
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  async committed(records: EventRecord[]): Promise<void> {
    for (const r of records) this.onRecorded?.(r.kind);
    await this.deliver();
  }

  /** Reads what this pod has not delivered yet and sends it, one run at a time. */
  deliver(): Promise<void> {
    this.delivering = this.delivering
      .then(async () => {
        for (;;) {
          const rows = await this.readFrom(this.delivered + 1n, 500);
          if (!rows.length) return;
          this.delivered = BigInt(rows[rows.length - 1]!.id);
          this.emit(rows);
          if (rows.length < 500) return;
        }
      })
      .then(() => {
        this.failures = 0;
      })
      .catch(() => this.retryLater());
    return this.delivering;
  }

  /** A failed read is tried again with a back-off (1 s, then double, at most 30 s), so a database blip loses no live event. */
  private retryLater(): void {
    if (this.retry || this.closed) return;
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5));
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.deliver();
    }, wait);
    this.retry.unref();
  }

  async head(): Promise<EventHead> {
    return (await this.headAndFloor()).head;
  }

  /** The head and the high-water mark of removed ids. `latest` is the highest id ever stored (contract section 8.3). */
  private async headAndFloor(): Promise<{ head: EventHead; floor: bigint }> {
    const r = await this.db.query('SELECT min(id)::text AS oldest, max(id)::text AS newest FROM mcp_events');
    const log = await this.db.query('SELECT log_id::text AS id, floor::text AS floor FROM mcp_event_floor');
    const floor = BigInt((log.rows[0]?.floor as string | undefined) ?? '0');
    const newest = r.rows[0]?.newest as string | null | undefined;
    return {
      floor,
      head: { logId: (log.rows[0]?.id as string | undefined) ?? '00000000-0000-0000-0000-000000000000', latest: highest(newest ? BigInt(newest) : null, floor), oldestRetained: (r.rows[0]?.oldest as string | null) ?? null },
    };
  }

  async readAfter(after: bigint, limit: number, filter: EventFilter = {}): Promise<EventPage> {
    const { head, floor } = await this.headAndFloor();
    const reset = isReset(after, head.latest, floor);
    const start = pageStart(after, reset, head.oldestRetained);
    const r = await this.db.query(`SELECT ${COLUMNS} FROM mcp_events WHERE id > $1 ORDER BY id ASC LIMIT $2`, [String(start), limit + 1]);
    const rows = (r.rows as Row[]).map(toRecord);
    const page = rows.slice(0, limit);
    return {
      events: page.filter(e => passes(e, filter)),
      nextAfter: page.length ? page[page.length - 1]!.id : reset ? (head.latest ?? '0') : String(after),
      hasMore: rows.length > page.length,
      ...head,
      reset,
    };
  }

  async readFrom(from: bigint, limit: number): Promise<EventRecord[]> {
    const r = await this.db.query(`SELECT ${COLUMNS} FROM mcp_events WHERE id >= $1 ORDER BY id ASC LIMIT $2`, [String(from), limit]);
    return (r.rows as Row[]).map(toRecord);
  }

  async prune(): Promise<number> {
    const cutoff = new Date(this.now() - RETENTION_MS);
    return this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [EVENT_LOCK]);
      const r = await tx.query(
        `WITH doomed AS (
           SELECT id FROM mcp_events WHERE id <= coalesce((SELECT max(id) FROM mcp_events WHERE at < $1), 0)
           UNION SELECT id FROM (SELECT id FROM mcp_events ORDER BY id DESC OFFSET $2) over_cap
         ), gone AS (DELETE FROM mcp_events WHERE id IN (SELECT id FROM doomed) RETURNING id)
         SELECT count(*)::int AS n, coalesce(max(id), 0)::text AS top FROM gone`,
        [cutoff, MAX_EVENTS],
      );
      const n = r.rows[0]?.n as number;
      if (n > 0) await tx.query('UPDATE mcp_event_floor SET floor = greatest(floor, $1::bigint)', [r.rows[0]!.top]);
      return n;
    });
  }

  async count(): Promise<number> {
    return (await this.db.query('SELECT count(*)::int AS n FROM mcp_events')).rows[0]!.n as number;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    await this.unlisten?.();
  }
}
