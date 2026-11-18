import type { KubeObject } from '../kube.js';

export interface Row {
  kind: string;
  name: string;
  namespace?: string;
  status: string;
  detail: string;
  age: string;
}

export function age(timestamp: string | undefined, now = Date.now()): string {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.round((now - Date.parse(timestamp)) / 1000));
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function conditions(obj: KubeObject): Array<{ type: string; status: string; reason?: string; message?: string }> {
  return Array.isArray(obj.status?.conditions) ? obj.status.conditions : [];
}

/** One line of status per object, kind-aware for the common workload kinds, conditions otherwise. */
export function summarize(obj: KubeObject, now = Date.now()): Row {
  const kind = obj.kind ?? '';
  const meta = obj.metadata ?? {};
  const base = { kind, name: meta.name ?? '', namespace: meta.namespace, age: age(meta.creationTimestamp, now) };
  const s = obj.status ?? {};
  const spec = obj.spec ?? {};
  switch (kind) {
    case 'Pod': {
      const containers: any[] = s.containerStatuses ?? [];
      const ready = containers.filter(c => c.ready).length;
      const restarts = containers.reduce((n, c) => n + (c.restartCount ?? 0), 0);
      const waiting = containers.map(c => c.state?.waiting?.reason).filter(Boolean);
      const terminated = containers.map(c => c.lastState?.terminated?.reason).filter(Boolean);
      const status = waiting[0] ?? (s.reason as string | undefined) ?? s.phase ?? 'Unknown';
      const parts = [`ready ${ready}/${containers.length || (spec.containers?.length ?? 0)}`, `restarts ${restarts}`];
      if (spec.nodeName) parts.push(`node ${spec.nodeName}`);
      if (terminated.length) parts.push(`last terminated ${[...new Set(terminated)].join(', ')}`);
      return { ...base, status, detail: parts.join(', ') };
    }
    case 'Deployment':
    case 'StatefulSet':
    case 'ReplicaSet': {
      const want = spec.replicas ?? 1;
      const ready = s.readyReplicas ?? 0;
      const unavailable = s.unavailableReplicas ?? Math.max(0, want - ready);
      return { ...base, status: ready >= want ? 'Ready' : 'Degraded', detail: `ready ${ready}/${want}${unavailable ? `, unavailable ${unavailable}` : ''}` };
    }
    case 'DaemonSet': {
      const want = s.desiredNumberScheduled ?? 0;
      const ready = s.numberReady ?? 0;
      return { ...base, status: ready >= want ? 'Ready' : 'Degraded', detail: `ready ${ready}/${want}` };
    }
    case 'Job': {
      const status = s.succeeded ? 'Complete' : s.failed ? 'Failed' : s.active ? 'Running' : 'Pending';
      return { ...base, status, detail: `active ${s.active ?? 0}, succeeded ${s.succeeded ?? 0}, failed ${s.failed ?? 0}` };
    }
    case 'Node': {
      const ready = conditions(obj).find(c => c.type === 'Ready');
      const pressure = conditions(obj)
        .filter(c => c.type !== 'Ready' && c.status === 'True')
        .map(c => c.type);
      const unschedulable = spec.unschedulable ? ', cordoned' : '';
      return {
        ...base,
        status: ready?.status === 'True' ? 'Ready' : 'NotReady',
        detail: `${s.nodeInfo?.kubeletVersion ?? ''}${pressure.length ? `, ${pressure.join(', ')}` : ''}${unschedulable}`,
      };
    }
    case 'PersistentVolumeClaim':
      return { ...base, status: s.phase ?? 'Unknown', detail: `${s.capacity?.storage ?? spec.resources?.requests?.storage ?? ''} ${spec.storageClassName ?? ''}`.trim() };
    case 'Service':
      return { ...base, status: spec.type ?? 'ClusterIP', detail: (spec.ports ?? []).map((p: any) => `${p.port}/${p.protocol ?? 'TCP'}`).join(', ') };
    case 'Event':
      return {
        ...base,
        status: (obj as any).type ?? '',
        detail: `${(obj as any).reason ?? ''}: ${String((obj as any).message ?? '').slice(0, 200)}`,
        age: age((obj as any).lastTimestamp ?? (obj as any).eventTime ?? meta.creationTimestamp, now),
      };
    default: {
      const cs = conditions(obj);
      const ready = cs.find(c => c.type === 'Ready' || c.type === 'Available' || c.type === 'Healthy');
      const failing = cs.filter(c => c.status === 'False' && (c.type === 'Ready' || c.type === 'Available'));
      const status = ready ? (ready.status === 'True' ? ready.type : `Not${ready.type}`) : (s.phase ?? s.state ?? '');
      return { ...base, status: String(status), detail: failing.map(c => `${c.type}: ${c.reason ?? ''} ${c.message ?? ''}`.trim()).join('; ').slice(0, 240) };
    }
  }
}

/** Serialises a value and cuts it to `limit` characters, keeping valid JSON by replacing it with a note. */
export function capJson<T>(value: T, limit = 60_000): T | { truncated: true; note: string; preview: string } {
  const text = JSON.stringify(value);
  if (text.length <= limit) return value;
  return { truncated: true, note: `The object is ${text.length} characters; showing the first ${limit}. Ask for a narrower section.`, preview: text.slice(0, limit) };
}
