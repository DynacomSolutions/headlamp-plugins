/** Agent launch API types, parsers and display helpers (pure, no React). */

export type LaunchStatus =
  | 'pending_approval'
  | 'rejected'
  | 'expired'
  | 'launching'
  | 'running'
  | 'waiting'
  | 'tracking_lost'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const LAUNCH_STATUSES: LaunchStatus[] = [
  'pending_approval',
  'launching',
  'running',
  'waiting',
  'tracking_lost',
  'completed',
  'failed',
  'rejected',
  'expired',
  'cancelled',
];

export type TimelineKind = 'run' | 'message' | 'tool' | 'file_change' | 'other';
export type StepStatus = 'running' | 'done' | 'failed' | 'waiting';

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  title: string;
  detail?: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
}

export interface LaunchFix {
  index: number;
  title: string;
  detail?: string;
  command?: string;
}

export interface LaunchSummary {
  id: string;
  purpose: string;
  status: LaunchStatus;
  requestedBy: string;
  requestedAt: string;
  decidedBy?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  threadLink?: string;
  diagnosisId?: string;
  chatId?: string;
  fixTitle?: string;
  projectKey: string;
  steps: number;
}

export interface LaunchDetail extends LaunchSummary {
  brief: string;
  timeline: TimelineEntry[];
  lastReply?: string;
  threadId?: string;
}

