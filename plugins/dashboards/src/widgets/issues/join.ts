/*
 * The join behind the alerts and incidents widget (`agent.issues`). Two panels of the agent say
 * different things about the same problems: `alerts` (the alerts that are firing or pending now) and
 * `incidents` (the diagnoses, one for each time an alert opened an incident). The join runs in the
 * browser.
 *
 * An issue group is one alert name on one target. The key is `group` in the `meta` of a row, for
 * example `KubeDeploymentDown|shop/web`. The agent builds it with the same function for an alert and
 * for the incident of that alert, so the two meet. An older agent sends no `meta`: the key is then
 * the alert name alone, which is coarser but still correct.
 *
 * The members of a group are the alerts that are firing or pending and the incidents that are open.
 * A group with no such member is shown only when an incident of it was resolved today. Nothing folds
 * into a "+N more" line and no group is named "Other": every group appears once.
 */
import type { PanelModel, PanelRow, PanelStatus, Stat } from '../panels/model';

export type IssueState = 'firing' | 'pending' | 'open' | 'resolved';
/** What the agent does about a group: it works on it, it diagnosed it, the diagnosis failed, or nothing. */
export type AgentState = 'working' | 'diagnosed' | 'failed' | 'none';

export interface IssueGroup {
  key: string;
  /** The alert name. */
  name: string;
  /** What the alert is about, for example `shop/web`. Empty when the alert has no such label. */
  target: string;
  status: PanelStatus;
  state: IssueState;
  /** The members in the group: alerts and incidents that are active, or the incidents resolved today. */
  count: number;
  alerts: number;
  incidents: number;
  agent: AgentState;
  /** The likely cause of the newest diagnosis. Only a diagnosed group has one. */
  cause: string;
  /** The raw link of the group. The widget maps it to a Headlamp page. */
  link?: string;
}

export interface IssuesModel {
  groups: IssueGroup[];
  /** The alert tiles: critical, warning, pending. */
  alertStats: Stat[];
  /** The incident tiles: open, in progress, resolved today. */
  incidentStats: Stat[];
  summary: string;
  status: PanelStatus;
}

export interface IssuesPanels {
  alerts?: PanelModel | null;
  incidents?: PanelModel | null;
}

const RANK: Record<PanelStatus, number> = { crit: 3, warn: 2, unknown: 1, ok: 0 };
const worse = (a: PanelStatus, b: PanelStatus): PanelStatus => (RANK[b] > RANK[a] ? b : a);
const STATE_RANK: Record<IssueState, number> = { firing: 0, pending: 1, open: 2, resolved: 3 };
const AGENT_RANK: Record<AgentState, number> = { working: 3, diagnosed: 2, failed: 1, none: 0 };

interface AlertRec {
  name: string;
  target: string;
  group: string;
  firing: boolean;
  critical: boolean;
}

interface IncidentRec {
  name: string;
  target: string;
  group: string;
  open: boolean;
  critical: boolean;
  agent: AgentState;
  cause: string;
  /** The time of the incident, ms since the epoch, or 0 when unknown. */
  at: number;
  resolvedAt: number;
  id: string;
  link?: string;
  /** The position in the panel, newest first, used when two incidents have no time. */
  order: number;
}

const time = (v: string | undefined): number => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};

const asAgent = (v: string | undefined): AgentState | undefined =>
  v === 'working' || v === 'diagnosed' || v === 'failed' ? v : v === '' ? 'none' : undefined;

