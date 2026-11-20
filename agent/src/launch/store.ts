import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mask } from '../mask.js';

export type LaunchStatus = 'pending_approval' | 'rejected' | 'expired' | 'launching' | 'running' | 'waiting' | 'tracking_lost' | 'completed' | 'failed' | 'cancelled';
export type TimelineKind = 'run' | 'message' | 'tool' | 'file_change' | 'other';
export type TimelineStatus = 'running' | 'done' | 'failed' | 'waiting';

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  title: string;
  detail?: string;
  status: TimelineStatus;
  startedAt?: string;
  finishedAt?: string;
}

export interface LaunchFix {
  /** Position in the diagnosis fixes. The server looks the fix up by it. */
  index: number;
  title: string;
  detail?: string;
  command?: string;
}

export interface Launch {
  /** The `Diagnosis.evidence` items are not copied. The brief is the only text the agent gets. */
  id: string;
  purpose: string;
  source: { diagnosisId?: string; chatId?: string; fix?: LaunchFix };
  brief: string;
  projectKey: string;
  threadId?: string;
  model: { instanceId: string; model: string };
  status: LaunchStatus;
  requestedBy: string;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  timeline: TimelineEntry[];
  lastReply?: string;
  threadLink?: string;
  /** Number of runs the last poll saw in the thread. */
  runsSeen?: number;
  /** After a message, a thread whose run count is not above `reviveRuns` is not final until `reviveUntil`. */
  reviveRuns?: number;
  reviveUntil?: string;
  /** The process that polls this launch. Another process may take over when the lease ran out. */
  owner?: string;
  leaseUntil?: string;
}

export const ACTIVE_STATUSES: ReadonlySet<LaunchStatus> = new Set(['launching', 'running', 'waiting', 'tracking_lost']);
export const FINAL_STATUSES: ReadonlySet<LaunchStatus> = new Set(['rejected', 'expired', 'completed', 'failed', 'cancelled']);

const LOCK_WAIT_MS = 500;
const LOCK_STALE_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Launches, capped at `max`. With a data directory each launch is one JSON file,
 * `<dir>/launches/<id>.json`, written by atomic rename. Without one they live in
 * memory only. Every record is masked before it is stored or served.
 *
 * Two processes (the old and the new pod of a rollout) can share the directory.
 * Reads come from disk, and `update` reads, changes and writes one record while it
 * holds the record's lock file, so a change is always made on the newest state.
 */
