/*
 * Pure functions: fold raw Emissary Mappings into one entry per user-facing
 * site. No React and no network access here so it is unit-testable.
 *
 * Aliases of one app (tailnet, LAN and localhost names, and their -public /
 * -lan / -localhost / -local Mapping names) collapse onto one site keyed by
 * the host with its suffix stripped.
 */

export type Kind = 'tailnet' | 'lan' | 'local' | 'other';

/** The subset of an Emissary Mapping the directory needs. */
export interface Mapping {
  namespace: string;
  name: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  host: string;
  prefix: string;
  service: string;
}

export interface MappingView {
  name: string;
  namespace: string;
  host: string;
  prefix: string;
  service: string;
}

export interface Site {
  id: string;
  app: string;
  namespace: string;
  primaryUrl: string;
  kind: Kind;
  hosts: string[];
  paths: string[];
  service: string;
  mappings: MappingView[];
}

/** Hostname suffixes (each with its leading dot) that identify each kind of name. */
export interface Suffixes {
  tailnet: string[];
  network: string[];
  machine: string[];
}

/** Generic defaults. A deployment supplies its real suffixes through the plugin config. */
export const DEFAULT_SUFFIXES: Suffixes = {
  tailnet: ['.example.com'],
  network: ['.example.net'],
  machine: ['.localhost'],
};

export const NAME_SUFFIXES = ['-public', '-lan', '-localhost', '-local'];

const norm = (s: string) => s.trim().toLowerCase();

/** Parse "a.example.com, b.example.com" into normalised dotted suffixes. */
export function parseSuffixes(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const out = value
    .split(',')
    .map(norm)
    .filter(Boolean)
    .map(s => (s.startsWith('.') ? s : `.${s}`));
  return out.length ? out : fallback;
}

export function suffixesFrom(cfg: {
  tailnetSuffixes?: string;
  lanSuffixes?: string;
  localSuffixes?: string;
}): Suffixes {
  return {
    tailnet: parseSuffixes(cfg.tailnetSuffixes, DEFAULT_SUFFIXES.tailnet),
    network: parseSuffixes(cfg.lanSuffixes, DEFAULT_SUFFIXES.network),
    machine: parseSuffixes(cfg.localSuffixes, DEFAULT_SUFFIXES.machine),
  };
}

const endsWithAny = (h: string, sufs: string[]) => sufs.some(s => h.endsWith(s));

/** Strip one tailnet, LAN or localhost suffix so aliases collapse. */
export function groupKey(host: string, sufs: Suffixes = DEFAULT_SUFFIXES): string {
  const h = norm(host);
  for (const suf of [...sufs.tailnet, ...sufs.network, ...sufs.machine]) {
    if (h.endsWith(suf)) return h.slice(0, h.length - suf.length);
  }
  return h;
}

/** Classify a hostname for URL scheme and filters. */
export function kindOf(host: string, sufs: Suffixes = DEFAULT_SUFFIXES): Kind {
  const h = norm(host);
  if (endsWithAny(h, sufs.tailnet)) return 'tailnet';
  if (endsWithAny(h, sufs.network)) return 'lan';
  if (h === 'localhost' || endsWithAny(h, sufs.machine)) return 'local';
  return 'other';
}

/** https for public names, http for local and LAN aliases. */
export function schemeOf(kind: Kind): 'http' | 'https' {
  return kind === 'local' || kind === 'lan' ? 'http' : 'https';
}

/** scheme://host/prefix with a leading slash, and "/" for an empty prefix. */
export function joinUrl(scheme: string, host: string, prefix: string): string {
  let p = prefix;
  if (p === '') p = '/';
  if (!p.startsWith('/')) p = `/${p}`;
  return `${scheme}://${host}${p}`;
}

function normalise(m: Mapping): Mapping | null {
  const host = norm(m.host || '');
  if (host === '') return null;
  let prefix = m.prefix;
  if (!prefix || prefix.trim() === '') prefix = '/';
  if (!prefix.startsWith('/')) prefix = `/${prefix}`;
  return { ...m, host, prefix };
}

/** Prefer Kubernetes app labels, then the Helm release, then the Mapping name. */
export function appName(m: Pick<Mapping, 'name' | 'labels' | 'annotations'>): string {
  const l = m.labels;
  if (l) {
    const v = (l['app.kubernetes.io/name'] || '').trim();
    if (v) return v;
    const p = (l['app.kubernetes.io/part-of'] || '').trim();
    if (p) return p;
  }
  const rel = (m.annotations?.['meta.helm.sh/release-name'] || '').trim();
  if (rel) return rel;
  for (const suf of NAME_SUFFIXES) {
    if (m.name.endsWith(suf)) return m.name.slice(0, m.name.length - suf.length);
  }
  return m.name;
}

const KIND_RANK: Record<Kind, number> = { tailnet: 0, other: 1, lan: 2, local: 3 };

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

