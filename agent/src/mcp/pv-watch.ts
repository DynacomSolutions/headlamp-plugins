import type { EventLog } from '../incidents/events.js';
import { storageUri } from '../incidents/types.js';

/** The part of the Kubernetes client that the watch needs. */
export interface WatchClient {
  request(path: string, accept?: string, timeoutMs?: number): Promise<Response>;
  getJson<T = unknown>(path: string): Promise<T>;
}

interface PvObject {
  metadata?: { name?: string; resourceVersion?: string };
  status?: { phase?: string };
}

const PATH = '/api/v1/persistentvolumes';
const WATCH_SECONDS = 300;

/**
 * The event source of `storage.updated` (contract section 7.1): a Kubernetes watch on PersistentVolumes.
 * A volume that appears, disappears or changes its phase raises one event for `headlamp://storage/volumes`.
 * The watch is a stream that the API server pushes, not a poll. After a break it lists again and compares, so no change is lost.
 */
export class PvWatch {
  private phases = new Map<string, string>();
  private stopped = false;
  private abort: AbortController | undefined;
  private task: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly kube: WatchClient,
    private readonly events: EventLog,
    private readonly log: (level: 'info' | 'warn', message: string, extra?: Record<string, unknown>) => void = () => {},
    private readonly retryMs = 5000,
  ) {}

  start(): void {
    this.task = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    this.wake?.();
    await this.task?.catch(() => {});
  }

  private async raise(): Promise<void> {
    const stored = await this.events.append([{ kind: 'storage.updated', uri: storageUri('volumes'), incidentId: null, labels: {} }]);
    await this.events.committed(stored);
  }

  /** Compares one volume with what the watch knew. Returns true when it is a change. */
  private seen(name: string, phase: string | undefined, deleted: boolean): boolean {
    const before = this.phases.get(name);
    if (deleted) return this.phases.delete(name);
    const now = phase ?? '';
    this.phases.set(name, now);
    return before !== now;
  }

  private async run(): Promise<void> {
    let first = true;
    while (!this.stopped) {
      try {
        const list = await this.kube.getJson<{ metadata?: { resourceVersion?: string }; items?: PvObject[] }>(`${PATH}?limit=500`);
        const next = new Map<string, string>();
        for (const pv of list.items ?? []) if (pv.metadata?.name) next.set(pv.metadata.name, pv.status?.phase ?? '');
        const changed = !first && (next.size !== this.phases.size || [...next].some(([k, v]) => this.phases.get(k) !== v));
        this.phases = next;
        first = false;
        if (changed) await this.raise();
        await this.watch(list.metadata?.resourceVersion);
      } catch (error) {
        if (this.stopped) return;
        this.log('warn', 'persistent volume watch failed', { error: String(error) });
      }
      if (!this.stopped) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, this.retryMs);
          timer.unref();
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = undefined;
      }
    }
  }

  private async watch(resourceVersion: string | undefined): Promise<void> {
    this.abort = new AbortController();
    const res = await this.kube.request(`${PATH}?watch=true&allowWatchBookmarks=true&timeoutSeconds=${WATCH_SECONDS}${resourceVersion ? `&resourceVersion=${encodeURIComponent(resourceVersion)}` : ''}`, 'application/json', (WATCH_SECONDS + 30) * 1000);
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    this.abort.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}));
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        const e = JSON.parse(line) as { type?: string; object?: PvObject };
        if (e.type === 'ERROR') throw new Error('the watch ended with an error event');
        if (e.type === 'BOOKMARK' || !e.object?.metadata?.name) continue;
        if (this.seen(e.object.metadata.name, e.object.status?.phase, e.type === 'DELETED')) await this.raise();
      }
    }
  }
}
