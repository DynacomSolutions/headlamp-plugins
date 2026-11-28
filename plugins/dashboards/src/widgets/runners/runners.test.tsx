import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useHistory, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn(), clusterRequest: vi.fn() },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));

import { parsePanel } from '../panels/model';
import {
  capOf,
  countsOf,
  formatNodeKeys,
  formatWait,
  groupTree,
  isHostedJob,
  jobNodeOf,
  jobRunSecondsOf,
  jobWaitSecondsOf,
  joinRunners,
  nodeKey,
  orderRuns,
  parseNodeKeys,
  placeOf,
  progressOf,
  runSuffixOf,
  splitRepo,
  STEP_GAP,
  STEP_MIN_SEGMENT,
  stepBarLayout,
  treeKeys,
} from './join';
import { countsText, expandOf, ringShares, RunnersView, viewOf } from './RunnersView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pools = parsePanel({
  version: 1,
  id: 'pools',
  title: 'Pools',
  status: 'ok',
  summary: '2 pools, 9 running, 1 queued',
  stats: [
    { label: 'Running', value: '9', status: 'ok' },
    { label: 'Queued', value: '1', status: 'ok' },
    { label: 'Free', value: '390', status: 'ok' },
    { label: 'Pools', value: '2', status: 'ok' },
  ],
  rows: [
    { label: 'pool-a', detail: '4 running, 1 queued, 195 free', value: '4/200', status: 'ok' },
    { label: 'pool-b', detail: '5 running, 0 queued, 195 free', value: '5/200', status: 'ok' },
  ],
});
const queue = parsePanel({
  version: 1,
  id: 'queue',
  title: 'Queue',
  status: 'ok',
  summary: '1 queued job',
  stats: [
    { label: 'Queued', value: '1', status: 'ok' },
    { label: 'Oldest', value: '35s', status: 'ok' },
  ],
  rows: [{ label: 'org/repo-a', detail: 'pool pool-a, 1 queued', value: '35s', status: 'ok' }],
});
const emptyQueue = parsePanel({
  version: 1,
  id: 'queue',
  title: 'Queue',
  status: 'ok',
  summary: 'No queued jobs',
  stats: [{ label: 'Oldest', value: '-', status: 'ok' }],
  rows: [],
});
const step = (name: string, state: string) => ({ name, state });
const runs = parsePanel({
  version: 1,
  id: 'runs',
  title: 'Runs',
  status: 'ok',
  summary: '',
  runs: [
    {
      id: 'q-old',
      repo: 'org/repo-q',
      workflow: 'ci',
      ref: 'main',
      pool: 'pool-a',
      state: 'queued',
      seconds: 90,
    },
    {
      id: 'r-short',
      repo: 'org/repo-s',
      workflow: 'ci',
      ref: 'main',
      pool: 'pool-a',
      state: 'running',
      seconds: 20,
    },
    {
      id: 'r-long',
      repo: 'org/repo-l',
      workflow: 'build',
      ref: 'PR 12',
      pool: 'pool-b',
      state: 'running',
      seconds: 400,
      jobs: [
        {
          id: 'j1',
          name: 'compile',
          state: 'running',
          pool: 'pool-b',
          seconds: 380,
          steps: [step('Checkout', 'done'), step('Build', 'running'), step('Test', 'pending')],
        },
        {
          id: 'j2',
          name: 'lint',
          state: 'running',
          pool: 'pool-b',
          seconds: 100,
          steps: [step('Checkout', 'done'), step('Lint', 'failed'), step('Report', 'skipped')],
        },
      ],
    },
    {
      id: 'q-new',
      repo: 'org/repo-n',
      workflow: 'ci',
      ref: 'main',
      pool: 'pool-a',
      state: 'queued',
      seconds: 5,
    },
  ],
});

let hist: ReturnType<typeof useHistory>;
/** Captures the router history, so a test can read the URL and spy on history calls. */
function Probe(): null {
  hist = useHistory();
  useLocation();
  return null;
}
const searchNow = (): string => hist.location.search;
const param = (name = 'w.w1'): string | null => new URLSearchParams(searchNow()).get(name);

type Model = ReturnType<typeof joinRunners>;
interface MountOptions {
  entries?: string[];
  /** The widget id. `null` leaves it out. Default: `w1`. */
  instanceId?: string | null;
  editing?: boolean;
  expand?: 'all' | 'default';
  view?: 'full' | 'summary' | 'list';
}

/** Mounts the view in a router, so the URL state can be read and written. */
const mount = (model: Model, o: MountOptions = {}) => {
  const ui = (m: Model) => (
    <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
      <MemoryRouter initialEntries={o.entries ?? ['/dashboards/ops/overview']}>
        <Probe />
        <RunnersView
          model={m}
          editing={!!o.editing}
          instanceId={o.instanceId === null ? undefined : o.instanceId ?? 'w1'}
          expand={o.expand}
          view={o.view}
        />
      </MemoryRouter>
    </ThemeProvider>
  );
  const r = render(ui(model));
  return { ...r, update: (m: Model) => r.rerender(ui(m)) };
};

/** Every row of one kind, by the attribute `data-group`. */
const rows = (c: HTMLElement, kind: string) =>
  [...c.querySelectorAll(`[data-group="${kind}"]`)] as HTMLElement[];
const names = (c: HTMLElement, kind: string) =>
  rows(c, kind).map(r => r.querySelector('[data-group-name]')?.textContent);
const byKey = (c: HTMLElement, key: string) =>
  c.querySelector(`[data-group-key="${key}"]`) as HTMLElement;
const jobs = (c: HTMLElement) => [...c.querySelectorAll('[data-job]')] as HTMLElement[];

describe('parsers', () => {
  it('reads the counts of a pool row and its cap', () => {
    expect(countsOf('4 running, 1 queued, 195 free')).toEqual({ running: 4, queued: 1, free: 195 });
    expect(countsOf('nothing')).toEqual({ running: 0, queued: 0, free: 0 });
    expect(capOf('4/200')).toBe(200);
    expect(capOf('-')).toBe(0);
  });

  it('formats a wait', () => {
    expect(formatWait(45)).toBe('45s');
    expect(formatWait(127)).toBe('2m 7s');
    expect(formatWait(3900)).toBe('1h 5m');
  });

  it('drops bad run data without throwing', () => {
    const p = parsePanel({
      version: 1,
      id: 'runs',
      runs: [{ repo: '' }, 7, { repo: 'a/b', state: 'weird', seconds: -4, jobs: [{ steps: [] }] }],
    });
    expect(p.runs).toHaveLength(1);
    expect(p.runs[0]).toMatchObject({ state: 'queued', seconds: 0, jobs: [] });
  });

  it('reads the optional node, waited and running seconds of a job, and the PR of a run', () => {
    const p = parsePanel({
      version: 1,
      id: 'runs',
      runs: [
        {
          repo: 'my-org/my-repo',
          pr: 12,
          jobs: [
            { name: 'a', node: 'worker-1', waitedSeconds: 4, runningSeconds: 9, seconds: 9 },
            { name: 'b', node: 7, waitedSeconds: '4', runningSeconds: -1 },
            { name: 'c', node: '  ', waitedSeconds: null, runningSeconds: Infinity },
            { name: 'd' },
          ],
        },
        { repo: 'my-org/other', pr: 'x' },
        { repo: 'my-org/third', pr: 0 },
        { repo: 'my-org/fourth', pr: 1.5 },
      ],
    });
    expect(p.runs[0].pr).toBe(12);
    expect(p.runs[0].jobs[0]).toMatchObject({
      node: 'worker-1',
      waitedSeconds: 4,
      runningSeconds: 9,
    });
    for (const j of p.runs[0].jobs.slice(1)) {
      expect(j).not.toHaveProperty('node');
      expect(j).not.toHaveProperty('waitedSeconds');
      expect(j).not.toHaveProperty('runningSeconds');
    }
    for (const r of p.runs.slice(1)) expect(r).not.toHaveProperty('pr');
  });
});

describe('order and progress', () => {
  it('puts running first (longest first), then queued (oldest first)', () => {
    expect(orderRuns(runs.runs).map(r => r.id)).toEqual(['r-long', 'r-short', 'q-old', 'q-new']);
  });

  it('finds the current step', () => {
    expect(progressOf([])).toBeNull();
    expect(
      progressOf([step('a', 'done'), step('b', 'running'), step('c', 'pending')] as never)
    ).toMatchObject({
      n: 2,
      total: 3,
      name: 'b',
    });
    expect(
      progressOf([step('a', 'done'), step('b', 'failed'), step('c', 'skipped')] as never)
    ).toMatchObject({
      n: 2,
      state: 'failed',
    });
    expect(progressOf([step('a', 'done'), step('b', 'done')] as never)).toMatchObject({
      n: 2,
      total: 2,
    });
  });

  it('splits a ring into running, queued and free', () => {
    const s = ringShares({ running: 50, queued: 25, cap: 100 });
    expect(s).toEqual({ running: 0.5, queued: 0.25, free: 0.25 });
    expect(ringShares({ running: 0, queued: 0, cap: 0 }).free).toBe(1);
    expect(ringShares({ running: 150, queued: 10, cap: 100 }).free).toBe(0);
  });
});

