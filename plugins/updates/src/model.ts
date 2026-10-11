/** Pure parsing, derived values, filtering and URL state for the version-tracker report. */

export const SCHEMA_VERSION = 1;
export const REPORT_LABEL = 'app.kubernetes.io/name=version-tracker';
export const REPORT_CONFIGMAP = 'version-tracker-report';
export const REPORT_KEY = 'report.json';
export const PREFERRED_NAMESPACE = 'monitoring';
/** The tracker runs twice a day; older than this means a run was missed. */
export const STALE_AFTER_HOURS = 13;

export type Status = 'up-to-date' | 'available' | 'blocked' | 'unknown';
export const STATUSES: Status[] = ['available', 'blocked', 'unknown', 'up-to-date'];

export interface Blocker {
  reason: string;
  requires: string;
  source: string;
}

export interface Component {
  id: string;
  name: string;
  category: string;
  current: string;
  latest: string;
  latestUrl: string;
  releaseNotesUrl: string;
  status: Status;
  security: boolean;
  blockers: Blocker[];
  blocks: string[];
  checkedAt: string;
  error: string | null;
}

export interface Report {
  schemaVersion: number;
  generatedAt: string;
  kubernetes: { server: string; nodes: { name: string; version: string }[] };
  components: Component[];
}

export type ParseResult =
  | { kind: 'ok'; report: Report }
  | { kind: 'malformed' | 'schema'; message: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function component(raw: unknown): Component | null {
  if (!isObj(raw) || !str(raw.id)) return null;
  const status = STATUSES.includes(raw.status as Status) ? (raw.status as Status) : 'unknown';
  return {
    id: str(raw.id),
    name: str(raw.name) || str(raw.id),
    category: str(raw.category) || 'other',
    current: str(raw.current),
    latest: str(raw.latest),
    latestUrl: str(raw.latestUrl),
    releaseNotesUrl: str(raw.releaseNotesUrl),
    status,
    security: raw.security === true,
    blockers: (Array.isArray(raw.blockers) ? raw.blockers : []).filter(isObj).map(b => ({
      reason: str(b.reason),
      requires: str(b.requires),
      source: str(b.source),
    })),
    blocks: (Array.isArray(raw.blocks) ? raw.blocks : []).filter(b => typeof b === 'string'),
    checkedAt: str(raw.checkedAt),
    error: typeof raw.error === 'string' && raw.error ? raw.error : null,
  };
}

/** Parse the report.json text; never throws. */
export function parseReport(text: string | undefined): ParseResult {
  if (!text) return { kind: 'malformed', message: 'The report is empty.' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return {
      kind: 'malformed',
      message: `The report is not valid JSON (${(e as Error).message}).`,
    };
  }
  if (!isObj(data)) return { kind: 'malformed', message: 'The report is not a JSON object.' };
  if (data.schemaVersion !== SCHEMA_VERSION) {
    return {
      kind: 'schema',
      message: `The report uses schema version ${String(
        data.schemaVersion
      )}, but this plugin understands version ${SCHEMA_VERSION}. Update the plugin or the version tracker.`,
    };
  }
  if (!Array.isArray(data.components)) {
    return { kind: 'malformed', message: 'The report has no components list.' };
  }
  const k = isObj(data.kubernetes) ? data.kubernetes : {};
  return {
    kind: 'ok',
    report: {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: str(data.generatedAt),
      kubernetes: {
        server: str(k.server),
        nodes: (Array.isArray(k.nodes) ? k.nodes : []).filter(isObj).map(n => ({
          name: str(n.name),
          version: str(n.version),
        })),
      },
      components: data.components.map(component).filter((c): c is Component => c !== null),
    },
  };
}

/** Pick the report ConfigMap: prefer the monitoring namespace, then the first by namespace/name. */
export function pickConfigMap<T extends { metadata?: { name?: string; namespace?: string } }>(
  items: T[]
): T | undefined {
  const named = items.filter(i => i.metadata?.name === REPORT_CONFIGMAP);
  const pool = named.length ? named : items;
  const key = (i: T) => `${i.metadata?.namespace ?? ''}/${i.metadata?.name ?? ''}`;
  return (
    pool.find(i => i.metadata?.namespace === PREFERRED_NAMESPACE) ??
    [...pool].sort((a, b) => key(a).localeCompare(key(b)))[0]
  );
}

export interface Counts {
  available: number;
  blocked: number;
  security: number;
  unknown: number;
  upToDate: number;
}

export function countsOf(components: Component[]): Counts {
  const c: Counts = { available: 0, blocked: 0, security: 0, unknown: 0, upToDate: 0 };
  for (const x of components) {
    if (x.status === 'available') c.available++;
    else if (x.status === 'blocked') c.blocked++;
    else if (x.status === 'unknown') c.unknown++;
    else c.upToDate++;
    if (x.security) c.security++;
  }
  return c;
}

/** Numeric parts of a version such as v1.34.6+k3s1 (build metadata ignored); null if none. */
export function versionParts(v: string): number[] | null {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(v.trim());
  return m ? m[1].split('.').map(Number) : null;
}

export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) return 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export type Skew = 'none' | 'newer' | 'older';

