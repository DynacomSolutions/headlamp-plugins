/**
 * A small Prometheus text registry. The agent exposes these at `GET /metrics`, and vmagent scrapes them
 * into VictoriaMetrics. Counters live in memory and start at 0 with the process. Gauges are set at scrape time.
 */
type Labels = Record<string, string>;

interface Meta {
  type: 'counter' | 'gauge';
  help: string;
}

const META: Record<string, Meta> = {
  headlamp_agent_storage_reconcile_total: { type: 'counter', help: 'Storage scan reconcile requests by result.' },
  headlamp_agent_storage_scan_total: { type: 'counter', help: 'Storage scanner executions by result.' },
  headlamp_agent_storage_reconcile_node_checks_total: { type: 'counter', help: 'Storage reconcile checks by configured scanner node, check and result.' },
  headlamp_agent_storage_last_full_scan_timestamp_seconds: { type: 'gauge', help: 'Unix time of the last complete daily scan by node.' },
  headlamp_agent_storage_reconcile_last_success_timestamp_seconds: { type: 'gauge', help: 'Unix time of the last successful storage scan reconcile.' },
  headlamp_agent_storage_holder_evidence_expected: { type: 'gauge', help: 'Whether storage scans must collect host process evidence.' },
  headlamp_agent_storage_receipts: { type: 'gauge', help: 'Storage plan receipts by status.' },
  headlamp_agent_storage_push_authority: { type: 'gauge', help: 'Current storage notification authority status. Exactly one status is 1.' },
  headlamp_agent_storage_push_registered_recipients: { type: 'gauge', help: 'Devices with a verified current storage grant, or NaN without a decision.' },
  headlamp_agent_storage_push_revoked_recipients: { type: 'gauge', help: 'Devices with a revoked storage grant, or NaN without a decision.' },
  headlamp_agent_storage_push_notices: { type: 'gauge', help: 'Active storage notices by delivery status.' },
  headlamp_agent_storage_push_deliveries: { type: 'gauge', help: 'Durable storage provider deliveries by status.' },
  headlamp_agent_model_fallback_total: { type: 'counter', help: 'Runs that moved from one default model to the next, by from, to and reason (rate_limit, payment, quota, usage_limit, missing_credentials).' },
  headlamp_agent_model_exhausted: { type: 'gauge', help: 'Default models in a usage cool-down: 1 while the model is skipped, else 0.' },
  headlamp_agent_automatic_investigations_enabled: { type: 'gauge', help: 'The setting "Automatic investigations": 1 while on, 0 while off. Read from the shared store at each scrape.' },
  headlamp_agent_automatic_investigations_skipped_total: { type: 'counter', help: 'Automatic investigations that did not start because the setting is off, by path: webhook, resume or queued.' },
  headlamp_agent_automatic_investigations_read_errors_total: { type: 'counter', help: 'Reads of the setting "Automatic investigations" that failed. The agent then treats the setting as off, so the incident opens without an investigation.' },
  headlamp_agent_diagnoses_open: { type: 'gauge', help: 'Diagnoses that are not resolved, by alert severity.' },
  headlamp_agent_reconcile_runs_total: { type: 'counter', help: 'Reconcile runs of this pod, by result: ok, error (vmalert unreadable) or skipped (another pod leads).' },
  headlamp_agent_reconcile_resolved_total: { type: 'counter', help: 'Open diagnoses that a reconcile run resolved because vmalert no longer has the alert.' },
  headlamp_agent_reconcile_folded_total: { type: 'counter', help: 'Open duplicate diagnoses of one fingerprint that were folded into the newest one.' },
  headlamp_agent_alert_repeats_merged_total: { type: 'counter', help: 'Firing alerts that attached to an open diagnosis instead of starting a new one.' },
  headlamp_agent_resolve_notifications_total: { type: 'counter', help: 'Resolved alerts that vmalert posted to the webhook.' },
  headlamp_agent_reconcile_vmalert_alerts: { type: 'gauge', help: 'Pending or firing alerts that vmalert listed in the last successful reconcile run.' },
  headlamp_agent_reconcile_last_success_timestamp_seconds: { type: 'gauge', help: 'Unix time of the last successful reconcile run of this pod.' },
  headlamp_agent_acp_sessions: { type: 'gauge', help: 'ACP sessions that are open now on the /acp endpoint.' },
  headlamp_agent_acp_connections: { type: 'gauge', help: 'WebSocket connections that are open now on the /acp endpoint.' },
  headlamp_agent_acp_prompts_total: { type: 'counter', help: 'ACP prompts that ended, by result: ok, cancelled, failed (a failed diagnosis) or error.' },
  headlamp_agent_acp_errors_total: { type: 'counter', help: 'ACP endpoint errors by kind: limit (a place was refused), protocol (a bad frame or socket error) or upgrade (a bad upgrade request).' },
  headlamp_agent_acp_auth_failures_total: { type: 'counter', help: 'ACP upgrades that failed authentication, by reason: unconfigured, missing, invalid, scope or origin.' },
};

