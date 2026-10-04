/*
 * Pure logic for the agent-memory plugin: the backend payload types, size
 * parsing and formatting, edit validation (the same rules the backend enforces,
 * so mistakes are caught before a request is made), usage-bar geometry and
 * settings resolution. Nothing here touches React or the network.
 */

export const CONFIG_KEY = 'agent-memory';

export interface Pressure {
  avg10: number;
  avg60: number;
  avg300: number;
  totalUs: number;
}

/** A byte quantity; null means unlimited ("max" / infinity). */
export type Limit = number | null;

export interface MemUnit {
  name: string;
  kind: 'slice' | 'scope' | 'service';
  parent: string;
  depth: number;
  current: number;
  high: Limit;
  max: Limit;
  min: Limit;
  low: Limit;
  swapCurrent: number;
  swapMax: Limit;
  events: Record<string, number>;
  eventsLocal: Record<string, number>;
  pressureSome: Pressure;
  pressureFull: Pressure;
  procs: number;
  command?: string;
  topProcess?: string;
  topRss?: number;
}

export interface MemAlert {
  unit: string;
  severity: 'warning' | 'critical';
  reason: string;
  detail: string;
}

export interface AgentMemoryState {
  node: string;
  sampled: number;
  error: string;
  writable: boolean;
  host: { total: number; available: number; swapTotal: number };
  policy: { heavyHigh: string; heavyMax: string; heavySwap: string; keepFree: number };
  minLimit: number;
  protected: string[];
  units: MemUnit[];
  alerts: MemAlert[];
}

export interface ChangeRecord {
  time: string;
  caller: string;
  reason?: string;
  unit: string;
  method: string;
  runtime: boolean;
  old: Record<string, string>;
  new: Record<string, string>;
  error?: string;
}

/* ---------- settings ---------- */

export interface Settings {
  /** Backend as service/<namespace>/<name>:<port>, reached through the cluster API proxy. */
  backend: string;
  /** Seconds between refreshes. */
  refreshSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  backend: 'service/agent-memory/agent-memory:80',
  refreshSeconds: 10,
};

export function resolveSettings(
  stored: Partial<Settings> | undefined,
  defaults: Partial<Settings> | undefined
): Settings {
  const pick = <K extends keyof Settings>(key: K): Settings[K] => {
    const s = stored?.[key];
    const d = defaults?.[key];
    const blank = (v: unknown) => v === undefined || v === null || v === '';
    if (!blank(s)) return s as Settings[K];
    if (!blank(d)) return d as Settings[K];
    return DEFAULT_SETTINGS[key];
  };
  const refresh = Number(pick('refreshSeconds'));
  return {
    backend: String(pick('backend')).trim(),
    refreshSeconds: Number.isFinite(refresh) ? Math.min(300, Math.max(2, refresh)) : 10,
  };
}

/** Turns service/<ns>/<name>[:port] plus an API path into a Kubernetes service-proxy URL. */
export function backendUrl(backend: string, path: string): string {
  const m = /^service\/([^/]+)\/([^/:]+)(?::([^/]+))?$/.exec(backend.trim());
  if (!m)
    throw new Error(`Backend must look like service/<namespace>/<name>:<port>, got "${backend}"`);
  const [, ns, name, port] = m;
  const svc = port ? `${name}:${port}` : name;
  return `/api/v1/namespaces/${ns}/services/${svc}/proxy${
    path.startsWith('/') ? path : `/${path}`
  }`;
}

/* ---------- sizes ---------- */

const MULTIPLIERS: Record<string, number> = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

/** Parses "16G", "512M", "1.5G", "1073741824", "infinity". Returns null for unlimited, undefined when invalid. */
export function parseSize(input: string): Limit | undefined {
  const s = input.trim().toLowerCase();
  if (s === '') return undefined;
  if (s === 'infinity' || s === 'max' || s === 'unlimited') return null;
  const m = /^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)$/.exec(s);
  if (!m || !(m[2] in MULTIPLIERS)) return undefined;
  const bytes = Math.round(parseFloat(m[1]) * MULTIPLIERS[m[2]]);
  return Number.isFinite(bytes) && bytes < 2 ** 53 ? bytes : undefined;
}

/** Formats bytes with the largest binary unit that keeps the number readable. */
export function formatSize(v: Limit | undefined): string {
  if (v === null || v === undefined) return '∞';
  const units: [number, string][] = [
    [1024 ** 4, 'T'],
    [1024 ** 3, 'G'],
    [1024 ** 2, 'M'],
    [1024, 'K'],
  ];
  for (const [n, s] of units) {
    if (v >= n) {
      const f = v / n;
      return `${Number.isInteger(f) ? f : f.toFixed(f >= 100 ? 0 : 1)}${s}`;
    }
  }
  return `${v}B`;
}

