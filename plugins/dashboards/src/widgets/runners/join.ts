/*
 * The model of the runner widget (`runners.overview`): the pools panel, the queue panel and the
 * optional `runs` panel of one runner source, joined in the browser. The pools give one ring each.
 * The `runs` panel gives the tree of running and queued workflow runs with their jobs and steps.
 * A source with no `runs` panel still works: the rows of the queue panel are the list, with no tree.
 */
import type {
  JobCounts,
  PanelModel,
  PanelRun,
  PanelStatus,
  PanelStep,
  Stat,
  StepState,
} from '../panels/model';

export interface RunnerPool {
  name: string;
  running: number;
  queued: number;
  /** The slot cap of the pool. 0 when the source gave none. */
  cap: number;
  free: number;
  status: PanelStatus;
}

/** One row of the list that has no tree: a repository with queued jobs in one pool. */
export interface QueueRow {
  key: string;
  repo: string;
  pool: string;
  queued: number;
  oldest: string;
}

export interface RunnerModel {
  pools: RunnerPool[];
  stats: Stat[];
  /** The runs, running first (longest first), then queued (oldest first). Empty when the source has no `runs` panel. */
  runs: PanelRun[];
  /**
   * The jobs of the source that no listed run counts: the source cuts its run list at a fixed
   * length. 0 when every job is listed, or when the source gave no job totals.
   */
  unlisted: number;
  /** True when the source serves the `runs` panel, so the list is a tree. */
  tree: boolean;
  /** The list when there is no tree. */
  queue: QueueRow[];
  status: PanelStatus;
  summary: string;
  link: string;
}

const RANK: Record<PanelStatus, number> = { crit: 3, warn: 2, unknown: 1, ok: 0 };
const worst = (list: PanelStatus[]): PanelStatus =>
  list.reduce<PanelStatus>((a, s) => (RANK[s] > RANK[a] ? s : a), 'ok');

/** "4 running, 1 queued, 195 free" gives the three counts. A missing count is 0. */
export function countsOf(detail: string): { running: number; queued: number; free: number } {
  const get = (word: string): number => {
    const m = new RegExp(`(\\d+)\\s+${word}\\b`, 'i').exec(detail);
    return m ? Number(m[1]) : 0;
  };
  return { running: get('running'), queued: get('queued'), free: get('free') };
}

/** "4/200" gives 200. Anything else gives 0. */
export function capOf(value: string): number {
  const m = /^\s*\d+(?:\.\d+)?\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
  return m ? Number(m[1]) : 0;
}

export function poolsOf(panel: PanelModel | null | undefined): RunnerPool[] {
  return (panel?.rows ?? []).map(r => {
    const c = countsOf(r.detail);
    return { name: r.label, ...c, cap: capOf(r.value), status: r.status };
  });
}

export function queueRowsOf(panel: PanelModel | null | undefined): QueueRow[] {
  return (panel?.rows ?? []).map((r, i) => {
    const m = /^pool\s+(.+?),\s*(\d+)\s+queued$/i.exec(r.detail);
    return {
      key: `${r.label} ${m ? m[1] : ''} ${i}`,
      repo: r.label,
      pool: m ? m[1] : '',
      queued: m ? Number(m[2]) : 0,
      oldest: r.value,
    };
  });
}

/** Running runs first, the longest running first. Then queued runs, the longest waiting first. */
export function orderRuns(runs: ReadonlyArray<PanelRun>): PanelRun[] {
  const rank = (r: PanelRun): number => (r.state === 'running' ? 0 : 1);
  return runs
    .map((run, i) => ({ run, i }))
    .sort((a, b) => rank(a.run) - rank(b.run) || b.run.seconds - a.run.seconds || a.i - b.i)
    .map(e => e.run);
}

/** The org label of a run whose repo name has no "org/" part. */
export const NO_ORG = 'No org';

/** The name of the repo row of the runs whose repo the source does not know, only their owner. */
export const UNKNOWN_REPO = 'Repo not known';

