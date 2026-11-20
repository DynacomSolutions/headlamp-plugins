import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnosis } from './agent/report.js';

export const LEASE_MS = 60_000;
const EPOCH = new Date(0).toISOString();

export interface StoreOptions {
  /** Identity of this process. Defaults to the pod name. */
  owner?: string;
  /** Clock in milliseconds, for tests. */
  now?: () => number;
}

/** A diagnosis as the list shows it: no A2UI messages and no evidence, only how many items of evidence there are. */
export type DiagnosisSummary = Omit<Diagnosis, 'a2ui' | 'evidence'> & { evidenceCount: number };

export interface PageOptions {
  offset?: number;
  limit?: number;
  /** Only diagnoses whose alert name holds this text (case-insensitive). */
  alert?: string;
}

export interface Page {
  /** Every stored diagnosis that matches, not only this page. */
  total: number;
  diagnoses: DiagnosisSummary[];
}

export interface UpdateOptions {
  /** Skip the owner check (a resolve by any pod). */
  force?: boolean;
  /** Write only when no record exists. */
  exclusive?: boolean;
}

export function summarize({ a2ui: _a2ui, evidence, ...d }: Diagnosis): DiagnosisSummary {
  return { ...d, evidenceCount: evidence.length };
}

/**
 * The diagnoses. Nothing here deletes a diagnosis: the history is kept for ever (owner rule, 20 Nov 2026).
 * Queued and running records have an owner and a lease, so two pods of a rollout never run the same one.
 * `update` is the only way to change a record. It reads, changes and writes under one lock, and a record
 * that another owner holds with a live lease is never overwritten.
 */
export abstract class DiagnosisStore {
  readonly owner: string;
  protected readonly clock: () => number;

  constructor(options: StoreOptions = {}) {
    this.owner = options.owner ?? process.env.HOSTNAME ?? `pid-${process.pid}`;
    this.clock = options.now ?? Date.now;
  }

  now(): number {
    return this.clock();
  }

  /** A new lease end, as an ISO time. */
  lease(): string {
    return new Date(this.now() + LEASE_MS).toISOString();
  }

  /** A lease end that is already over, to hand a record back. */
  static released(): string {
    return EPOCH;
  }

  /** True when nobody holds the record: no lease, or the lease ran out. */
  expired(d: Diagnosis): boolean {
    return !d.leaseUntil || Date.parse(d.leaseUntil) <= this.now();
  }

  /** Prepare the store: create the schema and import the old JSON files. Call once before use. */
  abstract init(): Promise<void>;
  abstract close(): Promise<void>;
  abstract get(id: string): Promise<Diagnosis | undefined>;
  /** One page, newest first, and the total. Reads only the page, never the whole history. */
  abstract page(options?: PageOptions): Promise<Page>;
  /** Queued or running diagnoses whose lease ran out, oldest first. */
  abstract stale(): Promise<Diagnosis[]>;
  /** How many diagnoses from the webhook were created at or after `sinceMs`. */
  abstract countWebhookSince(sinceMs: number): Promise<number>;
  abstract findByFingerprint(fingerprint: string, startsAt: string): Promise<Diagnosis | undefined>;
  /** Fingerprints of firing alerts that have an unresolved diagnosis: ids to mark as resolved. */
  protected abstract unresolvedIds(fingerprint: string): Promise<string[]>;
  /**
   * Read, change and write one record under its lock. `fn` gets the stored record (undefined when none) and
   * returns the new one, or undefined to leave it. Returns false, and writes nothing, when `fn` declines, when
   * another owner holds the stored record (queued or running) with a live lease, or, with `exclusive`, when
   * the record exists. A record whose lease ran out can be taken over. A `resolvedAt` that is already stored is kept.
   */
  abstract update(id: string, fn: (current: Diagnosis | undefined) => Diagnosis | undefined, options?: UpdateOptions): Promise<boolean>;

  /** Write a record. See `update` for when this returns false. */
  put(d: Diagnosis): Promise<boolean> {
    return this.update(d.id, () => d);
  }

