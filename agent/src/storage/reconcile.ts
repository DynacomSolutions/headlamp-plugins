import type { DiagnosticDispatch } from './diagnostic.js';
import { randomUUID } from 'node:crypto';
import type { Metrics } from '../metrics.js';
import { raiseScanQuestion } from './findings.js';
import { ingestScan, resolveCooldowns } from './inventory.js';
import type { StorageStore } from './store.js';
import { RequestDeadlineError, SCAN_TIMEOUT_MS, type Scanner } from './transport.js';
import { SCAN_CHECKS, type Decision, type ExpectedScopes, type FilesystemPolicy, type ScanChecks, type ScanResult, type Trigger } from './types.js';

const DAY_MS = 24 * 60 * 60_000;
const COOLDOWN_MS = 15 * 60_000;
const INGEST_TIMEOUT_MS = 90_000;
const SCAN_LEASE_MS = SCAN_TIMEOUT_MS + INGEST_TIMEOUT_MS + 60_000;
const CLOCK_SKEW_MS = 60_000;

const CHECK_METRIC = 'headlamp_agent_storage_reconcile_node_checks_total';

export class StorageReconciler {
  constructor(private readonly deps: {
    store: StorageStore;
    scanner: Scanner;
    nodes: ReadonlySet<string>;
    metrics: Metrics;
    filesystemPolicies?: ReadonlyMap<string, FilesystemPolicy[]>;
    partialScanScopes?: ReadonlyMap<string, ExpectedScopes>;
    holderEvidenceExpected?: boolean;
    now: () => number;
  }) {
    for (const node of deps.nodes) {
      for (const [check, results] of Object.entries(SCAN_CHECKS)) {
        for (const result of results) deps.metrics.inc(CHECK_METRIC, { node, check, result }, 0);
      }
    }
  }

  private record(node: string, checks: ScanChecks | Pick<ScanChecks, 'acceptance'>): void {
    for (const [check, result] of Object.entries(checks)) {
      this.deps.metrics.inc(CHECK_METRIC, { node, check, result });
    }
  }

  async run(triggers: Trigger[], diagnostic?: DiagnosticDispatch): Promise<boolean> {
    const { nodes } = this.deps;
    const byNode = new Map<string, Trigger[]>();
    for (const trigger of triggers) {
      const list = byNode.get(trigger.node) ?? [];
      list.push(trigger);
      byNode.set(trigger.node, list);
    }
    const results = await Promise.allSettled([...nodes].map(node => this.scanNode(
      node, byNode.get(node) ?? [], diagnostic?.nodes.has(node) ? diagnostic.job : undefined,
    )));
    return [...byNode.keys()].every(node => nodes.has(node)) && results.every(result => result.status === 'fulfilled' && result.value);
  }

  private async scanNode(node: string, triggers: Trigger[], diagnosticJob?: string): Promise<boolean> {
    const { store, scanner, now, metrics, filesystemPolicies } = this.deps;
    const owner = randomUUID();
    let claimed = false;
    let failure: 'scanner_error' | 'store_error' = 'store_error';
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
      if (work.state !== 'scan') {
        this.record(node, { acceptance: work.state === 'skip' ? 'skipped' : 'busy' });
        return work.state === 'skip';
      }
      claimed = true;
      failure = 'scanner_error';
      const requested = now();
      const scan = await scanner.scan(node, diagnosticJob);
      const received = now();
      const scannedAt = Date.parse(scan.scannedAt);
      if (received >= requested + SCAN_TIMEOUT_MS) throw new RequestDeadlineError();
      if (scan.node !== node || !Number.isFinite(scannedAt) || Math.abs(scannedAt - requested) > CLOCK_SKEW_MS) {
        throw new Error('Scan is outside its requested node or time');
      }
      failure = 'store_error';
      const deadline = received + INGEST_TIMEOUT_MS;
      const result = await store.transaction(async tx => {
        const remaining = deadline - now();
        if (remaining <= 0) throw new RequestDeadlineError();
        await tx.query("SELECT set_config('transaction_timeout', $1, true)", [`${remaining}ms`]);
        await tx.query("SET LOCAL statement_timeout = '45s'");
        if (!await tx.ownsScan(node, owner, now())) throw new RequestDeadlineError();
        const policies = filesystemPolicies?.get(node) ?? [];
        const evaluatedTriggers = scan.version === 2 ? triggers : work.due;
        const { checks, observed } = await ingestScan(
          tx, scan, evaluatedTriggers, policies, received, COOLDOWN_MS,
          this.deps.holderEvidenceExpected === false, this.deps.partialScanScopes?.get(node),
        );
        for (const state of observed) await raiseScanQuestion(tx, state, await tx.list<Decision>('decision', state.drive.id), received);
        const finished = now();
        if (finished >= deadline || finished >= work.started + SCAN_LEASE_MS) throw new RequestDeadlineError();
        const complete = checks.acceptance === 'full';
        const status = complete ? 'complete' : 'incomplete';
        await tx.finishScan(node, owner, status, finished, checks, complete && work.full ? scannedAt : undefined);
        return { status, checks };
      });
      metrics.inc('headlamp_agent_storage_scan_total', { result: result.status });
      this.record(node, result.checks);
      return result.checks.acceptance !== 'rejected';
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      const result: ScanResult = error instanceof RequestDeadlineError || code === '57014' || code === '25P04' ? 'timeout' : 'error';
      const checks: ScanChecks = {
        inventory: 'unknown', policy: 'unknown', trigger: 'unknown', holder: 'unknown',
        acceptance: result === 'timeout' ? 'timeout' : failure,
      };
      if (claimed) {
        await store.transaction(async tx => {
          await tx.query("SET LOCAL statement_timeout = '15s'");
          await tx.query("SET LOCAL transaction_timeout = '15s'");
          await tx.finishScan(node, owner, result, now(), checks);
        }).catch(() => undefined);
      }
      metrics.inc('headlamp_agent_storage_scan_total', { result });
      this.record(node, checks);
      return false;
    }
  }
}