/** One repo with its runs. The runs keep the order they came in. */
export interface RepoGroup {
  /** The org, then a slash, then the repo name. Unique in the list. */
  key: string;
  /** The repo name without the org. */
  name: string;
  runs: PanelRun[];
  /** Jobs that hold a slot: running, or assigned to a runner. */
  running: number;
  /** Jobs that wait for a runner. */
  queued: number;
  /** The longest time in seconds: how long a run has run, or how long it has waited. */
  longest: number;
}

/**
 * One org with its repos. `running` and `queued` count jobs, not runs. The sum over the orgs
 * equals the totals of the source, except for the jobs of the runs that the source did not list.
 */
export interface OrgGroup {
  key: string;
  name: string;
  repos: RepoGroup[];
  running: number;
  queued: number;
  longest: number;
}

/** "org/repo" gives the org and the repo name. Without a slash the org is `NO_ORG`. */
export function splitRepo(full: string): { org: string; name: string } {
  const at = full.indexOf('/');
  if (at <= 0 || at === full.length - 1) return { org: NO_ORG, name: full };
  return { org: full.slice(0, at), name: full.slice(at + 1) };
}

/**
 * The org and the repo name of a run. A run whose repo is not known has only its owner in `repo`:
 * it goes under that org, in a repo row that says the repo is not known.
 */
export function placeOf(run: Pick<PanelRun, 'repo' | 'repoKnown'>): { org: string; name: string } {
  if (run.repoKnown !== false) return splitRepo(run.repo);
  const at = run.repo.indexOf('/');
  const owner = at > 0 ? run.repo.slice(0, at) : run.repo;
  return { org: owner === '' ? NO_ORG : owner, name: UNKNOWN_REPO };
}

/**
 * The jobs of a run. A run from an older source has no counts: it counts as one job, running or
 * waiting, by the state of the run.
 */
export function jobCountsOf(run: PanelRun): JobCounts {
  if (run.counts) return run.counts;
  return run.state === 'running' ? { running: 1, queued: 0 } : { running: 0, queued: 1 };
}

interface Counted {
  running: number;
  queued: number;
  longest: number;
}

const tally = (runs: ReadonlyArray<PanelRun>): Counted => ({
  running: runs.reduce((n, r) => n + jobCountsOf(r).running, 0),
  queued: runs.reduce((n, r) => n + jobCountsOf(r).queued, 0),
  longest: runs.reduce((m, r) => Math.max(m, r.seconds), 0),
});

/** Most running first, then the longest time first. The sort is stable, so ties keep their place. */
const byBusy = (a: Counted, b: Counted): number => b.running - a.running || b.longest - a.longest;

/**
 * Groups runs by org, then by repo name. The counts are jobs, summed from the counts of each run.
 * Orgs and repos go by running count (most first), then by the longest time. Runs keep their order inside a repo. Every run is in exactly one group.
 */
export function groupRuns(runs: ReadonlyArray<PanelRun>): OrgGroup[] {
  const orgs = new Map<string, Map<string, PanelRun[]>>();
  for (const run of runs) {
    const { org, name } = placeOf(run);
    const repos = orgs.get(org) ?? new Map<string, PanelRun[]>();
    repos.set(name, [...(repos.get(name) ?? []), run]);
    orgs.set(org, repos);
  }
  return [...orgs.entries()]
    .map(([org, repos]): OrgGroup => {
      const list = [...repos.entries()]
        .map(
          ([name, own]): RepoGroup => ({ key: `${org}/${name}`, name, runs: own, ...tally(own) })
        )
        .sort(byBusy);
      const all = list.flatMap(r => r.runs);
      return { key: org, name: org, repos: list, ...tally(all) };
    })
    .sort(byBusy);
}

/** The steps of a run in job order. */
export const stepsOfRun = (run: PanelRun): PanelStep[] => run.jobs.flatMap(j => j.steps);

export interface StepProgress {
  /** The 1-based number of the current step. */
  n: number;
  total: number;
  /** The name of the current step. */
  name: string;
  state: StepState;
}

