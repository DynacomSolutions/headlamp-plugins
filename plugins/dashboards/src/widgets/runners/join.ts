/*
 * The model of the runner widget (`runners.overview`): the pools panel, the queue panel and the
 * optional `runs` panel of one runner source, joined in the browser. The pools give one ring each.
 * The `runs` panel gives the tree of running and queued workflow runs: repository, then branch or
 * pull request, then workflow, then job (the steps of a job are one level more). The Running and
 * Queued tiles and the summary come from the `runs` panel (`jobs`), the same snapshot as the repo
 * rows. The pools panel is a separate request and can be from another
 * moment, so it only gives the rings, Free and Pools, unless the `runs` panel has no `jobs`.
 * A source with no `runs` panel still works: the rows of the queue panel are the list, with no tree.
 */
import type {
  JobCounts,
  PanelJob,
  PanelModel,
  PanelRepo,
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

/** One node of the optional `nodes` panel, with the CPU figure that the source measured. */
export interface RunnerNode {
  name: string;
  /** Busy cores and allocatable cores; null when the source gave no figure that we can read. */
  busy: number | null;
  allocatable: number | null;
  /** Where the figure comes from, for example "metrics-server". Empty when not given. */
  source: string;
  /** The sample window as the source wrote it, for example "10s". Empty when not given. */
  window: string;
  /** The row detail text. It shows when the figure cannot be read. */
  detail: string;
}

export interface RunnerModel {
  pools: RunnerPool[];
  /** The nodes of the optional `nodes` panel, most busy first. Empty when the source has none. */
  nodes: RunnerNode[];
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
  /** The names of the rows of the pools panel. A job on another pool is on a GitHub-hosted runner. */
  poolNames: string[];
  /** The repos of the optional `repos` panel, or null when the source has none. */
  repos: PanelRepo[] | null;
  /** The list when there is no tree. */
  queue: QueueRow[];
  status: PanelStatus;
  summary: string;
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

const cores = (text: string | undefined): number | null => {
  if (text === undefined || !/^\s*\d+(?:\.\d+)?\s*$/.test(text)) return null;
  return Number(text);
};

/** "CPU busy 37.9/62.0 cores" gives both numbers. Case, spacing and the word "cores" are loose. */
export function cpuFromDetail(detail: string): { busy: number; allocatable: number } | null {
  const m = /cpu\s+busy\s+(\d+(?:\.\d+)?)\s*(?:\/|of)\s*(\d+(?:\.\d+)?)/i.exec(detail);
  return m ? { busy: Number(m[1]), allocatable: Number(m[2]) } : null;
}

/** The share of allocatable that is busy, or null when it cannot be worked out. */
export function busyShare(n: Pick<RunnerNode, 'busy' | 'allocatable'>): number | null {
  return n.busy !== null && n.allocatable !== null && n.allocatable > 0
    ? n.busy / n.allocatable
    : null;
}

/**
 * The rows of the `nodes` panel: one node each, the row label is the node name. The row `meta`
 * keys `cpuBusy`, `cpuAllocatable`, `cpuSource` and `cpuWindow` win. A key that is missing or not
 * a number falls back to the row detail text "CPU busy 37.9/62.0 cores". Most busy first; a node
 * with no readable figure comes last, by name.
 */
export function nodesOf(panel: PanelModel | null | undefined): RunnerNode[] {
  const nodes = (panel?.rows ?? []).map<RunnerNode>(r => {
    const fromText = cpuFromDetail(r.detail);
    return {
      name: r.label,
      busy: cores(r.meta?.cpuBusy) ?? fromText?.busy ?? null,
      allocatable: cores(r.meta?.cpuAllocatable) ?? fromText?.allocatable ?? null,
      source: (r.meta?.cpuSource ?? '').trim(),
      window: (r.meta?.cpuWindow ?? '').trim(),
      detail: r.detail,
    };
  });
  return nodes.sort((a, b) => {
    const x = busyShare(a);
    const y = busyShare(b);
    if (x === null || y === null)
      return x === y ? a.name.localeCompare(b.name) : x === null ? 1 : -1;
    return y - x || a.name.localeCompare(b.name);
  });
}

/** "10s" as "10 s", "1m" as "1 min". Text that is not a plain window stays as it is. */
export function windowText(window: string): string {
  const m = /^(\d+)\s*(s|m|h)$/.exec(window);
  return m ? `${m[1]} ${m[2] === 'm' ? 'min' : m[2]}` : window;
}

/** The name that the label has when the runner source has no title. */
export const DEFAULT_SOURCE_TITLE = 'Runner source';

/**
 * "My runners, metrics-server, 10 s sample": the title of the runner source, then what the source
 * gave. The title is the one the panel source has in the dashboard settings. It names only what
 * the source gave: no window means no "sample" part.
 */
export function nodeSourceLabel(n: Pick<RunnerNode, 'source' | 'window'>, title?: string): string {
  return [
    title?.trim() || DEFAULT_SOURCE_TITLE,
    n.source,
    n.window ? `${windowText(n.window)} sample` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** "37.9 of 62.0 cores busy", or the row detail text when the figure cannot be read. */
export function nodeBusyText(n: RunnerNode): string {
  if (n.busy === null || n.allocatable === null) return n.detail;
  return `${n.busy.toFixed(1)} of ${n.allocatable.toFixed(1)} cores busy`;
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

/** The row label of a ref that has no name. */
export const NO_BRANCH = 'No branch';

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

/** What every level of the tree shows: the job counts and the longest time in seconds. */
export interface Counted {
  /** Jobs that hold a slot: running, or assigned to a runner. */
  running: number;
  /** Jobs that wait for a runner. */
  queued: number;
  /** The longest time in seconds: how long a run has run, or how long it has waited. */
  longest: number;
}

/** One job of the tree, with the run that holds it. */
export interface JobEntry {
  key: string;
  job: PanelJob;
  run: PanelRun;
  /** True when the job ran on a GitHub-hosted runner. */
  hosted: boolean;
}

/** One workflow under one ref. Its runs share the workflow name. */
export interface WorkflowNode extends Counted {
  key: string;
  name: string;
  runs: PanelRun[];
  /** The visible jobs of all runs of the workflow, run by run. */
  jobs: JobEntry[];
  /** True when every job of the workflow is GitHub-hosted. */
  hosted: boolean;
}

/** One branch or pull request of a repo. */
export interface RefNode extends Counted {
  key: string;
  /** The branch name or the ref text of the source. Empty when the source gave none. */
  name: string;
  /** The pull request number, when a run of the ref has one. */
  pr?: number;
  workflows: WorkflowNode[];
  /** True when every job of the ref is GitHub-hosted. */
  hosted: boolean;
}

/** One repo. The label is `owner/repo`, or the owner and `UNKNOWN_REPO`. */
export interface RepoNode extends Counted {
  key: string;
  name: string;
  /** The org and the repo name, for the icon lookup. */
  org: string;
  short: string;
  refs: RefNode[];
  /** True when every job of the repo is GitHub-hosted. */
  hosted: boolean;
  /** True when no job of the repo is listed: the row has no children. It may still show a queued count. */
  idle: boolean;
  /** When the last run of the repo started (RFC 3339), from the `repos` panel. */
  lastRunAt?: string;
  /** The result of the last run, from the `repos` panel. */
  lastConclusion?: string;
}

/** The text of a key part. A comma and a bar never stay in it, so a key holds no list separator. */
const escPart = (s: string): string => s.replace(/[%,|]/g, c => `%${c.charCodeAt(0).toString(16)}`);

/**
 * The stable key of a tree node: its level, then the names that lead to it, joined with a bar.
 * The key depends only on the data (repo, ref, workflow, run id, job id), so it stays the same
 * when the list is fetched again. A key holds no comma.
 */
export function nodeKey(level: 'r' | 'b' | 'w' | 'j', ...parts: ReadonlyArray<string>): string {
  return [level, ...parts.map(escPart)].join('|');
}

const tally = (runs: ReadonlyArray<PanelRun>): Counted => ({
  running: runs.reduce((n, r) => n + jobCountsOf(r).running, 0),
  queued: runs.reduce((n, r) => n + jobCountsOf(r).queued, 0),
  longest: runs.reduce((m, r) => Math.max(m, r.seconds), 0),
});

/** Most running first, then the longest time first. The sort is stable, so ties keep their place. */
const byBusy = (a: Counted, b: Counted): number => b.running - a.running || b.longest - a.longest;
/** The longest time first. The sort is stable. */
const byLongest = (a: Counted, b: Counted): number => b.longest - a.longest;

/** The text of the repo row for a run: `owner/repo`, or the owner and `UNKNOWN_REPO`. */
export function repoLabelOf(run: Pick<PanelRun, 'repo' | 'repoKnown'>): string {
  if (run.repoKnown !== false) return run.repo;
  const { org, name } = placeOf(run);
  return `${org}/${name}`;
}

/** The runs in the order they came in, grouped by the value that `pick` gives. */
function groupBy<T>(items: ReadonlyArray<T>, pick: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = pick(item);
    out.set(k, [...(out.get(k) ?? []), item]);
  }
  return out;
}

/**
 * The name of the workflow row of a run: its workflow, or its id when the source gave no workflow
 * name, so a run with no name never merges with another.
 */
export const workflowNameOf = (run: Pick<PanelRun, 'workflow' | 'id'>): string =>
  run.workflow || run.id;

/** True when a pool is not one of the pools of the source: the job ran on a GitHub-hosted runner. */
export function isHostedPool(pool: string, pools: ReadonlySet<string>): boolean {
  return pool === '' || (pools.size > 0 && !pools.has(pool));
}

/**
 * True when a job ran on a GitHub-hosted runner: the source says so (`hosted`), or else its pool is
 * empty or is not the name of a pool of the source.
 */
export function isHostedJob(
  job: Pick<PanelJob, 'hosted' | 'pool'>,
  pools: ReadonlySet<string>
): boolean {
  return job.hosted !== undefined ? job.hosted : isHostedPool(job.pool, pools);
}

/** True when every job of the run is GitHub-hosted. A run with no listed job goes by its pool. */
export function isHostedRun(run: PanelRun, pools: ReadonlySet<string>): boolean {
  return run.jobs.length > 0
    ? run.jobs.every(j => isHostedJob(j, pools))
    : isHostedPool(run.pool, pools);
}

/**
 * The job counts of a run for the rows. A run that lists hosted jobs, when they are hidden, counts
 * only its visible listed jobs. Any other run keeps the counts of the source.
 */
function visibleCountsOf(
  run: PanelRun,
  pools: ReadonlySet<string>,
  showHosted: boolean
): JobCounts {
  if (showHosted || !run.jobs.some(j => isHostedJob(j, pools))) return jobCountsOf(run);
  const visible = run.jobs.filter(j => !isHostedJob(j, pools));
  const queued = visible.filter(j => j.phase === 'queued').length;
  return { running: visible.length - queued, queued };
}

/** What the tree builder needs besides the runs. */
export interface TreeOptions {
  /** Show GitHub-hosted jobs. Default: hide them. */
  showHosted?: boolean;
  /** The names of the pools of the source. */
  pools?: ReadonlySet<string>;
  /** The repos of the `repos` panel. They add the idle repos. */
  repos?: ReadonlyArray<PanelRepo> | null;
  /** The queue rows. A repo that is only here is listed with its queued count. */
  queue?: ReadonlyArray<QueueRow>;
}

/** Newest first. A missing or bad time goes last. */
const atOf = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * Groups runs into the tree repo, ref (branch or pull request), workflow, job. The counts are jobs.
 * GitHub-hosted jobs are hidden unless `showHosted`: a run with only hosted jobs is hidden, and so
 * is every group that has nothing left. Runs of one workflow name under one ref share a workflow
 * row. Every visible run is in exactly one workflow row.
 *
 * Every repo stays listed. A repo with no visible job is an idle row with no children, with its
 * last run time when the `repos` panel gives it, unless the `repos` panel says that all its jobs
 * are GitHub-hosted (then it is hidden unless `showHosted`). Without the `repos` panel the idle
 * rows are the repos of the queue rows and the repos that have a visible run.
 *
 * Order: repos with running or queued jobs first (most running first, then the longest time), then
 * idle repos by the last run time, newest first. Refs and workflows go by the longest time.
 */
export function groupTree(runs: ReadonlyArray<PanelRun>, opts: TreeOptions = {}): RepoNode[] {
  const showHosted = opts.showHosted === true;
  const pools = opts.pools ?? new Set<string>();
  const known = new Map((opts.repos ?? []).map(r => [r.repo, r]));
  const nodes = [...groupBy<PanelRun>(runs, repoLabelOf).entries()]
    .map(([label, inRepo]): RepoNode | null => {
      const visibleRuns = showHosted ? inRepo : inRepo.filter(r => !isHostedRun(r, pools));
      const meta = known.get(label);
      const place = placeOf(inRepo[0]);
      const base = {
        key: nodeKey('r', label),
        name: label,
        org: place.org,
        short: place.name,
        ...(meta?.lastRunAt ? { lastRunAt: meta.lastRunAt } : {}),
        ...(meta?.lastConclusion ? { lastConclusion: meta.lastConclusion } : {}),
      };
      if (visibleRuns.length === 0) {
        // Nothing to list. The repo stays as an idle row, unless the source says that it is
        // hosted only, or has no `repos` panel to say that the repo exists.
        if (!meta || meta.hosted === true) return null;
        return { ...base, refs: [], running: 0, queued: 0, longest: 0, hosted: false, idle: true };
      }
      const counted = (list: ReadonlyArray<PanelRun>): Counted => ({
        running: list.reduce((n, r) => n + visibleCountsOf(r, pools, showHosted).running, 0),
        queued: list.reduce((n, r) => n + visibleCountsOf(r, pools, showHosted).queued, 0),
        longest: list.reduce((m, r) => Math.max(m, r.seconds), 0),
      });
      const refs = [...groupBy<PanelRun>(visibleRuns, r => r.ref).entries()]
        .map(([ref, inRef]): RefNode => {
          const workflows = [...groupBy<PanelRun>(inRef, workflowNameOf).entries()]
            .map(([name, own]): WorkflowNode => {
              const entries = own.flatMap(run =>
                run.jobs
                  .map(job => ({
                    key: nodeKey('j', label, ref, name, run.id, job.id),
                    job,
                    run,
                    hosted: isHostedJob(job, pools),
                  }))
                  .filter(e => showHosted || !e.hosted)
              );
              return {
                key: nodeKey('w', label, ref, name),
                name,
                runs: own,
                jobs: entries,
                hosted: own.every(r => isHostedRun(r, pools)),
                ...counted(own),
              };
            })
            .sort(byLongest);
          const pr = inRef.find(r => r.pr !== undefined)?.pr;
          return {
            key: nodeKey('b', label, ref),
            name: ref,
            ...(pr !== undefined ? { pr } : {}),
            workflows,
            hosted: inRef.every(r => isHostedRun(r, pools)),
            ...counted(inRef),
          };
        })
        .sort(byLongest);
      return {
        ...base,
        refs,
        hosted: visibleRuns.every(r => isHostedRun(r, pools)),
        idle: false,
        ...counted(visibleRuns),
      };
    })
    .filter((n): n is RepoNode => n !== null);
  const listed = new Set(nodes.map(n => n.name));
  const idle = (label: string, extra: Partial<RepoNode> = {}): RepoNode => {
    const { org, name } = splitRepo(label);
    const meta = known.get(label);
    return {
      key: nodeKey('r', label),
      name: label,
      org,
      short: name,
      refs: [],
      running: 0,
      queued: 0,
      longest: 0,
      hosted: meta?.hosted === true,
      idle: true,
      ...(meta?.lastRunAt ? { lastRunAt: meta.lastRunAt } : {}),
      ...(meta?.lastConclusion ? { lastConclusion: meta.lastConclusion } : {}),
      ...extra,
    };
  };
  // Repos that no run lists: the queue rows, then the `repos` panel.
  const queued = new Map<string, number>();
  for (const q of opts.queue ?? []) queued.set(q.repo, (queued.get(q.repo) ?? 0) + q.queued);
  for (const [repo, count] of queued) {
    if (listed.has(repo)) continue;
    listed.add(repo);
    nodes.push(idle(repo, { queued: count }));
  }
  for (const r of opts.repos ?? []) {
    if (listed.has(r.repo)) continue;
    if (r.hosted === true && !showHosted) continue;
    listed.add(r.repo);
    nodes.push(idle(r.repo));
  }
  const busy = (n: RepoNode): boolean => n.running + n.queued > 0;
  return nodes.sort((a, b) =>
    busy(a) !== busy(b)
      ? busy(a)
        ? -1
        : 1
      : busy(a)
      ? byBusy(a, b)
      : atOf(b.lastRunAt) - atOf(a.lastRunAt)
  );
}

/** The keys of every node of a tree, for pruning the state in the URL. */
export function treeKeys(tree: ReadonlyArray<RepoNode>): Set<string> {
  const keys = new Set<string>();
  for (const repo of tree) {
    keys.add(repo.key);
    for (const ref of repo.refs) {
      keys.add(ref.key);
      for (const wf of ref.workflows) {
        keys.add(wf.key);
        for (const j of wf.jobs) keys.add(j.key);
      }
    }
  }
  return keys;
}

/** The node keys in a state text from the URL. Nothing is dropped on read. */
export function parseNodeKeys(text: string): Set<string> {
  return new Set(text.split(',').filter(Boolean));
}

/**
 * The state text for a set of node keys: only keys of nodes that still exist, sorted, joined with
 * a comma. An empty set gives an empty text, which removes the param.
 */
export function formatNodeKeys(keys: ReadonlySet<string>, valid: ReadonlySet<string>): string {
  return [...keys]
    .filter(k => valid.has(k))
    .sort()
    .join(',');
}

/** The run id as a short suffix for a job of a workflow row that holds more than one run. */
export const runSuffixOf = (run: Pick<PanelRun, 'id'>): string => `#${run.id.slice(-6)}`;

/** What a job row shows for its node: the node, or the pool when the source gave no node. */
export function jobNodeOf(job: Pick<PanelJob, 'node' | 'pool'>): {
  text: string;
  reported: boolean;
} {
  return job.node ? { text: job.node, reported: true } : { text: job.pool, reported: false };
}

/** The time that a job has run, or undefined when it has not run yet. */
export function jobRunSecondsOf(
  job: Pick<PanelJob, 'runningSeconds' | 'seconds' | 'phase'>
): number | undefined {
  if (job.runningSeconds !== undefined) return job.runningSeconds;
  return job.phase === 'running' ? job.seconds : undefined;
}

/** The time that a job waited for a runner, or undefined when the source gives none. */
export function jobWaitSecondsOf(
  job: Pick<PanelJob, 'waitedSeconds' | 'seconds' | 'phase'>
): number | undefined {
  if (job.waitedSeconds !== undefined) return job.waitedSeconds;
  return job.phase === 'running' ? undefined : job.seconds;
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

/** "2 pools, 34 running, 13 queued": the pools panel wording, with the counts of the runs panel. */
function summaryOf(poolCount: number, totals: JobCounts): string {
  return [
    ...(poolCount > 0 ? [`${poolCount} ${poolCount === 1 ? 'pool' : 'pools'}`] : []),
    `${totals.running} running`,
    `${totals.queued} queued`,
  ].join(', ');
}

export function joinRunners(input: {
  pools: PanelModel | null;
  queue: PanelModel | null;
  runs: PanelModel | null;
  /** The optional `repos` panel. */
  repos?: PanelModel | null;
  /** The optional `nodes` panel. */
  nodes?: PanelModel | null;
}): RunnerModel {
  const pools = poolsOf(input.pools);
  const queueStats = input.queue?.stats ?? [];
  const fromPools = (label: string): Stat | undefined =>
    input.pools?.stats.find(s => s.label.toLowerCase() === label);
  const sum = (pick: (p: RunnerPool) => number): number => pools.reduce((n, p) => n + pick(p), 0);
  const totals = input.runs?.jobs;
  // One snapshot: the runs panel gives the job totals, the tree and the org headers, so the tiles
  // and the headers always agree. The pools panel is fetched at another moment and can differ.
  // Only a source with no job totals falls back to the pools stats.
  const running = totals
    ? stat('Running', String(totals.running), fromPools('running')?.status ?? 'ok')
    : fromPools('running') ?? stat('Running', String(sum(p => p.running)));
  const queued = totals
    ? stat('Queued', String(totals.queued), fromPools('queued')?.status ?? 'ok')
    : fromPools('queued') ?? stat('Queued', String(sum(p => p.queued)));
  const free = fromPools('free') ?? stat('Free', String(sum(p => p.free)));
  const poolCount = fromPools('pools') ?? stat('Pools', String(pools.length));
  const oldest =
    queueStats.find(s => s.label.toLowerCase() === 'oldest') ?? stat('Oldest wait', '-');
  const runs = input.runs ? orderRuns(input.runs.runs) : [];
  const listed = tally(runs);
  const unlisted = totals
    ? Math.max(0, totals.running - listed.running) + Math.max(0, totals.queued - listed.queued)
    : 0;
  const status = worst([
    ...(input.pools ? [input.pools.status] : []),
    ...(input.queue ? [input.queue.status] : []),
  ]);
  const summary = totals
    ? summaryOf(pools.length, totals)
    : input.pools?.summary || input.queue?.summary || '';
  return {
    pools,
    nodes: nodesOf(input.nodes),
    stats: [running, queued, free, poolCount, { ...oldest, label: 'Oldest wait' }],
    runs,
    unlisted,
    tree: input.runs !== null,
    poolNames: pools.map(p => p.name),
    repos: input.repos?.repos ?? null,
    queue: queueRowsOf(input.queue),
    status,
    summary,
  };
}
