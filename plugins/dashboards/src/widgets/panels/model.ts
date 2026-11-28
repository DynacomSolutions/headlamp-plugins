/*
 * The panel model (version 1) that a panel source serves on `GET /api/widgets/<id>`. The agent
 * layer is one source, and external apps may serve the same API. The parsers are strict about the
 * shape (a wrong shape or version is an error) and forgiving about extra fields: unknown fields
 * are ignored, a bad value is dropped or replaced by a default, and the widget never throws on
 * bad data. The types match `agent/src/widgets.ts`, plus the optional `tables` field.
 */
import type { SunburstCategory, SunburstData, SunburstGroupBy } from '../sunburst/geometry';

export type PanelStatus = 'ok' | 'warn' | 'crit' | 'unknown';

export interface Stat {
  label: string;
  value: string;
  status: PanelStatus;
}

/** The icon of a row. `src` is a safe relative path (see `safeIconPath`); `alt` is the engine kind. */
export interface PanelRowIcon {
  src: string;
  alt: string;
}

/** One account that an agent session used, with its turns and its tokens by type. */
export interface PanelAgentAccount {
  identity: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** ISO times as the source wrote them. Empty when absent. */
  firstSeen: string;
  lastSeen: string;
}

/**
 * The agent fields of a row of the AIS `agents` panel. They are an optional v1 extension: only a row
 * that carries them has this field. `pool` is null for a direct login. `identity` is the real login.
 * `activeIdentity` is the account of the latest request of the session. It wins over `identity`.
 * `identities` lists each account that the session used.
 */
export interface PanelAgentFields {
  pool: string | null;
  identity: string | null;
  identitySource: string;
  sessionIdentity: string | null;
  activeIdentity: string | null;
  identities: PanelAgentAccount[];
}

/** The live count of a row of the HoardDB `engines` panel, for example 14 "databases". */
export interface PanelRowCount {
  value: number;
  unit: string;
}

/** The role of an instance in the HoardDB `engines` panel. */
export type PanelInstanceRole = 'primary' | 'standby' | 'replica' | 'single' | 'unknown';

/** One instance of an engine, from the `instances` field of a row of the HoardDB `engines` panel. */
export interface PanelRowInstance {
  name: string;
  node: string;
  role: PanelInstanceRole;
  status: PanelStatus;
  /** Only present when the status is not ok. */
  reason?: string;
}

export interface PanelRow {
  label: string;
  detail: string;
  value: string;
  /** Between 0 and 1. */
  fraction?: number;
  status: PanelStatus;
  link?: string;
  /**
   * An optional v1 extension (also in `agent/src/widgets.ts`). `src` is relative to the source's
   * `/api/widgets/` base, for example `icons/postgresql.svg`. A bad value drops the icon, never the row.
   */
  icon?: PanelRowIcon;
  /** An optional v1 extension: the live count of a HoardDB engine row. Absent when the service does not answer. */
  count?: PanelRowCount;
  /** An optional v1 extension: the instances of a HoardDB engine row, one ring segment for each. */
  instances?: PanelRowInstance[];
  /**
   * An optional v1 extension: named text fields for a widget that joins several panels (the alerts
   * and incidents widget). Only string values are kept, a bad entry is dropped, never the row.
   */
  meta?: Record<string, string>;
  /** The pool, identity and accounts of an agent row. Absent from an older source. */
  agent?: PanelAgentFields;
}

export interface PanelSeries {
  label: string;
  points: number[];
  /**
   * An optional v1 extension: the value that the series must stay under (for example 5 for a lag
   * of 5 seconds). The plot draws it as a dashed line. A bad value drops the line, never the series.
   */
  limit?: number;
  /** An optional v1 extension: the unit of the values, for the axis (for example `s`). */
  unit?: string;
}

export interface RingSegment {
  key: string;
  label: string;
  value: number;
  children?: RingSegment[];
}

/** One node of a ring: its own capacity and use, and its categories with their children. */
export interface RingNode {
  key: string;
  label: string;
  capacity: number;
  used: number;
  segments: RingSegment[];
}

export interface PanelRing {
  id: string;
  label: string;
  unit: 'cores' | 'bytes' | string;
  capacity: number;
  used: number;
  segments: RingSegment[];
  /** The same data split by node first. Absent from an older agent. */
  nodes?: RingNode[];
}