describe('the widget view', () => {
  it('draws tiles, one ring for each pool with the same value size, and the summary', () => {
    const model = joinRunners({ pools, queue, runs: null });
    const { container } = mount(model);
    expect([...container.querySelectorAll('[data-stat]')]).toHaveLength(5);
    expect(container.textContent).toContain('Oldest wait');
    const poolNames = [...container.querySelectorAll('[data-pool]')].map(e =>
      e.getAttribute('data-pool')
    );
    expect(poolNames).toEqual(['pool-a', 'pool-b']);
    const values = [...container.querySelectorAll('[data-pool-value]')];
    expect(values.map(v => v.textContent)).toEqual(['4/200', '5/200']);
    expect(new Set(values.map(v => getComputedStyle(v).fontSize)).size).toBe(1);
    expect(container.querySelector('[data-ring="queued"]')).not.toBeNull();
    expect(container.querySelector('[data-runners-summary]')?.textContent).toBe(
      '2 pools, 9 running, 1 queued'
    );
  });

  it('shows the queue rows without a tree when the source has no runs panel', () => {
    const { container } = mount(joinRunners({ pools, queue, runs: null }));
    const qrows = container.querySelectorAll('[data-queue-row]');
    expect(qrows).toHaveLength(1);
    expect(qrows[0].textContent).toContain('org/repo-a');
    expect(qrows[0].textContent).toContain('35s');
    expect(container.querySelector('[data-group]')).toBeNull();
    // The queue rows are plain rows: no link, no button.
    expect(container.querySelectorAll('a, [href], [target], [role="button"]')).toHaveLength(0);
  });

  it('shows one quiet line when nothing is queued', () => {
    const { container } = mount(joinRunners({ pools, queue: emptyQueue, runs: null }));
    expect(container.querySelector('[data-runners-empty]')?.textContent).toBe('No queued jobs');
  });

  it('colours the step segments by state, with a distinct colour for each', () => {
    const { container } = mount(joinRunners({ pools, queue, runs }), { expand: 'all' });
    const colour = (state: string) =>
      getComputedStyle(container.querySelector(`[data-step-state="${state}"]`)!).backgroundColor;
    const all = ['done', 'running', 'failed', 'skipped', 'pending'].map(colour);
    expect(new Set(all).size).toBe(5);
  });

  it('has no "more" row and no "Other" group', () => {
    const { container } = mount(joinRunners({ pools, queue, runs }), { expand: 'all' });
    expect(container.textContent).not.toMatch(/\+\s*\d+ more|\d+ more|\bOther\b/i);
  });
});

/** A run with one job of `total` steps: the first `done` are done, then one running, rest pending. */
const runOfSteps = (total: number, done: number, failed = false) =>
  parsePanel({
    version: 1,
    id: 'runs',
    title: 'Runs',
    status: 'ok',
    summary: '',
    runs: [
      {
        id: 'r-many',
        repo: 'org/repo-m',
        workflow: 'build',
        ref: 'main',
        pool: 'pool-a',
        state: 'running',
        seconds: 60,
        jobs: [
          {
            id: 'j1',
            name: 'compile',
            state: 'running',
            pool: 'pool-a',
            seconds: 60,
            steps: Array.from({ length: total }, (_, i) =>
              step(
                `Step ${i + 1}`,
                i < done ? 'done' : i === done ? (failed ? 'failed' : 'running') : 'pending'
              )
            ),
          },
        ],
      },
    ],
  });

describe('the step bar layout', () => {
  const stepsOf = (total: number, done: number) =>
    (runOfSteps(total, done).runs ?? [])[0].jobs[0].steps;
  const WIDTH = 380;

  it('keeps one segment for each step while every segment is at least 4 px wide', () => {
    for (const total of [3, 12, 31, 75]) {
      expect(stepBarLayout(stepsOf(total, 1), WIDTH).mode).toBe('segments');
      expect(total * (STEP_MIN_SEGMENT + STEP_GAP) - STEP_GAP).toBeLessThanOrEqual(WIDTH);
    }
  });

  it('draws one continuous bar when the segments would be thinner than 4 px', () => {
    for (const total of [80, 200]) {
      expect(stepBarLayout(stepsOf(total, 5), WIDTH).mode).toBe('continuous');
    }
    expect(stepBarLayout(stepsOf(31, 5), 100).mode).toBe('continuous');
  });

  it('splits a continuous bar by state in proportion to the step count', () => {
    const layout = stepBarLayout(stepsOf(80, 40), WIDTH);
    expect(layout).toEqual({
      mode: 'continuous',
      groups: [
        { state: 'done', count: 40 },
        { state: 'running', count: 1 },
        { state: 'pending', count: 39 },
      ],
    });
  });

  it('assumes a default width before the first measurement', () => {
    expect(stepBarLayout(stepsOf(12, 1), 0).mode).toBe('segments');
    expect(stepBarLayout(stepsOf(80, 1), 0).mode).toBe('continuous');
  });
});

describe('the step bar and its label', () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const measure = (width: number) =>
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return (this as HTMLElement).hasAttribute('data-step-bar') ? width : 0;
      },
    });
  afterEach(() => {
    if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original);
  });

  it.each([3, 12, 31, 80])('puts the bar and the label on separate lines for %i steps', total => {
    measure(380);
    const { container } = mount(joinRunners({ pools, queue, runs: runOfSteps(total, 2) }), {
      expand: 'all',
    });
    const bar = container.querySelector('[data-job] [data-step-bar]') as HTMLElement;
    const label = container.querySelector('[data-job] [data-progress-text]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(label.textContent).toBe('step 3 of ' + total + ' · Step 3');
    // The label is not inside the bar, and both are children of one column.
    expect(bar.contains(label)).toBe(false);
    expect(bar.parentElement).toBe(label.parentElement);
    const column = getComputedStyle(bar.parentElement!);
    expect(column.display).toBe('flex');
    expect(column.flexDirection).toBe('column');
    // The bar takes the full width and the label truncates with an ellipsis.
    expect(getComputedStyle(bar).width).toBe('100%');
    expect(getComputedStyle(label).textOverflow).toBe('ellipsis');
    expect(getComputedStyle(label).whiteSpace).toBe('nowrap');
    // The count of drawn parts stays in step with the layout choice.
    const parts = bar.querySelectorAll('[data-step-state]').length;
    if (total * (STEP_MIN_SEGMENT + STEP_GAP) - STEP_GAP <= 380) {
      expect(bar.getAttribute('data-step-bar-mode')).toBe('segments');
      expect(parts).toBe(total);
    } else {
      expect(bar.getAttribute('data-step-bar-mode')).toBe('continuous');
      expect(parts).toBe(3);
    }
  });

  it('keeps the state colours in a continuous bar', () => {
    measure(380);
    const { container } = mount(joinRunners({ pools, queue, runs: runOfSteps(80, 20, true) }), {
      expand: 'all',
    });
    const bar = container.querySelector('[data-job] [data-step-bar]') as HTMLElement;
    const colour = (state: string) =>
      getComputedStyle(bar.querySelector(`[data-step-state="${state}"]`)!).backgroundColor;
    expect(bar.getAttribute('data-step-bar-mode')).toBe('continuous');
    expect(new Set(['done', 'failed', 'pending'].map(colour)).size).toBe(3);
    const sizes = [...bar.querySelectorAll('[data-step-count]')].map(e =>
      e.getAttribute('data-step-count')
    );
    expect(sizes).toEqual(['20', '1', '59']);
    expect(bar.getAttribute('aria-label')).toBe('80 steps: 20 done, 1 failed, 59 pending');
  });
});

interface RunOpts {
  ref?: string;
  workflow?: string;
  pr?: number;
  repoKnown?: boolean;
  counts?: unknown;
  job?: Record<string, unknown>;
  jobs?: unknown[];
}
const run = (id: string, repo: string, state: string, seconds: number, o: RunOpts = {}) => ({
  id,
  repo,
  workflow: o.workflow ?? `wf-${id}`,
  ref: o.ref ?? 'main',
  ...(o.pr !== undefined ? { pr: o.pr } : {}),
  ...(o.repoKnown !== undefined ? { repoKnown: o.repoKnown } : {}),
  ...(o.counts !== undefined ? { counts: o.counts } : {}),
  pool: 'pool-a',
  state,
  seconds,
  jobs: o.jobs ?? [
    {
      id: `${id}-j`,
      name: 'job',
      state,
      pool: 'pool-a',
      seconds,
      steps: [step('Checkout', 'done'), step('Build', 'running')],
      ...o.job,
    },
  ],
});
const panelOf = (list: unknown[], extra: Record<string, unknown> = {}) =>
  parsePanel({
    version: 1,
    id: 'runs',
    title: 'Runs',
    status: 'ok',
    summary: '',
    runs: list,
    ...extra,
  });

