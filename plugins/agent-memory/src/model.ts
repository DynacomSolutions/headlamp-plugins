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

/** Labels the orchestrator itself supplies (Herdr workspace and tab). */
export interface AgentNames {
  workspace?: string;
  tab?: string;
  title?: string;
  agent?: string;
  status?: string;
  /** T3 project directory. */
  projectDir?: string;
  /** Parent thread id (T3 sub-threads). */
  parent?: string;
}

/** A limit the agent raised itself, after a verified approval. */
export interface RaisedInfo {
  size: number;
  high: Limit;
  /** The limit before the raise; null when unknown or unlimited. */
  previous: Limit;
  reason: string;
  question: string;
  label: string;
  approvedAt: string;
  at: string;
}

/** The agent session in an orchestrator's agent scope. */
export interface AgentInfo {
  /** The orchestrator that started it (t3, herdr); absent from old backends. */
  orchestrator?: string;
  provider: string;
  id: string;
  /** The orchestrator's thread (T3CODE_THREAD_ID) or pane (HERDR_PANE_ID). */
  threadId?: string;
  /** Opens the thread in the orchestrator; only http(s) links are kept. */
  threadUrl?: string;
  names?: AgentNames;
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
  /** The agent behind an agent scope; absent for slices. */
  agent?: AgentInfo;
  /** Orchestrator and layer (control, agents, agent); absent from old backends. */
  orchestrator?: string;
  role?: '' | 'control' | 'agents' | 'agent';
  /** Set when the agent's limit was raised by its own request. */
  raised?: RaisedInfo;
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
  /**
   * The orchestrators (T3 Code, Herdr, ...). An old backend without them
   * gets one synthesised T3 entry holding every unit.
   */
  orchestrators: Orchestrator[];
  /** The node's pods by QoS class; null when the backend does not read them. */
  pods: PodMemory | null;
  units: MemUnit[];
  alerts: MemAlert[];
  /** Agent warnings from the last 24 hours, newest first. */
  warnings: AgentWarning[];
  warningPolicy: WarningPolicy;
}

/** An orchestrator's per-agent default file. undefined: not set; null: infinity. */
export interface AgentDefault {
  file: string;
  memoryHigh?: Limit;
  memoryMax?: Limit;
  memorySwapMax?: Limit;
  /** daemon-reload (T3) or running-agents (Herdr: set on each running pane). */
  apply?: string;
  /** Shown without an editor (mounted read-only). */
  readOnly?: boolean;
  note?: string;
  error?: string;
}

export interface LayerLimits {
  memoryMin?: Limit;
  memoryLow?: Limit;
  memoryHigh?: Limit;
  memoryMax?: Limit;
  memorySwapMax?: Limit;
  managedOOMPreference?: string;
  oomPolicy?: string;
  ioWeight?: number;
}

export interface Drift {
  layer: 'control' | 'agents' | 'agent';
  unit: string;
  property: string;
  want: Limit;
  have: Limit;
}