export interface PanelTableColumn {
  key: string;
  label: string;
  align: 'left' | 'right';
}

/** An optional v1 extension: a titled table with its own columns. */
export interface PanelTable {
  title: string;
  columns: PanelTableColumn[];
  rows: Array<Record<string, string | number>>;
}

export type RunState = 'running' | 'queued';
export type StepState = 'done' | 'running' | 'failed' | 'skipped' | 'pending';
const RUN_STATES: RunState[] = ['running', 'queued'];
const STEP_STATES: StepState[] = ['done', 'running', 'failed', 'skipped', 'pending'];

/** Where a job stands: on a runner, assigned to a runner that has not started it, or waiting. */
export type JobPhase = 'running' | 'assigned' | 'queued';
const JOB_PHASES: JobPhase[] = ['running', 'assigned', 'queued'];

/** A count of jobs. `running` includes the jobs that are assigned to a runner. */
export interface JobCounts {
  running: number;
  queued: number;
}

export interface PanelStep {
  name: string;
  state: StepState;
}

/** One job of a workflow run, with its steps in order. */
export interface PanelJob {
  id: string;
  name: string;
  state: RunState;
  /** `assigned` counts as running in the job counts, while `state` is still `queued`. */
  phase: JobPhase;
  pool: string;
  /** Seconds the job has run (running) or waited (queued). */
  seconds: number;
  /** True when the job ran, or runs, on a GitHub-hosted runner. A source may not report it. */
  hosted?: boolean;
  /** The node that runs the job. A source may not report it yet. */
  node?: string;
  /** Seconds the job waited for a runner, when the source reports it apart from `seconds`. */
  waitedSeconds?: number;
  /** Seconds the job has run, when the source reports it apart from `seconds`. */
  runningSeconds?: number;
  steps: PanelStep[];
}

/**
 * An optional v1 extension: one workflow run that is running or queued, with its jobs and their
 * steps. A source serves it in a panel with the id `runs`.
 */
export interface PanelRun {
  id: string;
  /** `owner/repo`. Only the owner when `repoKnown` is false. */
  repo: string;
  /** False when the source knows only the owner of the run, not its repository. */
  repoKnown: boolean;
  workflow: string;
  /** The branch or pull request of the run. */
  ref: string;
  /** The number of the pull request, when the run belongs to one. */
  pr?: number;
  pool: string;
  state: RunState;
  /** Seconds the run has run (running) or waited (queued). */
  seconds: number;
  link?: string;
  /**
   * The jobs of this run, counted before the source cut the list of jobs. Missing in the data of
   * an older source.
   */
  counts?: JobCounts;
  jobs: PanelJob[];
}

/**
 * One repository of an optional `repos` panel: every repository that the source knows, also when
 * it has no running or queued job.
 */
export interface PanelRepo {
  /** `owner/repo`. */
  repo: string;
  /** When the last run of the repository started, as an RFC 3339 time. */
  lastRunAt?: string;
  /** The result of the last run, for example `success` or `failure`. */
  lastConclusion?: string;
  /** True when every recent job of the repository ran on GitHub-hosted runners. */
  hosted?: boolean;
}

export interface PanelModel {
  id: string;
  title: string;
  generatedAt: string;
  link: string;
  status: PanelStatus;
  summary: string;
  stats: Stat[];
  rows: PanelRow[];
  series: PanelSeries[];
  rings: PanelRing[];
  tables: PanelTable[];
  runs: PanelRun[];
  /** The repositories of the optional `repos` panel. Missing when the source has none. */
  repos?: PanelRepo[];
  /**
   * The totals of all jobs of the source, counted before the source cut the list of runs. Missing
   * in the data of an older source.
   */
  jobs?: JobCounts;
}

export interface PanelInfo {
  id: string;
  title: string;
  description: string;
  plugin: string;
  link: string;
  refreshSeconds: number;
}

const STATUSES: PanelStatus[] = ['ok', 'warn', 'crit', 'unknown'];
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const status = (v: unknown): PanelStatus =>
  STATUSES.includes(v as PanelStatus) ? (v as PanelStatus) : 'unknown';
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Only web and path links open from a panel. Anything else (javascript:, data:) is dropped. */
export function safeLink(href: unknown): string | undefined {
  if (typeof href !== 'string') return undefined;
  const v = href.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('/') && !v.startsWith('//')) return v;
  return undefined;
}

