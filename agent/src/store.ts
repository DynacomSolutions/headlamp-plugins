import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnosis } from './agent/report.js';

export const LEASE_MS = 60_000;
const REFRESH_MS = 2000;
const LOCK_WAIT_MS = 500;
const LOCK_STALE_MS = 10_000;
const EPOCH = new Date(0).toISOString();

export interface StoreOptions {
  /** Identity of this process. Defaults to the pod name. */
  owner?: string;
  /** Clock in milliseconds, for tests. */
  now?: () => number;
}

/**
 * Diagnoses, capped at `max`. With a data directory each one is a JSON file,
 * `<dir>/diagnoses/<id>.json`, written by atomic rename. Two processes (the old
 * and the new pod of a rollout) can share the directory: reads come from disk
 * through a short-lived cache, and a record that another owner holds with a
 * live lease is never overwritten (see `put`). Without a data directory the
 * records live in memory only. No database: a few hundred reports are a few MiB.
 */
export class DiagnosisStore {
  readonly owner: string;
  private readonly cache = new Map<string, Diagnosis>();
  private readonly meta = new Map<string, { mtimeMs: number; size: number }>();
  private readonly listeners = new Set<(d: Diagnosis) => void>();
  private readonly clock: () => number;
  private readonly dir: string;
  private dirMtime = -1;
  private loadedAt = 0;

