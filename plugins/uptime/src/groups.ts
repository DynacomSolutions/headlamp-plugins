/*
 * Pure model of the Dashboards widget: checks grouped by one key, with a status, counts and a
 * worst-per-bucket history line for every group. Nothing here fetches or renders.
 *
 * The probe series carry no Kubernetes namespace or app, so the cluster supplies them: the host of a check
 * is matched with the routes (see routes.ts) and the route gives the namespace and the app. A check that no
 * route serves goes in "Not in cluster", one group per check type, never in a mixed "Other" group.
 * The other groupings are a `group` series label, the first word of the check name and the check type.
 * `auto` takes the namespace when any check has one, then the app, then the name.
 */
import { Check, CountSummary, HistoryGrid, Status, summarise } from './model';
import type { Placement } from './routes';

/** The placement of each check that a route serves, by check name. */
export type Placements = ReadonlyMap<string, Placement>;
const NO_PLACEMENTS: Placements = new Map();

export const NOT_IN_CLUSTER = 'Not in cluster';

export type GroupBy = 'auto' | 'namespace' | 'app' | 'group' | 'name' | 'type';
export type WidgetRange = 'dashboard' | '1h' | '6h' | '24h' | '7d' | '30d';

export const GROUP_BY_VALUES: readonly GroupBy[] = ['auto', 'namespace', 'app', 'group', 'name', 'type'];
export const RANGE_VALUES: readonly WidgetRange[] = ['dashboard', '1h', '6h', '24h', '7d', '30d'];

/** The series labels that can carry a grouping, in the order they are read. A label wins over the cluster. */
const LABEL_KEYS: Record<'namespace' | 'app' | 'group', string[]> = {
  namespace: ['namespace', 'kubernetes_namespace'],
  app: ['app', 'app_kubernetes_io_name', 'application'],
  group: ['group'],
};

export interface UptimeGroup {
  key: string;
  status: Status;
  counts: CountSummary;
  checks: Check[];
  /** The worst availability of its checks per history bucket (0..1), undefined = no data. */
  history: (number | undefined)[];
}

/** The widget grid for a time range: about 60 to 96 buckets, never narrower than a minute. */
export function gridFor(range: WidgetRange, dashboardRange: string): HistoryGrid {
  const effective = range === 'dashboard' ? dashboardRange : range;
  switch (effective) {
    case '6h':
      return { stepSec: 300, buckets: 72 };
    case '7d':
      return { stepSec: 7200, buckets: 84 };
    case '30d':
      return { stepSec: 28800, buckets: 90 };
    case '1h':
    case '5m':
    case '15m':
      return { stepSec: 60, buckets: 60 };
    default:
      return { stepSec: 900, buckets: 96 };
  }
}

export function gridLabel(grid: HistoryGrid): string {
  const hours = (grid.stepSec * grid.buckets) / 3600;
  return hours >= 48 ? `${Math.round(hours / 24)} days` : `${Math.round(hours)} h`;
}

function labelOf(check: Check, kind: keyof typeof LABEL_KEYS): string | undefined {
  for (const k of LABEL_KEYS[kind]) if (check.labels[k]) return check.labels[k];
  return undefined;
}

/** The first word of a check name: `t3.hq.example.com` and `t3-host` both give `t3`. */
export function namePrefix(name: string): string {
  return name.split(/[.-]/)[0] || name;
}

function placementKey(check: Check, kind: 'namespace' | 'app', placements: Placements): string | undefined {
  return labelOf(check, kind) ?? placements.get(check.name)?.[kind];
}

/** The grouping `auto` resolves to: the namespace when any check has one, then the app, then the name. */
export function resolveGroupBy(
  groupBy: GroupBy,
  checks: Check[],
  placements: Placements = NO_PLACEMENTS
): Exclude<GroupBy, 'auto'> {
  if (groupBy !== 'auto') return groupBy;
  for (const kind of ['namespace', 'app'] as const) {
    if (checks.some(c => placementKey(c, kind, placements) !== undefined)) return kind;
  }
  return 'name';
}

export function groupKeyOf(
  check: Check,
  groupBy: Exclude<GroupBy, 'auto'>,
  placements: Placements = NO_PLACEMENTS
): string {
  const type = check.type ? check.type.toUpperCase() : '(no type)';
  switch (groupBy) {
    case 'type':
      return type;
    case 'name':
      return namePrefix(check.name);
    case 'group':
      return labelOf(check, 'group') ?? '(no group)';
    default:
      // The app falls back to the namespace of its route, as the cluster knows no better.
      return (
        placementKey(check, groupBy, placements) ??
        (groupBy === 'app' ? placementKey(check, 'namespace', placements) : undefined) ??
        `${NOT_IN_CLUSTER} · ${type}`
      );
  }
}

/** Worst status wins: down, then degraded, then up. Unknown only when no check has data. */
export function worstStatus(checks: Check[]): Status {
  if (checks.some(c => c.status === 'down')) return 'down';
  if (checks.some(c => c.status === 'degraded')) return 'degraded';
  if (checks.some(c => c.status === 'up')) return 'up';
  return 'unknown';
}

/** The lowest availability of the checks in every bucket. A bucket with no data stays undefined. */
export function worstHistory(checks: Check[], buckets: number): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(buckets).fill(undefined);
  for (const c of checks) {
    for (let i = 0; i < buckets; i++) {
      const v = c.history[i];
      if (v !== undefined && (out[i] === undefined || v < (out[i] as number))) out[i] = v;
    }
  }
  return out;
}

/** The mean availability over the buckets that have data. */
export function meanAvailability(history: (number | undefined)[]): number | undefined {
  const defined = history.filter((v): v is number => v !== undefined);
  if (defined.length === 0) return undefined;
  return defined.reduce((a, b) => a + b, 0) / defined.length;
}

const ORDER: Record<Status, number> = { down: 0, degraded: 1, unknown: 2, up: 3 };

/**
 * Group the checks. Every check lands in exactly one group, with no top-N and no "Other" group.
 * Failing groups sort first, then by name. `onlyFailing` drops the groups that are not down or degraded.
 * Checks keep their order inside a group (failing first, as the page sorts them).
 */
export function buildGroups(
  checks: Check[],
  groupBy: GroupBy,
  grid: HistoryGrid,
  onlyFailing: boolean,
  placements: Placements = NO_PLACEMENTS
): { groups: UptimeGroup[]; resolved: Exclude<GroupBy, 'auto'> } {
  const resolved = resolveGroupBy(groupBy, checks, placements);
  const byKey = new Map<string, Check[]>();
  for (const c of checks) {
    const key = groupKeyOf(c, resolved, placements);
    const list = byKey.get(key);
    if (list) list.push(c);
    else byKey.set(key, [c]);
  }
  let groups: UptimeGroup[] = [...byKey.entries()].map(([key, list]) => ({
    key,
    status: worstStatus(list),
    counts: summarise(list),
    checks: list,
    history: worstHistory(list, grid.buckets),
  }));
  if (onlyFailing) groups = groups.filter(g => g.status === 'down' || g.status === 'degraded');
  groups.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.key.localeCompare(b.key));
  return { groups, resolved };
}