const ICON_PATH_MAX = 200;
const ICON_ALT_MAX = 80;
const ICON_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * An icon path is safe when it is relative to the source's `/api/widgets/` base: no scheme, no
 * leading slash, no backslash, no empty, `.` or `..` segment, no query or fragment, only URL-safe
 * characters, a `.svg` or `.png` ending and a limited length. Anything else gives undefined.
 */
export function safeIconPath(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const path = v.trim();
  if (path === '' || path.length > ICON_PATH_MAX) return undefined;
  if (!/\.(svg|png)$/i.test(path)) return undefined;
  const segments = path.split('/');
  const ok = segments.every(seg => seg !== '.' && seg !== '..' && ICON_SEGMENT.test(seg));
  return ok ? path : undefined;
}

/** The icon of a row, or undefined for a missing or unsafe one. `alt` defaults to the row label. */
export function parseRowIcon(raw: unknown, label: string): PanelRowIcon | undefined {
  if (!isObject(raw)) return undefined;
  const src = safeIconPath(raw.src);
  if (src === undefined) return undefined;
  const alt = str(raw.alt).trim().slice(0, ICON_ALT_MAX);
  return { src, alt: alt === '' ? label : alt };
}

const COUNT_UNIT_MAX = 24;

/** The count of a row. A bad value (no finite non-negative number, no unit) gives undefined. */
export function parseRowCount(raw: unknown): PanelRowCount | undefined {
  if (!isObject(raw)) return undefined;
  const value = raw.value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const unit = str(raw.unit).trim().slice(0, COUNT_UNIT_MAX);
  return unit === '' ? undefined : { value, unit };
}

const INSTANCE_ROLES: PanelInstanceRole[] = ['primary', 'standby', 'replica', 'single', 'unknown'];
const INSTANCE_REASON_MAX = 240;
/** The source writes `warning` and `critical` for an instance. The short forms are also read. */
const instanceStatus = (v: unknown): PanelStatus =>
  v === 'warning' ? 'warn' : v === 'critical' ? 'crit' : status(v);

/**
 * The instances of a row. An entry with no name is dropped, a bad role or status becomes "unknown".
 * With no list, or no valid entry, the result is undefined and the widget uses the old text join.
 */
