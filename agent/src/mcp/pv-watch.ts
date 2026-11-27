import type { EventLog } from '../incidents/events.js';
import { storageUri, type NewEvent } from '../incidents/types.js';
import { volumeOf, type KubeLike } from './extras.js';

/** The part of the Kubernetes client that the watch needs. */
export interface WatchClient {
  request(path: string, accept?: string, timeoutMs?: number): Promise<Response>;
  getJson<T = unknown>(path: string): Promise<T>;
}

type PvObject = KubeLike & { metadata?: { resourceVersion?: string } };
/** What the watch keeps of one volume: its `StorageVolume` fields as one string, and its node. */
interface Seen {
  fields: string;
  node: string | null;
}

/** The part of a volume that the contract shows (`StorageVolume`, section 5.3). The namespace of the claim is part of `claim`. */
function seenOf(pv: PvObject): Seen {
  const { claimNamespace: _ns, ...v } = volumeOf(pv);
  return { fields: JSON.stringify(v), node: v.node };
}

const PATH = '/api/v1/persistentvolumes';
const WATCH_SECONDS = 300;

/**
 * The event source of `storage.updated` (contract section 7.1): a Kubernetes watch on PersistentVolumes.
 * A volume that appears, disappears or changes any field of `StorageVolume` raises an event for `headlamp://storage/volumes`.
 * The event labels hold `node` and `volume`, so a node URI gets only its own events. A change of node raises one event for each node.
 * The watch is a stream that the API server pushes, not a poll. After a break it lists again and compares, so no change is lost.
 */
export class PvWatch {
  private volumes = new Map<string, Seen>();
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

  private async raise(changes: Array<{ volume: string; node: string | null }>): Promise<void> {
    if (!changes.length) return;
    const events: NewEvent[] = changes.map(c => ({ kind: 'storage.updated', uri: storageUri('volumes'), incidentId: null, labels: { volume: c.volume, ...(c.node ? { node: c.node } : {}) } }));
    await this.events.committed(await this.events.append(events));
  }

  /** The nodes whose volume list changes when `before` becomes `after`. Empty when nothing changed. */
  private static changed(volume: string, before: Seen | undefined, after: Seen | undefined): Array<{ volume: string; node: string | null }> {
    if (before?.fields === after?.fields) return [];
    const nodes = new Set([before?.node ?? null, after?.node ?? null]);
    return [...nodes].map(node => ({ volume, node }));
  }

  /** Compares one volume with what the watch knew. Returns the events to raise. */
  private seen(pv: PvObject, deleted: boolean): Array<{ volume: string; node: string | null }> {
    const name = pv.metadata!.name!;
    const before = this.volumes.get(name);
    if (deleted) {
      this.volumes.delete(name);
      return PvWatch.changed(name, before, undefined);
    }
    const now = seenOf(pv);
    this.volumes.set(name, now);
    return PvWatch.changed(name, before, now);
  }

  /** Reads all volumes, page by page with `continue`, so more than 500 volumes give no false change. */
  private async listAll(): Promise<{ resourceVersion?: string; items: PvObject[] }> {
    const items: PvObject[] = [];
    let resourceVersion: string | undefined;
    let next: string | undefined;
    do {
      const page = await this.kube.getJson<{ metadata?: { resourceVersion?: string; continue?: string }; items?: PvObject[] }>(`${PATH}?limit=500${next ? `&continue=${encodeURIComponent(next)}` : ''}`);
      items.push(...(page.items ?? []));
      resourceVersion ??= page.metadata?.resourceVersion;
      next = page.metadata?.continue || undefined;
    } while (next);
    return { resourceVersion, items };
  }

  private async run(): Promise<void> {
    let first = true;
    while (!this.stopped) {
      try {
        const list = await this.listAll();
        const next = new Map<string, Seen>();
        for (const pv of list.items) if (pv.metadata?.name) next.set(pv.metadata.name, seenOf(pv));
        const changes: Array<{ volume: string; node: string | null }> = [];
        if (!first) {
          for (const [name, now] of next) changes.push(...PvWatch.changed(name, this.volumes.get(name), now));
          for (const [name, was] of this.volumes) if (!next.has(name)) changes.push(...PvWatch.changed(name, was, undefined));
        }
        this.volumes = next;
        first = false;
        await this.raise(changes);
        await this.watch(list.resourceVersion);
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
        await this.raise(this.seen(e.object, e.type === 'DELETED'));
      }
    }
  }
}
