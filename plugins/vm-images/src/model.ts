export const CONFIG_KEY = 'vm-images';

/* ---------- settings ---------- */

export interface Settings {
  /** Namespace of the catalogue backend Service. */
  namespace: string;
  /** Name of the catalogue backend Service. */
  service: string;
  /** Service port (number or port name). */
  port: string;
  /** Comma-separated repository name prefixes that count as VM images. */
  namePrefixes: string;
  /** Comma-separated first path segments that mark a repository kind (pr, charts, ...). */
  kindPrefixes: string;
  /** Seconds between refreshes. */
  refreshSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  namespace: 'registry',
  service: 'registry-catalog',
  port: '80',
  namePrefixes: 'macos-vz/,containerdisks/,vm/',
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
    namePrefixes: String(pick('namePrefixes')).trim(),
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

/* ---------- VM image repositories ---------- */

export function parsePrefixes(list: string): string[] {
  return list
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
}

const VM_MEDIA = /kubevirt|containerdisk|qcow2|vmdk|[/.+-]vm[.+-]/i;

/** A repository is a VM image by name prefix, or when any tag carries a VM artefact media type. */
export function isVmRepo(r: Repo, prefixes: string[]): boolean {
  if (prefixes.some(p => r.name.startsWith(p))) return true;
  return r.tags.some(t => [t.artifactType, t.configMediaType].some(m => !!m && VM_MEDIA.test(m)));
}

export function vmRepos(repos: Repo[], prefixes: string[]): Repo[] {
  return repos.filter(r => isVmRepo(r, prefixes));
}

/* ---------- image references ---------- */

export interface ImageRef {
  /** Repository path without registry host, tag or digest. */
  path: string;
  tag: string | null;
  digest: string | null;
}

/** Splits "host[:port]/path[:tag][@sha256:...]" and drops the registry host. */
export function parseImageRef(ref: string, digestHint?: string | null): ImageRef {
  let rest = ref.trim().replace(/^docker:\/\//, '');
  let digest: string | null = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1) || null;
    rest = rest.slice(0, at);
  }
  const parts = rest.split('/');
  if (parts.length > 1 && /[.:]|^localhost$/.test(parts[0])) parts.shift();
  let tag: string | null = null;
  const last = parts[parts.length - 1];
  const colon = last.lastIndexOf(':');
  if (colon >= 0) {
    tag = last.slice(colon + 1) || null;
    parts[parts.length - 1] = last.slice(0, colon);
  }
  if (!digest && digestHint) digest = digestHint;
  return { path: parts.join('/'), tag: tag ?? (digest ? null : 'latest'), digest };
}

/** The digest from a pod's status imageID ("host/path@sha256:..."), if any. */
export function digestOfImageId(imageId: string | undefined | null): string | null {
  const m = /@(sha256:[0-9a-f]+)/.exec(imageId ?? '');
  return m ? m[1] : null;
}

export interface Match {
  repo: Repo | null;
  tag: Tag | null;
}

/** Matches on repository path, then on digest, else on tag name. */
export function matchImage(ref: ImageRef, repos: Repo[]): Match {
  const repo = repos.find(r => r.name === ref.path) ?? null;
  if (!repo) return { repo: null, tag: null };
  const tag =
    (ref.digest && repo.tags.find(t => t.digest === ref.digest)) ||
    (ref.tag && repo.tags.find(t => t.tag === ref.tag)) ||
    null;
  return { repo, tag };
}

/* ---------- who uses an image ---------- */

export interface User {
  kind: 'Pod' | 'VirtualMachine';
  namespace: string;
  name: string;
  node: string | null;
}

export interface Usage {
  image: string;
  digestHint: string | null;
  user: User;
}

export interface Group {
  key: string;
  ref: ImageRef;
  repo: string | null;
  tag: string | null;
  users: User[];
}

type J = any;
const meta = (o: J) => ({ name: String(o?.metadata?.name ?? ''), namespace: String(o?.metadata?.namespace ?? '') });

/** A node is virtual-kubelet by label type=virtual-kubelet or a kubelet version containing "-vk-". */
export function isVirtualKubeletNode(node: J): boolean {
  return (
    node?.metadata?.labels?.type === 'virtual-kubelet' ||
    String(node?.status?.nodeInfo?.kubeletVersion ?? '').includes('-vk-')
  );
}

export function virtualKubeletNodes(nodes: J[]): Set<string> {
  return new Set(nodes.filter(isVirtualKubeletNode).map(n => String(n?.metadata?.name ?? '')));
}

/** Images of pods scheduled on the given nodes (containers and init containers, once per pod). */
export function podUsages(pods: J[], nodeNames: Set<string>): Usage[] {
  const out: Usage[] = [];
  for (const p of pods) {
    const node = p?.spec?.nodeName;
    if (!node || !nodeNames.has(node)) continue;
    const ids = new Map<string, string | null>();
    for (const cs of [
      ...(p.status?.containerStatuses ?? []),
      ...(p.status?.initContainerStatuses ?? []),
    ])
      ids.set(cs.name, digestOfImageId(cs.imageID));
    const user: User = { kind: 'Pod', ...meta(p), node };
    const seen = new Set<string>();
    for (const c of [...(p.spec?.containers ?? []), ...(p.spec?.initContainers ?? [])]) {
      if (!c?.image || seen.has(c.image)) continue;
      seen.add(c.image);
      out.push({ image: c.image, digestHint: ids.get(c.name) ?? null, user });
    }
  }
  return out;
}

export function vmVolumes(vm: J): J[] {
  return vm?.spec?.template?.spec?.volumes ?? [];
}

