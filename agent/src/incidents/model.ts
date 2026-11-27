import type { Diagnosis } from '../agent/report.js';
import { incidentUri, investigationUri, type EventRecord, type InvestigationStatus } from './types.js';

/** A record with or without its A2UI messages and evidence: the list shows the second kind. */
export type Rec = Omit<Diagnosis, 'a2ui' | 'evidence'>;

export type IncidentStateName = 'open' | 'acknowledged' | 'resolved';

export interface InvestigationSummary {
  status: InvestigationStatus;
  attempt: number;
  model: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  automatic: boolean;
}

export interface Incident {
  id: string;
  uri: string;
  name: string;
  severity: 'critical' | 'warning' | 'info' | 'none';
  state: IncidentStateName;
  escalated: boolean;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  fingerprint: string;
  test: boolean;
  startsAt: string;
  createdAt: string;
  updatedAt: string;
  fires: number;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
  escalatedAt: string | null;
  noteCount: number;
  investigation: InvestigationSummary;
}

export interface Investigation extends InvestigationSummary {
  incidentId: string;
  uri: string;
  toolCalls: number;
  previousAttempts: Array<{ at: string; model: string; error: string }>;
}

/** The investigation status of a record. A status this contract does not know means no investigation exists. `skipped` is known (contract section 3.2). */
export function investigationStatus(d: Pick<Diagnosis, 'status'>): InvestigationStatus {
  const s = d.status as string;
  return s === 'queued' || s === 'running' || s === 'done' || s === 'failed' || s === 'skipped' ? s : 'none';
}

/** True for the two statuses that mean no run exists: `none` and `skipped` behave alike (contract section 3.2). */
export const noRun = (s: InvestigationStatus): s is 'none' | 'skipped' => s === 'none' || s === 'skipped';

export function incidentState(d: Rec): IncidentStateName {
  if (d.resolvedAt) return 'resolved';
  return d.incident?.acknowledgedAt ? 'acknowledged' : 'open';
}

function severityOf(value: string): Incident['severity'] {
  return value === 'critical' || value === 'warning' || value === 'info' ? value : 'none';
}

export function investigationSummary(d: Rec): InvestigationSummary {
  const status = investigationStatus(d);
  const none = noRun(status);
  return {
    status,
    attempt: none ? 0 : (d.previousAttempts?.length ?? 0) + 1,
    model: none ? null : d.model || null,
    startedAt: none ? null : (d.rerunAt ?? d.createdAt),
    finishedAt: d.finishedAt ?? null,
    error: d.error ?? null,
    automatic: !none && d.source === 'webhook' && !d.rerunAt && !d.incident?.manualRun,
  };
}

export function toInvestigation(d: Rec): Investigation {
  return {
    ...investigationSummary(d),
    incidentId: d.id,
    uri: investigationUri(d.id),
    toolCalls: d.toolCalls,
    previousAttempts: (d.previousAttempts ?? []).map(p => ({ at: p.at, model: p.model, error: p.error })),
  };
}

export function toIncident(d: Rec): Incident {
  const i = d.incident;
  const times = [d.createdAt, d.finishedAt, d.resolvedAt, i?.acknowledgedAt, i?.escalatedAt, d.lastFiredAt, ...(i?.timeline.map(t => t.at) ?? [])].filter((t): t is string => Boolean(t));
  const updatedAt = times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a), d.createdAt);
  return {
    id: d.id,
    uri: incidentUri(d.id),
    name: d.alert.name,
    severity: severityOf(d.alert.severity),
    state: incidentState(d),
    escalated: Boolean(i?.escalatedAt),
    labels: d.alert.labels,
    annotations: d.alert.annotations,
    fingerprint: d.alert.fingerprint,
    test: d.alert.labels.test === 'true',
    startsAt: d.alert.startsAt,
    createdAt: d.createdAt,
    updatedAt,
    fires: d.fires ?? 1,
    acknowledgedAt: i?.acknowledgedAt ?? null,
    acknowledgedBy: i?.acknowledgedBy ?? null,
    resolvedAt: d.resolvedAt ?? null,
    resolvedBy: d.resolvedAt ? (i?.resolvedBy ?? 'alert') : null,
    resolution: d.resolvedAt ? (i?.resolution ?? d.resolvedNote ?? null) : null,
    escalatedAt: i?.escalatedAt ?? null,
    noteCount: i?.noteCount ?? 0,
    investigation: investigationSummary(d),
  };
}