export interface LaunchConfig {
  enabled: boolean;
  reason?: string;
  projects: { key: string; title: string }[];
  model: { instanceId: string; model: string };
  threadUrlTemplate: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const opt = (v: unknown): string | undefined => str(v) || undefined;
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const KINDS: TimelineKind[] = ['run', 'message', 'tool', 'file_change', 'other'];
const STEP_STATUSES: StepStatus[] = ['running', 'done', 'failed', 'waiting'];
const status = (v: unknown): LaunchStatus =>
  LAUNCH_STATUSES.includes(v as LaunchStatus) ? (v as LaunchStatus) : 'pending_approval';

export function parseSummary(raw: unknown): LaunchSummary {
  const l = rec(raw);
  const source = rec(l.source);
  return {
    id: str(l.id),
    purpose: str(l.purpose),
    status: status(l.status),
    requestedBy: str(l.requestedBy),
    requestedAt: str(l.requestedAt),
    decidedBy: opt(l.decidedBy),
    startedAt: opt(l.startedAt),
    finishedAt: opt(l.finishedAt),
    error: opt(l.error),
    threadLink: opt(l.threadLink),
    diagnosisId: opt(source.diagnosisId),
    chatId: opt(source.chatId),
    fixTitle: opt(rec(source.fix).title),
    projectKey: str(l.projectKey),
    steps:
      typeof l.steps === 'number' ? l.steps : Array.isArray(l.timeline) ? l.timeline.length : 0,
  };
}

export function parseLaunches(json: unknown): LaunchSummary[] {
  const list = rec(json).launches;
  if (!Array.isArray(list)) return [];
  return list
    .map(parseSummary)
    .filter(l => l.id)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

function parseEntry(raw: unknown): TimelineEntry {
  const e = rec(raw);
  return {
    id: str(e.id),
    kind: KINDS.includes(e.kind as TimelineKind) ? (e.kind as TimelineKind) : 'other',
    title: str(e.title),
    detail: opt(e.detail),
    status: STEP_STATUSES.includes(e.status as StepStatus) ? (e.status as StepStatus) : 'done',
    startedAt: opt(e.startedAt),
    finishedAt: opt(e.finishedAt),
  };
}

export function parseLaunch(json: unknown): LaunchDetail {
  const l = rec(json);
  return {
    ...parseSummary(json),
    brief: str(l.brief),
    timeline: Array.isArray(l.timeline) ? l.timeline.map(parseEntry) : [],
    lastReply: opt(l.lastReply),
    threadId: opt(l.threadId),
  };
}

export function parseLaunchConfig(json: unknown): LaunchConfig {
  const c = rec(json);
  const model = rec(c.model);
  return {
    enabled: c.enabled === true,
    reason: opt(c.reason),
    projects: (Array.isArray(c.projects) ? c.projects : [])
      .map(p => ({ key: str(rec(p).key), title: str(rec(p).title) || str(rec(p).key) }))
      .filter(p => p.key),
    model: { instanceId: str(model.instanceId), model: str(model.model) },
    threadUrlTemplate: str(c.threadUrlTemplate),
  };
}

/* ---------- Status ---------- */

export type PillColour = 'default' | 'info' | 'success' | 'error' | 'warning';

export interface StatusMeta {
  label: string;
  colour: PillColour;
  icon: string;
  /** True while the agent works, so the pill shows a spinner. */
  busy: boolean;
}

const META: Record<LaunchStatus, StatusMeta> = {
  pending_approval: {
    label: 'Pending approval',
    colour: 'warning',
    icon: 'mdi:shield-account-outline',
    busy: false,
  },
  launching: { label: 'Launching', colour: 'info', icon: 'mdi:rocket-launch-outline', busy: true },
  running: { label: 'Running', colour: 'info', icon: 'mdi:play-circle-outline', busy: true },
  waiting: { label: 'Waiting', colour: 'warning', icon: 'mdi:timer-sand', busy: false },
  completed: {
    label: 'Completed',
    colour: 'success',
    icon: 'mdi:check-circle-outline',
    busy: false,
  },
  failed: { label: 'Failed', colour: 'error', icon: 'mdi:alert-circle-outline', busy: false },
  tracking_lost: {
    label: 'Tracking lost, retrying',
    colour: 'warning',
    icon: 'mdi:lan-disconnect',
    busy: true,
  },
  rejected: { label: 'Rejected', colour: 'default', icon: 'mdi:close-circle-outline', busy: false },
  expired: { label: 'Expired', colour: 'default', icon: 'mdi:clock-remove-outline', busy: false },
  cancelled: { label: 'Cancelled', colour: 'default', icon: 'mdi:cancel', busy: false },
};

export const statusMeta = (s: LaunchStatus): StatusMeta => META[s];

export const isFinalLaunch = (s: LaunchStatus): boolean =>
  s === 'completed' || s === 'failed' || s === 'rejected' || s === 'expired' || s === 'cancelled';

/** The launch changes without an operator action: poll it. */
export const isLiveLaunch = (s: LaunchStatus): boolean =>
  s === 'launching' || s === 'running' || s === 'waiting' || s === 'tracking_lost';

export const STEP_COLOUR: Record<StepStatus, PillColour> = {
  running: 'info',
  done: 'success',
  failed: 'error',
  waiting: 'warning',
};

/* ---------- Time ---------- */

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** Time from `from` to `to`, or to `now` when `to` is empty. Empty when `from` is missing. */
export function elapsed(from: string | undefined, to: string | undefined, now: number): string {
  if (!from) return '';
  const start = Date.parse(from);
  if (Number.isNaN(start)) return '';
  const end = to ? Date.parse(to) : now;
  return formatDuration((Number.isNaN(end) ? now : end) - start);
}

/** Time the launch has been active: from start (or request) to the end, or to `now`. */
export function launchElapsed(l: LaunchSummary, now: number): string {
  if (l.status === 'pending_approval' || l.status === 'rejected' || l.status === 'expired')
    return '';
  return elapsed(
    l.startedAt ?? l.requestedAt,
    isFinalLaunch(l.status) ? l.finishedAt : undefined,
    now
  );
}

/* ---------- Fixes ---------- */

export const PLAN_TOOL = 'dns_placement_plan';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `text` holds `token` as a whole word. The token is matched as plain text, not as a pattern. */
export function hasToken(text: string, token: string): boolean {
  return token !== '' && new RegExp(`(?<!\\w)${escapeRegExp(token)}(?!\\w)`).test(text);
}

/** True when a fix talks about the DNS plan: it names the tool, cites its fact id, or is about DNS and a plan exists. Same rule as the agent. */
export function fixCitesPlan(
  fix: Pick<LaunchFix, 'title' | 'detail' | 'command'>,
  planFactIds: string[]
): boolean {
  if (planFactIds.length === 0) return false;
  const text = `${fix.title} ${fix.detail ?? ''} ${fix.command ?? ''}`;
  if (text.includes(PLAN_TOOL)) return true;
  if (planFactIds.some(id => hasToken(text, id))) return true;
  return /\bdns\b/i.test(text);
}

/* ---------- Filter ---------- */

/** The status filter from the query string. Unknown values mean no filter. */
export function statusFilter(search: string): LaunchStatus | null {
  const v = new URLSearchParams(search).get('status');
  return LAUNCH_STATUSES.includes(v as LaunchStatus) ? (v as LaunchStatus) : null;
}

export function searchWithStatus(search: string, value: LaunchStatus | null): string {
  const params = new URLSearchParams(search);
  if (value) params.set('status', value);
  else params.delete('status');
  const text = params.toString();
  return text ? `?${text}` : '';
}
