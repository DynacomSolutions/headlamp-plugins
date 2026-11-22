import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn(), clusterRequest: vi.fn() },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));

import { LinkContext } from '../../links';
import { parsePanel } from '../panels/model';
import {
  capOf,
  countsOf,
  formatWait,
  groupRuns,
  joinRunners,
  orderRuns,
  placeOf,
  progressOf,
  splitRepo,
  STEP_GAP,
  STEP_MIN_SEGMENT,
  stepBarLayout,
  stepsOfRun,
} from './join';
import { countsText, resetRunnerFolds, ringShares, RunnersView } from './RunnersView';

afterEach(() => {
  cleanup();
  resetRunnerFolds();
});

const pools = parsePanel({
  version: 1,
  id: 'pools',
  title: 'Pools',
  status: 'ok',
  summary: '2 pools, 9 running, 1 queued',
  link: 'https://runners.example.com/overview',
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
      link: 'https://runners.example.com/jobs/1',
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

const LINKS = { base: '/c/main', dashboard: 'ops', tabs: ['overview', 'runners'] };
/** Open every repo group, so a test can reach the run rows. A repo is folded at first. */
const openRepos = (container: HTMLElement) => {
  for (const h of container.querySelectorAll('[data-group="repo"][aria-expanded="false"]')) {
    fireEvent.click(h);
  }
};

const viewFolded = (model: ReturnType<typeof joinRunners>, mode: 'dark' | 'light' = 'dark') =>
  render(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <MemoryRouter>
        <LinkContext.Provider value={LINKS}>
          <RunnersView model={model} sourceId="runners" editing={false} />
        </LinkContext.Provider>
      </MemoryRouter>
    </ThemeProvider>
  );

/** The view with every repo open, for the tests about the rows under a repo. */
const view = (model: ReturnType<typeof joinRunners>, mode: 'dark' | 'light' = 'dark') => {
  const r = viewFolded(model, mode);
  openRepos(r.container);
  return r;
};

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
    expect(stepsOfRun(runs.runs[2])).toHaveLength(6);
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
    const { container } = view(model);
    expect([...container.querySelectorAll('[data-stat]')]).toHaveLength(5);
    expect(container.textContent).toContain('Oldest wait');
    const names = [...container.querySelectorAll('[data-pool]')].map(e =>
      e.getAttribute('data-pool')
    );
    expect(names).toEqual(['pool-a', 'pool-b']);
    const values = [...container.querySelectorAll('[data-pool-value]')];
    expect(values.map(v => v.textContent)).toEqual(['4/200', '5/200']);
    expect(new Set(values.map(v => getComputedStyle(v).fontSize)).size).toBe(1);
    expect(container.querySelector('[data-ring="queued"]')).not.toBeNull();
    expect(container.querySelector('[data-runners-summary]')?.textContent).toBe(
      '2 pools, 9 running, 1 queued'
    );
  });

  it('shows the queue rows without a tree when the source has no runs panel', () => {
    const { container } = view(joinRunners({ pools, queue, runs: null }));
    const rows = container.querySelectorAll('[data-queue-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('org/repo-a');
    expect(rows[0].textContent).toContain('35s');
    expect(container.querySelector('[data-run]')).toBeNull();
  });

  it('shows one quiet line when nothing is queued', () => {
    const { container } = view(joinRunners({ pools, queue: emptyQueue, runs: null }));
    expect(container.querySelector('[data-runners-empty]')?.textContent).toBe('No queued jobs');
  });

  it('draws every run collapsed, with a step bar, and no "more" row', () => {
    const { container } = view(joinRunners({ pools, queue, runs }));
    const rows = [...container.querySelectorAll('[data-run]')];
    expect(rows.map(r => r.getAttribute('data-run'))).toEqual([
      'r-long',
      'r-short',
      'q-old',
      'q-new',
    ]);
    expect(container.querySelector('[data-job]')).toBeNull();
    const long = rows[0];
    expect(long.querySelectorAll('[data-step-state]')).toHaveLength(6);
    expect(long.textContent).toContain('step 2 of 6 · Build');
    expect(rows[2].textContent).toContain('Waiting for a runner');
    expect(container.textContent).not.toMatch(/\+\s*\d+ more|\d+ more/i);
  });

  it('expands a run to its jobs, and a job to its steps', () => {
    const { container } = view(joinRunners({ pools, queue, runs }));
    fireEvent.click(container.querySelector('[data-run="r-long"]')!);
    const jobs = container.querySelectorAll('[data-job]');
    expect(jobs).toHaveLength(2);
    expect(container.querySelector('[data-step-list]')).toBeNull();
    fireEvent.click(jobs[0]);
    expect(container.querySelectorAll('[data-step-list] [data-step]')).toHaveLength(3);
    fireEvent.click(container.querySelector('[data-run="r-long"]')!);
    expect(container.querySelector('[data-job]')).toBeNull();
  });

  it('colours the step segments by state, with a distinct colour for each', () => {
    const { container } = view(joinRunners({ pools, queue, runs }));
    fireEvent.click(container.querySelector('[data-run="r-long"]')!);
    const colour = (state: string) =>
      getComputedStyle(container.querySelector(`[data-step-state="${state}"]`)!).backgroundColor;
    const all = ['done', 'running', 'failed', 'skipped', 'pending'].map(colour);
    expect(new Set(all).size).toBe(5);
  });

  it('links only to the runner tab of the dashboard', () => {
    const { container } = view(joinRunners({ pools, queue, runs }));
    const anchors = [...container.querySelectorAll('a')];
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) expect(a.getAttribute('href')).toBe('/c/main/dashboards/ops/runners');
    expect(container.innerHTML).not.toContain('example.com');
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
    const { container } = view(joinRunners({ pools, queue, runs: runOfSteps(total, 2) }));
    const bar = container.querySelector('[data-run] [data-step-bar]') as HTMLElement;
    const label = container.querySelector('[data-run] [data-progress-text]') as HTMLElement;
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
    const { container } = view(joinRunners({ pools, queue, runs: runOfSteps(80, 20, true) }));
    const bar = container.querySelector('[data-run] [data-step-bar]') as HTMLElement;
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

const run = (id: string, repo: string, state: string, seconds: number) => ({
  id,
  repo,
  workflow: `wf-${id}`,
  ref: 'main',
  pool: 'pool-a',
  state,
  seconds,
  jobs: [
    {
      id: `${id}-j`,
      name: 'job',
      state,
      pool: 'pool-a',
      seconds,
      steps: [step('Checkout', 'done'), step('Build', 'running')],
    },
  ],
});
const grouped = parsePanel({
  version: 1,
  id: 'runs',
  title: 'Runs',
  status: 'ok',
  summary: '',
  runs: [
    run('a1', 'org-b/app', 'queued', 500),
    run('a2', 'org-a/api', 'running', 30),
    run('a3', 'org-a/web', 'running', 200),
    run('a4', 'org-a/web', 'running', 10),
    run('a5', 'org-a/web', 'queued', 60),
    run('a6', 'org-c/tool', 'running', 5),
    run('a7', 'org-c/tool', 'running', 6),
    run('a8', 'loose', 'queued', 1),
  ],
});

describe('grouping by org and repo', () => {
  it('splits the org from the repo name', () => {
    expect(splitRepo('org/.cluster')).toEqual({ org: 'org', name: '.cluster' });
    expect(splitRepo('org/a/b')).toEqual({ org: 'org', name: 'a/b' });
    expect(splitRepo('loose')).toEqual({ org: 'No org', name: 'loose' });
    expect(splitRepo('/x')).toEqual({ org: 'No org', name: '/x' });
  });

  it('counts running and queued runs and the longest time in each group', () => {
    const groups = groupRuns(grouped.runs ?? []);
    const a = groups.find(g => g.name === 'org-a')!;
    expect(a).toMatchObject({ running: 3, queued: 1, longest: 200 });
    const web = a.repos.find(r => r.name === 'web')!;
    expect(web).toMatchObject({ key: 'org-a/web', running: 2, queued: 1, longest: 200 });
    expect(groups.flatMap(g => g.repos.flatMap(r => r.runs))).toHaveLength(8);
  });

  it('orders orgs and repos by running count, then by longest time', () => {
    const groups = groupRuns(grouped.runs ?? []);
    expect(groups.map(g => g.name)).toEqual(['org-a', 'org-c', 'org-b', 'No org']);
    expect(groups[0].repos.map(r => r.name)).toEqual(['web', 'api']);
    const tie = groupRuns([
      run('x1', 'o/short', 'running', 5),
      run('x2', 'o/long', 'running', 50),
    ] as never);
    expect(tie[0].repos.map(r => r.name)).toEqual(['long', 'short']);
  });

  it('keeps the order of the runs inside a repo', () => {
    const web = groupRuns(grouped.runs ?? [])[0].repos[0];
    expect(web.runs.map(r => r.id)).toEqual(['a3', 'a4', 'a5']);
  });

  it('writes the counts as text', () => {
    expect(countsText({ running: 2, queued: 1 })).toBe('2 running, 1 queued');
    expect(countsText({ running: 0, queued: 3 })).toBe('3 queued');
    expect(countsText({ running: 0, queued: 0 })).toBe('idle');
  });
});

describe('the grouped list', () => {
  const draw = () => viewFolded(joinRunners({ pools, queue, runs: grouped }));
  const drawOpen = () => view(joinRunners({ pools, queue, runs: grouped }));

  const HEADS = [
    'org:org-a',
    'repo:org-a/web',
    'repo:org-a/api',
    'org:org-c',
    'repo:org-c/tool',
    'org:org-b',
    'repo:org-b/app',
    'org:No org',
    'repo:No org/loose',
  ];
  const headsOf = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-group]')].map(
      h => `${h.getAttribute('data-group')}:${h.getAttribute('data-group-key')}`
    );

  it('opens every org and folds every repo at first, so no run row shows', () => {
    const { container } = draw();
    const heads = [...container.querySelectorAll('[data-group]')];
    expect(headsOf(container)).toEqual(HEADS);
    for (const h of heads) {
      expect(h.getAttribute('aria-expanded')).toBe(
        h.getAttribute('data-group') === 'org' ? 'true' : 'false'
      );
    }
    expect(container.querySelector('[data-run]')).toBeNull();
  });

  it('keeps the counts and the longest time on a folded repo header', () => {
    const { container } = draw();
    const web = container.querySelector('[data-group="repo"][data-group-key="org-a/web"]')!;
    expect(web.getAttribute('aria-expanded')).toBe('false');
    expect(web.querySelector('[data-group-running]')?.textContent).toBe('2 running');
    expect(web.querySelector('[data-group-queued]')?.textContent).toBe('1 queued');
    expect(web.querySelector('[data-time]')?.textContent).toBe('3m 20s');
    const loose = container.querySelector('[data-group="repo"][data-group-key="No org/loose"]')!;
    expect(loose.querySelector('[data-group-running]')).toBeNull();
    expect(loose.querySelector('[data-group-queued]')?.textContent).toBe('1 queued');
  });

  it('opens a repo to show its runs in order', () => {
    const { container } = drawOpen();
    const heads = [...container.querySelectorAll('[data-group]')];
    expect(headsOf(container)).toEqual(HEADS);
    for (const h of heads) expect(h.getAttribute('aria-expanded')).toBe('true');
    expect(
      [...container.querySelectorAll('[data-run]')].map(r => r.getAttribute('data-run'))
    ).toEqual(['a3', 'a4', 'a5', 'a2', 'a7', 'a6', 'a1', 'a8']);
    expect(container.querySelector('[data-job]')).toBeNull();
  });

  it('shows the counts and the longest time in a header', () => {
    const { container } = draw();
    const org = container.querySelector('[data-group="org"][data-group-key="org-a"]')!;
    expect(org.querySelector('[data-group-running]')?.textContent).toBe('3 running');
    expect(org.querySelector('[data-group-queued]')?.textContent).toBe('1 queued');
    expect(org.querySelector('[data-time]')?.textContent).toBe('3m 20s');
    const only = container.querySelector('[data-group="org"][data-group-key="org-b"]')!;
    expect(only.querySelector('[data-group-running]')).toBeNull();
    expect(only.querySelector('[data-group-queued]')?.textContent).toBe('1 queued');
  });

  it('does not repeat the org and repo in a run row', () => {
    const { container } = drawOpen();
    const row = container.querySelector('[data-run="a3"]')!;
    expect(row.textContent).toContain('wf-a3');
    expect(row.textContent).toContain('main');
    expect(row.textContent).toContain('pool-a');
    expect(row.textContent).not.toContain('org-a');
    expect(row.textContent).not.toContain('web');
  });

  it('indents each level further', () => {
    const { container } = drawOpen();
    const pad = (sel: string) =>
      parseFloat(getComputedStyle(container.querySelector(sel)!).paddingLeft);
    expect(pad('[data-group="org"]')).toBe(0);
    expect(pad('[data-group="repo"]')).toBeGreaterThan(pad('[data-group="org"]'));
    expect(pad('[data-run="a3"]')).toBeGreaterThan(pad('[data-group="repo"]'));
  });

  it('opens a repo and folds an org, then reverses both', () => {
    const { container } = draw();
    const group = (key: string) => container.querySelector(`[data-group-key="${key}"]`)!;
    fireEvent.click(group('org-a/web'));
    expect(group('org-a/web').getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-run="a3"]')).not.toBeNull();
    expect(container.querySelector('[data-run="a2"]')).toBeNull();
    fireEvent.click(group('org-a'));
    expect(container.querySelector('[data-group-key="org-a/api"]')).toBeNull();
    expect(container.querySelector('[data-run="a3"]')).toBeNull();
    expect(container.querySelector('[data-group-key="org-c/tool"]')).not.toBeNull();
    fireEvent.click(group('org-a'));
    expect(container.querySelector('[data-run="a3"]')).not.toBeNull();
    fireEvent.click(group('org-a/web'));
    expect(container.querySelector('[data-run="a3"]')).toBeNull();
  });

  it('keeps an opened repo when the widget mounts again, and folds it after a reload', () => {
    const stored = JSON.stringify([window.localStorage, window.sessionStorage]);
    const first = draw();
    fireEvent.click(first.container.querySelector('[data-group-key="org-a/web"]')!);
    first.unmount();
    const again = draw();
    expect(again.container.querySelector('[data-run="a3"]')).not.toBeNull();
    expect(again.container.querySelector('[data-run="a2"]')).toBeNull();
    expect(JSON.stringify([window.localStorage, window.sessionStorage])).toBe(stored);
    again.unmount();
    resetRunnerFolds(); // A reload starts a new page, so the module state is new.
    const fresh = draw();
    expect(fresh.container.querySelector('[data-run]')).toBeNull();
    expect(
      fresh.container.querySelector('[data-group-key="org-a"]')!.getAttribute('aria-expanded')
    ).toBe('true');
  });

  it('keeps a fold when the data refreshes', () => {
    const next = (runs: typeof grouped) => joinRunners({ pools, queue, runs });
    const ui = (m: ReturnType<typeof joinRunners>) => (
      <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
        <MemoryRouter>
          <LinkContext.Provider value={LINKS}>
            <RunnersView model={m} sourceId="runners" editing={false} />
          </LinkContext.Provider>
        </MemoryRouter>
      </ThemeProvider>
    );
    const r = render(ui(next(grouped)));
    fireEvent.click(r.container.querySelector('[data-group-key="org-a/web"]')!);
    fireEvent.click(r.container.querySelector('[data-group="org"][data-group-key="org-c"]')!);
    r.rerender(ui(next(grouped)));
    expect(r.container.querySelector('[data-run="a3"]')).not.toBeNull();
    expect(r.container.querySelector('[data-run="a2"]')).toBeNull();
    expect(r.container.querySelector('[data-group-key="org-c/tool"]')).toBeNull();
  });

  it('still opens a run to its jobs and steps inside a group', () => {
    const { container } = drawOpen();
    fireEvent.click(container.querySelector('[data-run="a3"]')!);
    expect(container.querySelectorAll('[data-job]')).toHaveLength(1);
    fireEvent.click(container.querySelector('[data-job]')!);
    expect(container.querySelectorAll('[data-step-list] [data-step]')).toHaveLength(2);
  });

  it('has no "more" row and no "Other" group', () => {
    const { container } = drawOpen();
    expect(container.textContent).not.toMatch(/\d+ more|\bOther\b/);
  });
});

