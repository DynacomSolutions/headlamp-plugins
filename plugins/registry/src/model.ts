export const CONFIG_KEY = 'registry';

/* ---------- settings ---------- */

export interface Settings {
  /** Namespace of the catalogue backend Service. */
  namespace: string;
  /** Name of the catalogue backend Service. */
  service: string;
  /** Service port (number or port name). */
  port: string;
  /** Comma-separated first path segments that mark a repository kind (pr, charts, ...). */
  kindPrefixes: string;
  /** Seconds between refreshes. */
  refreshSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  namespace: 'registry',
  service: 'registry-catalog',
  port: '80',
  kindPrefixes: 'pr,buildcache,ci,charts,mirror',
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
    kindPrefixes: String(pick('kindPrefixes')).trim(),
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
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
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

/* ---------- project tree ---------- */

export const IMAGES_KIND = 'images';

/** Splits a comma-separated list; falls back to the defaults when empty. */
export function parseKindPrefixes(list: string | undefined): string[] {
  const out = (list ?? '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  return out.length ? out : DEFAULT_SETTINGS.kindPrefixes.split(',');
}

export interface TreeNode {
  /** Stable unique id, used for expansion state and React keys. */
  id: string;
  label: string;
  /** Present on repository leaves only. */
  repo?: Repo;
  /** Folder children; empty on leaves. */
  children: TreeNode[];
}

export interface Aggregate {
  count: number;
  sizeBytes: number;
  created: number | null;
}

/** Kind, and the path segments after the kind prefix, of a repository name. */
function splitName(name: string, kinds: string[]): { kind: string; segs: string[] } {
  const segs = name.split('/');
  if (segs.length > 1 && kinds.includes(segs[0])) return { kind: segs[0], segs: segs.slice(1) };
  return { kind: IMAGES_KIND, segs };
}

/** Project of a repository: first segment that is, or starts (before a dash) with, a known project. */
function projectOf(segs: string[], known: Set<string>, fallback: string): string {
  for (const s of segs) {
    if (known.has(s)) return s;
    const head = s.split('-')[0];
    if (known.has(head)) return head;
  }
  return segs[0] || fallback;
}

/** Groups repositories as project, then kind, then repository. Unsorted. */
export function buildProjectTree(repos: Repo[], kindPrefixes: string[]): TreeNode[] {
  const known = new Set<string>();
  for (const r of repos) {
    const i = r.name.indexOf('/');
    if (i < 0) known.add(r.name.split('-')[0]);
    else if (!kindPrefixes.includes(r.name.slice(0, i))) known.add(r.name.slice(0, i));
  }
  const byProject = new Map<string, { images: TreeNode[]; kinds: Map<string, TreeNode[]>; n: number }>();
  for (const r of repos) {
    const { kind, segs } = splitName(r.name, kindPrefixes);
    const project = projectOf(segs, known, r.name);
    let p = byProject.get(project);
    if (!p) byProject.set(project, (p = { images: [], kinds: new Map(), n: 0 }));
    p.n++;
    const leaf = (label: string): TreeNode => ({ id: `r:${r.name}`, label, repo: r, children: [] });
    if (kind === IMAGES_KIND) {
      const rest = [`${project}-`, `${project}/`].find(x => r.name.startsWith(x));
      p.images.push(leaf(rest ? r.name.slice(rest.length) || r.name : r.name));
    } else {
      const list = p.kinds.get(kind) ?? [];
      list.push(leaf(segs.join('/')));
      p.kinds.set(kind, list);
    }
  }
  return [...byProject].map(([project, p]): TreeNode => {
    if (p.n === 1) {
      const only = p.images[0] ?? [...p.kinds.values()][0][0];
      return { ...only, label: only.repo!.name };
    }
    return {
      id: `p:${project}`,
      label: project,
      children: [
        ...p.images,
        ...[...p.kinds].map(([kind, children]) => ({ id: `p:${project}/k:${kind}`, label: kind, children })),
      ],
    };
  });
}

/** Count, total size and newest created time over the leaves of a node. */
export function aggregate(n: TreeNode): Aggregate {
  if (n.repo) return { count: 1, sizeBytes: repoSize(n.repo), created: lastCreated(n.repo) };
  return n.children.map(aggregate).reduce(
    (a, b) => ({
      count: a.count + b.count,
      sizeBytes: a.sizeBytes + b.sizeBytes,
      created: a.created === null ? b.created : b.created === null ? a.created : Math.max(a.created, b.created),
    }),
    { count: 0, sizeBytes: 0, created: null as number | null }
  );
}

/** Keeps the leaves whose full name matches and the folders that contain them. */
export function pruneTree(nodes: TreeNode[], query: string): TreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const walk = (n: TreeNode): TreeNode | null => {
    if (n.repo) return n.repo.name.toLowerCase().includes(q) ? n : null;
    const children = n.children.map(walk).filter((c): c is TreeNode => c !== null);
    return children.length ? { ...n, children } : null;
  };
  return nodes.map(walk).filter((n): n is TreeNode => n !== null);
}

/** Sorts every level. Inside a project folder, image leaves stay before the kind folders. */
export function sortTree(nodes: TreeNode[], key: SortKey, desc: boolean, imagesFirst = false): TreeNode[] {
  const val = (n: TreeNode): number | string | null => {
    if (key === 'name') return n.label;
    const a = aggregate(n);
    return key === 'size' ? a.sizeBytes : a.created;
  };
  const cmp = (a: TreeNode, b: TreeNode): number => {
    if (imagesFirst && !a.repo !== !b.repo) return a.repo ? -1 : 1;
    const x = val(a);
    const y = val(b);
    if (x === null && y === null) return a.label.localeCompare(b.label);
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number);
    return (desc ? -c : c) || a.label.localeCompare(b.label);
  };
  return [...nodes].sort(cmp).map(n =>
    n.repo ? n : { ...n, children: sortTree(n.children, key, desc, n.id.startsWith('p:') && !n.id.includes('/k:')) }
  );
}

/** Ids of every folder in the tree. */
export function folderIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap(n => (n.repo ? [] : [n.id, ...folderIds(n.children)]));
}
