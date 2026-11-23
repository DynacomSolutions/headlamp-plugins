/*
 * Pure model of the Dashboards widget: checks grouped by one key, with a status, counts and a
 * worst-per-bucket history line for every group. Nothing here fetches or renders.
 *
 * The probe series carry no Kubernetes namespace or app, so the cluster supplies them: the host of a check
 * is matched with the routes (see routes.ts) and the route gives the namespace and the app. The app is the
 * `app.kubernetes.io/name` or `part-of` label of the route, and the namespace of the route when it has none.
 * A check that no route serves groups under its own real name: its host, or its check name when it has no
 * host. A raw IP address is never a group name: a node address gives the node name, any other address gives the
 * check name. There is never an "Other", "Ungrouped" or "Not in cluster" bucket.
 * The other groupings are a `group` series label, the first word of the check name and the check type.
 * `auto` takes the app when any check has one, then the namespace, then the name.
 *
 * The app and group groupings then merge the groups of one project (see `projectKeys`): `ergon`,
 * `ergon-lite-hub` and `ergon-cross-preview` are one group `ergon`, and `t3-cluster` and `t3code` are one
 * group `t3`. The rule reads the first word of the check name and the route, never a list of names.
 */
import { Check, CountSummary, HistoryGrid, Status, summarise } from './model';
import { appLabelOf, type Backend, endpointsOf, type Placement } from './routes';

/** The placement of each check that a route serves, by check name. */
export type Placements = ReadonlyMap<string, Placement>;
const NO_PLACEMENTS: Placements = new Map();

/** The node name of each node address (a node's internal or external IP), see clusterApi.ts. */
export type NodeAddresses = ReadonlyMap<string, string>;
const NO_NODES: NodeAddresses = new Map();

export type GroupBy = 'auto' | 'namespace' | 'app' | 'group' | 'name' | 'type';
export type WidgetRange = 'dashboard' | '1h' | '6h' | '24h' | '7d' | '30d';

export const GROUP_BY_VALUES: readonly GroupBy[] = [
  'auto',
  'namespace',
  'app',
  'group',
  'name',
  'type',
];
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
  /** True when every check of the group probes a node address, so the key is the node name. */
  node: boolean;
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

function placementKey(
  check: Check,
  kind: 'namespace' | 'app',
  placements: Placements
): string | undefined {
  return labelOf(check, kind) ?? placements.get(check.name)?.[kind];
}