/** The text that round-trips through parseSize, for pre-filling an input. */
export function sizeInput(v: Limit): string {
  if (v === null) return 'infinity';
  const units: [number, string][] = [
    [1024 ** 4, 'T'],
    [1024 ** 3, 'G'],
    [1024 ** 2, 'M'],
    [1024, 'K'],
  ];
  for (const [n, s] of units) {
    if (v >= n && v % n === 0) return `${v / n}${s}`;
  }
  return String(v);
}

/* ---------- edit validation ---------- */

export type EditField = 'memoryHigh' | 'memoryMax' | 'memorySwapMax' | 'memoryMin' | 'memoryLow';

export const FIELD_LABELS: Record<EditField, string> = {
  memoryHigh: 'Soft limit (MemoryHigh)',
  memoryMax: 'Hard limit (MemoryMax)',
  memorySwapMax: 'Swap limit (MemorySwapMax)',
  memoryMin: 'Protected minimum (MemoryMin)',
  memoryLow: 'Best-effort floor (MemoryLow)',
};

export function editableFields(unit: MemUnit): EditField[] {
  return unit.kind === 'slice'
    ? ['memoryHigh', 'memoryMax', 'memorySwapMax', 'memoryMin', 'memoryLow']
    : ['memoryHigh', 'memoryMax', 'memorySwapMax'];
}

export function currentValue(unit: MemUnit, f: EditField): Limit {
  switch (f) {
    case 'memoryHigh':
      return unit.high;
    case 'memoryMax':
      return unit.max;
    case 'memorySwapMax':
      return unit.swapMax;
    case 'memoryMin':
      return unit.min;
    default:
      return unit.low;
  }
}

export type EditForm = Partial<Record<EditField, string>>;

export interface EditCheck {
  /** Only the fields whose value differs from the current one. */
  changes: Partial<Record<EditField, string>>;
  errors: string[];
  /** The new hard limit is below current usage: needs an explicit confirmation. */
  belowCurrent: boolean;
}

export interface EditContext {
  minLimit: number;
  hostTotal: number;
  protectedUnits: string[];
}

/** Mirrors the backend rules so the dialog can explain a problem before sending. */
export function checkEdit(
  unit: MemUnit,
  form: EditForm,
  persist: boolean,
  ctx: EditContext
): EditCheck {
  const errors: string[] = [];
  const parsed: Partial<Record<EditField, Limit>> = {};
  const changes: Partial<Record<EditField, string>> = {};
  for (const f of editableFields(unit)) {
    const raw = form[f];
    if (raw === undefined) continue;
    const v = parseSize(raw);
    if (v === undefined) {
      errors.push(
        `${FIELD_LABELS[f]}: "${raw}" is not a size (use for example 8G, 512M or infinity)`
      );
      continue;
    }
    if (v === currentValue(unit, f)) continue;
    parsed[f] = v;
    changes[f] = raw.trim();
  }
  if (errors.length) return { changes, errors, belowCurrent: false };
  if (Object.keys(parsed).length === 0) {
    return { changes, errors: ['Nothing has changed.'], belowCurrent: false };
  }
  if (persist && unit.kind !== 'slice')
    errors.push('Only slices can be persisted; scopes are transient.');
  if (ctx.protectedUnits.includes(unit.name)) {
    for (const f of ['memoryHigh', 'memoryMax', 'memorySwapMax'] as EditField[]) {
      if (parsed[f] !== undefined && parsed[f] !== null) {
        errors.push(
          `${unit.name} is the protected control plane: it takes only the protected minimum and best-effort floor.`
        );
        break;
      }
    }
  }
  for (const f of ['memoryHigh', 'memoryMax'] as EditField[]) {
    const v = parsed[f];
    if (typeof v === 'number' && v < ctx.minLimit) {
      errors.push(`${FIELD_LABELS[f]} must be at least ${formatSize(ctx.minLimit)}.`);
    }
  }
  for (const f of [
    'memoryHigh',
    'memoryMax',
    'memorySwapMax',
    'memoryMin',
    'memoryLow',
  ] as EditField[]) {
    const v = parsed[f];
    if (typeof v === 'number' && ctx.hostTotal > 0 && v > ctx.hostTotal) {
      errors.push(`${FIELD_LABELS[f]} exceeds the host memory (${formatSize(ctx.hostTotal)}).`);
    }
  }
  for (const f of ['memoryMin', 'memoryLow'] as EditField[]) {
    if (parsed[f] === null) errors.push(`${FIELD_LABELS[f]} cannot be infinity.`);
  }
  const eff = (f: EditField): Limit => (f in parsed ? (parsed[f] as Limit) : currentValue(unit, f));
  const high = eff('memoryHigh');
  const max = eff('memoryMax');
  if (max !== null && (high === null || high > max)) {
    errors.push(
      `The soft limit (${formatSize(high)}) must not exceed the hard limit (${formatSize(max)}).`
    );
  }
  const min = eff('memoryMin');
  const low = eff('memoryLow');
  if ((min ?? 0) > (low ?? 0)) {
    errors.push(
      `The protected minimum (${formatSize(min)}) must not exceed the floor (${formatSize(low)}).`
    );
  }
  const newMax = parsed.memoryMax;
  const belowCurrent = typeof newMax === 'number' && newMax < unit.current;
  return { changes, errors, belowCurrent };
}