  /** Create a record only if none exists. False means one is already there and nothing was written. */
  putNew(d: Diagnosis): Promise<boolean> {
    return this.update(d.id, () => d, { exclusive: true });
  }

  /** Any pod may do this, whoever owns the record. `put` keeps the mark when the owner writes later. */
  async markResolved(fingerprint: string, at: string): Promise<void> {
    for (const id of await this.unresolvedIds(fingerprint)) {
      await this.update(id, d => (d && !d.resolvedAt ? { ...d, resolvedAt: at } : undefined), { force: true });
    }
  }

  /** The decision `update` takes before it writes. Returns the record to write, or undefined to write nothing. */
  protected decide(current: Diagnosis | undefined, fn: (current: Diagnosis | undefined) => Diagnosis | undefined, options: UpdateOptions): Diagnosis | undefined {
    if (options.exclusive && current) return undefined;
    let next = fn(current);
    if (!next) return undefined;
    if (!options.force && current && (current.status === 'queued' || current.status === 'running') && current.owner && current.owner !== next.owner && !this.expired(current)) return undefined;
    if (current?.resolvedAt && !next.resolvedAt) next = { ...next, resolvedAt: current.resolvedAt };
    return next;
  }
}

/** Diagnoses in memory only. For tests and for a run without a database. They are gone when the process ends. */
export class MemoryDiagnosisStore extends DiagnosisStore {
  private readonly records = new Map<string, Diagnosis>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async get(id: string): Promise<Diagnosis | undefined> {
    return this.records.get(id);
  }

  private sorted(): Diagnosis[] {
    return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async page(options: PageOptions = {}): Promise<Page> {
    const f = options.alert?.toLowerCase();
    const all = this.sorted().filter(d => !f || d.alert.name.toLowerCase().includes(f));
    const offset = options.offset ?? 0;
    return { total: all.length, diagnoses: all.slice(offset, options.limit === undefined ? undefined : offset + options.limit).map(summarize) };
  }

  async stale(): Promise<Diagnosis[]> {
    return this.sorted()
      .filter(d => (d.status === 'queued' || d.status === 'running') && this.expired(d))
      .reverse();
  }

  async countWebhookSince(sinceMs: number): Promise<number> {
    return this.sorted().filter(d => d.source === 'webhook' && Date.parse(d.createdAt) >= sinceMs).length;
  }

  async findByFingerprint(fingerprint: string, startsAt: string): Promise<Diagnosis | undefined> {
    return this.sorted().find(d => d.alert.fingerprint === fingerprint && d.alert.startsAt === startsAt);
  }

  protected async unresolvedIds(fingerprint: string): Promise<string[]> {
    return this.sorted()
      .filter(d => d.alert.fingerprint === fingerprint && !d.resolvedAt)
      .map(d => d.id);
  }

  async update(id: string, fn: (current: Diagnosis | undefined) => Diagnosis | undefined, options: UpdateOptions = {}): Promise<boolean> {
    // No await between the read and the write, so this is atomic in one process.
    const next = this.decide(this.records.get(id), fn, options);
    if (!next) return false;
    this.records.set(next.id, next);
    return true;
  }
}

/** The result of a query. `rows` hold the selected columns. */
export interface QueryResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[];
  rowCount: number | null;
}