/**
 * Where a list of steps stands: the running step, else the first failed step, else the next
 * pending step. All steps done gives the last one. No steps gives null.
 */
export function progressOf(steps: ReadonlyArray<PanelStep>): StepProgress | null {
  if (steps.length === 0) return null;
  let at = steps.findIndex(s => s.state === 'running');
  if (at < 0) at = steps.findIndex(s => s.state === 'failed');
  if (at < 0) at = steps.findIndex(s => s.state === 'pending');
  if (at < 0) at = steps.length - 1;
  return { n: at + 1, total: steps.length, name: steps[at].name, state: steps[at].state };
}

/** The narrowest step segment in pixels, and the gap between two segments. */
export const STEP_MIN_SEGMENT = 4;
export const STEP_GAP = 1;
/** The bar width to assume before the first measurement. */
export const STEP_BAR_FALLBACK_WIDTH = 360;

/** The order of the groups in a continuous bar. */
export const STEP_GROUP_ORDER: StepState[] = ['done', 'failed', 'running', 'skipped', 'pending'];

export type StepBarLayout =
  | { mode: 'segments' }
  | { mode: 'continuous'; groups: { state: StepState; count: number }[] };

/**
 * How to draw the bar. Each step gets its own segment while every segment keeps the minimum
 * width. With more steps than that the bar is one continuous strip, split into one block for each
 * state in proportion to its step count. A width of zero or less means "not measured yet".
 */
export function stepBarLayout(steps: ReadonlyArray<PanelStep>, width: number): StepBarLayout {
  const room = width > 0 ? width : STEP_BAR_FALLBACK_WIDTH;
  const needed = steps.length * (STEP_MIN_SEGMENT + STEP_GAP) - STEP_GAP;
  if (needed <= room) return { mode: 'segments' };
  const groups = STEP_GROUP_ORDER.map(state => ({
    state,
    count: steps.filter(s => s.state === state).length,
  })).filter(g => g.count > 0);
  return { mode: 'continuous', groups };
}

/** A time in seconds as text: "45s", "2m 7s", "1h 5m". */
export function formatWait(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const stat = (label: string, value: string, status: PanelStatus = 'ok'): Stat => ({
  label,
  value,
  status,
});

export function joinRunners(input: {
  pools: PanelModel | null;
  queue: PanelModel | null;
  runs: PanelModel | null;
}): RunnerModel {
  const pools = poolsOf(input.pools);
  const queueStats = input.queue?.stats ?? [];
  const fromPools = (label: string): Stat | undefined =>
    input.pools?.stats.find(s => s.label.toLowerCase() === label);
  const sum = (pick: (p: RunnerPool) => number): number => pools.reduce((n, p) => n + pick(p), 0);
  const running = fromPools('running') ?? stat('Running', String(sum(p => p.running)));
  const queued = fromPools('queued') ?? stat('Queued', String(sum(p => p.queued)));
  const free = fromPools('free') ?? stat('Free', String(sum(p => p.free)));
  const poolCount = fromPools('pools') ?? stat('Pools', String(pools.length));
  const oldest =
    queueStats.find(s => s.label.toLowerCase() === 'oldest') ?? stat('Oldest wait', '-');
  const runs = input.runs ? orderRuns(input.runs.runs) : [];
  const totals = input.runs?.jobs;
  const listed = tally(runs);
  const unlisted = totals
    ? Math.max(0, totals.running - listed.running) + Math.max(0, totals.queued - listed.queued)
    : 0;
  const status = worst([
    ...(input.pools ? [input.pools.status] : []),
    ...(input.queue ? [input.queue.status] : []),
  ]);
  const summary = input.pools?.summary || input.queue?.summary || '';
  return {
    pools,
    stats: [running, queued, free, poolCount, { ...oldest, label: 'Oldest wait' }],
    runs,
    unlisted,
    tree: input.runs !== null,
    queue: queueRowsOf(input.queue),
    status,
    summary,
    link: input.pools?.link ?? input.queue?.link ?? '',
  };
}