function uniqueStable(input: string[], less: (a: string, b: string) => boolean): string[] {
  const out = [...new Set(input)];
  return out.sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0));
}

function pathLess(a: string, b: string): boolean {
  if (a === b) return false;
  if (a === '/') return true;
  if (b === '/') return false;
  if (a.length !== b.length) return a.length < b.length;
  return a < b;
}

function buildSite(id: string, ms: Mapping[], sufs: Suffixes): Site {
  const rank = (h: string) => KIND_RANK[kindOf(h, sufs)];
  const sorted = [...ms].sort(
    (a, b) =>
      cmp(rank(a.host), rank(b.host)) ||
      cmp(a.host, b.host) ||
      cmp(a.prefix.length, b.prefix.length) ||
      cmp(a.prefix, b.prefix) ||
      cmp(a.namespace, b.namespace) ||
      cmp(a.name, b.name)
  );
  const primary = sorted[0];
  const kind = kindOf(primary.host, sufs);
  let prefix = primary.prefix;
  for (const m of sorted) {
    if (m.host === primary.host && m.prefix.length < prefix.length) prefix = m.prefix;
  }
  const hostLess = (a: string, b: string) =>
    rank(a) !== rank(b) ? rank(a) < rank(b) : a < b;
  return {
    id,
    app: appName(primary),
    namespace: primary.namespace,
    primaryUrl: joinUrl(schemeOf(kind), primary.host, prefix),
    kind,
    hosts: uniqueStable(
      sorted.map(m => m.host),
      hostLess
    ),
    paths: uniqueStable(
      sorted.filter(m => m.host === primary.host).map(m => m.prefix),
      pathLess
    ),
    service: primary.service,
    mappings: sorted.map(m => ({
      name: m.name,
      namespace: m.namespace,
      host: m.host,
      prefix: m.prefix,
      service: m.service,
    })),
  };
}

/** Fold raw mappings into sites. Empty-host mappings are dropped. */
export function buildSites(input: Mapping[], sufs: Suffixes = DEFAULT_SUFFIXES): Site[] {
  const groups = new Map<string, Mapping[]>();
  for (const m of input) {
    const n = normalise(m);
    if (!n) continue;
    const key = groupKey(n.host, sufs);
    const list = groups.get(key);
    if (list) list.push(n);
    else groups.set(key, [n]);
  }
  const sites = [...groups].map(([key, ms]) => buildSite(key, ms, sufs));
  return sites.sort((a, b) => cmp(a.primaryUrl, b.primaryUrl) || cmp(a.id, b.id));
}

/** Read the fields the directory needs from a raw Mapping object (spec.host or spec.hostname). */
export function mappingFrom(o: any): Mapping {
  const spec = o?.spec ?? {};
  return {
    namespace: o?.metadata?.namespace ?? '',
    name: o?.metadata?.name ?? '',
    labels: o?.metadata?.labels,
    annotations: o?.metadata?.annotations,
    host: spec.host || spec.hostname || '',
    prefix: spec.prefix || '',
    service: spec.service || '',
  };
}

export type KindFilter = 'tailnet' | 'all' | 'local';

export interface Filters {
  q: string;
  kind: KindFilter;
  namespaces: string[];
}

export const DEFAULT_FILTERS: Filters = { q: '', kind: 'tailnet', namespaces: [] };

export function filtersDirty(f: Filters): boolean {
  return f.q.trim() !== '' || f.kind !== DEFAULT_FILTERS.kind || f.namespaces.length > 0;
}

export function matchesSite(site: Site, f: Filters): boolean {
  if (f.kind === 'tailnet' && site.kind !== 'tailnet') return false;
  if (f.kind === 'local' && site.kind !== 'local' && site.kind !== 'lan') return false;
  if (f.namespaces.length && !f.namespaces.includes(site.namespace)) return false;
  const q = f.q.trim().toLowerCase();
  if (!q) return true;
  const blob = [site.app, site.namespace, site.primaryUrl, site.service, site.id, ...site.hosts, ...site.mappings.map(m => m.name)]
    .join(' ')
    .toLowerCase();
  return blob.includes(q);
}

/** Namespaces with the number of sites in each, sorted by name. */
export function namespaceCounts(sites: Site[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const s of sites) counts.set(s.namespace, (counts.get(s.namespace) || 0) + 1);
  return [...counts].sort((a, b) => cmp(a[0], b[0]));
}

/** URL of one extra path on a site's primary host. */
export function pathUrl(site: Site, prefix: string): string {
  try {
    return new URL(site.primaryUrl).origin + prefix;
  } catch {
    return site.primaryUrl;
  }
}

/** Hosts other than the primary one. */
export function aliasesOf(site: Site): string[] {
  return site.hosts.filter(h => !site.primaryUrl.includes(h));
}
