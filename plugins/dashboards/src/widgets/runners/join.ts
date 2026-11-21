/*
 * The model of the runner widget (`runners.overview`): the pools panel, the queue panel and the
 * optional `runs` panel of one runner source, joined in the browser. The pools give one ring each.
 * The `runs` panel gives the tree of running and queued workflow runs with their jobs and steps.
 * A source with no `runs` panel still works: the rows of the queue panel are the list, with no tree.
 */
import type {
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
  const status = worst([
    ...(input.pools ? [input.pools.status] : []),
    ...(input.queue ? [input.queue.status] : []),
  ]);
  const summary = input.pools?.summary || input.queue?.summary || '';
  return {
    pools,
    stats: [running, queued, free, poolCount, { ...oldest, label: 'Oldest wait' }],
    runs,
    tree: input.runs !== null,
    queue: queueRowsOf(input.queue),
    status,
    summary,
    link: input.pools?.link ?? input.queue?.link ?? '',
  };
}