/** The part of a database client that the store uses. `pg` and PGlite both fit behind it. */
export interface Db {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  /** Run `fn` in one transaction. A thrown error rolls it back. */
  transaction<T>(fn: (tx: { query: Db['query'] }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS diagnoses (
    id text PRIMARY KEY,
    created_at timestamptz NOT NULL,
    status text NOT NULL,
    source text NOT NULL,
    alert_name text NOT NULL,
    fingerprint text NOT NULL,
    starts_at text NOT NULL DEFAULT '',
    resolved boolean NOT NULL DEFAULT false,
    lease_until timestamptz,
    data jsonb NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS diagnoses_created_idx ON diagnoses (created_at DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS diagnoses_fingerprint_idx ON diagnoses (fingerprint, starts_at)',
  "CREATE INDEX IF NOT EXISTS diagnoses_open_idx ON diagnoses (created_at) WHERE status IN ('queued', 'running')",
  "CREATE INDEX IF NOT EXISTS diagnoses_webhook_idx ON diagnoses (created_at) WHERE source = 'webhook'",
];

/** Any 64-bit number. Two pods that start together take this advisory lock, so only one creates the schema. */
const SCHEMA_LOCK = 7_483_920_115;
const SUMMARY_SQL = "(data - 'a2ui' - 'evidence') || jsonb_build_object('evidenceCount', jsonb_array_length(COALESCE(data->'evidence', '[]'::jsonb)))";

function created(d: Diagnosis, now: number): Date {
  const t = Date.parse(d.createdAt);
  return new Date(Number.isFinite(t) ? t : now);
}

function lease(d: Diagnosis): Date | null {
  const t = d.leaseUntil ? Date.parse(d.leaseUntil) : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * Diagnoses in the shared PostgreSQL cluster (`pg-shared`). One row each, the whole record as `data` (jsonb)
 * and the fields the queries need as columns, so a list reads one page and a count never loads a record.
 * Two pods share the table. `update` locks the row (`SELECT ... FOR UPDATE`), so the lease checks hold.
 */
export class PgDiagnosisStore extends DiagnosisStore {
  constructor(
    private readonly db: Db,
    private readonly dataDir = '',
    options: StoreOptions = {},
    private readonly log: (message: string, extra?: Record<string, unknown>) => void = () => {},
  ) {
    super(options);
  }

  async init(): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK]);
      for (const statement of SCHEMA) await tx.query(statement);
    });
    if (this.dataDir) {
      const imported = await this.importFiles(this.dataDir);
      if (imported > 0) this.log('imported diagnoses from the data directory', { imported });
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * Copies the JSON files of the old store (`diagnoses/<id>.json` and the single file `diagnoses.json[.migrated]`)
   * into the table. A record that is already there stays as it is, so this is safe to run at every start
   * and by two pods. The files stay where they are.
   */
  async importFiles(dataDir: string): Promise<number> {
    const files: string[] = [];
    const dir = join(dataDir, 'diagnoses');
    if (existsSync(dir)) for (const name of readdirSync(dir)) if (name.endsWith('.json')) files.push(join(dir, name));
    for (const name of ['diagnoses.json', 'diagnoses.json.migrated']) if (existsSync(join(dataDir, name))) files.push(join(dataDir, name));
    let imported = 0;
    for (const file of files) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue; // A half-written file. The next start sees it again.
      }
      for (const d of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!d || typeof d !== 'object' || typeof (d as Diagnosis).id !== 'string' || !/^[A-Za-z0-9_-]+$/.test((d as Diagnosis).id) || !(d as Diagnosis).alert) continue;
        if (await this.insert(this.db, d as Diagnosis)) imported++;
      }
    }
    return imported;
  }

  private async insert(db: { query: Db['query'] }, d: Diagnosis): Promise<boolean> {
    const r = await db.query(
      `INSERT INTO diagnoses (id, created_at, status, source, alert_name, fingerprint, starts_at, resolved, lease_until, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) ON CONFLICT (id) DO NOTHING`,
      [d.id, created(d, this.now()), d.status, d.source, d.alert.name ?? '', d.alert.fingerprint ?? '', d.alert.startsAt ?? '', Boolean(d.resolvedAt), lease(d), JSON.stringify(d)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async get(id: string): Promise<Diagnosis | undefined> {
    const r = await this.db.query('SELECT data FROM diagnoses WHERE id = $1', [id]);
    return r.rows[0]?.data as Diagnosis | undefined;
  }

  async page(options: PageOptions = {}): Promise<Page> {
    const alert = options.alert ?? null;
    const where = '($1::text IS NULL OR position(lower($1) in lower(alert_name)) > 0)';
    const total = await this.db.query(`SELECT count(*)::int AS n FROM diagnoses WHERE ${where}`, [alert]);
    const rows = await this.db.query(`SELECT ${SUMMARY_SQL} AS d FROM diagnoses WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`, [alert, options.limit ?? null, options.offset ?? 0]);
    return { total: total.rows[0].n as number, diagnoses: rows.rows.map(r => r.d as DiagnosisSummary) };
  }

  async stale(): Promise<Diagnosis[]> {
    const r = await this.db.query("SELECT data FROM diagnoses WHERE status IN ('queued', 'running') AND (lease_until IS NULL OR lease_until <= $1) ORDER BY created_at ASC, id ASC", [new Date(this.now())]);
    return r.rows.map(row => row.data as Diagnosis);
  }

  async countWebhookSince(sinceMs: number): Promise<number> {
    const r = await this.db.query("SELECT count(*)::int AS n FROM diagnoses WHERE source = 'webhook' AND created_at >= $1", [new Date(sinceMs)]);
    return r.rows[0].n as number;
  }

  async findByFingerprint(fingerprint: string, startsAt: string): Promise<Diagnosis | undefined> {
    const r = await this.db.query('SELECT data FROM diagnoses WHERE fingerprint = $1 AND starts_at = $2 ORDER BY created_at DESC LIMIT 1', [fingerprint, startsAt]);
    return r.rows[0]?.data as Diagnosis | undefined;
  }

  protected async unresolvedIds(fingerprint: string): Promise<string[]> {
    const r = await this.db.query('SELECT id FROM diagnoses WHERE fingerprint = $1 AND NOT resolved', [fingerprint]);
    return r.rows.map(row => row.id as string);
  }

  async update(id: string, fn: (current: Diagnosis | undefined) => Diagnosis | undefined, options: UpdateOptions = {}): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid diagnosis id: ${id}`);
    return this.db.transaction(async tx => {
      const row = await tx.query('SELECT data FROM diagnoses WHERE id = $1 FOR UPDATE', [id]);
      const current = row.rows[0]?.data as Diagnosis | undefined;
      const next = this.decide(current, fn, options);
      if (!next) return false;
      if (!current) return this.insert(tx, next); // False when another pod created it a moment ago.
      await tx.query(
        'UPDATE diagnoses SET created_at = $2, status = $3, source = $4, alert_name = $5, fingerprint = $6, starts_at = $7, resolved = $8, lease_until = $9, data = $10::jsonb WHERE id = $1',
        [id, created(next, this.now()), next.status, next.source, next.alert.name ?? '', next.alert.fingerprint ?? '', next.alert.startsAt ?? '', Boolean(next.resolvedAt), lease(next), JSON.stringify(next)],
      );
      return true;
    });
  }
}

/** A `Db` on a `pg` pool. `pg` is loaded here only, so the tests need no driver. */
export async function connectPg(connectionString: string): Promise<Db> {
  const { default: pg } = await import('pg');
  // The pooler serves TLS with the cluster certificate. `sslmode=require` means encrypt without verifying it.
  const url = new URL(connectionString);
  const mode = url.searchParams.get('sslmode') ?? 'require';
  url.searchParams.delete('sslmode');
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, ssl: mode === 'disable' ? false : { rejectUnauthorized: false } });
  pool.on('error', () => {}); // An idle client lost its connection. The pool replaces it.
  return {
    query: (text, params) => pool.query(text, params as unknown[]),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (text, params) => client.query(text, params as unknown[]) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** The store for this configuration: PostgreSQL when `databaseUrl` is set, else memory only. */
export async function openDiagnosisStore(databaseUrl: string, dataDir: string, log: (message: string, extra?: Record<string, unknown>) => void = () => {}, options: StoreOptions = {}): Promise<DiagnosisStore> {
  const store = databaseUrl ? new PgDiagnosisStore(await connectPg(databaseUrl), dataDir, options, log) : new MemoryDiagnosisStore(options);
  await store.init();
  return store;
}