/** One orchestrator: its three layers, its default and how live limits match the policy. */
export interface Orchestrator {
  name: string;
  kind: string;
  title: string;
  controlUnit: string;
  agentsSlice: string;
  agentScope: string;
  threadEnv: string;
  running: boolean;
  controlUp: boolean;
  agents: number;
  current: number;
  policy: { control: LayerLimits; agents: LayerLimits; agent: LayerLimits };
  defaults: AgentDefault | null;
  overrides: Record<string, Record<string, string>>;
  drift: Drift[];
  agentDrift: number;
  names?: { up: boolean; error?: string; entries: number };
  /** The orchestrator supports limit-raise requests. */
  raise?: boolean;
  /** false for the entry synthesised for an old backend. */
  fromBackend: boolean;
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
  old?: Record<string, string> | null;
  new?: Record<string, string> | null;
  error?: string;
  /** For raises by request: the approving answer. */
  approval?: string;
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
  /** The editable slices (every orchestrator's agents slice); wins over agentSlice. */
  agentSlices?: string[];
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
  const slices = ctx.agentSlices?.length ? ctx.agentSlices : ctx.agentSlice ? [ctx.agentSlice] : [];
  if (unit.kind === 'slice' && slices.length > 0 && !slices.includes(unit.name))
    errors.push(
      `Only ${slices.join(', ')} and the agents can be edited; ${
        unit.name
      } belongs to the orchestrator.`
    );
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

export type DefaultField = 'memoryHigh' | 'memoryMax' | 'memorySwapMax';
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
  for (const f of ['memoryHigh', 'memoryMax', 'memorySwapMax'] as DefaultField[]) {
    const raw = form[f];
    if (raw === undefined || (raw.trim() === '' && current[f] === undefined)) continue;
    const v = parseSize(raw);
    if (v === undefined) {
      errors.push(`${FIELD_LABELS[f]}: "${raw}" is not a size (use for example 64G or infinity)`);
      continue;
    }
    if (v === current[f]) continue;
    if (f !== 'memorySwapMax' && typeof v === 'number' && v < ctx.minLimit)
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

/** The editable slices: every orchestrator's agents slice (the legacy agentSlice otherwise). */
export function agentSlices(
  state: Partial<Pick<AgentMemoryState, 'agentSlice' | 'orchestrators'>>
): string[] {
  const out = (state.orchestrators ?? []).map(o => o.agentsSlice).filter(Boolean);
  if (out.length === 0 && state.agentSlice) out.push(state.agentSlice);
  return out;
}

/** Whether the page can edit this unit: an agents slice (persisted) or an agent scope (live). */
export function canEdit(
  u: MemUnit,
  state: Pick<AgentMemoryState, 'agentSlice' | 'writable'> &
    Partial<Pick<AgentMemoryState, 'orchestrators'>>
): boolean {
  if (!state.writable) return false;
  if (u.kind === 'scope') return true;
  const slices = agentSlices(state);
  return u.kind === 'slice' && (slices.length === 0 || slices.includes(u.name));
}

/** The units of one orchestrator, in the backend's order (parents before children). */
export function orchestratorUnits(units: MemUnit[], o: Orchestrator): MemUnit[] {
  if (!o.fromBackend) return units;
  return units.filter(u => u.orchestrator === o.name);
}

/** The orchestrator's own running agents. */
export function orchestratorAgents(units: MemUnit[], o: Orchestrator): MemUnit[] {
  return orchestratorUnits(units, o).filter(isAgent);
}

/** Only http(s) links are followed; anything else is dropped. */
export function safeUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 600) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
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
  if (a.orchestrator !== undefined) o.orchestrator = cleanText(a.orchestrator);
  if (a.threadId !== undefined) o.threadId = cleanText(a.threadId, 256);
  const url = safeUrl(a.threadUrl);
  if (url) o.threadUrl = url;
  if (a.names && typeof a.names === 'object') {
    const n: AgentNames = {};
    for (const k of ['workspace', 'tab', 'title', 'agent', 'status', 'parent'] as const)
      if (a.names[k]) n[k] = cleanText(a.names[k]);
    if (a.names.projectDir) n.projectDir = cleanText(a.names.projectDir, 300);
    o.names = n;
  }
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
  if ('memorySwapMax' in d) out.memorySwapMax = limitOrUndefined(d.memorySwapMax);
  if (d.apply) out.apply = cleanText(d.apply);
  if (d.readOnly) out.readOnly = true;
  if (d.note) out.note = cleanText(d.note, 300);
  if (d.error) out.error = cleanText(d.error, 300);
  return out;
}

function parseLayer(l: any): LayerLimits {
  const out: LayerLimits = {};
  if (!l || typeof l !== 'object') return out;
  for (const k of ['memoryMin', 'memoryLow', 'memoryHigh', 'memoryMax', 'memorySwapMax'] as const)
    if (k in l) out[k] = limitOrUndefined(l[k]);
  if (l.managedOOMPreference) out.managedOOMPreference = cleanText(l.managedOOMPreference);
  if (l.oomPolicy) out.oomPolicy = cleanText(l.oomPolicy);
  if (l.ioWeight) out.ioWeight = num(l.ioWeight);
  return out;
}

