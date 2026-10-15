export const CONFIG_KEY = 'registry';

/* ---------- settings ---------- */

export interface Settings {
  /** Namespace of the catalogue backend Service. */
  namespace: string;
  /** Name of the catalogue backend Service. */
  service: string;
  /** Service port (number or port name). */
  port: string;
  /** Seconds between refreshes. */
  refreshSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  namespace: 'registry',
  service: 'registry-catalog',
  port: '80',
  refreshSeconds: 60,
};

export function resolveSettings(
  stored: Partial<Settings> | undefined,
  defaults: Partial<Settings> | undefined
): Settings {
  const blank = (v: unknown) => v === undefined || v === null || v === '';
  const pick = <K extends keyof Settings>(key: K): Settings[K] => {
    const s = stored?.[key];
    const d = defaults?.[key];
    if (!blank(s)) return s as Settings[K];
    if (!blank(d)) return d as Settings[K];
    return DEFAULT_SETTINGS[key];
  };
  const refresh = Number(pick('refreshSeconds'));
  return {
    namespace: String(pick('namespace')).trim(),
    service: String(pick('service')).trim(),
    port: String(pick('port')).trim(),
    refreshSeconds: Number.isFinite(refresh) ? Math.min(600, Math.max(5, refresh)) : 60,
  };
}

/** Kubernetes service-proxy URL for a backend path. */
export function backendUrl(s: Settings, path: string): string {
  const e = encodeURIComponent;
  const svc = s.port ? `${e(s.service)}:${e(s.port)}` : e(s.service);
  return `/api/v1/namespaces/${e(s.namespace)}/services/${svc}/proxy${
    path.startsWith('/') ? path : `/${path}`
  }`;
}

/* ---------- catalogue ---------- */

export interface Tag {
  tag: string;
  digest: string | null;
  mediaType: string | null;
  artifactType: string | null;
  configMediaType: string | null;
  sizeBytes: number | null;
  created: string | null;
  platforms: string[];
}

export interface Repo {
  name: string;
  tags: Tag[];
}

export interface Catalogue {
  generatedAt: string | null;
  error: string | null;
  repositories: Repo[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function parseCatalogue(json: unknown): Catalogue {
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const repos = Array.isArray(o.repositories) ? o.repositories : [];
  return {
    generatedAt: str(o.generatedAt),
    error: str(o.error),
    repositories: repos
      .filter((r: any) => r && typeof r.name === 'string')
      .map((r: any) => ({
        name: r.name,
        tags: (Array.isArray(r.tags) ? r.tags : [])
          .filter((t: any) => t && typeof t.tag === 'string')
          .map(
            (t: any): Tag => ({
              tag: t.tag,
              digest: str(t.digest),
              mediaType: str(t.mediaType),
              artifactType: str(t.artifactType),
              configMediaType: str(t.configMediaType),
              sizeBytes: typeof t.sizeBytes === 'number' ? t.sizeBytes : null,
              created: str(t.created),
              platforms: Array.isArray(t.platforms)
                ? t.platforms.filter((p: unknown) => typeof p === 'string')
                : [],
            })
          ),
      })),
  };
}

/* ---------- formatting ---------- */

export function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** "sha256:0123456789ab" style short form. */
export function shortDigest(digest: string | null | undefined): string {
  if (!digest) return '-';
  const [algo, hex] = digest.includes(':') ? digest.split(':', 2) : ['', digest];
  return `${algo ? `${algo}:` : ''}${hex.slice(0, 12)}`;
}

export function formatRelative(iso: string | null | undefined, now: number): string {
  if (!iso) return '-';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '-';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const units: [string, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [name, secs] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

/* ---------- repository helpers ---------- */

/** Sum of tag sizes; layers shared between tags are counted once per tag. */
export function repoSize(r: Repo): number {
  return r.tags.reduce((n, t) => n + (t.sizeBytes ?? 0), 0);
}

/** Newest created timestamp (ms) among the tags, or null. */
export function lastCreated(r: Repo): number | null {
  let best: number | null = null;
  for (const t of r.tags) {
    const ms = t.created ? Date.parse(t.created) : NaN;
    if (!Number.isNaN(ms) && (best === null || ms > best)) best = ms;
  }
  return best;
}

export function filterRepos(repos: Repo[], query: string): Repo[] {
  const q = query.trim().toLowerCase();
  return q ? repos.filter(r => r.name.toLowerCase().includes(q)) : repos;
}

export type SortKey = 'name' | 'size' | 'created';

export function sortRepos(repos: Repo[], key: SortKey, desc: boolean): Repo[] {
  const val = (r: Repo): number | string | null =>
    key === 'name' ? r.name : key === 'size' ? repoSize(r) : lastCreated(r);
  const out = [...repos].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    // Missing values always sort last, whatever the direction.
    if (x === null && y === null) return a.name.localeCompare(b.name);
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number);
    return (desc ? -c : c) || a.name.localeCompare(b.name);
  });
  return out;
}

/** Tags newest first, undated last. */
export function sortTags(tags: Tag[]): Tag[] {
  const ms = (t: Tag) => (t.created ? Date.parse(t.created) : NaN);
  return [...tags].sort((a, b) => {
    const x = ms(a);
    const y = ms(b);
    if (Number.isNaN(x) && Number.isNaN(y)) return a.tag.localeCompare(b.tag);
    if (Number.isNaN(x)) return 1;
    if (Number.isNaN(y)) return -1;
    return y - x || a.tag.localeCompare(b.tag);
  });
}
