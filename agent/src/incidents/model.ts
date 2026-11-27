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

/** The investigation status of a record. A status this contract does not know means no investigation exists. */
export function investigationStatus(d: Pick<Diagnosis, 'status'>): InvestigationStatus {
  const s = d.status as string;
  return s === 'queued' || s === 'running' || s === 'done' || s === 'failed' ? s : 'none';
}

export function incidentState(d: Rec): IncidentStateName {
  if (d.resolvedAt) return 'resolved';
  return d.incident?.acknowledgedAt ? 'acknowledged' : 'open';
}

function severityOf(value: string): Incident['severity'] {
  return value === 'critical' || value === 'warning' || value === 'info' ? value : 'none';
}

export function investigationSummary(d: Rec): InvestigationSummary {
  const status = investigationStatus(d);
  const none = status === 'none';
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

/** At most 32 labels, each value cut to 256 characters: what an event carries. */
export function eventLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels).slice(0, 32)) out[k] = String(v).slice(0, 256);
  return out;
}

/** A filter on incidents, from a URI query or the `list_incidents` input. */
export interface IncidentFilter {
  state?: 'open' | 'acknowledged' | 'resolved' | 'active';
  severity?: string[];
  labels?: Record<string, string>;
  test?: boolean;
}

export function matchesFilter(i: Pick<Incident, 'state' | 'severity' | 'labels' | 'test'>, f: IncidentFilter): boolean {
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
  | { type: 'events'; kinds: string[]; labels: Record<string, string>; after?: string; limit?: number }
  | { type: 'settings' }
  | { type: 'storage'; kind: string; node?: string }
  | { type: 'contract' };

const STORAGE_KINDS = ['volumes', 'disks', 'smart', 'capacity'];
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function labelPairs(values: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const v of values) {
    const at = v.indexOf('=');
    if (at < 1) return undefined;
    out[v.slice(0, at)] = v.slice(at + 1);
  }
  return out;
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
      const labels = labelPairs(q.getAll('label'));
      if (!labels) return undefined;
      if (Object.keys(labels).length) filter.labels = labels;
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
    const labels = labelPairs(q.getAll('label'));
    if (!labels) return undefined;
    const after = q.get('after') ?? undefined;
    if (after !== undefined && !/^\d{1,18}$/.test(after)) return undefined;
    const limitText = q.get('limit');
    const limit = limitText === null ? undefined : Number(limitText);
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 500)) return undefined;
    return { type: 'events', kinds: q.getAll('kind'), labels, after, limit };
  }
  return undefined;
}

export function kindMatches(kinds: string[], kind: string): boolean {
  return kinds.length === 0 || kinds.some(k => (k.endsWith('.') ? kind.startsWith(k) : kind === k));
}

const INCIDENT_KIND = /^(incident|investigation)\./;

/** True when this event updates the resource that `parsed` names (contract section 7.2). */
export function eventMatches(event: EventRecord & { state?: IncidentStateName }, parsed: ParsedUri): boolean {
  switch (parsed.type) {
    case 'events':
      return kindMatches(parsed.kinds, event.kind) && Object.entries(parsed.labels).every(([k, v]) => event.labels[k] === v);
    case 'incidents': {
      if (!INCIDENT_KIND.test(event.kind) || !event.incidentId) return false;
      const severity = severityOf(event.labels.severity ?? '');
      return matchesFilter({ state: event.state ?? 'open', severity, labels: event.labels, test: event.labels.test === 'true' }, parsed.filter);
    }
    case 'incident':
    case 'timeline':
      return INCIDENT_KIND.test(event.kind) && event.incidentId === parsed.id;
    case 'investigation':
      return event.kind.startsWith('investigation.') && event.incidentId === parsed.id;
    case 'settings':
      return event.kind === 'settings.changed';
    case 'storage':
      return event.kind === 'storage.updated' && event.uri === `headlamp://storage/${parsed.kind}`;
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
    case 'events':
      return 'incidents:read';
    case 'investigation':
      return 'agent:investigate';
    case 'settings':
      return 'settings:read';
    case 'storage':
      return 'storage:read';
    case 'contract':
      return undefined;
  }
}