/** At most 32 labels, the 32 smallest keys in byte order (UTF-8), each value cut to 256 characters: what an event carries (contract section 3.6). */
export function eventLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = Object.keys(labels).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).slice(0, 32);
  for (const k of keys) out[k] = String(labels[k]).slice(0, 256);
  return out;
}

/** A filter on incidents, from a URI query or the `list_incidents` input. */
export interface IncidentFilter {
  state?: 'open' | 'acknowledged' | 'resolved' | 'active';
  severity?: string[];
  labels?: Record<string, string>;
  test?: boolean;
  /** Two `label` parameters with the same key and different values: nothing matches (contract section 6.2). */
  never?: true;
}

export function matchesFilter(i: Pick<Incident, 'state' | 'severity' | 'labels' | 'test'>, f: IncidentFilter): boolean {
  if (f.never) return false;
  const state = f.state ?? 'active';
  if (state === 'active' ? i.state === 'resolved' : i.state !== state) return false;
  if (f.severity?.length && !f.severity.includes(i.severity)) return false;
  if (f.test !== undefined && i.test !== f.test) return false;
  for (const [k, v] of Object.entries(f.labels ?? {})) if (i.labels[k] !== v) return false;
  return true;
}

export type ParsedUri =
  | { type: 'incidents'; filter: IncidentFilter }
  | { type: 'incident'; id: string }
  | { type: 'timeline'; id: string }
  | { type: 'investigation'; id: string }
  | { type: 'events'; kinds: string[]; labels: Record<string, string>; never?: true; after?: string; limit?: number; logId?: string }
  | { type: 'settings' }
  | { type: 'storage'; kind: string; node?: string }
  | { type: 'contract' };

const STORAGE_KINDS = ['volumes', 'disks', 'smart', 'capacity'];
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function labelPairs(values: string[]): { labels: Record<string, string>; never: boolean } | undefined {
  const labels: Record<string, string> = {};
  let never = false;
  for (const v of values) {
    const at = v.indexOf('=');
    if (at < 1) return undefined;
    const key = v.slice(0, at);
    const value = v.slice(at + 1);
    if (Object.hasOwn(labels, key) && labels[key] !== value) never = true;
    labels[key] = value;
  }
  return { labels, never };
}

/** Reads a `headlamp://` URI. Returns undefined for any URI this contract does not define. */
export function parseUri(uri: string): ParsedUri | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'headlamp:') return undefined;
  const parts = [url.hostname, ...url.pathname.split('/').filter(Boolean)].map(decodeURIComponent);
  const q = url.searchParams;
  const [head, a, b] = parts;
  // A URI with a query key that its template does not name does not match the template (contract section 6.2).
  const allowed = head === 'incidents' && parts.length === 1 ? ['state', 'severity', 'label', 'test'] : head === 'events' && parts.length === 1 ? ['after', 'logId', 'limit', 'kind', 'label'] : [];
  for (const key of q.keys()) if (!allowed.includes(key)) return undefined;
  if (url.hash) return undefined;
  if (head === 'contract' && parts.length === 1) return { type: 'contract' };
  if (head === 'settings' && a === 'automatic-investigations' && parts.length === 2) return { type: 'settings' };
  if (head === 'storage' && a && STORAGE_KINDS.includes(a) && parts.length <= 3) return { type: 'storage', kind: a, node: b };
  if (head === 'investigations' && a && ID.test(a) && parts.length === 2) return { type: 'investigation', id: a };
  if (head === 'incidents') {
    if (parts.length === 1) {
      const filter: IncidentFilter = {};
      const state = q.get('state');
      if (state) {
        if (!['open', 'acknowledged', 'resolved', 'active'].includes(state)) return undefined;
        filter.state = state as IncidentFilter['state'];
      }
      const severity = q.getAll('severity');
      if (severity.length) filter.severity = severity;
      const pairs = labelPairs(q.getAll('label'));
      if (!pairs) return undefined;
      if (Object.keys(pairs.labels).length) filter.labels = pairs.labels;
      if (pairs.never) filter.never = true;
      const test = q.get('test');
      if (test !== null) {
        if (test !== 'true' && test !== 'false') return undefined;
        filter.test = test === 'true';
      }
      return { type: 'incidents', filter };
    }
    if (a && ID.test(a) && parts.length === 2) return { type: 'incident', id: a };
    if (a && ID.test(a) && b === 'timeline' && parts.length === 3) return { type: 'timeline', id: a };
    return undefined;
  }
  if (head === 'events' && parts.length === 1) {
    const pairs = labelPairs(q.getAll('label'));
    if (!pairs) return undefined;
    const after = q.get('after') ?? undefined;
    if (after !== undefined && !/^\d{1,18}$/.test(after)) return undefined;
    const limitText = q.get('limit');
    const limit = limitText === null ? undefined : Number(limitText);
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 500)) return undefined;
    const logId = q.get('logId') ?? undefined;
    if (logId !== undefined && !/^[0-9a-f-]{36}$/i.test(logId)) return undefined;
    return { type: 'events', kinds: q.getAll('kind'), labels: pairs.labels, ...(pairs.never ? { never: true as const } : {}), after, limit, logId };
  }
  return undefined;
}

