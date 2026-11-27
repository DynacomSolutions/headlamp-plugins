import type { Db } from '../store.js';
import type { EventRecord, NewEvent } from './types.js';
import { kindMatches } from './model.js';

/** Events are kept 7 days and at most 100 000 (contract section 8.2). */
export const RETENTION_MS = 7 * 24 * 3600_000;
export const MAX_EVENTS = 100_000;

export interface EventFilter {
  kinds?: string[];
  labels?: Record<string, string>;
}

export interface EventPage {
  events: EventRecord[];
  nextAfter: string;
  hasMore: boolean;
  latest: string | null;
  oldestRetained: string | null;
  reset: boolean;
}

export interface EventHead {
  latest: string | null;
  oldestRetained: string | null;
}

export type EventListener = (event: EventRecord) => void;

type Tx = { query: Db['query'] };

/** Removes the internal fields before an event goes to a client. */
export function publicEvent({ state: _state, ...e }: EventRecord): Omit<EventRecord, 'state'> {
  return e;
}

function passes(e: EventRecord, f: EventFilter): boolean {
  if (f.kinds?.length && !kindMatches(f.kinds, e.kind)) return false;
  return Object.entries(f.labels ?? {}).every(([k, v]) => e.labels[k] === v);
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
  /** Tells the log that the transaction of `append` committed: now the events are delivered. */
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

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  async append(events: NewEvent[]): Promise<EventRecord[]> {
    const at = new Date(this.now()).toISOString();
    const records = events.map(e => ({ id: String(this.next++), at, kind: e.kind, uri: e.uri, incidentId: e.incidentId ?? null, labels: e.labels ?? {}, actor: e.actor ?? null, state: e.state }));
    this.rows.push(...records);
    for (const r of records) this.onRecorded?.(r.kind);
    return records;
  }

  async committed(records: EventRecord[]): Promise<void> {
    this.emit(records);
  }

  async head(): Promise<EventHead> {
    return { latest: this.rows.at(-1)?.id ?? null, oldestRetained: this.rows[0]?.id ?? null };
  }

  async readAfter(after: bigint, limit: number, filter: EventFilter = {}): Promise<EventPage> {
    const head = await this.head();
    const rows = this.rows.filter(r => BigInt(r.id) > after);
    const page = rows.slice(0, limit);
    return {
      events: page.filter(e => passes(e, filter)),
      nextAfter: page.length ? page[page.length - 1]!.id : String(after),
      hasMore: rows.length > page.length,
      ...head,
      reset: after !== 0n && after < this.floor,
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
  'CREATE INDEX IF NOT EXISTS mcp_events_at_idx ON mcp_events (at)',
  'CREATE TABLE IF NOT EXISTS mcp_event_floor (one boolean PRIMARY KEY DEFAULT true CHECK (one), floor bigint NOT NULL DEFAULT 0)',
  'INSERT INTO mcp_event_floor (one, floor) VALUES (true, 0) ON CONFLICT DO NOTHING',
];

/** Held by every transaction that writes events, so event ids commit in order (contract section 8.1). */
const EVENT_LOCK = 7_483_920_116;
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
}

const toRecord = (r: Row): EventRecord => ({ id: String(r.id), at: new Date(r.at).toISOString(), kind: r.kind, uri: r.uri, incidentId: r.incident_id, labels: r.labels ?? {}, actor: r.actor, state: (r.state ?? undefined) as EventRecord['state'] });

/** The log in PostgreSQL. A pod hears of events that another pod wrote through LISTEN/NOTIFY. */
export class PgEventLog extends EventLog {
  private delivered = 0n;
  private delivering: Promise<void> = Promise.resolve();
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
          'INSERT INTO mcp_events (at, kind, uri, incident_id, labels, actor, state) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id, at, kind, uri, incident_id, labels, actor, state',
          [new Date(this.now()), e.kind, e.uri, e.incidentId ?? null, JSON.stringify(e.labels ?? {}), e.actor ?? null, e.state ?? null],
        );
        out.push(toRecord(r.rows[0] as Row));
      }
      await t.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, out[out.length - 1]!.id]);
      for (const r of out) this.onRecorded?.(r.kind);
      return out;
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  async committed(_records: EventRecord[]): Promise<void> {
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
      .catch(() => {});
    return this.delivering;
  }

  async head(): Promise<EventHead> {
    const r = await this.db.query('SELECT min(id)::text AS oldest, max(id)::text AS latest FROM mcp_events');
    return { latest: (r.rows[0]?.latest as string | null) ?? null, oldestRetained: (r.rows[0]?.oldest as string | null) ?? null };
  }

  async readAfter(after: bigint, limit: number, filter: EventFilter = {}): Promise<EventPage> {
    const head = await this.head();
    const floor = BigInt(((await this.db.query('SELECT floor::text AS f FROM mcp_event_floor')).rows[0]?.f as string | undefined) ?? '0');
    const r = await this.db.query('SELECT id::text AS id, at, kind, uri, incident_id, labels, actor, state FROM mcp_events WHERE id > $1 ORDER BY id ASC LIMIT $2', [String(after), limit + 1]);
    const rows = (r.rows as Row[]).map(toRecord);
    const page = rows.slice(0, limit);
    return {
      events: page.filter(e => passes(e, filter)),
      nextAfter: page.length ? page[page.length - 1]!.id : String(after),
      hasMore: rows.length > page.length,
      ...head,
      reset: after !== 0n && after < floor,
    };
  }

  async readFrom(from: bigint, limit: number): Promise<EventRecord[]> {
    const r = await this.db.query('SELECT id::text AS id, at, kind, uri, incident_id, labels, actor, state FROM mcp_events WHERE id >= $1 ORDER BY id ASC LIMIT $2', [String(from), limit]);
    return (r.rows as Row[]).map(toRecord);
  }

  async prune(): Promise<number> {
    const cutoff = new Date(this.now() - RETENTION_MS);
    return this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [EVENT_LOCK]);
      const r = await tx.query(
        `WITH doomed AS (
           SELECT id FROM mcp_events WHERE at < $1
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
    await this.unlisten?.();
  }
}