/** containerDisk images of VMs; the node comes from the matching VirtualMachineInstance. */
export function vmUsages(vms: J[], vmis: J[]): Usage[] {
  const nodeOf = new Map<string, string>();
  for (const i of vmis) {
    const m = meta(i);
    if (i?.status?.nodeName) nodeOf.set(`${m.namespace}/${m.name}`, i.status.nodeName);
  }
  const out: Usage[] = [];
  for (const vm of vms) {
    const m = meta(vm);
    const user: User = { kind: 'VirtualMachine', ...m, node: nodeOf.get(`${m.namespace}/${m.name}`) ?? null };
    for (const v of vmVolumes(vm))
      if (v?.containerDisk?.image)
        out.push({ image: v.containerDisk.image, digestHint: null, user });
  }
  return out;
}

const userKey = (u: User) => `${u.kind}/${u.namespace}/${u.name}`;

/** Groups usages by image reference (host stripped), matched against the backend repositories. */
export function groupUsages(usages: Usage[], repos: Repo[]): Group[] {
  const groups = new Map<string, Group>();
  for (const u of usages) {
    const ref = parseImageRef(u.image, u.digestHint);
    const key = `${ref.path}:${ref.tag ?? ''}@${ref.digest ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      const m = matchImage(ref, repos);
      g = { key, ref, repo: m.repo?.name ?? null, tag: m.tag?.tag ?? null, users: [] };
      groups.set(key, g);
    }
    if (!g.users.some(x => userKey(x) === userKey(u.user))) g.users.push(u.user);
  }
  return [...groups.values()].sort((a, b) => a.ref.path.localeCompare(b.ref.path) || a.key.localeCompare(b.key));
}

/** Distinct users per repository ("repo") and per tag ("repo:tag"). */
export function usageCounts(groups: Group[]): Map<string, number> {
  const sets = new Map<string, Set<string>>();
  const add = (k: string, u: User) => {
    if (!sets.has(k)) sets.set(k, new Set());
    sets.get(k)!.add(userKey(u));
  };
  for (const g of groups) {
    if (!g.repo) continue;
    for (const u of g.users) {
      add(g.repo, u);
      if (g.tag) add(`${g.repo}:${g.tag}`, u);
    }
  }
  return new Map([...sets].map(([k, v]) => [k, v.size]));
}

/* ---------- KubeVirt disks ---------- */

const cond = (o: J, type: string): string =>
  (o?.status?.conditions ?? []).find((c: J) => c.type === type)?.status ?? '-';

/** Short description of a CDI source block. */
export function describeSource(src: J): string {
  if (!src || typeof src !== 'object') return '-';
  const kind = Object.keys(src)[0];
  if (!kind) return '-';
  const v = src[kind];
  if (kind === 'http' || kind === 'registry') return `${kind}: ${v?.url ?? v?.imageStream ?? ''}`.trim();
  if (kind === 'pvc' || kind === 'snapshot') return `${kind}: ${v?.namespace ?? ''}/${v?.name ?? ''}`;
  return kind;
}

export interface DataVolumeRow {
  namespace: string;
  name: string;
  phase: string;
  progress: string;
  source: string;
}

export function dataVolumeRow(dv: J): DataVolumeRow {
  const ref = dv?.spec?.sourceRef;
  return {
    ...meta(dv),
    phase: String(dv?.status?.phase ?? '-'),
    progress: String(dv?.status?.progress ?? '-'),
    source: ref ? `dataSource: ${ref.namespace ? `${ref.namespace}/` : ''}${ref.name ?? ''}` : describeSource(dv?.spec?.source),
  };
}

export interface DataSourceRow {
  namespace: string;
  name: string;
  ready: string;
  source: string;
}

export function dataSourceRow(ds: J): DataSourceRow {
  return { ...meta(ds), ready: cond(ds, 'Ready'), source: describeSource(ds?.spec?.source) };
}

export interface CronRow {
  namespace: string;
  name: string;
  schedule: string;
  target: string;
  ready: string;
  lastImport: string | null;
}

export function cronRow(c: J): CronRow {
  return {
    ...meta(c),
    schedule: String(c?.spec?.schedule ?? '-'),
    target: String(c?.spec?.managedDataSource ?? '-'),
    ready: cond(c, 'UpToDate'),
    lastImport: c?.status?.lastImportTimestamp ?? null,
  };
}

export interface DiskRow {
  volume: string;
  kind: 'PVC' | 'DataVolume' | 'containerDisk' | 'other';
  ref: string;
  capacity: string;
  storageClass: string;
}

export interface VmRow {
  namespace: string;
  name: string;
  state: string;
  disks: DiskRow[];
}

/** A VM's disk volumes, with PVC capacity and storage class (a DataVolume's PVC shares its name). */
export function vmRows(vms: J[], pvcs: J[]): VmRow[] {
  const byKey = new Map<string, J>();
  for (const p of pvcs) {
    const m = meta(p);
    byKey.set(`${m.namespace}/${m.name}`, p);
  }
  return vms
    .map((vm): VmRow => {
      const m = meta(vm);
      const disks = vmVolumes(vm).map((v: J): DiskRow => {
        const claim = v.persistentVolumeClaim?.claimName ?? v.dataVolume?.name;
        const kind = v.persistentVolumeClaim ? 'PVC' : v.dataVolume ? 'DataVolume' : v.containerDisk ? 'containerDisk' : 'other';
        const pvc = claim ? byKey.get(`${m.namespace}/${claim}`) : undefined;
        return {
          volume: String(v.name ?? ''),
          kind,
          ref: String(claim ?? v.containerDisk?.image ?? '-'),
          capacity: String(pvc?.status?.capacity?.storage ?? '-'),
          storageClass: String(pvc?.spec?.storageClassName ?? '-'),
        };
      });
      return { ...m, state: String(vm?.status?.printableStatus ?? '-'), disks };
    })
    .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
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
