/*
 * Field access for report rows. A field is either one of the common fields (`name`, `status` ...)
 * or a JSONPath-like path such as `.spec.replicas`, `.metadata.labels.app`,
 * `.metadata.labels["app.kubernetes.io/name"]`, `.spec.containers[0].image` or
 * `.spec.containers[*].image`. All functions here are pure.
 */

export type Scalar = string | number | boolean | null;

/** A cell: `value` drives sorting, filters and aggregates. `text` is what the user reads. */
export interface Cell {
  value: Scalar;
  text: string;
}

export const COMMON_FIELDS = [
  'name',
  'namespace',
  'age',
  'status',
  'labels',
  'owner',
  'node',
  'restarts',
  'ready',
] as const;
export type CommonField = (typeof COMMON_FIELDS)[number];

export const COMMON_FIELD_LABELS: Record<CommonField, string> = {
  name: 'Name',
  namespace: 'Namespace',
  age: 'Age',
  status: 'Status',
  labels: 'Labels',
  owner: 'Owner',
  node: 'Node',
  restarts: 'Restarts',
  ready: 'Ready',
};

export function isCommonField(field: string): field is CommonField {
  return (COMMON_FIELDS as readonly string[]).includes(field);
}

export type Segment = string | number | '*';

/**
 * Parse a field path into segments. Returns null for an empty or malformed path. A leading dot,
 * a leading `{.` and trailing `}` (kubectl JSONPath style) are all accepted. A backslash escapes
 * a dot in a key. A bracket holds an index, `*` or a quoted key.
 */
export function parseFieldPath(input: string): Segment[] | null {
  let s = input.trim();
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1).trim();
  if (s.startsWith('$')) s = s.slice(1);
  if (s === '') return null;
  const out: Segment[] = [];
  let i = 0;
  const readKey = (): string => {
    let key = '';
    while (i < s.length && s[i] !== '.' && s[i] !== '[') {
      if (s[i] === '\\' && i + 1 < s.length) i += 1;
      key += s[i];
      i += 1;
    }
    return key;
  };
  if (s[0] === '.') i = 1;
  while (i < s.length) {
    if (s[i] === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) return null;
      const inner = s.slice(i + 1, end).trim();
      i = end + 1;
      if (inner === '*') out.push('*');
      else if (/^\d+$/.test(inner)) out.push(Number(inner));
      else if (/^(".*"|'.*')$/.test(inner) && inner.length >= 2) out.push(inner.slice(1, -1));
      else return null;
    } else {
      const key = readKey();
      if (key === '') return null;
      out.push(key);
    }
    if (s[i] === '.') {
      i += 1;
      if (i >= s.length) return null;
    }
  }
  return out.length > 0 ? out : null;
}

/** Whether the text is a usable field path (for the settings editor). */
export function isValidFieldPath(input: string): boolean {
  return parseFieldPath(input) !== null;
}

function walk(node: unknown, segments: Segment[], index: number, out: unknown[]): void {
  if (index === segments.length) {
    if (node !== undefined) out.push(node);
    return;
  }
  if (node === null || node === undefined) return;
  const seg = segments[index];
  if (seg === '*') {
    if (Array.isArray(node)) node.forEach(n => walk(n, segments, index + 1, out));
    else if (typeof node === 'object')
      Object.values(node as object).forEach(n => walk(n, segments, index + 1, out));
    return;
  }
  if (typeof seg === 'number') {
    if (Array.isArray(node)) walk(node[seg], segments, index + 1, out);
    return;
  }
  if (typeof node === 'object' && !Array.isArray(node)) {
    walk((node as Record<string, unknown>)[seg], segments, index + 1, out);
  }
}

/** Every value the path reaches. A wildcard can reach several. Missing paths give an empty list. */
export function getPathValues(obj: unknown, path: string): unknown[] {
  const segments = parseFieldPath(path);
  if (!segments) return [];
  const out: unknown[] = [];
  walk(obj, segments, 0, out);
  return out;
}

function toScalar(v: unknown): Scalar {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

function flatten(values: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const v of values) {
    if (Array.isArray(v)) out.push(...flatten(v));
    else out.push(v);
  }
  return out;
}

/** Small decimal quantity suffixes and binary ones, for CPU and memory style values. */
const QUANTITY = /^([+-]?\d+(?:\.\d+)?)(n|u|m|k|K|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;
const FACTORS: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

/** A number from a number or a numeric string (including Kubernetes quantities such as 250m or 1Gi). */
export function toNumber(v: Scalar | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = QUANTITY.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? FACTORS[m[2]] : 1);
  return Number.isFinite(n) ? n : null;
}

