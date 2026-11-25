/*
 * Chat about a group of incidents: pure functions, no React.
 *
 * The dashboard URL holds the selection as path segments after the tab (the Dashboards plugin keeps
 * them opaque and gives them to the widgets as `focus`):
 *   /dashboards/<name>/<tab>/incident/<diagnosis id>   one incident
 *   /dashboards/<name>/<tab>/group/<alert name>        every incident of one alert name in the view
 * The list widget resolves the segments against its rows and publishes the result to the chat widget
 * (see selection.ts).
 *
 * What the agent receives for a group (the rule is one place, `groupChatRequest`):
 *  - The group is the incidents of the alert name that the list shows now. The widget setting
 *    "Hide resolved" is part of that: with it on, a resolved incident is not in the group.
 *  - The newest GROUP_FULL_DETAIL incidents go as `diagnosisIds`. The agent puts the same detail in
 *    the prompt for each of them as for a single incident (the multi-incident path of the Incidents
 *    page, one thread linked to several incidents).
 *  - The next GROUP_SUMMARY_LIMIT incidents, newest first, go as `summaryIds`. The agent puts one short
 *    line for each of them in the prompt (id, severity, status, time, where, cause).
 *  - Older incidents than that go uncounted into the prompt. `groupOmitted` tells the agent how many.
 */
import { groupByAlert, IncidentGroup } from './IncidentRows';
import { DiagnosisSummary } from './model';
import { SeverityGroup } from './severity';

/** Incidents of a group that get the full detail. The agent shares one prompt budget between them. */
export const GROUP_FULL_DETAIL = 10;
/** Incidents after those that get one short line each. This is the limit of the agent. */
export const GROUP_SUMMARY_LIMIT = 500;

export const FOCUS_INCIDENT = 'incident';
export const FOCUS_GROUP = 'group';

export interface SelectedIncident {
  kind: 'incident';
  id: string;
  alertName: string;
}

export interface SelectedGroup {
  kind: 'group';
  /** The alert name, the key of the group. */
  name: string;
  /** Every incident of the group that the view shows, newest first. */
  ids: string[];
  worst: SeverityGroup;
  /** `open` while the list hides resolved incidents, `all` when it shows them. */
  view: 'open' | 'all';
}

export type Selection = SelectedIncident | SelectedGroup;

export const incidentFocus = (id: string): string[] => [FOCUS_INCIDENT, id];
export const groupFocus = (name: string): string[] => [FOCUS_GROUP, name];

/** The selection that URL segments name, or null. A value of another shape is no selection. */
export function parseSelectionFocus(
  focus: readonly string[] | undefined
): { kind: 'incident' | 'group'; key: string } | null {
  if (!focus || focus.length !== 2 || !focus[1]) return null;
  if (focus[0] === FOCUS_INCIDENT) return { kind: 'incident', key: focus[1] };
  if (focus[0] === FOCUS_GROUP) return { kind: 'group', key: focus[1] };
  return null;
}

const time = (d: DiagnosisSummary): number => {
  const t = Date.parse(d.createdAt);
  return Number.isNaN(t) ? 0 : t;
};

/** Newest first. Equal times keep the order of the rows. */
export function newestFirst(rows: DiagnosisSummary[]): DiagnosisSummary[] {
  return rows
    .map((d, i) => [d, i] as const)
    .sort((a, b) => time(b[0]) - time(a[0]) || a[1] - b[1])
    .map(x => x[0]);
}

/**
 * Turns the URL segments into a selection. An incident is found among all the rows, so a link to a
 * resolved incident still works. A group is found among the rows of the view (`shown`), so it holds
 * what the list shows. A segment that names nothing gives null.
 */
export function resolveSelection(
  focus: readonly string[] | undefined,
  all: DiagnosisSummary[],
  shown: DiagnosisSummary[],
  openOnly: boolean
): Selection | null {
  const parsed = parseSelectionFocus(focus);
  if (!parsed) return null;
  if (parsed.kind === 'incident') {
    const d = all.find(x => x.id === parsed.key);
    return d ? { kind: 'incident', id: d.id, alertName: d.alertName || d.id } : null;
  }
  const g = groupByAlert(shown).find(x => x.name === parsed.key);
  return g ? selectedGroupOf(g, openOnly) : null;
}

export function selectedGroupOf(g: IncidentGroup, openOnly: boolean): SelectedGroup {
  return {
    kind: 'group',
    name: g.name,
    ids: newestFirst(g.rows).map(d => d.id),
    worst: g.worst,
    view: openOnly ? 'open' : 'all',
  };
}

/** True when two selections are the same, so the store keeps its object and nothing rerenders. */
export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'incident' && b.kind === 'incident')
    return a.id === b.id && a.alertName === b.alertName;
  if (a.kind === 'group' && b.kind === 'group')
    return (
      a.name === b.name &&
      a.worst === b.worst &&
      a.view === b.view &&
      a.ids.length === b.ids.length &&
      a.ids.every((id, i) => id === b.ids[i])
    );
  return false;
}

/** The body of the chat request for a group (see `createGroupChat`). */
export interface GroupChatRequest {
  diagnosisIds: string[];
  groupName: string;
  summaryIds?: string[];
  groupOmitted?: number;
}

/** Splits the incidents of a group, newest first, into full detail, one short line, and left out. */
export function groupChatRequest(group: SelectedGroup): GroupChatRequest {
  const full = group.ids.slice(0, GROUP_FULL_DETAIL);
  const summary = group.ids.slice(GROUP_FULL_DETAIL, GROUP_FULL_DETAIL + GROUP_SUMMARY_LIMIT);
  const omitted = group.ids.length - full.length - summary.length;
  return {
    diagnosisIds: full,
    groupName: group.name,
    ...(summary.length ? { summaryIds: summary } : {}),
    ...(omitted > 0 ? { groupOmitted: omitted } : {}),
  };
}

/** One chat for each context: the group in the open or the all view, one incident, or the cluster (''). */
export function chatContextKey(sel: Selection | null): string {
  if (!sel) return '';
  return sel.kind === 'incident' ? sel.id : `group:${sel.view}:${sel.name}`;
}

export const GROUP_PROMPTS = [
  'What do these incidents have in common?',
  'Is this one root cause?',
  'Which one should I look at first?',
];

export const incidentWord = (n: number): string => `${n} ${n === 1 ? 'incident' : 'incidents'}`;