const grouped = panelOf([
  run('a1', 'org-b/app', 'queued', 500),
  run('a2', 'org-a/api', 'running', 30, { workflow: 'ci' }),
  run('a3', 'org-a/web', 'running', 200, { workflow: 'ci', ref: 'feat-x', pr: 7 }),
  run('a4', 'org-a/web', 'running', 10, { workflow: 'ci', ref: 'feat-x', pr: 7 }),
  run('a5', 'org-a/web', 'queued', 60, { workflow: 'lint', ref: 'feat-x', pr: 7 }),
  run('a6', 'org-a/web', 'running', 90, { workflow: 'ci' }),
  run('a7', 'org-c/tool', 'running', 5, { workflow: 'build', ref: '' }),
  run('a8', 'loose', 'queued', 1),
]);
const WEB = nodeKey('r', 'org-a/web');
const WEB_FEAT = nodeKey('b', 'org-a/web', 'feat-x');
const WEB_FEAT_CI = nodeKey('w', 'org-a/web', 'feat-x', 'ci');
const WEB_FEAT_CI_JOB3 = nodeKey('j', 'org-a/web', 'feat-x', 'ci', 'a3', 'a3-j');
const model = () => joinRunners({ pools, queue: emptyQueue, runs: grouped });

describe('grouping by repo, ref, workflow and job', () => {
  it('splits the org from the repo name', () => {
    expect(splitRepo('org/.cluster')).toEqual({ org: 'org', name: '.cluster' });
    expect(splitRepo('org/a/b')).toEqual({ org: 'org', name: 'a/b' });
    expect(splitRepo('loose')).toEqual({ org: 'No org', name: 'loose' });
    expect(splitRepo('/x')).toEqual({ org: 'No org', name: '/x' });
  });

  it('builds repo, then ref, then workflow, then job, and puts every run in one workflow', () => {
    const tree = groupTree(grouped.runs);
    expect(tree.map(r => r.name)).toEqual([
      'org-a/web',
      'org-a/api',
      'org-c/tool',
      'org-b/app',
      'loose',
    ]);
    const web = tree[0];
    expect(web.refs.map(r => r.name)).toEqual(['feat-x', 'main']);
    expect(web.refs[0].workflows.map(w => w.name)).toEqual(['ci', 'lint']);
    // Two runs of the same workflow under one ref share one workflow row.
    expect(web.refs[0].workflows[0].runs.map(r => r.id)).toEqual(['a3', 'a4']);
    expect(web.refs[0].workflows[0].jobs.map(j => j.job.id)).toEqual(['a3-j', 'a4-j']);
    const all = tree.flatMap(r => r.refs.flatMap(f => f.workflows.flatMap(w => w.runs)));
    expect(all).toHaveLength(8);
  });

  it('counts the jobs and the longest time in every level', () => {
    const [web] = groupTree(grouped.runs);
    expect(web).toMatchObject({ running: 3, queued: 1, longest: 200 });
    expect(web.refs[0]).toMatchObject({ running: 2, queued: 1, longest: 200, pr: 7 });
    expect(web.refs[1]).toMatchObject({ running: 1, queued: 0, longest: 90 });
    expect(web.refs[0].workflows[0]).toMatchObject({ running: 2, queued: 0, longest: 200 });
    expect(web.refs[0].workflows[1]).toMatchObject({ running: 0, queued: 1, longest: 60 });
  });

  it('sorts repos by running jobs then longest time, and refs and workflows by longest time', () => {
    const tie = groupTree([
      run('x1', 'o/short', 'running', 5),
      run('x2', 'o/long', 'running', 50),
      run('x3', 'o/idle', 'queued', 900),
    ] as never);
    expect(tie.map(r => r.name)).toEqual(['o/long', 'o/short', 'o/idle']);
    const refs = groupTree([
      run('y1', 'o/r', 'running', 5, { ref: 'a' }),
      run('y2', 'o/r', 'running', 50, { ref: 'b' }),
      run('y3', 'o/r', 'running', 20, { ref: 'b', workflow: 'z' }),
    ] as never)[0].refs;
    expect(refs.map(r => r.name)).toEqual(['b', 'a']);
    expect(refs[0].workflows.map(w => w.name)).toEqual(['wf-y2', 'z']);
  });

  it('keeps a run with no workflow name apart, by its id', () => {
    const tree = groupTree([
      run('n1', 'o/r', 'running', 5, { workflow: '' }),
      run('n2', 'o/r', 'running', 6, { workflow: '' }),
    ] as never);
    expect(tree[0].refs[0].workflows.map(w => w.name).sort()).toEqual(['n1', 'n2']);
  });

  it('keeps a run of an unknown repo under its owner, in a row that says so', () => {
    const p = panelOf([
      run('u1', 'org-a', 'queued', 40, { repoKnown: false, counts: { running: 0, queued: 2 } }),
      run('u2', 'org-a/web', 'running', 10, { counts: { running: 5, queued: 0 } }),
    ]);
    expect(p.runs.map(r => r.repoKnown)).toEqual([false, true]);
    const tree = groupTree(p.runs);
    expect(tree.map(r => [r.name, r.running, r.queued])).toEqual([
      ['org-a/web', 5, 0],
      ['org-a/Repo not known', 0, 2],
    ]);
    expect(placeOf({ repo: 'org-a', repoKnown: false })).toEqual({
      org: 'org-a',
      name: 'Repo not known',
    });
    expect(placeOf({ repo: 'org-a/web', repoKnown: true })).toEqual({ org: 'org-a', name: 'web' });
  });

  it('treats a missing repoKnown as known', () => {
    const p = parsePanel({ version: 1, id: 'runs', runs: [run('k1', 'org-a/web', 'running', 1)] });
    expect(p.runs[0].repoKnown).toBe(true);
    expect(groupTree(p.runs)[0].name).toBe('org-a/web');
  });

  it('writes the counts as text', () => {
    expect(countsText({ running: 2, queued: 1 })).toBe('2 running, 1 queued');
    expect(countsText({ running: 0, queued: 3 })).toBe('3 queued');
    expect(countsText({ running: 0, queued: 0 })).toBe('idle');
  });

  it('makes stable keys that hold no comma and differ for every node', () => {
    const a = treeKeys(groupTree(grouped.runs));
    const b = treeKeys(groupTree(JSON.parse(JSON.stringify(grouped.runs))));
    expect([...a]).toEqual([...b]);
    for (const k of a) expect(k).not.toContain(',');
    expect(a.has(WEB)).toBe(true);
    expect(a.has(WEB_FEAT)).toBe(true);
    expect(a.has(WEB_FEAT_CI)).toBe(true);
    expect(a.has(WEB_FEAT_CI_JOB3)).toBe(true);
    expect(nodeKey('r', 'a,b|c%d')).toBe('r|a%2cb%7cc%25d');
    expect(runSuffixOf({ id: 'run-123456789' })).toBe('#456789');
    expect(runSuffixOf({ id: 'a3' })).toBe('#a3');
  });

  it('reads and writes the node keys: no pruning on read, pruning on write, sorted', () => {
    expect(parseNodeKeys('')).toEqual(new Set());
    expect(parseNodeKeys('a,,b')).toEqual(new Set(['a', 'b']));
    expect(parseNodeKeys('gone,b')).toEqual(new Set(['gone', 'b']));
    expect(formatNodeKeys(new Set(['gone', 'b', 'a']), new Set(['a', 'b']))).toBe('a,b');
    expect(formatNodeKeys(new Set(['gone']), new Set(['a']))).toBe('');
  });

  it('shows the node, or the pool when no node is reported, and the two times', () => {
    expect(jobNodeOf({ node: 'worker-1', pool: 'p' })).toEqual({
      text: 'worker-1',
      reported: true,
    });
    expect(jobNodeOf({ pool: 'p' })).toEqual({ text: 'p', reported: false });
    expect(jobRunSecondsOf({ runningSeconds: 4, seconds: 9, phase: 'queued' })).toBe(4);
    expect(jobRunSecondsOf({ seconds: 9, phase: 'running' })).toBe(9);
    expect(jobRunSecondsOf({ seconds: 9, phase: 'assigned' })).toBeUndefined();
    expect(jobRunSecondsOf({ seconds: 9, phase: 'queued' })).toBeUndefined();
    expect(jobWaitSecondsOf({ waitedSeconds: 2, seconds: 9, phase: 'running' })).toBe(2);
    expect(jobWaitSecondsOf({ seconds: 9, phase: 'queued' })).toBe(9);
    expect(jobWaitSecondsOf({ seconds: 9, phase: 'assigned' })).toBe(9);
    expect(jobWaitSecondsOf({ seconds: 9, phase: 'running' })).toBeUndefined();
  });
});