  constructor(
    private readonly dataDir: string,
    private readonly max: number,
    options: StoreOptions = {},
  ) {
    this.owner = options.owner ?? process.env.HOSTNAME ?? `pid-${process.pid}`;
    this.clock = options.now ?? Date.now;
    this.dir = dataDir ? join(dataDir, 'diagnoses') : '';
    if (dataDir) {
      mkdirSync(this.dir, { recursive: true });
      this.migrate();
    }
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

  private file(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid diagnosis id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  /** Split an old single-file store into one file per diagnosis, once. */
  private migrate(): void {
    const old = join(this.dataDir, 'diagnoses.json');
    if (!existsSync(old)) return;
    try {
      const parsed = JSON.parse(readFileSync(old, 'utf8')) as Diagnosis[];
      for (const d of parsed) if (d?.id && !existsSync(this.file(d.id))) this.writeFile(d);
      renameSync(old, `${old}.migrated`);
    } catch {
      // Unreadable, or another pod migrated it first. Nothing more to do.
    }
  }

  private writeFile(d: Diagnosis): void {
    const target = this.file(d.id);
    const tmp = `${target}.tmp-${this.owner.replace(/[^A-Za-z0-9_.-]/g, '_')}-${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(d));
    renameSync(tmp, target);
    this.meta.delete(d.id);
  }

  private readFile(id: string): Diagnosis | undefined {
    try {
      return JSON.parse(readFileSync(this.file(id), 'utf8')) as Diagnosis;
    } catch {
      return undefined;
    }
  }

  /** Reload from disk when the directory changed or the cache is older than 2 s. */
  private refresh(): void {
    if (!this.dir) return;
    let mtime: number;
    try {
      mtime = statSync(this.dir).mtimeMs;
    } catch {
      return;
    }
    const t = this.now();
    if (mtime === this.dirMtime && t - this.loadedAt < REFRESH_MS) return;
    this.dirMtime = mtime;
    this.loadedAt = t;
    const seen = new Set<string>();
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      try {
        const st = statSync(join(this.dir, name));
        const memo = this.meta.get(id);
        if (!(memo && memo.mtimeMs === st.mtimeMs && memo.size === st.size && this.cache.has(id))) {
          this.cache.set(id, JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as Diagnosis);
          this.meta.set(id, { mtimeMs: st.mtimeMs, size: st.size });
        }
        seen.add(id);
      } catch {
        // Half-written or removed meanwhile. The next refresh sees it.
      }
    }
    for (const id of [...this.cache.keys()]) {
      if (!seen.has(id)) {
        this.cache.delete(id);
        this.meta.delete(id);
      }
    }
  }

  onChange(listener: (d: Diagnosis) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Run `fn` while holding the record's lock file, `<id>.lock`, created with
   * the exclusive flag. Waits up to about 500 ms. A lock older than 10 s is
   * left over from a crashed process and is removed. Without a data directory
   * there is nothing to share, so `fn` just runs.
   */
  withLock<T>(id: string, fn: () => T): T {
    if (!this.dir) return fn();
    const lock = `${this.file(id).slice(0, -'.json'.length)}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx'));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
            unlinkSync(lock);
            continue;
          }
        } catch {
          continue; // Gone meanwhile: try again at once.
        }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock on diagnosis ${id}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      return fn();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        // Already removed as stale.
      }
    }
  }

  /**
   * Read, change and write one record under its lock. `fn` gets the stored
   * record (undefined when none) and returns the new one, or undefined to leave
   * it. Returns false, and writes nothing, when `fn` declines, when another
   * owner holds the stored record (queued or running) with a live lease, or,
   * with `exclusive`, when the record exists. A record whose lease ran out can
   * be taken over. `force` skips the owner check (a resolve by any pod). A
   * `resolvedAt` that is already stored is kept.
   */
  update(id: string, fn: (current: Diagnosis | undefined) => Diagnosis | undefined, options: { force?: boolean; exclusive?: boolean } = {}): boolean {
    const result = this.withLock(id, () => {
      const current = this.dir ? this.readFile(id) : this.cache.get(id);
      if (options.exclusive && current) return undefined;
      let next = fn(current);
      if (!next) return undefined;
      if (!options.force && current && (current.status === 'queued' || current.status === 'running') && current.owner && current.owner !== next.owner && !this.expired(current)) return undefined;
      if (current?.resolvedAt && !next.resolvedAt) next = { ...next, resolvedAt: current.resolvedAt };
      if (this.dir) this.writeFile(next);
      this.cache.set(next.id, next);
      return { next, created: !current };
    });
    if (!result) return false;
    if (result.created) this.prune();
    for (const l of this.listeners) l(result.next);
    return true;
  }

  /** Write a record. See `update` for when this returns false. */
  put(d: Diagnosis): boolean {
    return this.update(d.id, () => d);
  }

  /** Create a record only if none exists. False means one is already there and nothing was written. */
  putNew(d: Diagnosis): boolean {
    return this.update(d.id, () => d, { exclusive: true });
  }

  /** Delete the oldest finished records beyond the cap. Queued and running ones stay. */
  private prune(): void {
    if (this.cache.size <= this.max) return;
    const finished = [...this.cache.values()].filter(d => d.status === 'done' || d.status === 'failed').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const d of finished) {
      if (this.cache.size <= this.max) break;
      if (this.dir) {
        try {
          unlinkSync(this.file(d.id));
        } catch {
          // Already removed by the other pod.
        }
      }
      this.cache.delete(d.id);
      this.meta.delete(d.id);
    }
  }

  get(id: string): Diagnosis | undefined {
    this.refresh();
    return this.cache.get(id);
  }

  /** Read the record from disk now, ignoring the cache age. */
  getFresh(id: string): Diagnosis | undefined {
    if (!this.dir) return this.cache.get(id);
    const d = this.readFile(id);
    if (d) {
      this.cache.set(id, d);
      this.meta.delete(id);
    } else {
      this.cache.delete(id);
    }
    return d;
  }

  /** All diagnoses, newest first. */
  list(): Diagnosis[] {
    this.refresh();
    return [...this.cache.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  findByFingerprint(fingerprint: string, startsAt: string): Diagnosis | undefined {
    return this.list().find(d => d.alert.fingerprint === fingerprint && d.alert.startsAt === startsAt);
  }

  /** Any pod may do this, whoever owns the record. `put` keeps the mark when the owner writes later. */
  markResolved(fingerprint: string, at: string): void {
    for (const listed of this.list()) {
      if (listed.alert.fingerprint !== fingerprint || listed.resolvedAt) continue;
      this.update(listed.id, d => (d && !d.resolvedAt ? { ...d, resolvedAt: at } : undefined), { force: true });
    }
  }
}
