import { randomUUID } from 'node:crypto';
import type { Metrics } from '../metrics.js';
import { raiseScanQuestion } from './findings.js';
import { ingestScan, resolveCooldowns } from './inventory.js';
import type { StorageStore } from './store.js';
import { RequestDeadlineError, SCAN_TIMEOUT_MS, type Scanner } from './transport.js';
import type { Decision, FilesystemPolicy, ScanResult, Trigger } from './types.js';

const DAY_MS = 24 * 60 * 60_000;
const COOLDOWN_MS = 15 * 60_000;
const INGEST_TIMEOUT_MS = 90_000;
const SCAN_LEASE_MS = SCAN_TIMEOUT_MS + INGEST_TIMEOUT_MS + 60_000;
const CLOCK_SKEW_MS = 60_000;

export class StorageReconciler {
  constructor(private readonly deps: {
    store: StorageStore;
    scanner: Scanner;
    nodes: ReadonlySet<string>;
    metrics: Metrics;
    filesystemPolicies?: ReadonlyMap<string, FilesystemPolicy[]>;
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
    const { store, scanner, now, metrics, filesystemPolicies } = this.deps;
    const owner = randomUUID();
    let claimed = false;
    try {
      const work = await store.transaction(async tx => {
        await tx.query("SET LOCAL statement_timeout = '15s'");
        await tx.query("SET LOCAL transaction_timeout = '15s'");
        await tx.lock(`scan:${node}`);
        const started = now();
        const latest = await tx.scanState(node, started);
        if (latest.status === 'running') return { state: 'busy' } as const;
        const full = Math.floor(latest.lastFullAt / DAY_MS) < Math.floor(started / DAY_MS);
        const retry = ['incomplete', 'timeout', 'error'].includes(latest.status);
        const due = await resolveCooldowns(tx, node, triggers, started, COOLDOWN_MS);
        if (!full && !retry && !due.length) return { state: 'skip' } as const;
        const lease = await tx.leaseScan(node, owner, started, SCAN_LEASE_MS);
        return lease ? { state: 'scan', full, due, started } as const : { state: 'busy' } as const;
      });
      if (work.state !== 'scan') return work.state === 'skip';
      claimed = true;
      const requested = now();
      const scan = await scanner.scan(node);
      const received = now();
      const scannedAt = Date.parse(scan.scannedAt);
      if (received >= requested + SCAN_TIMEOUT_MS) throw new RequestDeadlineError();
      if (scan.node !== node || !Number.isFinite(scannedAt) || Math.abs(scannedAt - requested) > CLOCK_SKEW_MS) {
        throw new Error('Scan is outside its requested node or time');
      }
      const deadline = received + INGEST_TIMEOUT_MS;
      const result = await store.transaction(async tx => {
        const remaining = deadline - now();
        if (remaining <= 0) throw new RequestDeadlineError();
        await tx.query("SELECT set_config('transaction_timeout', $1, true)", [`${remaining}ms`]);
        await tx.query("SET LOCAL statement_timeout = '45s'");
        if (!await tx.ownsScan(node, owner, now())) throw new RequestDeadlineError();
        const policies = filesystemPolicies?.get(node) ?? [];
        const { complete, matched, observed } = await ingestScan(tx, scan, work.due, policies, received, COOLDOWN_MS);
        for (const state of observed) await raiseScanQuestion(tx, state, await tx.list<Decision>('decision', state.drive.id), received);
        const finished = now();
        if (finished >= deadline || finished >= work.started + SCAN_LEASE_MS) throw new RequestDeadlineError();
        const result = complete && matched ? 'complete' : 'incomplete';
        await tx.finishScan(node, owner, result, finished, result === 'complete' && work.full ? scannedAt : undefined);
        return result;
      });
      metrics.inc('headlamp_agent_storage_scan_total', { result });
      return result === 'complete';
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      const result: ScanResult = error instanceof RequestDeadlineError || code === '57014' || code === '25P04' ? 'timeout' : 'error';
      if (claimed) {
        await store.transaction(async tx => {
          await tx.query("SET LOCAL statement_timeout = '15s'");
          await tx.query("SET LOCAL transaction_timeout = '15s'");
          await tx.finishScan(node, owner, result, now());
        }).catch(() => undefined);
      }
      metrics.inc('headlamp_agent_storage_scan_total', { result });
      return false;
    }
  }
}