/* ---------- usage bar ---------- */

export interface BarGeometry {
  /** Percent of the bar filled by current usage, 0-100. */
  fill: number;
  /** Position of the soft and hard lines in percent, null when unlimited. */
  highAt: number | null;
  maxAt: number | null;
  swapFill: number | null;
  level: 'ok' | 'warning' | 'critical';
}

export const SOFT_RATIO = 0.95;
export const HARD_RATIO = 0.95;

/** The scale is the hard limit, else a little beyond the soft limit, else the usage itself. */
export function barGeometry(u: MemUnit, hostTotal: number): BarGeometry {
  const scale =
    u.max !== null
      ? u.max
      : u.high !== null
      ? u.high * 1.15
      : Math.max(u.current * 1.25, hostTotal > 0 ? hostTotal * 0.05 : 1, 1);
  const at = (v: number) => Math.min(100, (v / scale) * 100);
  let level: BarGeometry['level'] = 'ok';
  if (u.high !== null && u.current >= u.high * SOFT_RATIO) level = 'warning';
  if (u.max !== null && u.current >= u.max * HARD_RATIO) level = 'critical';
  return {
    fill: at(u.current),
    highAt: u.high !== null ? at(u.high) : null,
    maxAt: u.max !== null ? at(u.max) : null,
    swapFill:
      u.swapMax !== null && u.swapMax > 0 ? Math.min(100, (u.swapCurrent / u.swapMax) * 100) : null,
    level,
  };
}

/* ---------- alerts and events ---------- */

export function alertsByUnit(alerts: MemAlert[]): Map<string, MemAlert[]> {
  const out = new Map<string, MemAlert[]>();
  for (const a of alerts) out.set(a.unit, [...(out.get(a.unit) ?? []), a]);
  return out;
}

export function worstSeverity(alerts: MemAlert[] | undefined): 'critical' | 'warning' | null {
  if (!alerts || alerts.length === 0) return null;
  return alerts.some(a => a.severity === 'critical') ? 'critical' : 'warning';
}

/** "pane-12.scope" style names are long; show the part a person recognises. */
export function shortName(name: string): string {
  return name
    .replace(/^[a-z0-9]+-workload-native-/, 'pane ')
    .replace(/\.(scope|slice|service)$/, '');
}

/** Parses the backend's JSON, tolerating a missing or partial payload. */
export function parseState(json: any): AgentMemoryState {
  const zero = { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 };
  const units: MemUnit[] = (Array.isArray(json?.units) ? json.units : []).map((u: any) => ({
    ...u,
    events: u.events ?? {},
    eventsLocal: u.eventsLocal ?? {},
    pressureSome: u.pressureSome ?? zero,
    pressureFull: u.pressureFull ?? zero,
  }));
  return {
    node: String(json?.node ?? ''),
    sampled: Number(json?.sampled ?? 0),
    error: String(json?.error ?? ''),
    writable: Boolean(json?.writable),
    host: { total: 0, available: 0, swapTotal: 0, ...(json?.host ?? {}) },
    policy: {
      heavyHigh: '8G',
      heavyMax: '12G',
      heavySwap: '512M',
      keepFree: 0.25,
      ...(json?.policy ?? {}),
    },
    minLimit: Number(json?.minLimit ?? 0),
    protected: Array.isArray(json?.protected) ? json.protected : [],
    units,
    alerts: Array.isArray(json?.alerts) ? json.alerts : [],
  };
}