describe('job counts in the group headers', () => {
  const withCounts = (
    id: string,
    repo: string,
    state: string,
    seconds: number,
    counts: unknown,
    extra: Record<string, unknown> = {}
  ) => ({ ...run(id, repo, state, seconds), counts, ...extra });
  const jobsPanel = parsePanel({
    version: 1,
    id: 'runs',
    title: 'Runs',
    status: 'ok',
    summary: '',
    jobs: { running: 13, queued: 5 },
    runs: [
      withCounts('c1', 'org-a/web', 'running', 100, { running: 4, queued: 2 }),
      withCounts('c2', 'org-a/web', 'running', 50, { running: 1, queued: 0 }),
      withCounts('c3', 'org-a/api', 'running', 10, { running: 2, queued: 1 }),
      withCounts('c4', 'org-b/app', 'queued', 300, { running: 0, queued: 2 }),
      withCounts('c5', 'org-b/app', 'running', 20, { running: 6, queued: 0 }),
    ],
  });
  const runsOnly = (panel: typeof jobsPanel) => panel.runs;

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
    const bad = parsePanel({
      version: 1,
      id: 'runs',
      title: 'Runs',
      jobs: { running: 'many', queued: 1 },
      runs: [
        withCounts('b1', 'o/r', 'running', 1, { running: -1, queued: 0 }),
        withCounts('b2', 'o/r', 'running', 1, 'none'),
        withCounts('b3', 'o/r', 'running', 1, { running: 1 }),
        withCounts('b4', 'o/r', 'running', 1, null),
        withCounts('b5', 'o/r', 'running', 1, { running: 2.9, queued: 1 }),
      ],
    });
    expect(bad.jobs).toBeUndefined();
    expect(bad.runs.map(r => r.counts)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      { running: 2, queued: 1 },
    ]);
  });

  it('sums the counts of the runs in each org and repo, not the number of runs', () => {
    const groups = groupRuns(runsOnly(jobsPanel));
    const a = groups.find(g => g.name === 'org-a')!;
    const b = groups.find(g => g.name === 'org-b')!;
    expect(a).toMatchObject({ running: 7, queued: 3 });
    expect(b).toMatchObject({ running: 6, queued: 2 });
    expect(a.repos.find(r => r.name === 'web')).toMatchObject({ running: 5, queued: 2 });
    expect(a.repos.find(r => r.name === 'api')).toMatchObject({ running: 2, queued: 1 });
    expect(groups.reduce((n, g) => n + g.running, 0)).toBe(13);
    expect(groups.reduce((n, g) => n + g.queued, 0)).toBe(5);
  });

  it('orders by the running job count, then by the longest time', () => {
    const groups = groupRuns(runsOnly(jobsPanel));
    expect(groups.map(g => g.name)).toEqual(['org-a', 'org-b']);
    expect(groups[0].repos.map(r => r.name)).toEqual(['web', 'api']);
    const flip = groupRuns([
      withCounts('f1', 'o/few', 'running', 900, { running: 1, queued: 0 }),
      withCounts('f2', 'o/many', 'running', 5, { running: 3, queued: 0 }),
    ] as never);
    expect(flip[0].repos.map(r => r.name)).toEqual(['many', 'few']);
  });

  it('counts a job that is only assigned to a runner as running', () => {
    const p = parsePanel({
      version: 1,
      id: 'runs',
      title: 'Runs',
      runs: [
        withCounts(
          's1',
          'o/r',
          'queued',
          5,
          { running: 1, queued: 0 },
          {
            jobs: [
              { id: 'j', name: 'build', state: 'queued', phase: 'assigned', seconds: 5, steps: [] },
            ],
          }
        ),
      ],
    });
    expect(p.runs[0].jobs[0]).toMatchObject({ state: 'queued', phase: 'assigned' });
    expect(groupRuns(p.runs)[0]).toMatchObject({ running: 1, queued: 0 });
  });

  it('falls back to one job for each run when the counts are missing', () => {
    const groups = groupRuns(grouped.runs);
    const a = groups.find(g => g.name === 'org-a')!;
    expect(a).toMatchObject({ running: 3, queued: 1 });
    const mixed = groupRuns([
      withCounts('m1', 'o/r', 'running', 5, { running: 4, queued: 1 }),
      run('m2', 'o/r', 'queued', 9),
    ] as never);
    expect(mixed[0]).toMatchObject({ running: 4, queued: 2 });
  });

  it('shows no unlisted note when the listed jobs equal the totals, or no totals exist', () => {
    expect(joinRunners({ pools, queue, runs: jobsPanel }).unlisted).toBe(0);
    expect(joinRunners({ pools, queue, runs: grouped }).unlisted).toBe(0);
    expect(joinRunners({ pools, queue, runs: null }).unlisted).toBe(0);
    const { container } = viewFolded(joinRunners({ pools, queue, runs: jobsPanel }));
    expect(container.querySelector('[data-runners-unlisted]')).toBeNull();
  });

  it('shows the jobs of the runs that the source did not list, with no Other group', () => {
    const capped = parsePanel({
      version: 1,
      id: 'runs',
      title: 'Runs',
      summary: '',
      jobs: { running: 20, queued: 6 },
      runs: jobsPanel.runs,
    });
    const model = joinRunners({ pools, queue, runs: capped });
    expect(model.unlisted).toBe(7 + 1);
    const { container } = viewFolded(model);
    expect(container.querySelector('[data-runners-unlisted]')?.textContent).toMatch(
      /\+8 jobs not listed/
    );
    expect(container.querySelector('[data-runners-summary]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/\d+ more|\bOther\b/);
    const one = parsePanel({
      version: 1,
      id: 'runs',
      title: 'Runs',
      jobs: { running: 14, queued: 5 },
      runs: jobsPanel.runs,
    });
    const v = viewFolded(joinRunners({ pools, queue, runs: one }));
    expect(v.container.querySelector('[data-runners-unlisted]')?.textContent).toMatch(
      /\+1 job not listed/
    );
  });

  it('keeps a run of an unknown repo under its org, in a row that says so', () => {
    const p = parsePanel({
      version: 1,
      id: 'runs',
      title: 'Runs',
      jobs: { running: 5, queued: 2 },
      runs: [
        withCounts('u1', 'org-a', 'queued', 40, { running: 0, queued: 2 }, { repoKnown: false }),
        withCounts('u2', 'org-a/web', 'running', 10, { running: 5, queued: 0 }),
      ],
    });
    expect(p.runs.map(r => r.repoKnown)).toEqual([false, true]);
    const groups = groupRuns(p.runs);
    expect(groups.map(g => g.name)).toEqual(['org-a']);
    expect(groups[0]).toMatchObject({ running: 5, queued: 2 });
    expect(groups[0].repos.map(r => [r.name, r.running, r.queued])).toEqual([
      ['web', 5, 0],
      ['Repo not known', 0, 2],
    ]);
    expect(groups.flatMap(g => g.repos.flatMap(r => r.runs))).toHaveLength(2);
    expect(placeOf({ repo: 'org-a', repoKnown: false })).toEqual({
      org: 'org-a',
      name: 'Repo not known',
    });
    expect(placeOf({ repo: 'org-a/web', repoKnown: true })).toEqual({ org: 'org-a', name: 'web' });
  });

  it('treats a missing repoKnown as known, so older data groups as before', () => {
    const p = parsePanel({
      version: 1,
      id: 'runs',
      title: 'Runs',
      runs: [run('k1', 'org-a/web', 'running', 1)],
    });
    expect(p.runs[0].repoKnown).toBe(true);
    expect(groupRuns(p.runs)[0].repos[0].name).toBe('web');
  });

  it('draws the sums in the headers, and the sum of the orgs equals the tiles', () => {
    const model = joinRunners({ pools, queue, runs: jobsPanel });
    const { container } = viewFolded(model);
    const sum = (attr: string) =>
      [...container.querySelectorAll(`[data-group="org"] [${attr}]`)].reduce(
        (n, e) => n + Number(/\d+/.exec(e.textContent ?? '')?.[0] ?? 0),
        0
      );
    expect(sum('data-group-running')).toBe(13);
    expect(sum('data-group-queued')).toBe(5);
    const web = container.querySelector('[data-group="repo"][data-group-key="org-a/web"]')!;
    expect(web.querySelector('[data-group-running]')?.textContent).toBe('5 running');
    expect(web.querySelector('[data-group-queued]')?.textContent).toBe('2 queued');
  });
});
