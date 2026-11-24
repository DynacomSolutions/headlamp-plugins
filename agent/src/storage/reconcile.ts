import { randomUUID } from 'node:crypto';
import type { Metrics } from '../metrics.js';
import { raiseScanQuestion } from './findings.js';
import { ingestScan, resolveCooldowns } from './inventory.js';
import type { StorageStore } from './store.js';
import { SCAN_TIMEOUT_MS, type Scanner } from './transport.js';
import type { Decision, Trigger } from './types.js';

const DAY_MS = 24 * 60 * 60_000;
const COOLDOWN_MS = 15 * 60_000;
const SCAN_LEASE_MS = SCAN_TIMEOUT_MS + 2 * 60_000;

export class StorageReconciler {
  constructor(private readonly deps: {
    store: StorageStore;
    scanner: Scanner;
    nodes: ReadonlySet<string>;
    metrics: Metrics;
    now: () => number;
  }) {}

  async run(triggers: Trigger[]): Promise<boolean> {
    const { nodes } = this.deps;
    const byNode = new Map<string, Trigger[]>();
    for (const trigger of triggers) {
      const list = byNode.get(trigger.node) ?? [];
      list.push(trigger);
      byNode.set(trigger.node, list);
    }
    const results = await Promise.allSettled([...nodes].map(node => this.scanNode(node, byNode.get(node) ?? [])));
    return [...byNode.keys()].every(node => nodes.has(node)) && results.every(result => result.status === 'fulfilled' && result.value);
  }

  private async scanNode(node: string, triggers: Trigger[]): Promise<boolean> {
    const { store, scanner, now, metrics } = this.deps;
    const started = now();
    const owner = randomUUID();
    let claimed = false;
    try {
      const work = await store.transaction(async tx => {
        await tx.lock(`scan:${node}`);
        const full = Math.floor(await tx.lastFull(node) / DAY_MS) < Math.floor(started / DAY_MS);
        const due = await resolveCooldowns(tx, node, triggers, started, COOLDOWN_MS);
        if (!full && !due.length) return { state: 'skip' } as const;
        const lease = await tx.leaseScan(node, owner, started, SCAN_LEASE_MS);
        return lease ? { state: 'scan', full, due } as const : { state: 'busy' } as const;
      });
      if (work.state !== 'scan') return work.state === 'skip';
      claimed = true;
      const scan = await scanner.scan(node);
      if (scan.node !== node || Date.parse(scan.scannedAt) > now() + 60_000 || Date.parse(scan.scannedAt) < started - 60_000) {
        throw new Error('Scan is outside its requested node or time');
      }
      const done = await store.transaction(async tx => {
        if (!await tx.ownsScan(node, owner)) return false;
        await tx.query("SET LOCAL statement_timeout = '45s'");
        const result = await ingestScan(tx, scan, work.due, started, COOLDOWN_MS);
        for (const state of result.observed) await raiseScanQuestion(tx, state, await tx.list<Decision>('decision', state.drive.id), started);
        await tx.finishScan(node, owner, scan.complete && work.full ? started : undefined);
        return scan.complete && result.matched;
      });
      metrics.inc('headlamp_agent_storage_scan_total', { result: scan.complete ? 'complete' : 'incomplete' });
      return done;
    } catch {
      metrics.inc('headlamp_agent_storage_scan_total', { result: 'error' });
      return false;
    } finally {
      if (claimed) await store.finishScan(node, owner).catch(() => undefined);
    }
  }
}
