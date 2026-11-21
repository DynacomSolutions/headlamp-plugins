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
  joinRunners,
  orderRuns,
  progressOf,
  stepsOfRun,
} from './join';
import { ringShares, RunnersView } from './RunnersView';

afterEach(cleanup);

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
const view = (model: ReturnType<typeof joinRunners>, mode: 'dark' | 'light' = 'dark') =>
  render(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <MemoryRouter>
        <LinkContext.Provider value={LINKS}>
          <RunnersView model={model} sourceId="runners" editing={false} />
        </LinkContext.Provider>
      </MemoryRouter>
    </ThemeProvider>
  );

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