/** The labels that filters match: all labels of the incident when the event holds them, else the labels of the event. */
export const fullLabels = (e: Pick<EventRecord, 'labels' | 'fullLabels'>): Record<string, string> => e.fullLabels ?? e.labels;

export function kindMatches(kinds: string[], kind: string): boolean {
  return kinds.length === 0 || kinds.some(k => (k.endsWith('.') ? kind.startsWith(k) : kind === k));
}

const INCIDENT_KIND = /^(incident|investigation)\./;

/** True when this event updates the resource that `parsed` names (contract section 7.2). */
export function eventMatches(event: EventRecord, parsed: ParsedUri): boolean {
  switch (parsed.type) {
    case 'events':
      return !parsed.never && kindMatches(parsed.kinds, event.kind) && Object.entries(parsed.labels).every(([k, v]) => fullLabels(event)[k] === v);
    case 'incidents': {
      if (!INCIDENT_KIND.test(event.kind) || !event.incidentId) return false;
      // The filter sees the full labels that the server stores, not the 32 that the event carries (contract section 7.2).
      const labels = fullLabels(event);
      const view = { severity: severityOf(labels.severity ?? ''), labels, test: labels.test === 'true' };
      // An incident enters, changes inside or leaves the collection: it matches before or after the event.
      const after = matchesFilter({ ...view, state: event.state ?? 'open' }, parsed.filter);
      return after || (event.stateBefore !== undefined && matchesFilter({ ...view, state: event.stateBefore }, parsed.filter));
    }
    case 'incident':
    case 'timeline':
      return INCIDENT_KIND.test(event.kind) && event.incidentId === parsed.id;
    case 'investigation':
      return event.kind.startsWith('investigation.') && event.incidentId === parsed.id;
    case 'settings':
      return event.kind === 'settings.changed';
    case 'storage':
      // A node URI gets the events of its node only (contract section 7.2).
      return event.kind === 'storage.updated' && event.uri === `headlamp://storage/${parsed.kind}` && (parsed.node === undefined || event.labels.node === parsed.node);
    case 'contract':
      return false;
  }
}

export type Scope = 'registry:read' | 'incidents:read' | 'incidents:write' | 'incidents:resolve' | 'agent:investigate' | 'storage:read' | 'settings:read';
export const SCOPES: Scope[] = ['registry:read', 'incidents:read', 'incidents:write', 'incidents:resolve', 'agent:investigate', 'storage:read', 'settings:read'];

export function scopeForUri(parsed: ParsedUri): Scope | undefined {
  switch (parsed.type) {
    case 'incidents':
    case 'incident':
    case 'timeline':
      return 'incidents:read';
    case 'events':
      return undefined; // any valid token (contract section 6.1)
    case 'investigation':
      return 'agent:investigate';
    case 'settings':
      return 'settings:read';
    case 'storage':
      return 'storage:read';
    case 'contract':
      return 'registry:read';
  }
}

/** The scope of the primary URI of an event kind (contract section 7.1). `undefined`: any valid token may see it. */
export function eventScope(kind: string): Scope | undefined {
  if (kind.startsWith('incident.')) return 'incidents:read';
  if (kind.startsWith('investigation.')) return 'agent:investigate';
  if (kind.startsWith('settings.')) return 'settings:read';
  if (kind.startsWith('storage.')) return 'storage:read';
  return undefined;
}

/** True when a caller with `scopes` may see the event (contract section 8.7). Unknown kinds are hidden. */
export function canSee(scopes: ReadonlySet<string>, kind: string): boolean {
  if (kind === 'reset') return true;
  const scope = eventScope(kind);
  return scope !== undefined && scopes.has(scope);
}