function parseOrchestrators(json: any, units: MemUnit[]): Orchestrator[] {
  const list = Array.isArray(json?.orchestrators) ? json.orchestrators : null;
  if (!list) {
    // A backend that predates orchestrators: one T3 section with every unit.
    const slice = String(json?.agentSlice ?? '');
    return [
      {
        name: 't3',
        kind: 't3',
        title: 'T3 Code',
        controlUnit: '',
        agentsSlice: slice,
        agentScope: '',
        threadEnv: 'T3CODE_THREAD_ID',
        running: units.length > 0,
        controlUp: false,
        agents: units.filter(isAgent).length,
        current: units.find(u => u.name === slice)?.current ?? 0,
        policy: { control: {}, agents: {}, agent: {} },
        defaults: parseDefault(json?.agentDefault),
        overrides: parseOverrides(json?.overrides),
        drift: [],
        agentDrift: 0,
        fromBackend: false,
      },
    ];
  }
  return list
    .filter((o: any) => o && typeof o === 'object' && o.name)
    .map((o: any) => ({
      name: cleanText(o.name),
      kind: cleanText(o.kind),
      title: cleanText(o.title) || cleanText(o.name),
      controlUnit: cleanText(o.controlUnit),
      agentsSlice: cleanText(o.agentsSlice),
      agentScope: cleanText(o.agentScope, 200),
      threadEnv: cleanText(o.threadEnv),
      running: Boolean(o.running),
      controlUp: Boolean(o.controlUp),
      agents: num(o.agents),
      current: num(o.current),
      policy: {
        control: parseLayer(o.policy?.control),
        agents: parseLayer(o.policy?.agents),
        agent: parseLayer(o.policy?.agent),
      },
      defaults: parseDefault(o.defaults),
      overrides: parseOverrides(o.overrides),
      drift: (Array.isArray(o.drift) ? o.drift : []).slice(0, 100).map((d: any) => ({
        layer: d?.layer === 'control' || d?.layer === 'agents' ? d.layer : 'agent',
        unit: cleanText(d?.unit),
        property: cleanText(d?.property),
        want: limitOrUndefined(d?.want) ?? null,
        have: limitOrUndefined(d?.have) ?? null,
      })),
      agentDrift: num(o.agentDrift),
      names:
        o.names && typeof o.names === 'object'
          ? {
              up: Boolean(o.names.up),
              entries: num(o.names.entries),
              error: o.names.error ? cleanText(o.names.error, 200) : undefined,
            }
          : undefined,
      raise: o.raise === undefined ? undefined : Boolean(o.raise),
      fromBackend: true,
    }));
}

function parseRaised(r: any): RaisedInfo | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const size = limitOrUndefined(r.size);
  if (typeof size !== 'number') return undefined;
  const at = (v: unknown) => {
    const t = Date.parse(String(v ?? ''));
    return Number.isFinite(t) ? new Date(t).toISOString() : '';
  };
  return {
    size,
    high: limitOrUndefined(r.high) ?? null,
    previous: limitOrUndefined(r.previous) ?? null,
    reason: cleanText(r.reason, 300),
    question: cleanText(r.question, 300),
    label: cleanText(r.label, 200),
    approvedAt: at(r.approvedAt),
    at: at(r.at),
  };
}

/** Tooltip of the "Raised by request" chip. */
export function raisedTitle(
  r: RaisedInfo,
  fmt: (iso: string) => string = iso => new Date(iso).toLocaleString()
): string {
  const when = r.approvedAt ? fmt(r.approvedAt) : 'unknown time';
  return `approved ${when}: ${r.label || 'no label'}; reason: ${
    r.reason || 'none given'
  }; ${formatSize(r.previous)} → ${formatSize(r.size)}`;
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
    orchestrator: u.orchestrator === undefined ? undefined : cleanText(u.orchestrator),
    role: ['control', 'agents', 'agent'].includes(u.role)
      ? u.role
      : u.role === undefined
      ? undefined
      : '',
    raised: parseRaised(u.raised),
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
    orchestrators: parseOrchestrators(json, units),
    pods: parsePods(json?.pods),
    units,
    alerts: Array.isArray(json?.alerts) ? json.alerts : [],
    warnings: parseWarnings(json?.warnings, Number(json?.sampled ?? 0) * 1000 || Date.now()),
    warningPolicy: { enabled: false, ...(json?.warningPolicy ?? {}) },
  };
}

/* ---------- host > orchestrator > project > thread tree ---------- */

export interface ProjectGroup {
  key: string;
  name: string;
  orchestrator: string;
  /** All the project's agents, before the filter (the scopes, for the "Other scopes" group). */
  agents: number;
  /** The "Other scopes" group: non-agent scopes of the orchestrator. */
  other?: boolean;
  current: number;
}

export interface AgentTreeRow {
  /** Stable across refreshes; the collapsed set holds these keys. */
  key: string;
  kind: 'host' | 'orchestrator' | 'project' | 'unit';
  /** Host 0, orchestrator 1, control/agents/project 2, thread 3. */
  depth: number;
  /**
   * One entry per ancestor column left of the row's own elbow (depth - 1 of
   * them, none for the host): true draws a continuing vertical line there.
   */
  guides: boolean[];
  /** Last sibling: the elbow is a corner (└) instead of a tee (├). */
  last: boolean;
  /** Group rows only. */
  hasChildren: boolean;
  expanded: boolean;
  unit?: MemUnit;
  orchestrator?: Orchestrator;
  project?: ProjectGroup;
}

