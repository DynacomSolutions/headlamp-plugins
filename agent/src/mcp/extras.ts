import type { Runtime } from '../runtime.js';

/** Reads that the extra and storage tools of the contract share. They reuse the registry tools and the kube client. */

export interface KubeLike {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: Record<string, any>;
  status?: Record<string, any>;
}

const bytes = (q: unknown): number => {
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]*)$/.exec(String(q ?? ''));
  if (!m) return 0;
  const units: Record<string, number> = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  return Math.round(Number(m[1]) * (units[m[2]!] ?? 1));
};

export async function listNodes(rt: Runtime) {
  const items = (await rt.kube.listAll('nodes')) as KubeLike[];
  return {
    nodes: items.map(n => ({
      name: n.metadata?.name ?? '',
      ready: (n.status?.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True'),
      roles: Object.keys(n.metadata?.labels ?? {}).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.slice('node-role.kubernetes.io/'.length)),
      kubeletVersion: String(n.status?.nodeInfo?.kubeletVersion ?? ''),
      cpuAllocatable: String(n.status?.allocatable?.cpu ?? ''),
      memoryAllocatable: String(n.status?.allocatable?.memory ?? ''),
      conditions: (n.status?.conditions ?? []).map((c: any) => ({ type: String(c.type), status: String(c.status) })),
    })),
  };
}

export async function listWorkloads(rt: Runtime, input: { namespace?: string; kind?: 'Deployment' | 'StatefulSet' | 'DaemonSet'; unhealthyOnly?: boolean }) {
  const kinds = input.kind ? [input.kind] : ['Deployment', 'StatefulSet', 'DaemonSet'];
  const workloads: Array<{ kind: string; namespace: string; name: string; desired: number; ready: number; available: number }> = [];
  for (const kind of kinds) {
    const items = (await rt.kube.listAll(kind.toLowerCase() + 's', { namespace: input.namespace })) as KubeLike[];
    for (const w of items) {
      const s = w.status ?? {};
      const desired = kind === 'DaemonSet' ? Number(s.desiredNumberScheduled ?? 0) : Number(w.spec?.replicas ?? 1);
      const ready = Number(kind === 'DaemonSet' ? (s.numberReady ?? 0) : (s.readyReplicas ?? 0));
      const available = Number(kind === 'DaemonSet' ? (s.numberAvailable ?? 0) : (s.availableReplicas ?? 0));
      if (input.unhealthyOnly && ready >= desired && available >= desired) continue;
      workloads.push({ kind, namespace: w.metadata?.namespace ?? '', name: w.metadata?.name ?? '', desired, ready, available });
    }
  }
  return { workloads };
}

/** One PersistentVolume as the contract shows it (`StorageVolume`, section 5.3). The PV watch compares these. */
export function volumeOf(v: KubeLike) {
  const ref = v.spec?.claimRef as { namespace?: string; name?: string } | undefined;
  const affinity = JSON.stringify(v.spec?.nodeAffinity ?? {});
  const node = /"values":\["([^"]+)"\]/.exec(affinity)?.[1] ?? null;
  return {
    name: v.metadata?.name ?? '',
    claim: ref?.name ? `${ref.namespace ?? ''}/${ref.name}` : null,
    storageClass: (v.spec?.storageClassName as string | undefined) ?? null,
    capacityBytes: bytes(v.spec?.capacity?.storage),
    phase: String(v.status?.phase ?? ''),
    node,
    claimNamespace: ref?.namespace,
  };
}

export async function listVolumes(rt: Runtime, input: { namespace?: string; node?: string }) {
  const items = (await rt.kube.listAll('persistentvolumes')) as KubeLike[];
  const volumes = items
    .map(volumeOf)
    .filter(v => (!input.namespace || v.claimNamespace === input.namespace) && (!input.node || v.node === input.node))
    .map(({ claimNamespace: _ns, ...v }) => v);
  return { volumes };
}

/** Runs an existing registry tool and returns its data, or throws its failure summary. */
export async function viaRegistry(rt: Runtime, tool: string, args: Record<string, unknown>): Promise<any> {
  const out = await rt.registry.call(tool, args, p => rt.context(p));
  if (!out.ok) throw new Error(out.summary);
  return out.data;
}