/** The grouping `auto` resolves to: the app when any check has one, then the namespace, then the name. */
export function resolveGroupBy(
  groupBy: GroupBy,
  checks: Check[],
  placements: Placements = NO_PLACEMENTS
): Exclude<GroupBy, 'auto'> {
  if (groupBy !== 'auto') return groupBy;
  for (const kind of ['app', 'namespace'] as const) {
    if (checks.some(c => placementKey(c, kind, placements) !== undefined)) return kind;
  }
  return 'name';
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** True for an IPv4 or IPv6 address written as a host. */
export const isIpHost = (host: string): boolean =>
  IPV4.test(host) || (host.includes(':') && /^[0-9a-f:.]+$/i.test(host));

/** The node that a check probes, when its host is the address of a node. */
export function nodeOf(check: Check, nodes: NodeAddresses = NO_NODES): string | undefined {
  const host = endpointsOf(check)[0]?.host;
  return host ? nodes.get(host) : undefined;
}

/**
 * The real name of a check that no grouping places: its host (the `host` label, the probed address or a
 * host-like check name), else the check name. A raw IP address is not a name: the address of a node gives the
 * node name, and any other address gives the check name. It never gives a shared bucket.
 */
export function ownName(check: Check, nodes: NodeAddresses = NO_NODES): string {
  const host = endpointsOf(check)[0]?.host;
  if (!host) return check.name;
  if (isIpHost(host)) return nodes.get(host) ?? check.name;
  return host;
}

export function groupKeyOf(
  check: Check,
  groupBy: Exclude<GroupBy, 'auto'>,
  placements: Placements = NO_PLACEMENTS,
  nodes: NodeAddresses = NO_NODES
): string {
  switch (groupBy) {
    case 'type':
      return check.type ? check.type.toUpperCase() : ownName(check, nodes);
    case 'name':
      return namePrefix(check.name);
    case 'group':
      return (
        labelOf(check, 'group') ??
        placementKey(check, 'app', placements) ??
        placementKey(check, 'namespace', placements) ??
        ownName(check, nodes)
      );
    default:
      // The app falls back to the namespace of its route, as the cluster knows no better.
      return (
        placementKey(check, groupBy, placements) ??
        (groupBy === 'app' ? placementKey(check, 'namespace', placements) : undefined) ??
        ownName(check, nodes)
      );
  }
}

/** The words of a name, lower case: `ergon-lite.example` gives `ergon`, `lite`, `example`. */
const wordsOfRaw = (name: string): string[] => name.split(/[.-]+/).filter(Boolean);
const wordsOf = (name: string): string[] => wordsOfRaw(name.toLowerCase());

export interface KeyedCheck {
  check: Check;
  key: string;
}

/**
 * The names that tie a check to a project, lower case, and whether its key is a shared one. A check that its
 * series label or its route app label places has only its group key, and that key was set on purpose. A check
 * in a shared namespace (a route with no app label) has the Service and the route name too,
 * because the namespace says little, and its key is shared.
 */
function identitiesOf(c: KeyedCheck, placements: Placements): { ids: string[]; shared: boolean } {
  const placement = placements.get(c.check.name);
  const placed = labelOf(c.check, 'app') ?? labelOf(c.check, 'group');
  const strong = !!placed || (!!placement && appLabelOf(placement.route.labels) !== '');
  const ids = [c.key];
  if (!strong && placement) {
    ids.push(placement.route.name);
    if (placement.route.backend) ids.push(placement.route.backend.name);
  }
  return { ids: ids.map(s => s.toLowerCase()), shared: !strong && !!placement };
}

/**
 * The group key of every check after the projects merge. A project is the first word of the check name
 * (`ergon-lite.example.com` gives `ergon`, `t3.eu2.example.com` gives `t3`). A check is tied to it when its
 * group key or, in a shared namespace, its Service or route name starts with that word. A key that holds the
 * word as a whole word (`static-site-ergon-storybook`) also counts when another check already has the word as
 * its key. The checks of a project then share one group when they come from two or more different keys, or
 * when they all sit in a shared key (a namespace that holds many apps, such as `dev`) and are two or more.
 * A check that no route, app label or group label places keeps its own name. A project with one key and one
 * check, or whose checks an app label places apart, is not merged: the
 * `headlamp` Service of the dashboard stays out of `headlamp-agent`.
 */
export function projectKeys(
  entries: KeyedCheck[],
  placements: Placements = NO_PLACEMENTS
): Map<Check, string> {
  const out = new Map<Check, string>(entries.map(e => [e.check, e.key]));
  const keys = new Set(entries.map(e => e.key.toLowerCase()));
  const families = new Map<string, { entry: KeyedCheck; shared: boolean }[]>();
  for (const entry of entries) {
    const word = wordsOf(entry.check.name)[0];
    if (!word || word.length < 2) continue;
    // A check that nothing places keeps its own name: two probes of unrelated hosts are not one project.
    if (
      !placements.has(entry.check.name) &&
      !(labelOf(entry.check, 'app') ?? labelOf(entry.check, 'group'))
    )
      continue;
    const { ids, shared } = identitiesOf(entry, placements);
    const tied =
      ids.some(id => id.startsWith(word)) || (keys.has(word) && wordsOf(ids[0]).includes(word));
    if (!tied) continue;
    const list = families.get(word) ?? [];
    list.push({ entry, shared });
    families.set(word, list);
  }
  for (const members of families.values()) {
    const distinct = new Set(members.map(m => m.entry.key.toLowerCase()));
    const sharedOnly = members.length >= 2 && members.every(m => m.shared);
    if (distinct.size < 2 && !sharedOnly) continue;
    // The group takes the word as the first check spells it.
    const name = wordsOfRaw(members[0].entry.check.name)[0];
    for (const m of members) out.set(m.entry.check, name);
  }
  return out;
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
 * Group the checks. Every check lands in exactly one group, with no top-N and no "Other" group:
 * a check that the grouping cannot place groups under its own real name (see `ownName`).
 * Failing groups sort first (down, then degraded, then no data), then the healthy groups, each by name. `onlyFailing` drops the groups that are not down or degraded.
 * Checks keep their order inside a group (failing first, as the page sorts them).
 */
export function buildGroups(
  checks: Check[],
  groupBy: GroupBy,
  grid: HistoryGrid,
  onlyFailing: boolean,
  placements: Placements = NO_PLACEMENTS,
  nodes: NodeAddresses = NO_NODES
): { groups: UptimeGroup[]; resolved: Exclude<GroupBy, 'auto'> } {
  const resolved = resolveGroupBy(groupBy, checks, placements);
  const own = checks.map(c => ({ check: c, key: groupKeyOf(c, resolved, placements, nodes) }));
  // The app and group groupings merge the groups of one project. The others do what they say.
  const merged =
    resolved === 'app' || resolved === 'group' ? projectKeys(own, placements) : undefined;
  const byKey = new Map<string, Check[]>();
  for (const { check: c, key: ownKey } of own) {
    const key = merged?.get(c) ?? ownKey;
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
    node: list.every(c => nodeOf(c, nodes) === key),
  }));
  if (onlyFailing) groups = groups.filter(g => g.status === 'down' || g.status === 'degraded');
  groups.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.key.localeCompare(b.key));
  return { groups, resolved };
}

/** How many Services of one group are tried for an icon. */
export const ICON_CANDIDATES = 3;

const keyOf = (b: Backend): string => `${b.namespace}/${b.scheme ?? ''}${b.name}:${b.port ?? ''}`;

/** How well a Service name fits a group name: 0 same name, 1 one starts with the other plus a dash, 2 no fit. */
function nameFit(service: string, group: string): number {
  const s = service.toLowerCase();
  const g = group.toLowerCase();
  if (s === g) return 0;
  return s.startsWith(`${g}-`) || g.startsWith(`${s}-`) ? 1 : 2;
}

/**
 * The Services that can give a group its icon, best first. These are the backends of the routes that serve its
 * checks, once each. A group with one Service uses it. A group with several Services (a namespace that holds
 * unrelated apps) uses only the Services whose name fits the group name, the same name first, because the icon
 * of an unrelated app would mislead. With no fit, the group has no candidate and shows its initial badge.
 */
export function groupBackends(
  group: Pick<UptimeGroup, 'key' | 'checks'>,
  placements: Placements
): Backend[] {
  const seen = new Set<string>();
  const all: Backend[] = [];
  for (const c of group.checks) {
    const b = placements.get(c.name)?.route.backend;
    if (!b || seen.has(keyOf(b))) continue;
    seen.add(keyOf(b));
    all.push(b);
  }
  const services = new Set(all.map(b => `${b.namespace}/${b.name}`));
  const pool =
    services.size <= 1
      ? all
      : all
          .map((b, i) => ({ b, i, fit: nameFit(b.name, group.key) }))
          .filter(x => x.fit < 2)
          .sort((a, c) => a.fit - c.fit || a.i - c.i)
          .map(x => x.b);
  return pool.slice(0, ICON_CANDIDATES);
}