function baseName(p: string | undefined): string {
  const parts = (p ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

export const UNKNOWN_PROJECT = 'Unknown project';
export const OTHER_SCOPES = 'Other scopes';

/** The project an agent sits under: T3 project title or Herdr workspace. */
export function projectName(u: MemUnit): string {
  const n = u.agent?.names;
  if (n?.workspace) return n.workspace;
  const dn = u.displayName ?? '';
  for (const sep of [' > ', ' / ']) {
    const i = dn.indexOf(sep);
    if (i > 0) return dn.slice(0, i);
  }
  return baseName(n?.projectDir) || baseName(u.agent?.cwd) || UNKNOWN_PROJECT;
}

/** The thread name shown on an agent row: T3 thread title or Herdr tab, never the project. */
export function threadName(u: MemUnit): string {
  const n = u.agent?.names;
  const own = n?.title || n?.tab;
  if (own) return own;
  const dn = u.displayName || shortName(u.name);
  const project = projectName(u);
  for (const sep of [' > ', ' / ']) {
    if (dn.startsWith(`${project}${sep}`)) return dn.slice(project.length + sep.length) || dn;
  }
  return dn;
}

interface TreeNode {
  row: Omit<AgentTreeRow, 'guides' | 'last' | 'expanded' | 'hasChildren'>;
  children: TreeNode[];
  group: boolean;
}

function unitMatches(u: MemUnit, q: string): boolean {
  if (matchesFilter(u, q)) return true;
  const n = u.agent?.names;
  return [n?.workspace, n?.title, n?.tab, n?.projectDir].some(v =>
    (v ?? '').toLowerCase().includes(q)
  );
}

/**
 * The visible rows of the page's tree: host, orchestrators, their control and
 * agents-slice rows, projects and threads. Collapsed groups hide their rows;
 * the filter keeps matching units and their ancestors (a matching project or
 * orchestrator name keeps everything under it).
 */
export function buildTree(
  state: AgentMemoryState,
  collapsed: ReadonlySet<string>,
  filter: string
): AgentTreeRow[] {
  const q = filter.trim().toLowerCase();
  const host: TreeNode = {
    row: { key: 'host', kind: 'host', depth: 0 },
    children: [],
    group: true,
  };
  for (const o of state.orchestrators) {
    const oNode: TreeNode = {
      row: { key: `o:${o.name}`, kind: 'orchestrator', depth: 1, orchestrator: o },
      children: [],
      group: true,
    };
    const orchHit = q !== '' && `${o.title} ${o.name}`.toLowerCase().includes(q);
    const keep = (u: MemUnit) => q === '' || orchHit || unitMatches(u, q);
    const units = orchestratorUnits(state.units, o);
    const isControl = (u: MemUnit) =>
      u.role === 'control' || (!!o.controlUnit && u.name === o.controlUnit);
    const isAgents = (u: MemUnit) =>
      u.role === 'agents' || (!!o.agentsSlice && u.name === o.agentsSlice);
    const leaf = (u: MemUnit): TreeNode => ({
      row: { key: `u:${u.name}`, kind: 'unit', depth: 2, unit: u },
      children: [],
      group: false,
    });
    for (const u of units) if (isControl(u) && keep(u)) oNode.children.push(leaf(u));
    for (const u of units)
      if (isAgents(u) && !isControl(u) && keep(u)) oNode.children.push(leaf(u));
    const projects = new Map<string, { group: ProjectGroup; units: MemUnit[] }>();
    for (const u of units) {
      if (!isAgent(u) || isControl(u) || isAgents(u)) continue;
      const name = projectName(u);
      let p = projects.get(name);
      if (!p) {
        p = {
          group: { key: `p:${o.name}:${name}`, name, orchestrator: o.name, agents: 0, current: 0 },
          units: [],
        };
        projects.set(name, p);
      }
      p.group.agents++;
      p.group.current += u.current;
      p.units.push(u);
    }
    const rank = (n: string) => (n === UNKNOWN_PROJECT ? 1 : 0);
    const sorted = [...projects.values()].sort(
      (a, b) =>
        rank(a.group.name) - rank(b.group.name) ||
        a.group.name.localeCompare(b.group.name, undefined, { sensitivity: 'base' })
    );
    // Non-agent scopes and services (systemd-run jobs and the like) go last; intermediate slices stay hidden.
    const others = units.filter(
      u => !isControl(u) && !isAgents(u) && !isAgent(u) && u.kind !== 'slice'
    );
    if (others.length > 0)
      sorted.push({
        group: {
          key: `p:${o.name}:#other`,
          name: OTHER_SCOPES,
          orchestrator: o.name,
          agents: others.length,
          current: others.reduce((a, u) => a + u.current, 0),
          other: true,
        },
        units: others,
      });
    for (const p of sorted) {
      const projHit = q !== '' && p.group.name.toLowerCase().includes(q);
      const shown = p.units.filter(u => orchHit || projHit || keep(u));
      if (shown.length === 0) continue;
      oNode.children.push({
        row: { key: p.group.key, kind: 'project', depth: 2, project: p.group },
        group: true,
        children: shown.map(u => ({
          row: { key: `u:${u.name}`, kind: 'unit' as const, depth: 3, unit: u },
          children: [],
          group: false,
        })),
      });
    }
    if (q === '' || orchHit || oNode.children.length > 0) host.children.push(oNode);
  }
  const out: AgentTreeRow[] = [];
  const walk = (n: TreeNode, guides: boolean[], last: boolean) => {
    const expanded = n.group && !collapsed.has(n.row.key);
    out.push({
      ...n.row,
      guides,
      last,
      hasChildren: n.group && n.children.length > 0,
      expanded,
    });
    if (!expanded) return;
    const childGuides = n.row.depth === 0 ? [] : [...guides, !last];
    // The host has no line column, so its children start with no ancestors.
    n.children.forEach((c, i) =>
      walk(c, n.row.depth === 0 ? [] : childGuides, i === n.children.length - 1)
    );
  };
  walk(host, [], true);
  return out;
}

/** The connector cells of a row, left to right: ancestor lines, then its own elbow. */
export type GuideCell = 'line' | 'tee' | 'elbow' | 'none';

export function guideCells(row: Pick<AgentTreeRow, 'depth' | 'guides' | 'last'>): GuideCell[] {
  if (row.depth === 0) return [];
  return [...row.guides.map((g): GuideCell => (g ? 'line' : 'none')), row.last ? 'elbow' : 'tee'];
}

/** "1 process", "3 processes". */
export function processCount(n: number): string {
  return `${n} ${n === 1 ? 'process' : 'processes'}`;
}

/** Swap usage on one line: "used / max", where max is ∞ when unlimited. */
export function swapText(u: Pick<MemUnit, 'swapCurrent' | 'swapMax'>): string {
  return `${formatSize(u.swapCurrent)} / ${formatSize(u.swapMax)}`;
}

/** An agent row's label: the project (muted) and the thread (the link). */
export function agentLabelParts(u: MemUnit): { project: string; thread: string } {
  return { project: projectName(u), thread: threadName(u) };
}

/** The same label as plain text, for tooltips and aria labels. */
export function agentLabel(u: MemUnit): string {
  const { project, thread } = agentLabelParts(u);
  return `${project} > ${thread}`;
}

/** One line describing a change record; tolerates missing old/new maps. */
export function describeChange(c: ChangeRecord): string {
  const oldV = c.old ?? {};
  const newV = c.new ?? {};
  const parts = Object.keys(newV).map(
    k => `${k.replace('Memory', '')} ${oldV[k] ?? '?'} to ${newV[k]}`
  );
  let prefix = '';
  if (c.action === 'default') prefix = 'Default for every agent: ';
  else if (c.action === 'raise' && c.method === 'refused') prefix = 'Raise refused: ';
  else if (c.action === 'raise') prefix = 'Raised by request: ';
  const body = parts.join(', ') || '-';
  return `${prefix}${body}${
    c.error ? ` (${c.method === 'refused' ? '' : 'failed: '}${c.error})` : ''
  }`;
}

/** Processes in a unit: the tree's total, else the plain count; 0 for a slice. */
export function processTotal(u: Pick<MemUnit, 'kind' | 'procs' | 'processes'>): number {
  if (u.kind === 'slice') return 0;
  return Math.max(u.processes?.total ?? 0, u.procs ?? 0);
}

/** Column widths in px of the agent table (fixed layout; Name first, Edit last). */
export const TREE_COLUMN_WIDTHS = [390, 116, 60, 60, 60, 60, 104, 72, 220, 144, 48, 64];
