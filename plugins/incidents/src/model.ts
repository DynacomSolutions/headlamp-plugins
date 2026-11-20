import type { A2uiMessage } from './a2ui';

export const CONFIG_KEY = 'incidents';

export interface Settings {
  namespace: string;
  serviceName: string;
  servicePort: string;
}

export const DEFAULT_SETTINGS: Settings = {
  namespace: 'headlamp-agent',
  serviceName: 'headlamp-agent',
  servicePort: '80',
};

export function resolveSettings(
  stored: Partial<Settings> | undefined,
  defaults: Partial<Settings> | undefined
): Settings {
  const blank = (v: unknown) => v === undefined || v === null || v === '';
  const pick = <K extends keyof Settings>(key: K): string => {
    const s = stored?.[key];
    const d = defaults?.[key];
    if (!blank(s)) return String(s).trim();
    if (!blank(d)) return String(d).trim();
    return DEFAULT_SETTINGS[key];
  };
  return {
    namespace: pick('namespace'),
    serviceName: pick('serviceName'),
    servicePort: pick('servicePort'),
  };
}

/** Kubernetes service-proxy URL for a path on the agent Service. */
export function backendUrl(s: Settings, path: string): string {
  const e = encodeURIComponent;
  const svc = s.servicePort ? `${e(s.serviceName)}:${e(s.servicePort)}` : e(s.serviceName);
  return `/api/v1/namespaces/${e(s.namespace)}/services/${svc}/proxy${
    path.startsWith('/') ? path : `/${path}`
  }`;
}

export type Status = 'queued' | 'running' | 'done' | 'failed';

export interface DiagnosisSummary {
  id: string;
  createdAt: string;
  status: Status;
  source: string;
  alertName: string;
  severity: string;
  likelyCause: string;
  confidence: string;
  resolved: boolean;
}

export interface DiagnosisFix {
  title: string;
  detail: string;
  command?: string;
  recommended: boolean;
}

export interface DiagnosisDetail {
  id: string;
  status: Status;
  a2ui: A2uiMessage[];
  alertName: string;
  /** The suggested fixes, in the order the agent keeps them (a launch cites the index). */
  fixes: DiagnosisFix[];
  /** Fact ids of evidence items that hold a DNS placement plan. */
  planFactIds: string[];
}

const STATUSES: Status[] = ['queued', 'running', 'done', 'failed'];
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const status = (v: unknown): Status => (STATUSES.includes(v as Status) ? (v as Status) : 'queued');

export function parseList(json: unknown): DiagnosisSummary[] {
  const list = rec(json).diagnoses;
  if (!Array.isArray(list)) return [];
  return list
    .map(raw => {
      const d = rec(raw);
      const result = rec(d.result);
      const alert = rec(d.alert);
      return {
        id: str(d.id),
        createdAt: str(d.createdAt),
        status: status(d.status),
        source: str(d.source),
        alertName: str(alert.name),
        severity: str(alert.severity),
        likelyCause: str(result.likelyCause) || str(d.error),
        confidence: str(result.confidence),
        resolved: !!d.resolvedAt,
      };
    })
    .filter(d => d.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The total the agent reports for a list, or null for an agent that does not send one. */
export function parseTotal(json: unknown): number | null {
  const t = rec(json).total;
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : null;
}

export function parseDetail(json: unknown): DiagnosisDetail {
  const d = rec(json);
  const fixes = Array.isArray(rec(d.result).fixes) ? (rec(d.result).fixes as unknown[]) : [];
  const evidence = Array.isArray(d.evidence) ? (d.evidence as unknown[]) : [];
  return {
    id: str(d.id),
    status: status(d.status),
    a2ui: Array.isArray(d.a2ui) ? (d.a2ui as A2uiMessage[]) : [],
    alertName: str(rec(d.alert).name),
    fixes: fixes
      .map(raw => {
        const f = rec(raw);
        return {
          title: str(f.title),
          detail: str(f.detail),
          command: str(f.command) || undefined,
          recommended: f.recommended === true,
        };
      })
      .filter(f => f.title),
    planFactIds: evidence
      .map(rec)
      .filter(e => e.tool === 'dns_placement_plan' && e.ok !== false)
      .map(e => str(e.id))
      .filter(Boolean),
  };
}

export function isActive(s: Status): boolean {
  return s === 'queued' || s === 'running';
}

export type SeverityColour = 'error' | 'warning' | 'default';
export function severityColour(severity: string): SeverityColour {
  const s = severity.toLowerCase();
  return s === 'critical' ? 'error' : s === 'warning' ? 'warning' : 'default';
}

/** The filters of the incident list widget. `all` means no filter on that field. */
export interface IncidentFilter {
  status: Status | 'all';
  severity: 'critical' | 'warning' | 'other' | 'all';
  /** Hide diagnoses whose alert is resolved. */
  openOnly: boolean;
}

export const DEFAULT_FILTER: IncidentFilter = { status: 'all', severity: 'all', openOnly: false };

/** `critical` and `warning` match themselves. `other` matches every other severity, including none. */
export function severityGroup(severity: string): 'critical' | 'warning' | 'other' {
  const s = severity.toLowerCase();
  return s === 'critical' || s === 'warning' ? s : 'other';
}

export function filterDiagnoses(
  list: DiagnosisSummary[],
  filter: Partial<IncidentFilter>
): DiagnosisSummary[] {
  const f: IncidentFilter = {
    status: filter.status ?? DEFAULT_FILTER.status,
    severity: filter.severity ?? DEFAULT_FILTER.severity,
    openOnly: filter.openOnly ?? DEFAULT_FILTER.openOnly,
  };
  return list.filter(
    d =>
      (f.status === 'all' || d.status === f.status) &&
      (f.severity === 'all' || severityGroup(d.severity) === f.severity) &&
      (!f.openOnly || !d.resolved)
  );
}

export interface IncidentSummaryCounts {
  total: number;
  bySeverity: Record<'critical' | 'warning' | 'other', number>;
  byStatus: Record<Status, number>;
  resolved: number;
}

export function summariseDiagnoses(list: DiagnosisSummary[]): IncidentSummaryCounts {
  const counts: IncidentSummaryCounts = {
    total: list.length,
    bySeverity: { critical: 0, warning: 0, other: 0 },
    byStatus: { queued: 0, running: 0, done: 0, failed: 0 },
    resolved: 0,
  };
  for (const d of list) {
    counts.bySeverity[severityGroup(d.severity)] += 1;
    counts.byStatus[d.status] += 1;
    if (d.resolved) counts.resolved += 1;
  }
  return counts;
}
