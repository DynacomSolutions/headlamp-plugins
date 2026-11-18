import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnosis } from './agent/report.js';

/**
 * Diagnoses, newest first, capped at `max`. Kept in memory and, when a data
 * directory is set, written to one JSON file (atomic rename) so they survive
 * container restarts. No database: a few hundred reports are a few MiB.
 */
export class DiagnosisStore {
  private items: Diagnosis[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<(d: Diagnosis) => void>();

  constructor(
    private readonly dataDir: string,
    private readonly max: number,
  ) {
    if (dataDir) {
      try {
        const parsed = JSON.parse(readFileSync(this.file(), 'utf8')) as Diagnosis[];
        // Queued and running diagnoses stay as they are. The server runs them again at start (see interrupted()).
        // A resolved alert needs no new run, so those are closed as failed.
        this.items = parsed.slice(0, max).map(d => ((d.status === 'running' || d.status === 'queued') && d.resolvedAt ? { ...d, status: 'failed', error: 'Interrupted by a restart' } : d));
      } catch {
        this.items = [];
      }
    }
  }

  private file(): string {
    return join(this.dataDir, 'diagnoses.json');
  }

  onChange(listener: (d: Diagnosis) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  put(d: Diagnosis): void {
    const i = this.items.findIndex(x => x.id === d.id);
    if (i >= 0) this.items[i] = d;
    else this.items.unshift(d);
    if (this.items.length > this.max) this.items.length = this.max;
    for (const l of this.listeners) l(d);
    this.persistSoon();
  }

  get(id: string): Diagnosis | undefined {
    return this.items.find(d => d.id === id);
  }

  list(): Diagnosis[] {
    return this.items;
  }

  /** Diagnoses that were queued or running when the process stopped, newest first. */
  interrupted(): Diagnosis[] {
    return this.items.filter(d => (d.status === 'queued' || d.status === 'running') && !d.resolvedAt);
  }

  findByFingerprint(fingerprint: string, startsAt: string): Diagnosis | undefined {
    return this.items.find(d => d.alert.fingerprint === fingerprint && d.alert.startsAt === startsAt);
  }

  markResolved(fingerprint: string, at: string): void {
    for (const d of this.items) {
      if (d.alert.fingerprint === fingerprint && !d.resolvedAt) {
        d.resolvedAt = at;
        for (const l of this.listeners) l(d);
      }
    }
    this.persistSoon();
  }

  private persistSoon(): void {
    if (!this.dataDir || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 1000);
  }

  flush(): void {
    if (!this.dataDir) return;
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items));
    renameSync(tmp, this.file());
  }
}