describe('the tree in the view', () => {
  it('folds every repo at first, so no ref row shows', () => {
    const { container } = mount(model());
    expect(names(container, 'repo')).toEqual([
      'org-a/web',
      'org-a/api',
      'org-c/tool',
      'org-b/app',
      'loose',
    ]);
    for (const r of rows(container, 'repo')) expect(r.getAttribute('aria-expanded')).toBe('false');
    expect(rows(container, 'ref')).toHaveLength(0);
    expect(searchNow()).toBe('');
  });

  it('opens a repo to its refs, a ref to its workflows, a workflow to its jobs, a job to its steps', () => {
    const { container } = mount(model());
    fireEvent.click(byKey(container, WEB));
    expect(byKey(container, WEB).getAttribute('aria-expanded')).toBe('true');
    expect(names(container, 'ref')).toEqual(['PR #7feat-x', 'main']);
    expect(rows(container, 'workflow')).toHaveLength(0);
    fireEvent.click(byKey(container, WEB_FEAT));
    expect(names(container, 'workflow')).toEqual(['ci', 'lint']);
    expect(jobs(container)).toHaveLength(0);
    fireEvent.click(byKey(container, WEB_FEAT_CI));
    expect(jobs(container)).toHaveLength(2);
    expect(container.querySelector('[data-step-list]')).toBeNull();
    fireEvent.click(jobs(container)[0]);
    expect(container.querySelectorAll('[data-step-list] [data-step]')).toHaveLength(2);
    // Folding a parent hides everything below it.
    fireEvent.click(byKey(container, WEB));
    expect(rows(container, 'ref')).toHaveLength(0);
    expect(jobs(container)).toHaveLength(0);
  });

  it('opens and folds a row with Enter and with Space, at every level', () => {
    const { container } = mount(model());
    const press = (el: Element, key: string) => fireEvent.keyDown(el, { key });
    press(byKey(container, WEB), 'Enter');
    expect(byKey(container, WEB).getAttribute('aria-expanded')).toBe('true');
    press(byKey(container, WEB_FEAT), ' ');
    expect(byKey(container, WEB_FEAT).getAttribute('aria-expanded')).toBe('true');
    press(byKey(container, WEB_FEAT_CI), 'Enter');
    expect(jobs(container)).toHaveLength(2);
    press(jobs(container)[0], ' ');
    expect(container.querySelectorAll('[data-step-list] [data-step]')).toHaveLength(2);
    press(jobs(container)[0], 'Enter');
    expect(container.querySelector('[data-step-list]')).toBeNull();
    press(byKey(container, WEB_FEAT_CI), ' ');
    expect(jobs(container)).toHaveLength(0);
    press(byKey(container, WEB_FEAT), 'Enter');
    expect(rows(container, 'workflow')).toHaveLength(0);
    press(byKey(container, WEB), ' ');
    expect(rows(container, 'ref')).toHaveLength(0);
    // Another key does nothing.
    press(byKey(container, WEB), 'a');
    expect(byKey(container, WEB).getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the counts and the longest time in every row', () => {
    const { container } = mount(model(), { expand: 'all' });
    const web = byKey(container, WEB);
    expect(web.querySelector('[data-group-running]')?.textContent).toBe('3 running');
    expect(web.querySelector('[data-group-queued]')?.textContent).toBe('1 queued');
    expect(web.querySelector('[data-time]')?.textContent).toBe('3m 20s');
    const feat = byKey(container, WEB_FEAT);
    expect(feat.querySelector('[data-group-running]')?.textContent).toBe('2 running');
    expect(feat.querySelector('[data-time]')?.textContent).toBe('3m 20s');
    const lint = byKey(container, nodeKey('w', 'org-a/web', 'feat-x', 'lint'));
    expect(lint.querySelector('[data-group-running]')).toBeNull();
    expect(lint.querySelector('[data-group-queued]')?.textContent).toBe('1 queued');
    expect(lint.querySelector('[data-time]')?.textContent).toBe('1m 0s');
    const main = byKey(container, nodeKey('b', 'org-a/web', 'main'));
    expect(main.querySelector('[data-time]')?.textContent).toBe('1m 30s');
  });

  it('labels a ref with its PR number and branch, its name, or "No branch"', () => {
    const { container } = mount(model(), { expand: 'all' });
    const feat = byKey(container, WEB_FEAT);
    expect(feat.querySelector('[data-ref-pr]')?.textContent).toBe('PR #7');
    expect(feat.querySelector('[data-ref-branch]')?.textContent).toBe('feat-x');
    const main = byKey(container, nodeKey('b', 'org-a/web', 'main'));
    expect(main.querySelector('[data-ref-pr]')).toBeNull();
    expect(main.querySelector('[data-group-name]')?.textContent).toBe('main');
    const none = byKey(container, nodeKey('b', 'org-c/tool', ''));
    expect(none.querySelector('[data-ref-none]')?.textContent).toBe('No branch');
  });

  it('adds a short run id to the jobs of a workflow that has more than one run', () => {
    const { container } = mount(model(), { expand: 'all' });
    const ci = jobs(container).filter(j => j.getAttribute('data-job-key')?.includes('|feat-x|ci|'));
    expect(ci.map(j => j.querySelector('[data-run-suffix]')?.textContent)).toEqual(['#a3', '#a4']);
    const lint = jobs(container).find(j => j.getAttribute('data-job-key')?.includes('|lint|'))!;
    expect(lint.querySelector('[data-run-suffix]')).toBeNull();
  });

  it('indents each level further', () => {
    const { container } = mount(model(), { expand: 'all' });
    const pad = (el: Element) => parseFloat(getComputedStyle(el).paddingLeft);
    const repo = byKey(container, WEB);
    const ref = byKey(container, WEB_FEAT);
    const wf = byKey(container, WEB_FEAT_CI);
    const job = container.querySelector(`[data-job-key="${WEB_FEAT_CI_JOB3}"]`)!;
    expect(pad(repo)).toBe(0);
    expect(pad(ref)).toBeGreaterThan(pad(repo));
    expect(pad(wf)).toBeGreaterThan(pad(ref));
    expect(pad(job)).toBeGreaterThan(pad(wf));
  });
});

describe('the job row', () => {
  const one = (job: Record<string, unknown>, state = 'running') =>
    joinRunners({
      pools,
      queue,
      runs: panelOf([run('d1', 'my-org/my-repo', state, 100, { job })]),
    });
  const row = (c: HTMLElement) => c.querySelector('[data-job]') as HTMLElement;
  const text = (c: HTMLElement, attr: string) => row(c).querySelector(`[${attr}]`)?.textContent;

  it('shows the state, the node, the waited time and the running time from the new fields', () => {
    const { container } = mount(
      one({ node: 'worker-1', waitedSeconds: 5, runningSeconds: 375, seconds: 380 }),
      { expand: 'all' }
    );
    expect(text(container, 'data-job-state')).toBe('running');
    expect(row(container).querySelector('[data-status="ok"]')).not.toBeNull();
    const node = row(container).querySelector('[data-job-node]')!;
    expect(node.textContent).toBe('worker-1');
    expect(node.getAttribute('data-node-reported')).toBe('true');
    expect(text(container, 'data-job-waited')).toBe('5s');
    expect(text(container, 'data-job-running')).toBe('6m 15s');
  });

  it('falls back to the pool, and to the old seconds, when the new fields are missing', () => {
    const { container } = mount(one({ seconds: 380 }), { expand: 'all' });
    const node = row(container).querySelector('[data-job-node]')!;
    expect(node.textContent).toBe('pool-a');
    expect(node.getAttribute('data-node-reported')).toBe('false');
    expect(node.getAttribute('title')).toBe('Node not reported, pool shown');
    expect(text(container, 'data-job-running')).toBe('6m 20s');
    expect(text(container, 'data-job-waited')).toBe('-');
  });

  it('shows a queued job as waited with no running time', () => {
    const { container } = mount(one({ seconds: 42, phase: 'queued', steps: [] }, 'queued'), {
      expand: 'all',
    });
    expect(text(container, 'data-job-state')).toBe('queued');
    expect(row(container).querySelector('[data-status="warn"]')).not.toBeNull();
    expect(text(container, 'data-job-waited')).toBe('42s');
    expect(text(container, 'data-job-running')).toBe('-');
  });

  it('shows an assigned job as waited, with its own state word', () => {
    const { container } = mount(one({ seconds: 7, phase: 'assigned' }, 'queued'), {
      expand: 'all',
    });
    expect(text(container, 'data-job-state')).toBe('assigned');
    expect(row(container).querySelector('[data-status="unknown"]')).not.toBeNull();
    expect(text(container, 'data-job-waited')).toBe('7s');
    expect(text(container, 'data-job-running')).toBe('-');
  });

  it('counts a job that is only assigned to a runner as running', () => {
    const p = panelOf([
      run('s1', 'o/r', 'queued', 5, {
        counts: { running: 1, queued: 0 },
        job: { phase: 'assigned' },
      }),
    ]);
    expect(p.runs[0].jobs[0]).toMatchObject({ state: 'queued', phase: 'assigned' });
    expect(groupTree(p.runs)[0]).toMatchObject({ running: 1, queued: 0 });
  });

  it('opens a job with no steps to nothing, and gives it no button role', () => {
    const { container } = mount(one({ steps: [] }), { expand: 'all' });
    expect(row(container).getAttribute('role')).toBeNull();
    expect(row(container).hasAttribute('aria-expanded')).toBe(false);
    expect(container.querySelector('[data-step-list]')).toBeNull();
  });
});

describe('no row is a link', () => {
  it('draws no anchor, no href and no target, and never navigates', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { container } = mount(model(), { expand: 'all' });
    expect(container.querySelectorAll('[data-job]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('a, [href], [target]')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('href');
    const push = vi.spyOn(hist, 'push');
    const replace = vi.spyOn(hist, 'replace');
    const before = hist.location.pathname;
    for (const el of [...container.querySelectorAll('[role="button"]')]) {
      fireEvent.click(el);
      fireEvent.keyDown(el, { key: 'Enter' });
    }
    expect(push).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(hist.location.pathname).toBe(before);
    // Only the widget param may change, and only with replace.
    for (const call of replace.mock.calls) {
      expect((call[0] as { pathname: string }).pathname).toBe(before);
    }
  });
});

describe('the open rows in the URL', () => {
  it('writes the opened rows with history replace, never push, and keeps the other params', () => {
    const { container } = mount(model(), { entries: ['/dashboards/ops/overview?kiosk=1&ns=a'] });
    const push = vi.spyOn(hist, 'push');
    const replace = vi.spyOn(hist, 'replace');
    fireEvent.click(byKey(container, WEB));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(param()).toBe(WEB);
    expect(new URLSearchParams(searchNow()).get('kiosk')).toBe('1');
    expect(new URLSearchParams(searchNow()).get('ns')).toBe('a');
    expect(hist.location.pathname).toBe('/dashboards/ops/overview');
    fireEvent.click(byKey(container, WEB_FEAT));
    expect(param()?.split(',').sort()).toEqual([WEB, WEB_FEAT].sort());
    fireEvent.click(byKey(container, WEB));
    expect(param()).toBe(WEB_FEAT);
    fireEvent.click(byKey(container, WEB));
    fireEvent.click(byKey(container, WEB));
    expect(param()).toBe(WEB_FEAT);
  });

  it('removes the param when every row is back to its default', () => {
    const { container } = mount(model());
    fireEvent.click(byKey(container, WEB));
    expect(searchNow()).not.toBe('');
    fireEvent.click(byKey(container, WEB));
    expect(searchNow()).toBe('');
  });

  it('uses the param name w.<instanceId>', () => {
    const { container } = mount(model(), { instanceId: 'runners-9' });
    fireEvent.click(byKey(container, WEB));
    expect(new URLSearchParams(searchNow()).get('w.runners-9')).toBe(WEB);
    expect(param('w.w1')).toBeNull();
  });

  it('restores the open rows from the URL, in kiosk mode too', () => {
    const open = [WEB, WEB_FEAT, WEB_FEAT_CI, WEB_FEAT_CI_JOB3].join(',');
    const entries = [
      `/dashboards/ops/overview?kiosk=1&${new URLSearchParams({ 'w.w1': open }).toString()}`,
    ];
    const { container } = mount(model(), { entries });
    expect(byKey(container, WEB).getAttribute('aria-expanded')).toBe('true');
    expect(byKey(container, WEB_FEAT).getAttribute('aria-expanded')).toBe('true');
    expect(byKey(container, WEB_FEAT_CI).getAttribute('aria-expanded')).toBe('true');
    expect(jobs(container)).toHaveLength(2);
    expect(container.querySelectorAll('[data-step-list] [data-step]')).toHaveLength(2);
    // Other repos stay folded, and reading writes nothing.
    expect(byKey(container, nodeKey('r', 'org-a/api')).getAttribute('aria-expanded')).toBe('false');
    expect(searchNow()).toContain('kiosk=1');
    expect(param()).toBe(open);
  });

  it('keeps the open rows when the data refreshes with a new model', () => {
    const { container, update } = mount(model());
    fireEvent.click(byKey(container, WEB));
    fireEvent.click(byKey(container, WEB_FEAT));
    const search = searchNow();
    update(model());
    update(joinRunners({ pools, queue, runs: panelOf(grouped.runs.map(r => ({ ...r }))) }));
    expect(byKey(container, WEB_FEAT).getAttribute('aria-expanded')).toBe('true');
    expect(names(container, 'workflow')).toEqual(['ci', 'lint']);
    expect(searchNow()).toBe(search);
  });

  it('keeps the open rows when the widget mounts again at the same URL', () => {
    const first = mount(model());
    fireEvent.click(byKey(first.container, WEB));
    const url = `${hist.location.pathname}${hist.location.search}`;
    first.unmount();
    const again = mount(model(), { entries: [url] });
    expect(byKey(again.container, WEB).getAttribute('aria-expanded')).toBe('true');
  });

  it('with expand all opens everything, and the URL holds the folded rows', () => {
    const { container } = mount(model(), { expand: 'all' });
    expect(searchNow()).toBe('');
    for (const r of [...rows(container, 'repo'), ...rows(container, 'ref')]) {
      expect(r.getAttribute('aria-expanded')).toBe('true');
    }
    expect(jobs(container)).toHaveLength(8);
    expect(container.querySelectorAll('[data-step-list]')).toHaveLength(8);
    fireEvent.click(byKey(container, WEB_FEAT));
    expect(byKey(container, WEB_FEAT).getAttribute('aria-expanded')).toBe('false');
    expect(param()).toBe(WEB_FEAT);
    expect(container.querySelector(`[data-group-key="${WEB_FEAT_CI}"]`)).toBeNull();
    fireEvent.click(byKey(container, WEB_FEAT));
    expect(searchNow()).toBe('');
  });

  it('never prunes on read, and drops a stale key only when it writes', () => {
    const stale = nodeKey('r', 'gone/repo');
    const entries = [
      `/dashboards/ops/overview?${new URLSearchParams({ 'w.w1': stale }).toString()}`,
    ];
    const { container } = mount(model(), { entries });
    expect(param()).toBe(stale);
    expect(rows(container, 'ref')).toHaveLength(0);
    fireEvent.click(byKey(container, WEB));
    expect(param()).toBe(WEB);
  });

  it('draws the view in edit mode, but does not write the URL', () => {
    const { container } = mount(model(), { editing: true });
    const replace = vi.spyOn(hist, 'replace');
    fireEvent.click(byKey(container, WEB));
    expect(byKey(container, WEB).getAttribute('aria-expanded')).toBe('true');
    expect(names(container, 'ref')).toEqual(['PR #7feat-x', 'main']);
    fireEvent.click(byKey(container, WEB_FEAT));
    expect(rows(container, 'workflow')).toHaveLength(2);
    expect(replace).not.toHaveBeenCalled();
    expect(searchNow()).toBe('');
  });

  it('works with no widget id, in the view only', () => {
    const { container } = mount(model(), { instanceId: null });
    const replace = vi.spyOn(hist, 'replace');
    fireEvent.click(byKey(container, WEB));
    expect(byKey(container, WEB).getAttribute('aria-expanded')).toBe('true');
    expect(replace).not.toHaveBeenCalled();
    expect(searchNow()).toBe('');
  });

  it('follows the URL when it changes, as with Back', () => {
    const { container } = mount(model());
    fireEvent.click(byKey(container, WEB));
    expect(rows(container, 'ref')).toHaveLength(2);
    act(() => {
      hist.replace({ pathname: hist.location.pathname, search: '' });
    });
    expect(rows(container, 'ref')).toHaveLength(0);
  });
});

describe('job counts in the rows', () => {
  const withCounts = (
    id: string,
    repo: string,
    state: string,
    seconds: number,
    counts: unknown,
    extra: RunOpts = {}
  ) => run(id, repo, state, seconds, { ...extra, counts });
  const jobsPanel = panelOf(
    [
      withCounts('c1', 'org-a/web', 'running', 100, { running: 4, queued: 2 }),
      withCounts('c2', 'org-a/web', 'running', 50, { running: 1, queued: 0 }),
      withCounts('c3', 'org-a/api', 'running', 10, { running: 2, queued: 1 }),
      withCounts('c4', 'org-b/app', 'queued', 300, { running: 0, queued: 2 }),
      withCounts('c5', 'org-b/app', 'running', 20, { running: 6, queued: 0 }),
    ],
    { jobs: { running: 13, queued: 5 } }
  );

  it('parses the counts of each run and the totals of the source', () => {
    expect(jobsPanel.jobs).toEqual({ running: 13, queued: 5 });
    expect(jobsPanel.runs.map(r => r.counts)).toEqual([
      { running: 4, queued: 2 },
      { running: 1, queued: 0 },
      { running: 2, queued: 1 },
      { running: 0, queued: 2 },
      { running: 6, queued: 0 },
    ]);
  });

  it('never throws on bad counts, and leaves them out', () => {
    const bad = panelOf(
      [
        withCounts('b1', 'o/r', 'running', 1, { running: -1, queued: 0 }),
        withCounts('b2', 'o/r', 'running', 1, 'none'),
        withCounts('b3', 'o/r', 'running', 1, { running: 1 }),
        withCounts('b4', 'o/r', 'running', 1, null),
        withCounts('b5', 'o/r', 'running', 1, { running: 2.9, queued: 1 }),
      ],
      { jobs: { running: 'many', queued: 1 } }
    );
    expect(bad.jobs).toBeUndefined();
    expect(bad.runs.map(r => r.counts)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      { running: 2, queued: 1 },
    ]);
  });

  it('sums the counts of the runs in each repo, not the number of runs', () => {
    const tree = groupTree(jobsPanel.runs);
    expect(tree.map(r => [r.name, r.running, r.queued])).toEqual([
      ['org-b/app', 6, 2],
      ['org-a/web', 5, 2],
      ['org-a/api', 2, 1],
    ]);
    expect(tree.reduce((n, r) => n + r.running, 0)).toBe(13);
    expect(tree.reduce((n, r) => n + r.queued, 0)).toBe(5);
  });

  it('orders by the running job count, then by the longest time', () => {
    const flip = groupTree([
      withCounts('f1', 'o/few', 'running', 900, { running: 1, queued: 0 }),
      withCounts('f2', 'o/many', 'running', 5, { running: 3, queued: 0 }),
    ] as never);
    expect(flip.map(r => r.name)).toEqual(['o/many', 'o/few']);
  });

  it('falls back to one job for each run when the counts are missing', () => {
    const web = groupTree(grouped.runs).find(r => r.name === 'org-a/web')!;
    expect(web).toMatchObject({ running: 3, queued: 1 });
    const mixed = groupTree([
      withCounts('m1', 'o/r', 'running', 5, { running: 4, queued: 1 }),
      run('m2', 'o/r', 'queued', 9),
    ] as never);
    expect(mixed[0]).toMatchObject({ running: 4, queued: 2 });
  });

  it('shows no unlisted note when the listed jobs equal the totals, or no totals exist', () => {
    expect(joinRunners({ pools, queue, runs: jobsPanel }).unlisted).toBe(0);
    expect(joinRunners({ pools, queue, runs: grouped }).unlisted).toBe(0);
    expect(joinRunners({ pools, queue, runs: null }).unlisted).toBe(0);
    const { container } = mount(joinRunners({ pools, queue, runs: jobsPanel }));
    expect(container.querySelector('[data-runners-unlisted]')).toBeNull();
  });

  it('shows the jobs of the runs that the source did not list, with no Other group', () => {
    const capped = panelOf(jobsPanel.runs, { jobs: { running: 20, queued: 6 } });
    const m = joinRunners({ pools, queue, runs: capped });
    expect(m.unlisted).toBe(7 + 1);
    const { container } = mount(m);
    expect(container.querySelector('[data-runners-unlisted]')?.textContent).toMatch(
      /\+8 jobs not listed/
    );
    expect(container.querySelector('[data-runners-summary]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/\d+ more|\bOther\b/);
    cleanup();
    const one = panelOf(jobsPanel.runs, { jobs: { running: 14, queued: 5 } });
    const v = mount(joinRunners({ pools, queue, runs: one }));
    expect(v.container.querySelector('[data-runners-unlisted]')?.textContent).toMatch(
      /\+1 job not listed/
    );
  });

  it('draws the sums in the repo rows, and the sum of the repos equals the tiles', () => {
    const { container } = mount(joinRunners({ pools, queue: emptyQueue, runs: jobsPanel }));
    const sum = (attr: string) =>
      [...container.querySelectorAll(`[data-group="repo"] [${attr}]`)].reduce(
        (n, e) => n + Number(/\d+/.exec(e.textContent ?? '')?.[0] ?? 0),
        0
      );
    expect(sum('data-group-running')).toBe(13);
    expect(sum('data-group-queued')).toBe(5);
    const web = byKey(container, nodeKey('r', 'org-a/web'));
    expect(web.querySelector('[data-group-running]')?.textContent).toBe('5 running');
    expect(web.querySelector('[data-group-queued]')?.textContent).toBe('2 queued');
  });

  describe('one snapshot for the tiles and the rows', () => {
    // The pools panel is from an older moment: other generatedAt and other totals.
    const older = parsePanel({
      version: 1,
      id: 'pools',
      title: 'Pools',
      status: 'ok',
      summary: '2 pools, 9 running, 1 queued',
      generatedAt: '2026-11-22T12:42:45Z',
      stats: [
        { label: 'Running', value: '9', status: 'ok' },
        { label: 'Queued', value: '1', status: 'ok' },
        { label: 'Free', value: '390', status: 'ok' },
        { label: 'Pools', value: '2', status: 'ok' },
      ],
      rows: [
        { label: 'pool-a', detail: '4 running, 1 queued, 195 free', value: '4/200', status: 'ok' },
        { label: 'pool-b', detail: '5 running, 0 queued, 195 free', value: '5/200', status: 'ok' },
      ],
    });
    const newer = panelOf(jobsPanel.runs, {
      generatedAt: '2026-11-22T12:43:08Z',
      jobs: { running: 13, queued: 5 },
    });
    const tile = (c: HTMLElement, label: string): string | undefined =>
      [...c.querySelectorAll('[data-stat]')]
        .find(e => e.querySelector('[data-stat-label]')?.textContent === label)
        ?.querySelector('[data-stat-value]')?.textContent ?? undefined;

    it('takes Running, Queued and the summary from the runs panel, not the older pools panel', () => {
      const m = joinRunners({ pools: older, queue, runs: newer });
      expect(m.stats.map(s => [s.label, s.value])).toEqual([
        ['Running', '13'],
        ['Queued', '5'],
        ['Free', '390'],
        ['Pools', '2'],
        ['Oldest wait', '35s'],
      ]);
      expect(m.summary).toBe('2 pools, 13 running, 5 queued');
    });

    it('draws tiles that equal the sums of the repo rows', () => {
      const { container } = mount(joinRunners({ pools: older, queue: emptyQueue, runs: newer }));
      const sum = (attr: string) =>
        [...container.querySelectorAll(`[data-group="repo"] [${attr}]`)].reduce(
          (n, e) => n + Number(/\d+/.exec(e.textContent ?? '')?.[0] ?? 0),
          0
        );
      expect(tile(container, 'Running')).toBe(String(sum('data-group-running')));
      expect(tile(container, 'Queued')).toBe(String(sum('data-group-queued')));
      expect(container.querySelector('[data-runners-summary]')?.textContent).toBe(
        '2 pools, 13 running, 5 queued'
      );
      expect(container.querySelector('[data-runners-unlisted]')).toBeNull();
      // The rings still come from the pools panel.
      expect([...container.querySelectorAll('[data-pool-value]')].map(v => v.textContent)).toEqual([
        '4/200',
        '5/200',
      ]);
    });

    it('counts the unlisted jobs against the same totals as the tiles', () => {
      const capped = panelOf(jobsPanel.runs, { jobs: { running: 20, queued: 6 } });
      const m = joinRunners({ pools: older, queue, runs: capped });
      expect(m.stats[0].value).toBe('20');
      expect(m.stats[1].value).toBe('6');
      expect(m.unlisted).toBe(20 - 13 + (6 - 5));
    });

    it('falls back to the pools stats and summary when the runs panel has no job totals', () => {
      const noTotals = panelOf(jobsPanel.runs);
      const m = joinRunners({ pools: older, queue, runs: noTotals });
      expect(m.stats.slice(0, 2).map(s => s.value)).toEqual(['9', '1']);
      expect(m.summary).toBe('2 pools, 9 running, 1 queued');
    });
  });
});

describe('the expand and view options', () => {
  const open = (container: HTMLElement, sel: string) =>
    [...container.querySelectorAll(sel)].map(e => e.getAttribute('aria-expanded'));

  it('reads the options of a saved config and ignores a wrong value', () => {
    expect(expandOf('all')).toBe('all');
    expect(expandOf(undefined)).toBe('default');
    expect(expandOf('everything')).toBe('default');
    expect(viewOf('summary')).toBe('summary');
    expect(viewOf('list')).toBe('list');
    expect(viewOf('x')).toBe('full');
    expect(viewOf(undefined)).toBe('full');
  });

  it('keeps the default without the option: repos folded, nothing below them drawn', () => {
    const { container } = mount(model());
    expect(new Set(open(container, '[data-group="repo"]'))).toEqual(new Set(['false']));
    expect(container.querySelector('[data-group="ref"]')).toBeNull();
    expect(container.querySelector('[data-job]')).toBeNull();
  });

  it('with expand all opens every repo, ref, workflow and job, with no collapse', () => {
    const { container } = mount(model(), { expand: 'all' });
    expect(new Set(open(container, '[data-group]'))).toEqual(new Set(['true']));
    expect(rows(container, 'repo')).toHaveLength(5);
    expect(rows(container, 'ref')).toHaveLength(6);
    expect(rows(container, 'workflow')).toHaveLength(7);
    expect(jobs(container)).toHaveLength(8);
    expect(new Set(open(container, '[data-job]'))).toEqual(new Set(['true']));
    expect(container.textContent).not.toMatch(/\d+ more|\bOther\b/);
  });

  it('with expand all a click still folds any row, and a click again reopens it', () => {
    const { container } = mount(model(), { expand: 'all' });
    fireEvent.click(byKey(container, WEB_FEAT_CI));
    expect(byKey(container, WEB_FEAT_CI).getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector(`[data-job-key="${WEB_FEAT_CI_JOB3}"]`)).toBeNull();
    fireEvent.click(byKey(container, WEB_FEAT_CI));
    expect(container.querySelector(`[data-job-key="${WEB_FEAT_CI_JOB3}"]`)).not.toBeNull();
    fireEvent.click(container.querySelector(`[data-job-key="${WEB_FEAT_CI_JOB3}"]`)!);
    expect(container.querySelectorAll('[data-step-list]')).toHaveLength(7);
  });

  it('draws the list only, with no tiles and no rings, for the list view', () => {
    const { container } = mount(model(), { view: 'list', expand: 'all' });
    expect(container.querySelector('[data-stats]')).toBeNull();
    expect(container.querySelector('[data-pools]')).toBeNull();
    expect(container.querySelector('[data-group="repo"]')).not.toBeNull();
  });

  it('leaves the summary line to the strip in the list view, and keeps the unlisted note', () => {
    const cut = panelOf(
      [run('c1', 'org-a/web', 'running', 5, { counts: { running: 2, queued: 1 } })],
      {
        jobs: { running: 10, queued: 5 },
      }
    );
    const draw = (v: 'full' | 'list') =>
      mount(joinRunners({ pools, queue, runs: cut }), { view: v }).container;
    const list = draw('list');
    expect(list.querySelector('[data-runners-summary]')).toBeNull();
    expect(list.querySelector('[data-runners-unlisted]')?.textContent).toBe('+12 jobs not listed');
    cleanup();
    const full = draw('full');
    expect(full.querySelector('[data-runners-summary]')).not.toBeNull();
    expect(full.querySelector('[data-runners-unlisted]')?.textContent).toBe(
      ', +12 jobs not listed'
    );
    cleanup();
    // With every job listed the list view has no footer at all.
    const whole = mount(model(), { view: 'list' });
    expect(whole.container.querySelector('[data-runners-summary]')).toBeNull();
    expect(whole.container.querySelector('[data-runners-unlisted]')).toBeNull();
  });

  it('draws the tiles and the rings in one strip, and no list, for the summary view', () => {
    const { container } = mount(model(), { view: 'summary' });
    expect(container.querySelector('[data-runners-strip] [data-stats]')).not.toBeNull();
    expect(container.querySelector('[data-runners-strip] [data-pools]')).not.toBeNull();
    expect(container.querySelector('[data-group]')).toBeNull();
    expect(container.querySelector('[data-scroll-area]')).toBeNull();
    expect(container.querySelectorAll('[data-pool]')).toHaveLength(2);
  });

  it('draws smaller tile values in the strip, so a long wait never touches a ring', () => {
    const size = (v: 'full' | 'summary') =>
      getComputedStyle(
        mount(model(), { view: v }).container.querySelector('[data-stat-value]') as HTMLElement
      ).fontSize;
    expect(size('full')).toBe('24px');
    expect(size('summary')).toBe('20px');
    cleanup();
  });

  it('draws the tiles, the rings and the list for the full view', () => {
    const { container } = mount(model(), { view: 'full' });
    expect(container.querySelector('[data-stats]')).not.toBeNull();
    expect(container.querySelector('[data-pools]')).not.toBeNull();
    expect(container.querySelector('[data-group="repo"]')).not.toBeNull();
    expect(container.querySelector('[data-runners-strip]')).toBeNull();
  });
});

/** An RFC 3339 time that lies `minutes` minutes before now. */
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

describe('GitHub-hosted jobs and idle repos', () => {
  const hjob = (id: string, pool: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `job-${id}`,
    state: 'running',
    pool,
    seconds: 30,
    steps: [step('Build', 'running')],
    ...extra,
  });
  const hrun = (id: string, repo: string, jobsList: unknown[], counts?: unknown) =>
    run(id, repo, 'running', 100, { jobs: jobsList, counts });
  const runsPanel = panelOf([
    // One job on a pool of the source, one with no pool (GitHub-hosted).
    hrun('h1', 'my-org/my-repo', [hjob('ja', 'pool-a'), hjob('jh', '')], { running: 2, queued: 0 }),
    // Every job on a pool that the source does not list.
    hrun('h2', 'my-org/hosted-only', [hjob('jx', 'ubuntu-latest')], { running: 1, queued: 0 }),
    // The source says so with the flag, whatever the pool.
    hrun('h3', 'my-org/flag-only', [hjob('jf', 'pool-a', { hosted: true })], {
      running: 1,
      queued: 0,
    }),
    // The flag wins over an empty pool.
    hrun('h4', 'my-org/flag-false', [hjob('jn', '', { hosted: false })], { running: 1, queued: 0 }),
  ]);
  const reposPanel = parsePanel({
    version: 1,
    id: 'repos',
    title: 'Repos',
    repos: [
      { repo: 'my-org/idle-old', lastRunAt: ago(300), lastConclusion: 'failure' },
      { repo: 'my-org/idle-new', lastRunAt: ago(80), lastConclusion: 'success' },
      { repo: 'my-org/idle-hosted', lastRunAt: ago(10), hosted: true },
      { repo: 'my-org/hosted-only', lastRunAt: ago(5), hosted: true },
      { repo: 'my-org/never' },
      { repo: '' },
      { lastRunAt: ago(1) },
      7,
      { repo: 'my-org/bad-time', lastRunAt: 'yesterday', hosted: 'yes' },
    ],
  });
  const withRepos = () =>
    joinRunners({ pools, queue: emptyQueue, runs: runsPanel, repos: reposPanel });
  const MY = nodeKey('r', 'my-org/my-repo');
  const toggle = (c: HTMLElement) =>
    c.querySelector('[data-hosted-toggle] input') as HTMLInputElement;

  it('reads the repos panel, and drops bad entries and bad fields', () => {
    expect(reposPanel.repos?.map(r => r.repo)).toEqual([
      'my-org/idle-old',
      'my-org/idle-new',
      'my-org/idle-hosted',
      'my-org/hosted-only',
      'my-org/never',
      'my-org/bad-time',
    ]);
    expect(reposPanel.repos?.[1]).toMatchObject({ lastConclusion: 'success' });
    expect(reposPanel.repos?.[2].hosted).toBe(true);
    expect(reposPanel.repos?.[4]).toEqual({ repo: 'my-org/never' });
    expect(reposPanel.repos?.[5]).toEqual({ repo: 'my-org/bad-time' });
    expect(parsePanel({ version: 1, id: 'runs' }).repos).toBeUndefined();
    expect(parsePanel({ version: 1, id: 'repos', repos: 'x' }).repos).toBeUndefined();
    const job = panelOf([
      hrun('p', 'a/b', [hjob('j', 'p', { hosted: 'yes' }), hjob('k', 'p', { hosted: true })]),
    ]);
    expect(job.runs[0].jobs.map(j => j.hosted)).toEqual([undefined, true]);
  });

  it('decides what is GitHub-hosted: the flag first, else an empty or unknown pool', () => {
    const pl = new Set(['pool-a']);
    expect(isHostedJob({ hosted: true, pool: 'pool-a' }, pl)).toBe(true);
    expect(isHostedJob({ hosted: false, pool: '' }, pl)).toBe(false);
    expect(isHostedJob({ pool: '' }, pl)).toBe(true);
    expect(isHostedJob({ pool: 'ubuntu' }, pl)).toBe(true);
    expect(isHostedJob({ pool: 'pool-a' }, pl)).toBe(false);
    // With no pools panel, a pool name proves nothing. Only an empty pool is hosted.
    expect(isHostedJob({ pool: 'ubuntu' }, new Set())).toBe(false);
    expect(isHostedJob({ pool: '' }, new Set())).toBe(true);
  });

  it('hides GitHub-hosted jobs by default, and the runs, groups and repos that only have them', () => {
    const { container } = mount(withRepos());
    const list = names(container, 'repo');
    expect(list).toContain('my-org/my-repo');
    expect(list).toContain('my-org/flag-false');
    expect(list).not.toContain('my-org/flag-only');
    expect(list).not.toContain('my-org/hosted-only');
    expect(container.querySelector('[data-hosted-chip]')).toBeNull();
    fireEvent.click(byKey(container, MY));
    fireEvent.click(container.querySelector('[data-group="ref"]')!);
    fireEvent.click(container.querySelector('[data-group="workflow"]')!);
    expect(jobs(container).map(j => j.getAttribute('data-job'))).toEqual(['ja']);
    // The counts are the visible jobs: 2 jobs in the run, 1 of them hosted.
    expect(byKey(container, MY).querySelector('[data-group-running]')?.textContent).toBe(
      '1 running'
    );
    expect(toggle(container).checked).toBe(false);
  });

  it('shows them with a GitHub-hosted chip when the filter is on, and writes it to the URL', () => {
    const { container } = mount(withRepos(), { entries: ['/dashboards/ops/overview?kiosk=1'] });
    const push = vi.spyOn(hist, 'push');
    const replace = vi.spyOn(hist, 'replace');
    fireEvent.click(toggle(container));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(param('w.w1.hosted')).toBe('1');
    expect(new URLSearchParams(searchNow()).get('kiosk')).toBe('1');
    expect(toggle(container).checked).toBe(true);
    const list = names(container, 'repo');
    expect(list).toContain('my-org/flag-only');
    expect(list).toContain('my-org/hosted-only');
    // A repo with only hosted jobs has the chip. A repo with some has none on the repo row.
    const chip = (key: string) =>
      byKey(container, nodeKey('r', key)).querySelector('[data-hosted-chip]');
    expect(chip('my-org/flag-only')?.textContent).toBe('GitHub-hosted');
    expect(chip('my-org/hosted-only')?.textContent).toBe('GitHub-hosted');
    expect(chip('my-org/my-repo')).toBeNull();
    expect(chip('my-org/flag-false')).toBeNull();
    // The counts now include the hosted job.
    expect(byKey(container, MY).querySelector('[data-group-running]')?.textContent).toBe(
      '2 running'
    );
    // Inside the repo: the hosted job has the chip, the other has not.
    fireEvent.click(byKey(container, MY));
    fireEvent.click(
      container.querySelector(`[data-group="ref"][data-group-key^="b|my-org/my-repo"]`)!
    );
    fireEvent.click(
      container.querySelector(`[data-group="workflow"][data-group-key^="w|my-org/my-repo"]`)!
    );
    const chipOf = (id: string) =>
      container.querySelector(`[data-job="${id}"] [data-hosted-chip]`)?.textContent ?? null;
    expect(chipOf('jh')).toBe('GitHub-hosted');
    expect(chipOf('ja')).toBeNull();
    // Turning it off removes the param.
    fireEvent.click(toggle(container));
    expect(param('w.w1.hosted')).toBeNull();
    expect(names(container, 'repo')).not.toContain('my-org/flag-only');
  });

  it('restores the filter from the URL and keeps it when the data refreshes', () => {
    const { container, update } = mount(withRepos(), {
      entries: ['/dashboards/ops/overview?w.w1.hosted=1'],
    });
    expect(toggle(container).checked).toBe(true);
    expect(names(container, 'repo')).toContain('my-org/flag-only');
    update(withRepos());
    expect(toggle(container).checked).toBe(true);
    expect(names(container, 'repo')).toContain('my-org/flag-only');
  });

  it('keeps the open rows and the filter apart: both params stay', () => {
    const { container } = mount(withRepos());
    fireEvent.click(toggle(container));
    fireEvent.click(byKey(container, MY));
    expect(param()).toBe(MY);
    expect(param('w.w1.hosted')).toBe('1');
    fireEvent.click(toggle(container));
    expect(param()).toBe(MY);
    expect(param('w.w1.hosted')).toBeNull();
  });

  it('keeps a key of a hidden hosted node when it writes, and drops only dead keys', () => {
    const hostedRow = nodeKey('r', 'my-org/flag-only');
    const entries = [
      `/dashboards/ops/overview?${new URLSearchParams({
        'w.w1': `${hostedRow},r|gone/repo`,
      }).toString()}`,
    ];
    const { container } = mount(withRepos(), { entries });
    fireEvent.click(byKey(container, MY));
    expect(param()?.split(',').sort()).toEqual([MY, hostedRow].sort());
  });

  it('does not write the filter to the URL in edit mode, but still applies it', () => {
    const { container } = mount(withRepos(), { editing: true });
    const replace = vi.spyOn(hist, 'replace');
    fireEvent.click(toggle(container));
    expect(names(container, 'repo')).toContain('my-org/flag-only');
    expect(replace).not.toHaveBeenCalled();
    expect(searchNow()).toBe('');
  });

  it('shows no switch when no job is GitHub-hosted', () => {
    const { container } = mount(model());
    expect(container.querySelector('[data-hosted-toggle]')).toBeNull();
    expect(container.querySelector('[data-hosted-chip]')).toBeNull();
  });

  it('lists an idle repo with its last run time, folded, with no children', () => {
    const { container } = mount(withRepos());
    const row = byKey(container, nodeKey('r', 'my-org/idle-new'));
    expect(row.querySelector('[data-last-run]')?.textContent).toBe('last run 1h 20m ago');
    const title = row.querySelector('[data-last-run]')?.getAttribute('title') ?? '';
    expect(title).toContain(String(new Date(Date.now() - 80 * 60_000).getFullYear()));
    expect(title).toContain('success');
    expect(row.querySelector('[data-group-running], [data-group-queued]')).toBeNull();
    expect(row.hasAttribute('aria-expanded')).toBe(false);
    expect(row.getAttribute('role')).toBeNull();
    fireEvent.click(row);
    expect(searchNow()).toBe('');
    expect(
      rows(container, 'ref').filter(r => r.getAttribute('data-group-key')?.includes('idle-new'))
    ).toHaveLength(0);
    // A repo with no run time says so.
    const never = byKey(container, nodeKey('r', 'my-org/never'));
    expect(never.querySelector('[data-last-run]')?.textContent).toBe('no recent run');
  });

  it('orders the repos with jobs first, then the idle repos by the last run, newest first', () => {
    const { container } = mount(withRepos());
    expect(names(container, 'repo')).toEqual([
      'my-org/my-repo',
      'my-org/flag-false',
      'my-org/idle-new',
      'my-org/idle-old',
      'my-org/never',
      'my-org/bad-time',
    ]);
  });

  it('hides an idle repo that the source calls hosted, unless the filter is on', () => {
    const { container } = mount(withRepos());
    expect(names(container, 'repo')).not.toContain('my-org/idle-hosted');
    cleanup();
    const on = mount(withRepos(), { entries: ['/dashboards/ops/overview?w.w1.hosted=1'] });
    const names2 = names(on.container, 'repo');
    expect(names2).toContain('my-org/idle-hosted');
    // Newest idle first: idle-hosted ran 10 minutes ago.
    expect(names2.indexOf('my-org/idle-hosted')).toBeLessThan(names2.indexOf('my-org/idle-new'));
    const row = byKey(on.container, nodeKey('r', 'my-org/idle-hosted'));
    expect(row.querySelector('[data-hosted-chip]')?.textContent).toBe('GitHub-hosted');
  });

  it('works with no repos panel: the repos of the runs and of the queue, no idle repo', () => {
    const { container } = mount(
      joinRunners({ pools, queue, runs: runsPanel }) // queue has org/repo-a
    );
    expect(names(container, 'repo')).toEqual(['my-org/my-repo', 'my-org/flag-false', 'org/repo-a']);
    expect(container.querySelector('[data-last-run]')).toBeNull();
    const queued = byKey(container, nodeKey('r', 'org/repo-a'));
    expect(queued.querySelector('[data-group-queued]')?.textContent).toBe('1 queued');
    expect(queued.hasAttribute('aria-expanded')).toBe(false);
    // A hosted-only repo is not listed: nothing says that it exists.
    expect(names(container, 'repo')).not.toContain('my-org/hosted-only');
  });

  it('works with none of the new fields: nothing is hidden, nothing is idle', () => {
    const { container } = mount(model());
    expect(rows(container, 'repo')).toHaveLength(5);
    expect(container.querySelector('[data-last-run]')).toBeNull();
    expect(container.querySelector('[data-hosted-chip]')).toBeNull();
  });

  it('lists a repo of the repos panel once, also when a run lists it', () => {
    const p = parsePanel({
      version: 1,
      id: 'repos',
      repos: [{ repo: 'my-org/my-repo', lastRunAt: ago(3) }],
    });
    const { container } = mount(
      joinRunners({ pools, queue: emptyQueue, runs: runsPanel, repos: p })
    );
    expect(names(container, 'repo').filter(n => n === 'my-org/my-repo')).toHaveLength(1);
    expect(byKey(container, MY).querySelector('[data-last-run]')).toBeNull();
  });
});