/** The incident id from a link such as `/c/{cluster}/incidents/abc`. */
const idFromLink = (link: string | undefined): string => {
  const m = /\/incidents\/([^/?#]+)$/.exec(link ?? '');
  return m ? decodeURIComponent(m[1]) : '';
};

function alertOf(row: PanelRow): AlertRec | undefined {
  const state = row.meta?.state ?? row.value;
  if (state !== 'firing' && state !== 'pending') return undefined;
  const target = row.meta?.target ?? '';
  return {
    name: row.label,
    target,
    group: row.meta?.group ?? row.label,
    firing: state === 'firing',
    critical:
      row.meta?.severity !== undefined ? row.meta.severity === 'critical' : row.status === 'crit',
  };
}

function incidentOf(row: PanelRow, order: number): IncidentRec {
  const m = row.meta;
  const open = row.value !== 'resolved';
  // An older agent sends no agent state: the row value says it (running, queued, failed, open).
  const fallback: AgentState =
    row.value === 'running' || row.value === 'queued'
      ? 'working'
      : row.value === 'failed'
      ? 'failed'
      : row.value === 'open' || row.value === 'resolved'
      ? row.detail !== '' && row.detail !== row.value
        ? 'diagnosed'
        : 'none'
      : 'none';
  const agent = asAgent(m?.agent) ?? fallback;
  return {
    name: row.label,
    target: m?.target ?? '',
    group: m?.group ?? row.label,
    open,
    critical: m?.severity !== undefined ? m.severity === 'critical' : row.status === 'crit',
    agent,
    cause: agent === 'diagnosed' ? row.detail : '',
    at: time(m?.at),
    resolvedAt: time(m?.resolvedAt),
    id: m?.id ?? idFromLink(row.link),
    link: row.link,
    order,
  };
}

/** The start of the local day of `now`, in ms. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const INCIDENTS_LINK = '/c/{cluster}/incidents';

/** The newest first order of two incidents. */
const newest = (a: IncidentRec, b: IncidentRec): number => b.at - a.at || a.order - b.order;

export function joinIssues(panels: IssuesPanels, now: number = Date.now()): IssuesModel {
  const today = startOfDay(now);
  const alerts = (panels.alerts?.rows ?? []).map(alertOf).filter((a): a is AlertRec => !!a);
  const incidents = (panels.incidents?.rows ?? []).map(incidentOf);

  interface Draft {
    key: string;
    name: string;
    target: string;
    alerts: AlertRec[];
    open: IncidentRec[];
    resolved: IncidentRec[];
  }
  const drafts = new Map<string, Draft>();
  const draft = (key: string, name: string, target: string): Draft => {
    let d = drafts.get(key);
    if (!d) {
      d = { key, name, target, alerts: [], open: [], resolved: [] };
      drafts.set(key, d);
    }
    return d;
  };
  for (const a of alerts) draft(a.group, a.name, a.target).alerts.push(a);
  let resolvedToday = 0;
  for (const i of incidents) {
    if (i.open) {
      draft(i.group, i.name, i.target).open.push(i);
    } else if (i.resolvedAt >= today && i.resolvedAt > 0) {
      resolvedToday += 1;
      draft(i.group, i.name, i.target).resolved.push(i);
    }
  }

  const groups: IssueGroup[] = [];
  for (const d of drafts.values()) {
    const active = d.alerts.length > 0 || d.open.length > 0;
    const incs = (active ? d.open : d.resolved).slice().sort(newest);
    const firing = d.alerts.some(a => a.firing);
    const state: IssueState = !active
      ? 'resolved'
      : firing
      ? 'firing'
      : d.alerts.length > 0
      ? 'pending'
      : 'open';
    let status: PanelStatus = 'ok';
    for (const a of d.alerts)
      status = worse(status, a.firing ? (a.critical ? 'crit' : 'warn') : 'unknown');
    for (const i of d.open) status = worse(status, i.critical ? 'crit' : 'warn');
    let agent: AgentState = 'none';
    for (const i of incs) if (AGENT_RANK[i.agent] > AGENT_RANK[agent]) agent = i.agent;
    const cause = agent === 'diagnosed' ? incs.find(i => i.agent === 'diagnosed')?.cause ?? '' : '';
    const withId = incs.find(i => i.id !== '');
    groups.push({
      key: d.key,
      name: d.name,
      target: d.target,
      status,
      state,
      count: d.alerts.length + incs.length,
      alerts: d.alerts.length,
      incidents: incs.length,
      agent,
      cause,
      link: withId
        ? withId.link ?? `${INCIDENTS_LINK}/${encodeURIComponent(withId.id)}`
        : INCIDENTS_LINK,
    });
  }
  groups.sort(
    (a, b) =>
      RANK[b.status] - RANK[a.status] ||
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      b.count - a.count ||
      a.name.localeCompare(b.name) ||
      a.target.localeCompare(b.target)
  );

  const critical = alerts.filter(a => a.firing && a.critical).length;
  const warning = alerts.filter(a => a.firing && !a.critical).length;
  const pending = alerts.filter(a => !a.firing).length;
  const open = incidents.filter(i => i.open);
  const working = open.filter(i => i.agent === 'working').length;
  const tile = (label: string, n: number, status: PanelStatus): Stat => ({
    label,
    value: String(n),
    status: n === 0 ? 'ok' : status,
  });
  const alertStats = [
    tile('Critical', critical, 'crit'),
    tile('Warning', warning, 'warn'),
    tile('Pending', pending, 'unknown'),
  ];
  const incidentStats = [
    tile('Open', open.length - working, 'warn'),
    tile('In progress', working, 'unknown'),
    { label: 'Resolved today', value: String(resolvedToday), status: 'ok' as PanelStatus },
  ];

  const count = (s: IssueState): number => groups.filter(g => g.state === s).length;
  const status = groups.reduce<PanelStatus>(
    (s, g) => (g.state === 'resolved' ? s : worse(s, g.status)),
    'ok'
  );
  const summary =
    groups.length === 0
      ? 'No alerts or incidents'
      : `${groups.length} issues: ${count('firing')} firing, ${count('pending')} pending, ${count(
          'open'
        )} open, ${count('resolved')} resolved today`;
  return { groups, alertStats, incidentStats, summary, status };
}
