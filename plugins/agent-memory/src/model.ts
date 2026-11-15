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

/** Events inside the backend's recent window (a delta of the lifetime counters). */
export interface EventsWindow {
  /** Span actually covered; shorter than the configured window for a new or reset unit. */
  windowSeconds: number;
  partial: boolean;
  reset: boolean;
  events: Record<string, number>;
}

/** Memory stall time inside the recent window, in microseconds. */
export interface PressureWindow {
  windowSeconds: number;
  partial: boolean;
  reset: boolean;
  someUs: number;
  fullUs: number;
}

/** A byte quantity; null means unlimited ("max" / infinity). */
export type Limit = number | null;

/** The T3 Code agent session in a t3code-<provider>-<id>.scope. */
export interface AgentInfo {
  provider: string;
  id: string;
  /** T3CODE_THREAD_ID: the T3 thread the session belongs to. */
  threadId?: string;
  /** The agent CLI session (claude --resume=<id> or --session-id=<id>). */
  sessionId?: string;
  /** true when the session was resumed (--resume). */
  resumed?: boolean;
  cwd?: string;
  pid?: number;
}

/** One process in a scope's tree. */
export interface ProcNode {
  pid: number;
  ppid: number;
  command: string;
  state: string;
  rss: number;
  /** This process plus all its descendants kept in the tree. */
  subtreeRss: number;
  subtreeProcs: number;
  /** The real parent exited and the process was adopted by init or the user manager. */
  reparented: boolean;
  children: ProcNode[];
}

/** shown < total means the backend truncated the tree. */
export interface ProcTree {
  roots: ProcNode[];
  total: number;
  shown: number;
}

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
  /** Absent for backends that predate the windowed fields. */
  eventsWindow?: EventsWindow;
  pressureWindow?: PressureWindow;
  procs: number;
  command?: string;
  topProcess?: string;
  topRss?: number;
  /** The scope's process tree; absent for slices and for backends that predate it. */
  processes?: ProcTree;
  /** memory.peak: the highest usage seen since the cgroup was created. */
  peak?: number;
  /** The T3 agent behind an agent scope; absent for slices. */
  agent?: AgentInfo;
  /** Human-friendly label ("claude · .cluster · 32a684cb"); the unit name for slices. */
  displayName: string;
}

export interface MemAlert {
  unit: string;
  severity: 'warning' | 'critical';
  reason: string;
  detail: string;
}

/** A memory warning the backend prompted a pane's agent with (or tried to). */
export interface AgentWarning {
  time: string;
  unit: string;
  displayName: string;
  threadId: string;
  agent: string;
  /** Limit types reached: hard-limit, oom-kill, stall (or test). */
  types: string[];
  message: string;
  sent: boolean;
  test: boolean;
  error: string;
}

/** Warnings older than this are not shown. */
export const WARNING_MAX_AGE_MS = 24 * 3600 * 1000;

export interface WarningPolicy {
  enabled: boolean;
  intervalSeconds?: number;
  stallSeconds?: number;
  windowSeconds?: number;
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
  /** The host-level slice of every T3 agent; its limits are persisted. */
  agentSlice: string;
  t3: { agentSlice: string; agents: number };
  /** The per-agent default drop-in; null when the backend has no editor for it. */
  agentDefault: AgentDefault | null;
  /** Limits set on single agents from this page: unit to property to value. */
  overrides: Record<string, Record<string, string>>;
  /** The node's pods by QoS class; null when the backend does not read them. */
  pods: PodMemory | null;
  units: MemUnit[];
  alerts: MemAlert[];
  /** Agent warnings from the last 24 hours, newest first. */
  warnings: AgentWarning[];
  warningPolicy: WarningPolicy;
}

/** 50-agent-cap.conf: the default cap of every agent. undefined: not set; null: infinity. */
export interface AgentDefault {
  file: string;
  memoryHigh?: Limit;
  memoryMax?: Limit;
  error?: string;
}

