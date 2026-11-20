/*
 * API discovery: which resource kinds can the user list? Built-in kinds come first, then custom
 * resources (CRDs). `fetchKinds` takes the request function as an argument, so tests need no cluster.
 */
import type { SourceRef } from './config';

export interface KindEntry extends SourceRef {
  /** A custom resource (the group is not a Kubernetes one). */
  custom: boolean;
  /** `Pod (v1)` or `Certificate (cert-manager.io/v1)`. */
  label: string;
}

type Request = (path: string) => Promise<any>;

/** The kinds that most reports use. They go first, in this order. */
const PRIORITY = [
  'Pod',
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob',
  'ReplicaSet',
  'Service',
  'Ingress',
  'ConfigMap',
  'Secret',
  'PersistentVolumeClaim',
  'PersistentVolume',
  'Node',
  'Namespace',
  'Event',
];

export function isBuiltinGroup(group: string): boolean {
  return (
    group === '' ||
    group === 'apps' ||
    group === 'batch' ||
    group === 'policy' ||
    group === 'autoscaling' ||
    group === 'extensions' ||
    group === 'k8s.io' ||
    group.endsWith('.k8s.io')
  );
}

function entriesOf(group: string, version: string, list: any): KindEntry[] {
  const resources: any[] = Array.isArray(list?.resources) ? list.resources : [];
  return resources
    .filter(
      r =>
        typeof r?.name === 'string' &&
        !r.name.includes('/') &&
        Array.isArray(r.verbs) &&
        r.verbs.includes('list')
    )
    .map(r => ({
      group,
      version,
      plural: r.name,
      kind: String(r.kind ?? r.name),
      namespaced: r.namespaced === true,
      custom: !isBuiltinGroup(group),
      label: `${r.kind ?? r.name} (${group ? `${group}/` : ''}${version})`,
    }));
}

/** Built-in first (priority kinds, then by name), then custom kinds by group and name. One entry per group and plural. */
export function sortKinds(kinds: KindEntry[]): KindEntry[] {
  const seen = new Set<string>();
  const unique = kinds.filter(k => {
    const id = `${k.group}/${k.plural}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const rank = (k: KindEntry) => {
    const i = PRIORITY.indexOf(k.kind);
    return i >= 0 ? i : PRIORITY.length;
  };
  return unique.sort((a, b) => {
    if (a.custom !== b.custom) return a.custom ? 1 : -1;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.group.localeCompare(b.group) || a.kind.localeCompare(b.kind);
  });
}

/** Ask the API server for every listable kind. A group that fails is skipped. */
export async function fetchKinds(request: Request): Promise<KindEntry[]> {
  const out: KindEntry[] = [];
  const core = await request('/api/v1').catch(() => null);
  out.push(...entriesOf('', 'v1', core));
  const groups = await request('/apis').catch(() => null);
  const list: any[] = Array.isArray(groups?.groups) ? groups.groups : [];
  const results = await Promise.allSettled(
    list.map(async g => {
      const version = g?.preferredVersion?.version ?? g?.versions?.[0]?.version;
      if (typeof g?.name !== 'string' || typeof version !== 'string') return [];
      return entriesOf(g.name, version, await request(`/apis/${g.name}/${version}`));
    })
  );
  for (const r of results) if (r.status === 'fulfilled') out.push(...r.value);
  return sortKinds(out);
}

/** The API path of a kind, for one namespace or for the whole cluster. */
export function listPath(source: SourceRef, namespace?: string): string {
  const base =
    source.group === '' ? `/api/${source.version}` : `/apis/${source.group}/${source.version}`;
  return namespace && source.namespaced
    ? `${base}/namespaces/${encodeURIComponent(namespace)}/${source.plural}`
    : `${base}/${source.plural}`;
}