const escape = (v: string): string => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

function key(labels: Labels): string {
  const names = Object.keys(labels).sort();
  return names.length ? `{${names.map(n => `${n}="${escape(labels[n]!)}"`).join(',')}}` : '';
}

export class Metrics {
  private readonly values = new Map<string, Map<string, number>>();

  constructor() {
    // Counters start at 0, so rate() and increase() see the first event.
    this.inc('headlamp_agent_reconcile_resolved_total', {}, 0);
    this.inc('headlamp_agent_reconcile_folded_total', {}, 0);
    this.inc('headlamp_agent_alert_repeats_merged_total', {}, 0);
    this.inc('headlamp_agent_resolve_notifications_total', {}, 0);
    for (const result of ['success', 'error']) this.inc('headlamp_agent_storage_reconcile_total', { result }, 0);
    for (const result of ['complete', 'incomplete', 'timeout', 'error']) this.inc('headlamp_agent_storage_scan_total', { result }, 0);
    for (const result of ['ok', 'error', 'skipped']) this.inc('headlamp_agent_reconcile_runs_total', { result }, 0);
    this.inc('headlamp_agent_automatic_investigations_read_errors_total', {}, 0);
    for (const path of ['webhook', 'resume', 'queued']) this.inc('headlamp_agent_automatic_investigations_skipped_total', { path }, 0);
    for (const result of ['ok', 'cancelled', 'failed', 'error']) this.inc('headlamp_agent_acp_prompts_total', { result }, 0);
    for (const kind of ['limit', 'protocol', 'upgrade']) this.inc('headlamp_agent_acp_errors_total', { kind }, 0);
    for (const reason of ['unconfigured', 'missing', 'invalid', 'scope', 'origin']) this.inc('headlamp_agent_acp_auth_failures_total', { reason }, 0);
    this.set('headlamp_agent_acp_sessions', {}, 0);
    this.set('headlamp_agent_acp_connections', {}, 0);
  }

  inc(name: string, labels: Labels = {}, by = 1): void {
    const series = this.values.get(name) ?? new Map<string, number>();
    series.set(key(labels), (series.get(key(labels)) ?? 0) + by);
    this.values.set(name, series);
  }

  set(name: string, labels: Labels, value: number): void {
    const series = this.values.get(name) ?? new Map<string, number>();
    series.set(key(labels), value);
    this.values.set(name, series);
  }

  /** Forget the series of a gauge, so a label value that is gone stops being reported. */
  clear(name: string): void {
    this.values.delete(name);
  }

  get(name: string, labels: Labels = {}): number {
    return this.values.get(name)?.get(key(labels)) ?? 0;
  }

  render(): string {
    const out: string[] = [];
    for (const name of Object.keys(META)) {
      const series = this.values.get(name);
      if (!series || series.size === 0) continue;
      out.push(`# HELP ${name} ${META[name]!.help}`, `# TYPE ${name} ${META[name]!.type}`);
      for (const [labels, value] of series) out.push(`${name}${labels} ${value}`);
    }
    return `${out.join('\n')}\n`;
  }
}