export interface PodClass {
  class: 'guaranteed' | 'burstable' | 'besteffort' | string;
  pods: number;
  current: number;
  anon: number;
  file: number;
}

export interface PodMemory {
  current: number;
  max: Limit;
  classes: PodClass[];
  error?: string;
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
  /** "default" for a change of the per-agent default; absent for a limit change. */
  action?: string;
  displayName?: string;
  force?: boolean;
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
  /** The only editable slice; empty allows any. */
  agentSlice?: string;
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
  if (unit.kind === 'slice' && ctx.agentSlice && unit.name !== ctx.agentSlice)
    errors.push(`Only ${ctx.agentSlice} and the agents can be edited; ${unit.name} belongs to T3.`);
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

export type DefaultField = 'memoryHigh' | 'memoryMax';
export type DefaultForm = Partial<Record<DefaultField, string>>;

/**
 * Mirrors the backend's rules for POST /api/defaults. belowCurrent lists the
 * running agents (without their own limit) whose usage is above the new hard
 * limit: the daemon-reload applies the default to them too.
 */
export function checkDefaults(
  current: AgentDefault,
  form: DefaultForm,
  ctx: Pick<EditContext, 'minLimit' | 'hostTotal'>,
  agents: MemUnit[],
  overrides: Record<string, Record<string, string>>
): { changes: DefaultForm; errors: string[]; belowCurrent: MemUnit[] } {
  const errors: string[] = [];
  const parsed: Partial<Record<DefaultField, Limit>> = {};
  const changes: DefaultForm = {};
  for (const f of ['memoryHigh', 'memoryMax'] as DefaultField[]) {
    const raw = form[f];
    if (raw === undefined) continue;
    const v = parseSize(raw);
    if (v === undefined) {
      errors.push(`${FIELD_LABELS[f]}: "${raw}" is not a size (use for example 64G or infinity)`);
      continue;
    }
    if (v === current[f]) continue;
    if (typeof v === 'number' && v < ctx.minLimit)
      errors.push(`${FIELD_LABELS[f]} must be at least ${formatSize(ctx.minLimit)}.`);
    if (typeof v === 'number' && ctx.hostTotal > 0 && v > ctx.hostTotal)
      errors.push(`${FIELD_LABELS[f]} exceeds the host memory (${formatSize(ctx.hostTotal)}).`);
    parsed[f] = v;
    changes[f] = raw.trim();
  }
  if (errors.length) return { changes, errors, belowCurrent: [] };
  if (Object.keys(parsed).length === 0)
    return { changes, errors: ['Nothing has changed.'], belowCurrent: [] };
  const eff = (f: DefaultField): Limit =>
    f in parsed ? (parsed[f] as Limit) : current[f] === undefined ? null : (current[f] as Limit);
  const high = eff('memoryHigh');
  const max = eff('memoryMax');
  if (max !== null && (high === null || high > max))
    errors.push(
      `The soft limit (${formatSize(high)}) must not exceed the hard limit (${formatSize(max)}).`
    );
  const newMax = parsed.memoryMax;
  const belowCurrent =
    typeof newMax === 'number'
      ? agents.filter(u => !overrides[u.name]?.MemoryMax && u.current > newMax)
      : [];
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

/** Soft-limit (`high`) events are routine kernel reclaim, so they never show as an alert. */
export function visibleAlerts(alerts: MemAlert[]): MemAlert[] {
  return alerts.filter(a => a.reason !== 'high-events');
}

export function worstSeverity(alerts: MemAlert[] | undefined): 'critical' | 'warning' | null {
  if (!alerts || alerts.length === 0) return null;
  return alerts.some(a => a.severity === 'critical') ? 'critical' : 'warning';
}

/** "t3code-claude-9e2d894e.scope" style names are long; show the part a person recognises. */
export function shortName(name: string): string {
  return name.replace(/^t3code-([a-z0-9]+)-/, '$1 ').replace(/\.(scope|slice|service)$/, '');
}

/** The primary row label: provider, cwd and session when known, else the short unit name. */
export function unitLabel(u: Pick<MemUnit, 'name' | 'displayName'>): string {
  return u.displayName && u.displayName !== u.name ? u.displayName : shortName(u.name);
}

/** Label for an audit record, which may predate display names. */
export function changeLabel(c: Pick<ChangeRecord, 'unit' | 'displayName'>): string {
  const d = cleanText(c.displayName);
  return d && d !== c.unit ? d : shortName(c.unit);
}

/** Secondary text under the label: session (resumed or new), T3 thread and agent pid. */
export function unitDetail(u: MemUnit): string {
  const a = u.agent;
  if (!a) return '';
  return [
    a.sessionId ? `${a.resumed ? 'resumed' : 'session'} ${a.sessionId}` : '',
    a.threadId ? `thread ${a.threadId}` : '',
    a.pid ? `pid ${a.pid}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Everything a person might type to find a row: label, names, session, cwd, command. */
export function matchesFilter(u: MemUnit, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const a = u.agent;
  return [
    u.name,
    u.displayName,
    u.command,
    u.topProcess,
    ...processCommands(u.processes),
    a?.provider,
    a?.sessionId,
    a?.threadId,
    a?.cwd,
  ].some(v => (v ?? '').toLowerCase().includes(q));
}

export function isAgent(u: MemUnit): boolean {
  return u.kind === 'scope' && !!u.agent;
}

/** Applies the search; the order is the backend's (parents before children). */
export function arrangeRows(units: MemUnit[], query: string): MemUnit[] {
  return units.filter(u => matchesFilter(u, query));
}

/** Whether the page can edit this unit: the agents slice (persisted) or an agent scope (live). */
export function canEdit(
  u: MemUnit,
  state: Pick<AgentMemoryState, 'agentSlice' | 'writable'>
): boolean {
  if (!state.writable) return false;
  if (u.kind === 'scope') return true;
  return u.kind === 'slice' && (!state.agentSlice || u.name === state.agentSlice);
}

const MAX_TEXT = 120;

/** Drops control and bidi override/isolate characters and caps the length, for backend-supplied names. */
export function cleanText(v: unknown, max: number = MAX_TEXT): string {
  const out = String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(out);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : out;
}

const MAX_TREE_NODES = 5000;
const MAX_TREE_DEPTH = 64;
const MAX_COMMAND = 160;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Parses and validates a backend process tree: text is cleaned, numbers are
 * coerced, the node count and depth are bounded, and subtree totals are
 * recomputed so a malformed payload cannot mislead. Children and roots are
 * ordered largest subtree first.
 */
export function parseProcTree(raw: any): ProcTree | undefined {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.roots)) return undefined;
  let budget = MAX_TREE_NODES;
  const build = (r: any, depth: number): ProcNode | null => {
    if (!r || typeof r !== 'object' || budget <= 0) return null;
    budget--;
    const node: ProcNode = {
      pid: num(r.pid),
      ppid: num(r.ppid),
      command: cleanText(r.command, MAX_COMMAND),
      state: cleanText(r.state, 4),
      rss: num(r.rss),
      subtreeRss: 0,
      subtreeProcs: 1,
      reparented: r.reparented === true,
      children: [],
    };
    node.subtreeRss = node.rss;
    if (depth < MAX_TREE_DEPTH && Array.isArray(r.children)) {
      for (const c of r.children) {
        const child = build(c, depth + 1);
        if (!child) continue;
        node.children.push(child);
        node.subtreeRss += child.subtreeRss;
        node.subtreeProcs += child.subtreeProcs;
      }
      node.children.sort(bySubtree);
    }
    return node;
  };
  const roots: ProcNode[] = [];
  for (const r of raw.roots) {
    const n = build(r, 0);
    if (n) roots.push(n);
  }
  roots.sort(bySubtree);
  const shown = roots.reduce((a, n) => a + n.subtreeProcs, 0);
  return { roots, total: Math.max(num(raw.total), shown), shown };
}

function bySubtree(a: ProcNode, b: ProcNode): number {
  return b.subtreeRss - a.subtreeRss || a.pid - b.pid;
}

/** Every command in a tree, for the filter box. */
export function processCommands(t: ProcTree | undefined): string[] {
  const out: string[] = [];
  const walk = (ns: ProcNode[]) =>
    ns.forEach(n => {
      out.push(n.command);
      walk(n.children);
    });
  if (t) walk(t.roots);
  return out;
}

export interface TreeRow {
  node: ProcNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/** The visible rows of a tree, depth first, skipping the children of collapsed pids. */
export function visibleProcesses(t: ProcTree, collapsed: ReadonlySet<number>): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (ns: ProcNode[], depth: number) =>
    ns.forEach(n => {
      const expanded = !collapsed.has(n.pid);
      out.push({ node: n, depth, hasChildren: n.children.length > 0, expanded });
      if (expanded) walk(n.children, depth + 1);
    });
  walk(t.roots, 0);
  return out;
}

function cleanAgent(a: any): AgentInfo | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const o: AgentInfo = { provider: cleanText(a.provider), id: cleanText(a.id) };
  if (a.threadId !== undefined) o.threadId = cleanText(a.threadId);
  if (a.sessionId !== undefined) o.sessionId = cleanText(a.sessionId);
  if (a.cwd !== undefined) o.cwd = cleanText(a.cwd, 300);
  if (a.resumed !== undefined) o.resumed = Boolean(a.resumed);
  if (a.pid !== undefined) o.pid = num(a.pid);
  return o;
}

function limitOrUndefined(v: unknown): Limit | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseDefault(d: any): AgentDefault | null {
  if (!d || typeof d !== 'object') return null;
  const out: AgentDefault = { file: cleanText(d.file, 300) };
  if ('memoryHigh' in d) out.memoryHigh = limitOrUndefined(d.memoryHigh);
  if ('memoryMax' in d) out.memoryMax = limitOrUndefined(d.memoryMax);
  if (d.error) out.error = cleanText(d.error, 300);
  return out;
}

function parsePods(p: any): PodMemory | null {
  if (!p || typeof p !== 'object') return null;
  return {
    current: num(p.current),
    max: p.max === null || p.max === undefined ? null : num(p.max),
    classes: (Array.isArray(p.classes) ? p.classes : []).map((c: any) => ({
      class: cleanText(c?.class),
      pods: num(c?.pods),
      current: num(c?.current),
      anon: num(c?.anon),
      file: num(c?.file),
    })),
    error: p.error ? cleanText(p.error) : undefined,
  };
}

function parseOverrides(o: any): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!o || typeof o !== 'object') return out;
  for (const [unit, props] of Object.entries(o)) {
    if (!props || typeof props !== 'object') continue;
    out[cleanText(unit)] = Object.fromEntries(
      Object.entries(props as Record<string, unknown>).map(([k, v]) => [cleanText(k), cleanText(v)])
    );
  }
  return out;
}

function parseEventsWindow(w: any): EventsWindow | undefined {
  if (!w || typeof w !== 'object') return undefined;
  const events: Record<string, number> = {};
  for (const [k, v] of Object.entries(w.events ?? {})) events[k] = num(v);
  return {
    windowSeconds: num(w.windowSeconds),
    partial: Boolean(w.partial),
    reset: Boolean(w.reset),
    events,
  };
}

function parsePressureWindow(w: any): PressureWindow | undefined {
  if (!w || typeof w !== 'object') return undefined;
  return {
    windowSeconds: num(w.windowSeconds),
    partial: Boolean(w.partial),
    reset: Boolean(w.reset),
    someUs: num(w.someUs),
    fullUs: num(w.fullUs),
  };
}

/** "10 min", "45 s", "1 h 5 min": a span in seconds, for window labels. */
export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** Stall time from microseconds: "0 s", "3.4 s", "2.5 min", "1.2 h". */
export function formatStall(us: number): string {
  const s = us / 1e6;
  if (s < 0.05) return '0 s';
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export const EVENT_LABELS: Record<string, string> = {
  high: 'soft-limit events',
  max: 'hard-limit events',
  oom: 'OOM events',
  oom_kill: 'OOM kill events',
};

/**
 * Events of one kind in the window, formatted for a badge, plus whether it
 * should be highlighted. Highlighting depends only on the windowed count, never
 * on the lifetime total.
 */
export function windowedEvent(unit: MemUnit, key: string): { n: number; active: boolean } {
  const n = unit.eventsWindow?.events[key] ?? 0;
  return { n, active: n > 0 };
}

/** Seconds of full stall in the window that turns the stall badge amber. */
export const STALL_WARN_SECONDS = 1;
export const STALL_CRIT_SECONDS = 10;

/** Colour of the full-stall badge from the windowed stall time only. */
export function stallLevel(unit: MemUnit): 'default' | 'warning' | 'error' {
  const s = (unit.pressureWindow?.fullUs ?? 0) / 1e6;
  return s >= STALL_CRIT_SECONDS ? 'error' : s >= STALL_WARN_SECONDS ? 'warning' : 'default';
}

/** Cleans the backend's warning list and keeps only the last 24 hours, newest first. */
export function parseWarnings(list: any, nowMs: number): AgentWarning[] {
  if (!Array.isArray(list)) return [];
  const out: AgentWarning[] = [];
  for (const w of list) {
    if (!w || typeof w !== 'object') continue;
    const at = Date.parse(String(w.time ?? ''));
    if (!Number.isFinite(at) || nowMs - at > WARNING_MAX_AGE_MS) continue;
    out.push({
      time: new Date(at).toISOString(),
      unit: cleanText(w.unit),
      displayName: cleanText(w.displayName) || cleanText(w.unit),
      threadId: cleanText(w.threadId),
      agent: cleanText(w.agent),
      types: Array.isArray(w.types) ? w.types.map((t: unknown) => cleanText(t)) : [],
      message: cleanText(w.message),
      sent: Boolean(w.sent),
      test: Boolean(w.test),
      error: cleanText(w.error),
    });
  }
  return out.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

/** Parses the backend's JSON, tolerating a missing or partial payload. */
export function parseState(json: any): AgentMemoryState {
  const zero = { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 };
  const units: MemUnit[] = (Array.isArray(json?.units) ? json.units : []).map((u: any) => ({
    ...u,
    displayName: cleanText(u.displayName) || u.name,
    agent: cleanAgent(u.agent),
    processes: parseProcTree(u.processes),
    events: u.events ?? {},
    eventsLocal: u.eventsLocal ?? {},
    pressureSome: u.pressureSome ?? zero,
    pressureFull: u.pressureFull ?? zero,
    eventsWindow: parseEventsWindow(u.eventsWindow),
    pressureWindow: parsePressureWindow(u.pressureWindow),
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
    agentSlice: String(json?.agentSlice ?? ''),
    t3: { agentSlice: '', agents: 0, ...(json?.t3 ?? {}) },
    agentDefault: parseDefault(json?.agentDefault),
    overrides: parseOverrides(json?.overrides),
    pods: parsePods(json?.pods),
    units,
    alerts: Array.isArray(json?.alerts) ? json.alerts : [],
    warnings: parseWarnings(json?.warnings, Number(json?.sampled ?? 0) * 1000 || Date.now()),
    warningPolicy: { enabled: false, ...(json?.warningPolicy ?? {}) },
  };
}
