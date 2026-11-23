/*
 * The multi-select of the Incidents page: pure functions, no React. The selection is a list of
 * diagnosis ids in the order the user chose them. The list state (filters and selection) lives in
 * the query string of the page, so the URL alone shows the same view again.
 */
import { DiagnosisSummary, IncidentFilter, Status } from './model';

/** The agent links at most this many incidents to one chat. */
export const MAX_CHAT_INCIDENTS = 20;

export interface SelectionResult {
  ids: string[];
  /** True when the cap stopped at least one incident from joining the selection. */
  capped: boolean;
}

/** Adds ids to a selection, in order, without repeats, up to the cap. */
function add(current: string[], extra: string[], cap: number): SelectionResult {
  const ids = [...current];
  let capped = false;
  for (const id of extra) {
    if (ids.includes(id)) continue;
    if (ids.length >= cap) {
      capped = true;
      continue;
    }
    ids.push(id);
  }
  return { ids, capped };
}

/** Selects an incident that is not selected, and clears one that is. */
export function toggleId(
  current: string[],
  id: string,
  cap: number = MAX_CHAT_INCIDENTS
): SelectionResult {
  if (current.includes(id)) return { ids: current.filter(x => x !== id), capped: false };
  return add(current, [id], cap);
}

/**
 * Shift-click: selects every incident from the anchor to the target, as the list shows them. The
 * anchor is the last incident the user toggled. Without a usable anchor it selects the target only.
 */
export function rangeIds(
  current: string[],
  order: string[],
  anchor: string | null,
  target: string,
  cap: number = MAX_CHAT_INCIDENTS
): SelectionResult {
  const to = order.indexOf(target);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  if (to < 0) return { ids: current, capped: false };
  if (from < 0) return add(current, [target], cap);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return add(current, order.slice(lo, hi + 1), cap);
}

/** Selects every incident of the current filter, as the list shows them, up to the cap. */
export function selectAllIds(
  current: string[],
  order: string[],
  cap: number = MAX_CHAT_INCIDENTS
): SelectionResult {
  return add(current, order, cap);
}

/** Clears the shown incidents from the selection. Selected incidents that the filter hides stay. */
export function clearShown(current: string[], order: string[]): string[] {
  const shown = new Set(order);
  return current.filter(id => !shown.has(id));
}

/** Drops ids that no diagnosis has any more. Keeps the order. */
export function pruneIds(current: string[], existing: Iterable<string>): string[] {
  const known = new Set(existing);
  return current.filter(id => known.has(id));
}

/* ---------- Query string ---------- */

export interface ListQuery extends IncidentFilter {
  /** Free text, matched against the alert name, the cause and the source. */
  q: string;
  /** The selected diagnosis ids, in the order the user chose them. */
  sel: string[];
}

export const DEFAULT_LIST_QUERY: ListQuery = {
  status: 'all',
  severity: 'all',
  openOnly: true,
  q: '',
  sel: [],
};

const STATUSES: Status[] = ['queued', 'running', 'done', 'failed'];
const SEVERITIES = ['critical', 'warning', 'other'] as const;

export function parseListQuery(search: string): ListQuery {
  const p = new URLSearchParams(search);
  const status = p.get('status');
  const severity = p.get('severity');
  const seen = new Set<string>();
  const sel: string[] = [];
  for (const raw of (p.get('sel') ?? '').split(',')) {
    const id = raw.trim();
    if (id && !seen.has(id) && sel.length < MAX_CHAT_INCIDENTS) {
      seen.add(id);
      sel.push(id);
    }
  }
  return {
    status: STATUSES.includes(status as Status) ? (status as Status) : 'all',
    severity: SEVERITIES.includes(severity as (typeof SEVERITIES)[number])
      ? (severity as ListQuery['severity'])
      : 'all',
    // The default view is open incidents only. `?resolved=1` adds the resolved ones. A link with `?open=1` is the default view.
    openOnly: p.get('resolved') !== '1',
    q: p.get('q') ?? '',
    sel,
  };
}

/** The query string of a list state, with a leading `?`, or an empty string for the default view. */
export function listQueryString(query: ListQuery): string {
  const p = new URLSearchParams();
  if (query.status !== 'all') p.set('status', query.status);
  if (query.severity !== 'all') p.set('severity', query.severity);
  if (!query.openOnly) p.set('resolved', '1');
  if (query.q.trim()) p.set('q', query.q.trim());
  if (query.sel.length) p.set('sel', query.sel.join(','));
  const text = p.toString().replace(/%2C/g, ',');
  return text ? `?${text}` : '';
}

/** True when the diagnosis matches every word of the text. An empty text matches all. */
export function matchesText(d: DiagnosisSummary, text: string): boolean {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${d.alertName} ${d.likelyCause} ${d.source} ${d.id}`.toLowerCase();
  return words.every(w => hay.includes(w));
}
