import { fingerprint } from './alerts.js';
import type { Metrics } from './metrics.js';
import type { Diagnosis } from './agent/report.js';
import type { DiagnosisStore, DiagnosisSummary } from './store.js';

/** The part of vmalert's `/api/v1/alerts` that the reconcile run needs. */
export interface VmalertAlert {
  name: string;
  labels: Record<string, string>;
  state: string;
}

export interface VmalertSnapshot {
  /** Alerts that are pending or firing now. */
  alerts: VmalertAlert[];
  /** Alert names of rules whose group has not run a recent evaluation. Their alerts may be missing only because vmalert just started. */
  unevaluated: Set<string>;
}

/** A group counts as stale when its last evaluation is older than this many intervals (and at least 5 minutes). */
const STALE_INTERVALS = 3;
const MIN_STALE_MS = 5 * 60_000;
/** A diagnosis that fired or was created in this window is left alone: the alert may be firing a moment after the snapshot. */
export const GRACE_MS = 2 * 60_000;

interface RawGroup {
  name?: string;
  interval?: number;
  lastEvaluation?: string;
  rules?: Array<{ name?: string; type?: string }>;
}

/** Read the active alerts and the rule groups. Throws when vmalert cannot be read or answers with an unexpected body. */
export async function readVmalert(baseUrl: string, now = Date.now(), fetchFn: typeof fetch = fetch): Promise<VmalertSnapshot> {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchFn(`${baseUrl}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`vmalert answered ${res.status} for ${path}`);
    const body = (await res.json()) as { status?: string; data?: unknown };
    if (body?.status !== 'success' || !body.data || typeof body.data !== 'object') throw new Error(`vmalert gave no data for ${path}`);
    return body.data;
  };
  const alertsData = (await get('/api/v1/alerts')) as { alerts?: Array<{ name?: string; state?: string; labels?: Record<string, unknown> }> };
  const rulesData = (await get('/api/v1/rules')) as { groups?: RawGroup[] };
  if (!Array.isArray(alertsData.alerts)) throw new Error('vmalert gave no alert list');
  // No rule group at all means vmalert did not load its rules. An empty alert list would then say nothing.
  if (!Array.isArray(rulesData.groups) || rulesData.groups.length === 0) throw new Error('vmalert lists no rule group');

  const alerts: VmalertAlert[] = [];
  for (const a of alertsData.alerts) {
    if (!a || typeof a !== 'object') continue;
    const labels = Object.fromEntries(Object.entries(a.labels ?? {}).map(([k, v]) => [k, String(v)]));
    const name = a.name ?? labels.alertname;
    if (!name || (a.state !== 'firing' && a.state !== 'pending')) continue;
    alerts.push({ name, labels: { alertname: name, ...labels }, state: a.state });
  }

  const unevaluated = new Set<string>();
  for (const g of rulesData.groups) {
    const last = g.lastEvaluation && !g.lastEvaluation.startsWith('0001-') ? Date.parse(g.lastEvaluation) : NaN;
    const limit = Math.max(MIN_STALE_MS, (g.interval ?? 60) * 1000 * STALE_INTERVALS);
    const fresh = Number.isFinite(last) && now - last <= limit;
    if (fresh) continue;
    for (const r of g.rules ?? []) if (r.name) unevaluated.add(r.name);
  }
  return { alerts, unevaluated };
}

const subset = (a: Record<string, string>, b: Record<string, string>): boolean => Object.entries(a).every(([k, v]) => b[k] === v);

/**
 * True when vmalert still has the alert of this diagnosis. The fingerprint is the first test. When the label sets of
 * the two sources differ (an added or a dropped label), one set inside the other for the same alert name counts as the same alert:
 * a wrong "present" leaves a diagnosis open, a wrong "gone" would close a live one.
 */
export function isPresent(d: Pick<DiagnosisSummary, 'alert'>, snapshot: Pick<VmalertSnapshot, 'alerts'>, fingerprints: Set<string>): boolean {
  if (d.alert.fingerprint && fingerprints.has(d.alert.fingerprint)) return true;
  const labels = d.alert.labels ?? {};
  return snapshot.alerts.some(a => a.name === d.alert.name && (subset(a.labels, labels) || subset(labels, a.labels)));
}

/** The time the alert stopped, as best known: its last expected end if that is a past time after the last fire, else now. */
export function resolvedTime(d: Pick<Diagnosis, 'alert' | 'lastFiredAt' | 'createdAt'>, now: number): string {
  const lastFire = Math.max(...[d.alert.startsAt, d.lastFiredAt, d.createdAt].map(t => (t ? Date.parse(t) : NaN)).filter(Number.isFinite));
  const ends = d.alert.endsAt ? Date.parse(d.alert.endsAt) : NaN;
  return new Date(Number.isFinite(ends) && ends <= now && ends >= lastFire ? ends : now).toISOString();
}

export interface ReconcileResult {
  result: 'ok' | 'error' | 'skipped';
  folded: number;
  resolved: number;
  open: number;
  error?: string;
}

export interface ReconcilerOptions {
  store: DiagnosisStore;
  /** Reads vmalert. Absent means only the fold of duplicates runs. */
  snapshot?: () => Promise<VmalertSnapshot>;
  metrics: Metrics;
  intervalMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
}

/**
 * Keeps the open diagnoses in step with vmalert. One pod leads at a time (a lease in the store). It folds duplicate
 * open diagnoses of one fingerprint, then resolves each open webhook diagnosis whose alert is neither firing nor pending.
 * It never resolves anything when vmalert cannot be read or has not evaluated the rule lately. Every write is a
 * conditional update of one record, so a second run or a second pod does no harm.
 */
export class Reconciler {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<ReconcileResult> | undefined;
  private stopped = false;
  readonly intervalMs: number;

  constructor(private readonly o: ReconcilerOptions) {
    this.intervalMs = o.intervalMs ?? 60_000;
  }

  private log(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
    this.o.log?.(level, message, extra);
  }

  /** Run now, and then at every interval. The first run does not block the caller. */
  start(): void {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  /** Stop the timer and wait for a run that is in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.current?.catch(() => {});
  }

  runOnce(): Promise<ReconcileResult> {
    if (this.current) return this.current;
    const run = this.run().finally(() => {
      this.current = undefined;
    });
    this.current = run;
    return run;
  }

  private async run(): Promise<ReconcileResult> {
    const { store, metrics } = this.o;
    const empty = { folded: 0, resolved: 0, open: 0 };
    if (this.stopped) return { result: 'skipped', ...empty };
    try {
      if (!(await store.acquireLease('reconcile', this.intervalMs * 2 + 30_000))) {
        metrics.inc('headlamp_agent_reconcile_runs_total', { result: 'skipped' });
        return { result: 'skipped', ...empty };
      }
      const { folded } = await store.foldDuplicates();
      if (folded) {
        metrics.inc('headlamp_agent_reconcile_folded_total', {}, folded);
        this.log('info', 'folded duplicate open diagnoses', { folded });
      }
      if (!this.o.snapshot) {
        metrics.inc('headlamp_agent_reconcile_runs_total', { result: 'ok' });
        return { result: 'ok', folded, resolved: 0, open: (await store.openSummaries()).length };
      }
      // The snapshot first, then the open list: a diagnosis that appears in between is inside the grace window.
      const snapshot = await this.o.snapshot();
      const now = store.now();
      const fingerprints = new Set(snapshot.alerts.map(a => fingerprint(a.labels)));
      let resolved = 0;
      let open = 0;
      for (const d of await store.openSummaries()) {
        open++;
        if (d.source !== 'webhook') continue; // A person or an outside agent reported it. No alert of vmalert stands behind it.
        if (snapshot.unevaluated.has(d.alert.name)) continue;
        if (isPresent(d, snapshot, fingerprints)) continue;
        const newest = Math.max(...[d.createdAt, d.lastFiredAt, d.alert.startsAt].map(t => (t ? Date.parse(t) : NaN)).filter(Number.isFinite));
        if (now - newest < GRACE_MS) continue;
        if (await store.resolveOpen(d.id, resolvedTime(d, now), 'Resolved by reconcile: vmalert has no firing or pending alert for it.')) {
          resolved++;
          open--;
        }
      }
      if (resolved) {
        metrics.inc('headlamp_agent_reconcile_resolved_total', {}, resolved);
        this.log('info', 'resolved diagnoses whose alert is gone', { resolved });
      }
      metrics.inc('headlamp_agent_reconcile_runs_total', { result: 'ok' });
      metrics.set('headlamp_agent_reconcile_vmalert_alerts', {}, snapshot.alerts.length);
      metrics.set('headlamp_agent_reconcile_last_success_timestamp_seconds', {}, Math.floor(now / 1000));
      return { result: 'ok', folded, resolved, open };
    } catch (error) {
      metrics.inc('headlamp_agent_reconcile_runs_total', { result: 'error' });
      this.log('warn', 'reconcile failed', { error: String(error) });
      return { result: 'error', ...empty, error: String(error) };
    }
  }
}