/** A node on a different version from the server; "newer" is the unsupported direction. */
export function nodeSkew(server: string, node: string): Skew {
  const c = compareVersions(node, server);
  return c > 0 ? 'newer' : c < 0 ? 'older' : 'none';
}

export function reportAgeHours(generatedAt: string, now: number): number | null {
  const t = Date.parse(generatedAt);
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / 3_600_000);
}

export function isStale(ageHours: number | null): boolean {
  return ageHours === null || ageHours > STALE_AFTER_HOURS;
}

export function formatAge(hours: number | null): string {
  if (hours === null) return 'unknown age';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return `${Math.floor(hours)} h ${Math.round((hours % 1) * 60)} min`;
}

/** Components that block `c` (it lists them as blocks), and those `c` blocks. */
export function blockerChain(
  report: Report,
  c: Component
): { blockedBy: Component[]; blocks: Component[] } {
  const byId = new Map(report.components.map(x => [x.id, x]));
  return {
    blockedBy: report.components.filter(x => x.id !== c.id && x.blocks.includes(c.id)),
    blocks: c.blocks.map(id => byId.get(id)).filter((x): x is Component => !!x),
  };
}

export type SortKey = 'name' | 'category' | 'status' | 'current' | 'latest';
export type SortDir = 'asc' | 'desc';

export interface View {
  q: string;
  status: Status | 'security' | '';
  category: string;
  sort: SortKey;
  dir: SortDir;
}

export const DEFAULT_VIEW: View = { q: '', status: '', category: '', sort: 'name', dir: 'asc' };
const SORT_KEYS: SortKey[] = ['name', 'category', 'status', 'current', 'latest'];
const STATUS_ORDER: Record<Status, number> = {
  blocked: 0,
  available: 1,
  unknown: 2,
  'up-to-date': 3,
};

export function filterComponents(list: Component[], v: View): Component[] {
  const q = v.q.trim().toLowerCase();
  return list.filter(c => {
    if (v.status === 'security' ? !c.security : v.status && c.status !== v.status) return false;
    if (v.category && c.category !== v.category) return false;
    if (!q) return true;
    return [
      c.id,
      c.name,
      c.category,
      c.current,
      c.latest,
      ...c.blocks,
      ...c.blockers.map(b => b.reason),
    ]
      .join('\n')
      .toLowerCase()
      .includes(q);
  });
}

export function sortComponents(list: Component[], key: SortKey, dir: SortDir): Component[] {
  const sign = dir === 'asc' ? 1 : -1;
  const cmp = (a: Component, b: Component): number => {
    if (key === 'status') return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (key === 'current' || key === 'latest') return compareVersions(a[key], b[key]);
    return a[key].localeCompare(b[key]);
  };
  return [...list].sort((a, b) => sign * cmp(a, b) || a.name.localeCompare(b.name));
}

export function viewFromSearch(search: string): View {
  const p = new URLSearchParams(search);
  const status = p.get('status') ?? '';
  const sort = p.get('sort') as SortKey;
  return {
    q: p.get('q') ?? '',
    status:
      status === 'security' || STATUSES.includes(status as Status)
        ? (status as View['status'])
        : '',
    category: p.get('category') ?? '',
    sort: SORT_KEYS.includes(sort) ? sort : DEFAULT_VIEW.sort,
    dir: p.get('dir') === 'desc' ? 'desc' : 'asc',
  };
}

/** Only non-default values are written, so the default view has a clean URL. */
export function viewToSearch(v: View): string {
  const p = new URLSearchParams();
  (Object.keys(DEFAULT_VIEW) as (keyof View)[]).forEach(k => {
    if (v[k] !== DEFAULT_VIEW[k]) p.set(k, v[k]);
  });
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const BASE_PATH = '/updates';
export const detailPath = (id: string) => `${BASE_PATH}/${encodeURIComponent(id)}`;