export function parseRowInstances(raw: unknown): PanelRowInstance[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PanelRowInstance[] = [];
  for (const r of raw) {
    if (!isObject(r)) continue;
    const name = str(r.name).trim();
    if (name === '') continue;
    const role = INSTANCE_ROLES.includes(r.role as PanelInstanceRole)
      ? (r.role as PanelInstanceRole)
      : 'unknown';
    const item: PanelRowInstance = {
      name,
      node: str(r.node).trim(),
      role,
      status: instanceStatus(r.status),
    };
    const reason = str(r.reason).trim().slice(0, INSTANCE_REASON_MAX);
    if (reason !== '') item.reason = reason;
    out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

const META_KEY = /^[a-z][A-Za-z0-9_]{0,23}$/;
const META_MAX_KEYS = 16;
const META_MAX_VALUE = 240;

/** The meta fields of a row: string values under safe keys, in a limited number and length. */
export function parseMeta(raw: unknown): Record<string, string> | undefined {
  if (!isObject(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= META_MAX_KEYS) break;
    if (META_KEY.test(k) && typeof v === 'string') out[k] = v.slice(0, META_MAX_VALUE);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const nonEmpty = (v: unknown): string | null => {
  const t = str(v).trim();
  return t === '' ? null : t;
};
const count = (v: unknown): number => Math.max(0, num(v));

function parseAccount(raw: unknown): PanelAgentAccount | null {
  if (!isObject(raw)) return null;
  const identity = nonEmpty(raw.identity);
  if (identity === null) return null;
  return {
    identity,
    turns: count(raw.turns),
    inputTokens: count(raw.inputTokens),
    outputTokens: count(raw.outputTokens),
    cacheReadTokens: count(raw.cacheReadTokens),
    cacheWriteTokens: count(raw.cacheWriteTokens),
    firstSeen: str(raw.firstSeen, str(raw.firstTs)),
    lastSeen: str(raw.lastSeen, str(raw.lastTs)),
  };
}

/**
 * The agent fields of a row, or undefined for a row that has none (an older source, or another
 * panel). A bad `identities` entry is dropped, never the row.
 */
export function parseAgentFields(r: Record<string, unknown>): PanelAgentFields | undefined {
  const has =
    'identitySource' in r ||
    'activeIdentity' in r ||
    'identities' in r ||
    ('pool' in r && 'identity' in r);
  if (!has) return undefined;
  return {
    pool: nonEmpty(r.pool),
    identity: nonEmpty(r.identity),
    identitySource: str(r.identitySource).trim(),
    sessionIdentity: nonEmpty(r.sessionIdentity),
    activeIdentity: nonEmpty(r.activeIdentity),
    identities: array(r.identities)
      .map(parseAccount)
      .filter((a): a is PanelAgentAccount => a !== null),
  };
}

function parseSegment(raw: unknown, depth: number): RingSegment | null {
  if (!isObject(raw)) return null;
  const key = str(raw.key);
  const value = num(raw.value);
  if (key === '' || value <= 0) return null;
  const seg: RingSegment = { key, label: str(raw.label, key), value };
  if (depth === 0) {
    const kids = array(raw.children)
      .map(c => parseSegment(c, 1))
      .filter((c): c is RingSegment => c !== null);
    if (kids.length > 0) seg.children = kids;
  }
  return seg;
}

function parseSegments(raw: unknown): RingSegment[] {
  return array(raw)
    .map(s => parseSegment(s, 0))
    .filter((s): s is RingSegment => s !== null);
}

function parseNode(raw: unknown): RingNode | null {
  if (!isObject(raw)) return null;
  const key = str(raw.key);
  if (key === '') return null;
  return {
    key,
    label: str(raw.label, key),
    capacity: Math.max(0, num(raw.capacity)),
    used: Math.max(0, num(raw.used)),
    segments: parseSegments(raw.segments),
  };
}

function parseRing(raw: unknown): PanelRing | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  if (id === '') return null;
  const nodes = array(raw.nodes)
    .map(parseNode)
    .filter((n): n is RingNode => n !== null);
  return {
    id,
    label: str(raw.label, id),
    unit: str(raw.unit, 'bytes'),
    capacity: Math.max(0, num(raw.capacity)),
    used: Math.max(0, num(raw.used)),
    segments: parseSegments(raw.segments),
    ...(nodes.length > 0 ? { nodes } : {}),
  };
}

const oneOf = <T extends string>(v: unknown, list: ReadonlyArray<T>, fallback: T): T =>
  list.includes(v as T) ? (v as T) : fallback;
const seconds = (v: unknown): number => Math.max(0, num(v));

/** A pair of job counts, or undefined when the value is not a pair of non-negative numbers. */
function parseJobCounts(raw: unknown): JobCounts | undefined {
  if (!isObject(raw)) return undefined;
  const count = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  const running = count(raw.running);
  const queued = count(raw.queued);
  return running === undefined || queued === undefined ? undefined : { running, queued };
}

/** A non-negative finite number, or undefined for any other value. */
const optSeconds = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/** A positive whole number, or undefined for any other value. */
const optCount = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

function parseJob(raw: unknown): PanelJob | null {
  if (!isObject(raw)) return null;
  const name = str(raw.name);
  if (name === '') return null;
  const state = oneOf(raw.state, RUN_STATES, 'running');
  const node = typeof raw.node === 'string' && raw.node.trim() !== '' ? raw.node : undefined;
  const hosted = typeof raw.hosted === 'boolean' ? raw.hosted : undefined;
  const waitedSeconds = optSeconds(raw.waitedSeconds);
  const runningSeconds = optSeconds(raw.runningSeconds);
  return {
    id: str(raw.id, name),
    name,
    state,
    phase: oneOf(raw.phase, JOB_PHASES, state),
    pool: str(raw.pool),
    seconds: seconds(raw.seconds),
    ...(hosted !== undefined ? { hosted } : {}),
    ...(node !== undefined ? { node } : {}),
    ...(waitedSeconds !== undefined ? { waitedSeconds } : {}),
    ...(runningSeconds !== undefined ? { runningSeconds } : {}),
    steps: array(raw.steps)
      .filter(isObject)
      .map(s => ({ name: str(s.name), state: oneOf(s.state, STEP_STATES, 'pending') })),
  };
}

function parseRun(raw: unknown): PanelRun | null {
  if (!isObject(raw)) return null;
  const repo = str(raw.repo);
  if (repo === '') return null;
  const workflow = str(raw.workflow);
  const ref = str(raw.ref);
  const counts = parseJobCounts(raw.counts);
  const pr = optCount(raw.pr);
  return {
    id: str(raw.id, `${repo} ${workflow} ${ref}`),
    repo,
    repoKnown: raw.repoKnown !== false,
    workflow,
    ref,
    ...(pr !== undefined ? { pr } : {}),
    pool: str(raw.pool),
    state: oneOf(raw.state, RUN_STATES, 'queued'),
    seconds: seconds(raw.seconds),
    link: safeLink(raw.link),
    ...(counts ? { counts } : {}),
    jobs: array(raw.jobs)
      .map(parseJob)
      .filter((j): j is PanelJob => j !== null),
  };
}

/** A repo of the `repos` panel. A bad time or a wrong type is left out, and a missing name drops the entry. */
function parseRepo(raw: unknown): PanelRepo | null {
  if (!isObject(raw)) return null;
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : '';
  if (repo === '') return null;
  const at = typeof raw.lastRunAt === 'string' ? raw.lastRunAt : '';
  const lastRunAt = at !== '' && Number.isFinite(Date.parse(at)) ? at : undefined;
  const lastConclusion =
    typeof raw.lastConclusion === 'string' && raw.lastConclusion !== ''
      ? raw.lastConclusion
      : undefined;
  const hosted = typeof raw.hosted === 'boolean' ? raw.hosted : undefined;
  return {
    repo,
    ...(lastRunAt !== undefined ? { lastRunAt } : {}),
    ...(lastConclusion !== undefined ? { lastConclusion } : {}),
    ...(hosted !== undefined ? { hosted } : {}),
  };
}

function parseTable(raw: unknown): PanelTable | null {
  if (!isObject(raw)) return null;
  const columns = array(raw.columns)
    .filter(isObject)
    .map(c => ({
      key: str(c.key),
      label: str(c.label, str(c.key)),
      align: c.align === 'right' ? ('right' as const) : ('left' as const),
    }))
    .filter(c => c.key !== '');
  if (columns.length === 0) return null;
  const rows = array(raw.rows)
    .filter(isObject)
    .map(r => {
      const row: Record<string, string | number> = {};
      for (const c of columns) {
        const v = r[c.key];
        row[c.key] = typeof v === 'number' && Number.isFinite(v) ? v : str(v);
      }
      return row;
    });
  return { title: str(raw.title), columns, rows };
}

/**
 * The version check of a response. Only version 1 is known. Throws a short message for anything else,
 * so the widget shows a clear error card for an app that does not serve the panel API.
 */
function checkVersion(json: Record<string, unknown>, what: string): void {
  if (json.version === undefined)
    throw new Error(`The source sent ${what} with no version. Expected version 1.`);
  if (json.version !== 1)
    throw new Error(
      `The source sent ${what} with version ${str(json.version, '?')}. Only version 1 is supported.`
    );
}

/** A panel from the JSON a source served. Throws an error with a short message when it is not a panel. */
export function parsePanel(json: unknown): PanelModel {
  if (!isObject(json)) throw new Error('The source sent an answer that is not a panel.');
  checkVersion(json, 'a panel');
  const id = str(json.id);
  if (id === '') throw new Error('The source sent a panel with no id.');
  const jobs = parseJobCounts(json.jobs);
  const repos = Array.isArray(json.repos)
    ? json.repos.map(parseRepo).filter((r): r is PanelRepo => r !== null)
    : undefined;
  return {
    id,
    title: str(json.title, id),
    generatedAt: str(json.generatedAt),
    link: str(json.link),
    status: status(json.status),
    summary: str(json.summary),
    stats: array(json.stats)
      .filter(isObject)
      .map(s => ({ label: str(s.label), value: str(s.value), status: status(s.status) })),
    rows: array(json.rows)
      .filter(isObject)
      .map(r => {
        const fraction =
          typeof r.fraction === 'number' && Number.isFinite(r.fraction)
            ? Math.min(1, Math.max(0, r.fraction))
            : undefined;
        const label = str(r.label);
        return {
          label,
          detail: str(r.detail),
          value: str(r.value),
          fraction,
          status: status(r.status),
          link: safeLink(r.link),
          icon: parseRowIcon(r.icon, label),
          count: parseRowCount(r.count),
          instances: parseRowInstances(r.instances),
          meta: parseMeta(r.meta),
          agent: parseAgentFields(r),
        };
      }),
    series: array(json.series)
      .filter(isObject)
      .map(s => {
        const series: PanelSeries = {
          label: str(s.label),
          points: array(s.points).filter(
            (p): p is number => typeof p === 'number' && Number.isFinite(p)
          ),
        };
        if (typeof s.limit === 'number' && Number.isFinite(s.limit) && s.limit > 0)
          series.limit = s.limit;
        const unit = str(s.unit).trim().slice(0, 8);
        if (unit !== '') series.unit = unit;
        return series;
      }),
    rings: array(json.rings)
      .map(parseRing)
      .filter((r): r is PanelRing => r !== null),
    tables: array(json.tables)
      .map(parseTable)
      .filter((t): t is PanelTable => t !== null),
    runs: array(json.runs)
      .map(parseRun)
      .filter((r): r is PanelRun => r !== null),
    ...(repos ? { repos } : {}),
    ...(jobs ? { jobs } : {}),
  };
}

/** The panel list from `GET /api/widgets`: `{ version: 1, panels: [...] }`. Throws a short message for any other shape. */
export function parsePanelList(json: unknown): PanelInfo[] {
  if (!isObject(json)) throw new Error('The source sent an answer that is not a panel list.');
  checkVersion(json, 'a panel list');
  if (!Array.isArray(json.panels))
    throw new Error('The source sent a panel list with no panels field.');
  return json.panels
    .filter(isObject)
    .map(p => ({
      id: str(p.id),
      title: str(p.title, str(p.id)),
      description: str(p.description),
      plugin: str(p.plugin),
      link: str(p.link),
      refreshSeconds: Math.max(0, num(p.refreshSeconds)),
    }))
    .filter(p => p.id !== '');
}

/** A panel is empty when it shows nothing at all. */
export const isEmptyPanel = (p: PanelModel): boolean =>
  p.stats.length === 0 &&
  p.rows.length === 0 &&
  p.series.every(s => s.points.length === 0) &&
  p.rings.every(r => r.segments.length === 0) &&
  p.tables.every(t => t.rows.length === 0) &&
  p.runs.length === 0 &&
  (p.repos?.length ?? 0) === 0 &&
  p.summary === '';

/** A ring as sunburst data. Every segment stays its own arc: nothing is merged or cut. */
export function ringToSunburst(
  ring: PanelRing,
  options: { groupBy?: SunburstGroupBy } = {}
): SunburstData {
  const nodes =
    options.groupBy === 'node' && ring.nodes && ring.nodes.length > 0
      ? ring.nodes.map(n => ({
          key: n.key,
          label: n.label,
          capacity: n.capacity,
          used: n.used,
          categories: n.segments.map(s => ({
            key: s.key,
            label: s.label,
            value: s.value,
            children: (s.children ?? []).map(c => ({ key: c.key, label: c.label, value: c.value })),
          })),
        }))
      : undefined;
  const categories: SunburstCategory[] = ring.segments.map(s => ({
    key: s.key,
    label: s.label,
    value: s.value,
    children: (s.children ?? []).map(c => ({ key: c.key, label: c.label, value: c.value })),
  }));
  return { capacity: ring.capacity, categories, ...(nodes ? { nodes } : {}) };
}

/**
 * Whether a refresh signal may fetch now. The panel's own `refreshSeconds` is the smallest
 * time between two fetches, so a short dashboard interval never polls a panel faster than
 * the panel allows. The first fetch always runs.
 */
export function mayFetch(lastFetchAt: number | null, now: number, minSeconds: number): boolean {
  if (lastFetchAt === null) return true;
  return now - lastFetchAt >= Math.max(0, minSeconds) * 1000;
}

export type SortDir = 'asc' | 'desc';

/** The rows of a table sorted by one column. Numbers sort as numbers and text sorts naturally. The input is not changed. */
export function sortTableRows(
  rows: PanelTable['rows'],
  key: string,
  dir: SortDir
): PanelTable['rows'] {
  const sign = dir === 'asc' ? 1 : -1;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const x = a.row[key];
      const y = b.row[key];
      const c =
        typeof x === 'number' && typeof y === 'number'
          ? x - y
          : collator.compare(String(x ?? ''), String(y ?? ''));
      // The original order breaks ties, so the sort is stable in both directions.
      return c === 0 ? a.index - b.index : sign * c;
    })
    .map(e => e.row);
}