/** "3d4h", "5h12m", "42s". Used for the age column. */
export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 10) return `${d}d`;
  if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`;
  if (h > 0) return m > 0 && h < 10 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

type Obj = Record<string, any>;

function podStatus(o: Obj): string | null {
  const statuses: Obj[] = [
    ...(o.status?.initContainerStatuses ?? []),
    ...(o.status?.containerStatuses ?? []),
  ];
  for (const cs of statuses) {
    const reason = cs?.state?.waiting?.reason ?? cs?.state?.terminated?.reason;
    if (reason && reason !== 'Completed') return reason;
  }
  if (o.metadata?.deletionTimestamp) return 'Terminating';
  return o.status?.reason ?? o.status?.phase ?? null;
}

function genericStatus(o: Obj): string | null {
  if (o.kind === 'Pod') return podStatus(o);
  if (typeof o.status?.phase === 'string') return o.status.phase;
  const conditions: Obj[] = Array.isArray(o.status?.conditions) ? o.status.conditions : [];
  for (const type of ['Ready', 'Available', 'Complete', 'Succeeded', 'Established']) {
    const c = conditions.find(x => x?.type === type);
    if (c) return c.status === 'True' ? type : `Not ${type}`;
  }
  if (typeof o.status?.state === 'string') return o.status.state;
  return null;
}

function readyText(o: Obj): string | null {
  const cs: Obj[] = o.status?.containerStatuses;
  if (o.kind === 'Pod' || Array.isArray(cs)) {
    const total = (o.spec?.containers ?? cs ?? []).length;
    const ready = (cs ?? []).filter(c => c?.ready).length;
    return `${ready}/${total}`;
  }
  if (typeof o.spec?.replicas === 'number' || typeof o.status?.replicas === 'number') {
    const want = o.spec?.replicas ?? o.status?.replicas ?? 0;
    return `${o.status?.readyReplicas ?? 0}/${want}`;
  }
  if (typeof o.status?.desiredNumberScheduled === 'number') {
    return `${o.status?.numberReady ?? 0}/${o.status.desiredNumberScheduled}`;
  }
  return null;
}

function restarts(o: Obj): number | null {
  const cs: Obj[] = o.status?.containerStatuses;
  if (!Array.isArray(cs)) return null;
  return cs.reduce((n, c) => n + (Number(c?.restartCount) || 0), 0);
}

function ownerText(o: Obj): string | null {
  const ref = Array.isArray(o.metadata?.ownerReferences)
    ? o.metadata.ownerReferences[0]
    : undefined;
  return ref ? `${ref.kind}/${ref.name}` : null;
}

function labelList(o: Obj): string[] {
  const labels = o.metadata?.labels;
  if (!labels || typeof labels !== 'object') return [];
  return Object.entries(labels).map(([k, v]) => `${k}=${v}`);
}

function ageSeconds(o: Obj, now: number): number | null {
  const t = Date.parse(o.metadata?.creationTimestamp ?? '');
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 1000)) : null;
}

/** All scalar values of a field for one object. Filters test every value (any match). */
export function getValues(obj: unknown, field: string, now: number): Scalar[] {
  const o = (obj ?? {}) as Obj;
  if (isCommonField(field)) {
    switch (field) {
      case 'name':
        return [o.metadata?.name ?? null];
      case 'namespace':
        return [o.metadata?.namespace ?? null];
      case 'age':
        return [ageSeconds(o, now)];
      case 'status':
        return [genericStatus(o)];
      case 'labels':
        return labelList(o);
      case 'owner':
        return [ownerText(o)];
      case 'node':
        return [
          o.spec?.nodeName ??
            o.status?.nodeName ??
            (o.kind === 'Node' ? o.metadata?.name : null) ??
            null,
        ];
      case 'restarts':
        return [restarts(o)];
      case 'ready':
        return [readyText(o)];
    }
  }
  return flatten(getPathValues(obj, field)).map(toScalar);
}

/** The cell of a field for one object. Several values are joined with a comma. */
export function getCell(obj: unknown, field: string, now: number): Cell {
  const values = getValues(obj, field, now).filter(v => v !== null);
  if (values.length === 0) return { value: null, text: '' };
  if (field === 'age' && typeof values[0] === 'number')
    return { value: values[0], text: formatAge(values[0]) };
  if (values.length === 1) {
    const v = values[0];
    return { value: v, text: String(v) };
  }
  const text = values.join(', ');
  return { value: text, text };
}

/** A readable default header for a field. */
export function defaultHeader(field: string): string {
  if (isCommonField(field)) return COMMON_FIELD_LABELS[field];
  const segments = parseFieldPath(field);
  if (!segments) return field;
  const last = [...segments].reverse().find(s => typeof s === 'string' && s !== '*');
  return typeof last === 'string' ? last : field;
}

/** Compare two cells: numbers numerically, other values as natural text, empty values last. */
export function compareCells(a: Cell, b: Cell): number {
  const aEmpty = a.value === null;
  const bEmpty = b.value === null;
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  const an = toNumber(a.value);
  const bn = toNumber(b.value);
  if (an !== null && bn !== null && typeof a.value !== 'boolean' && typeof b.value !== 'boolean')
    return an - bn;
  return String(a.value).localeCompare(String(b.value), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}
