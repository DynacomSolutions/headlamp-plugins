import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mask } from '../mask.js';

export type LaunchStatus = 'pending_approval' | 'rejected' | 'launching' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
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
  index?: number;
  title: string;
  detail?: string;
  command?: string;
}

export interface Launch {
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
}

export const ACTIVE_STATUSES: ReadonlySet<LaunchStatus> = new Set(['launching', 'running', 'waiting']);
export const FINAL_STATUSES: ReadonlySet<LaunchStatus> = new Set(['rejected', 'completed', 'failed', 'cancelled']);

/**
 * Launches, capped at `max`. With a data directory each launch is one JSON file,
 * `<dir>/launches/<id>.json`, written by atomic rename. Without one they live in
 * memory only. Every record is masked before it is stored or served.
 */
export class LaunchStore {
  private readonly launches = new Map<string, Launch>();
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly max: number,
  ) {
    this.dir = dataDir ? join(dataDir, 'launches') : '';
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const launch = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as Launch;
        if (launch?.id && Array.isArray(launch.timeline)) this.launches.set(launch.id, launch);
      } catch {
        // A half-written or foreign file. Skip it.
      }
    }
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
  }

  get(id: string): Launch | undefined {
    return this.launches.get(id);
  }

  /** All launches, newest request first. */
  list(): Launch[] {
    return [...this.launches.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  /** Active launches: launching, running or waiting. */
  active(): Launch[] {
    return this.list().filter(l => ACTIVE_STATUSES.has(l.status));
  }

  /** Stores a masked copy and returns it. Nothing is written when the record did not change. */
  put(launch: Launch): Launch {
    const next = mask(launch);
    const current = this.launches.get(next.id);
    if (current && JSON.stringify(current) === JSON.stringify(next)) return current;
    this.launches.set(next.id, next);
    this.writeFile(next);
    if (!current) this.prune();
    return next;
  }

  /** Drops the oldest finished launches beyond the cap. Pending and active ones stay. */
  private prune(): void {
    if (this.launches.size <= this.max) return;
    for (const l of this.list().reverse()) {
      if (this.launches.size <= this.max) break;
      if (!FINAL_STATUSES.has(l.status)) continue;
      this.launches.delete(l.id);
      if (this.dir && existsSync(this.file(l.id))) {
        try {
          unlinkSync(this.file(l.id));
        } catch {
          // Already gone.
        }
      }
    }
  }
}