export class LaunchStore {
  private readonly launches = new Map<string, Launch>();
  private readonly meta = new Map<string, { mtimeMs: number; size: number }>();
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly max: number,
    private readonly lockOptions: { waitMs?: number; staleMs?: number } = {},
  ) {
    this.dir = dataDir ? join(dataDir, 'launches') : '';
    if (this.dir) mkdirSync(this.dir, { recursive: true });
    this.refresh();
  }

  private file(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid launch id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  private writeFile(launch: Launch): void {
    if (!this.dir) return;
    const target = this.file(launch.id);
    const tmp = `${target}.tmp-${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(launch));
    renameSync(tmp, target);
    this.meta.delete(launch.id);
  }

  /** Reload every file that changed on disk since the last read, and forget files that are gone. */
  private refresh(): void {
    if (!this.dir) return;
    const seen = new Set<string>();
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      try {
        const st = statSync(join(this.dir, name));
        const memo = this.meta.get(id);
        if (!(memo && memo.mtimeMs === st.mtimeMs && memo.size === st.size && this.launches.has(id))) {
          const launch = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as Launch;
          if (!launch?.id || !Array.isArray(launch.timeline)) continue;
          this.launches.set(id, launch);
          this.meta.set(id, { mtimeMs: st.mtimeMs, size: st.size });
        }
        seen.add(id);
      } catch {
        // Half-written, foreign or removed meanwhile. The next refresh sees it.
      }
    }
    for (const id of [...this.launches.keys()]) {
      if (!seen.has(id)) {
        this.launches.delete(id);
        this.meta.delete(id);
      }
    }
  }

  /** The record as it is on disk now. */
  get(id: string): Launch | undefined {
    if (this.dir) {
      try {
        const launch = JSON.parse(readFileSync(this.file(id), 'utf8')) as Launch;
        this.launches.set(id, launch);
        this.meta.delete(id);
        return launch;
      } catch {
        this.launches.delete(id);
        return undefined;
      }
    }
    return this.launches.get(id);
  }

  /** All launches, newest request first. */
  list(): Launch[] {
    this.refresh();
    return [...this.launches.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  /** Active launches: launching, running, waiting or tracking lost. Read from disk now. */
  active(): Launch[] {
    return this.list().filter(l => ACTIVE_STATUSES.has(l.status));
  }

  /**
   * Takes the lock file `name`. The file holds a random token and the time it was made. A lock
   * older than the stale limit belongs to a process that died. Breaking it is safe against a
   * second waiter and against a new owner: the stale file is first renamed to a unique name (only
   * one waiter wins the rename), and it is removed only when the renamed file still holds the
   * token that was seen as stale. When the rename caught a lock that is not stale, because its
   * owner replaced it meanwhile, the file goes back. Returns the token, or throws after the wait.
   */
  private async acquire(lock: string): Promise<string> {
    const token = randomUUID();
    const staleMs = this.lockOptions.staleMs ?? LOCK_STALE_MS;
    const deadline = Date.now() + (this.lockOptions.waitMs ?? LOCK_WAIT_MS);
    for (;;) {
      try {
        writeFileSync(lock, JSON.stringify({ token, at: Date.now() }), { flag: 'wx' });
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const seen = this.readLock(lock);
      if (seen && Date.now() - seen.at > staleMs) {
        const moved = `${lock}.stale-${randomUUID()}`;
        try {
          renameSync(lock, moved);
          const caught = this.readLock(moved);
          if (caught && caught.token === seen.token) unlinkSync(moved);
          else if (caught && Date.now() - caught.at <= staleMs) {
            // We moved a live lock: its owner replaced the stale one after we read it. Put it back.
            try {
              linkSync(moved, lock);
            } catch {
              // Someone else holds the lock now. The moved file is only a copy.
            }
            unlinkSync(moved);
          } else unlinkSync(moved);
        } catch {
          // Another waiter broke it first, or it is gone. Try again at once.
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock ${lock.split('/').pop()}`);
      await sleep(10);
    }
  }

  private readLock(lock: string): { token: string; at: number } | undefined {
    try {
      const raw = readFileSync(lock, 'utf8');
      try {
        const parsed = JSON.parse(raw) as { token?: unknown; at?: unknown };
        if (typeof parsed.token === 'string' && typeof parsed.at === 'number') return { token: parsed.token, at: parsed.at };
      } catch {
        // A lock without content: use the file time. The token is the raw text.
      }
      return { token: `raw:${raw}`, at: statSync(lock).mtimeMs };
    } catch {
      return undefined;
    }
  }

  /**
   * Runs `fn` while holding a lock file named `name`. Waits up to about 500 ms without blocking
   * the process. Without a data directory there is nothing to share, so `fn` just runs.
   */
  async withLock<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    if (!this.dir) return fn();
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Invalid lock name: ${name}`);
    const lock = join(this.dir, `${name}.lock`);
    const token = await this.acquire(lock);
    try {
      return await fn();
    } finally {
      // Remove the lock only when it is still ours.
      if (this.readLock(lock)?.token === token) {
        try {
          unlinkSync(lock);
        } catch {
          // Already removed.
        }
      }
    }
  }

  /**
   * Compare and set: reads the record from disk, gives it to `fn` and stores what `fn` returns.
   * `fn` returns undefined to leave the record as it is. Returns the stored record, or undefined
   * when `fn` declined or the record does not exist. The change is made on the newest state.
   */
  update(id: string, fn: (current: Launch) => Launch | undefined): Promise<Launch | undefined> {
    return this.withLock(id, () => {
      const current = this.get(id);
      if (!current) return undefined;
      const next = fn(current);
      return next ? this.write(next) : undefined;
    });
  }

  /** Creates a record. It is an error when the id exists. */
  create(launch: Launch): Promise<Launch> {
    return this.withLock(launch.id, () => {
      if (this.get(launch.id)) throw new Error(`Launch ${launch.id} exists`);
      const stored = this.write(launch);
      this.prune();
      return stored;
    });
  }

  private write(launch: Launch): Launch {
    const next = mask(launch);
    const current = this.launches.get(next.id);
    if (current && JSON.stringify(current) === JSON.stringify(next)) return current;
    this.launches.set(next.id, next);
    this.writeFile(next);
    return next;
  }

  /** Drops the oldest finished launches beyond the cap. Pending and active ones stay. */
  private prune(): void {
    if (this.launches.size <= this.max) return;
    for (const l of this.list().reverse()) {
      if (this.launches.size <= this.max) break;
      if (!FINAL_STATUSES.has(l.status)) continue;
      this.launches.delete(l.id);
      this.meta.delete(l.id);
      if (this.dir) {
        try {
          unlinkSync(this.file(l.id));
        } catch {
          // Already gone.
        }
      }
    }
  }

  /** How many records the store holds. */
  get size(): number {
    this.refresh();
    return this.launches.size;
  }

  get capacity(): number {
    return this.max;
  }
}
