import { describe, expect, it } from 'vitest';
import {
  buildLocalStatus,
  buildProjectTree,
  mergeEnrichment,
  nodeBadge,
  projectOf,
  tabFromParam,
  tabPath,
  viewFromSearch,
  viewToSearch,
  workflowName,
  workflowUrl,
} from './model';
import type { Status } from './types';

const pod = (name: string, node: string) => ({
  metadata: { name, namespace: 'runners', labels: { 'actions-ephemeral-runner': 'True' } },
  spec: { nodeName: node },
  status: { phase: 'Running', startTime: '2026-01-01T00:00:00Z' },
});
const runner = (name: string, status: Record<string, unknown>) => ({
  metadata: {
    name,
    namespace: 'runners',
    annotations: { 'actions.github.com/runner-scale-set-name': 'set-a' },
  },
  status,
});
const node = (name: string, ready: string) => ({
  metadata: { name },
  status: { conditions: [{ type: 'Ready', status: ready }], nodeInfo: { operatingSystem: 'linux' } },
});

describe('buildLocalStatus', () => {
  const status = buildLocalStatus({
    nodes: [node('worker-1', 'True'), node('worker-2', 'False')],
    pods: [pod('r1', 'worker-1'), pod('r2', 'worker-1'), pod('orphan', 'worker-2')],
    runners: [
      runner('r1', {
        phase: 'Running',
        jobDisplayName: 'build',
        jobRepositoryName: 'my-org/app',
        workflowRunId: 42,
        jobWorkflowRef: 'my-org/app/.github/workflows/ci.yml@refs/heads/main',
      }),
      runner('r2', { phase: 'Pending' }),
    ],
    scaleSets: [{ metadata: { name: 'a' }, spec: { runnerScaleSetName: 'set-a', maxRunners: 3 }, status: { pendingEphemeralRunners: 1 } }],
    externalWorkers: [
      { metadata: { name: 'mac-1' }, spec: { displayName: 'Mac', availability: 'best-effort' }, status: { ready: true } },
    ],
    now: new Date('2026-01-01T00:01:00Z'),
  });

  it('assigns jobs and starting runners to nodes', () => {
    const w1 = status.nodes.find(n => n.id === 'worker-1')!;
    expect(w1.jobs).toHaveLength(1);
    expect(w1.jobs[0].workflow).toBe('ci.yml');
    expect(w1.jobs[0].url).toBe('https://github.com/my-org/app/actions/runs/42');
    expect(w1.starting.map(s => s.name)).toEqual(['r2']);
  });
  it('treats unassigned runner pods as starting', () => {
    expect(status.nodes.find(n => n.id === 'worker-2')!.starting[0].name).toBe('orphan');
  });
  it('lists external workers last and marks best-effort', () => {
    const last = status.nodes[status.nodes.length - 1];
    expect(last.id).toBe('mac-1');
    expect(last.best_effort).toBe(true);
  });
  it('summarises', () => {
    expect(status.summary).toMatchObject({ running_jobs: 1, nodes_ready: 2, nodes_total: 3 });
  });
});

describe('helpers', () => {
  it('parses workflow refs', () => {
    expect(workflowName('o/r/.github/workflows/x.yml@refs/heads/main')).toBe('x.yml');
    expect(workflowUrl('o/r/.github/workflows/x.yml@refs/heads/main')).toBe(
      'https://github.com/o/r/blob/main/.github/workflows/x.yml'
    );
    expect(workflowUrl(null)).toBeNull();
  });
});

describe('mergeEnrichment', () => {
  const local = buildLocalStatus({
    nodes: [node('worker-1', 'True')],
    pods: [pod('r1', 'worker-1')],
    runners: [runner('r1', { phase: 'Running', jobDisplayName: 'build', jobRepositoryName: 'o/r', workflowRunId: 1 })],
    scaleSets: [],
    externalWorkers: [],
  });
  it('overlays job url and adds external nodes', () => {
    const remote: Status = {
      ...local,
      nodes: [
        { ...local.nodes[0], jobs: [{ ...local.nodes[0].jobs[0], url: 'https://github.com/o/r/actions/runs/1/job/9' }] },
        { id: 'mac', display_name: 'Mac', kind: 'external', ready: true, os: 'macOS', jobs: [], starting: [] },
      ],
    };
    const merged = mergeEnrichment(local, remote, true);
    expect(merged.nodes.find(n => n.id === 'worker-1')!.jobs[0].url).toMatch(/job\/9$/);
    expect(merged.nodes.some(n => n.id === 'mac')).toBe(true);
  });
  it('is a no-op without an endpoint', () => {
    expect(mergeEnrichment(local, null, true)).toBe(local);
  });
});

describe('node state', () => {
  it('shows standby with a neutral colour, not an error', () => {
    expect(nodeBadge({ ready: false, state: 'standby' })).toEqual({ label: 'standby', status: '' });
  });
  it('maps starting, online, busy and offline', () => {
    expect(nodeBadge({ ready: false, state: 'starting' }).status).toBe('warning');
    expect(nodeBadge({ ready: true, state: 'online' }).status).toBe('success');
    expect(nodeBadge({ ready: true, state: 'busy' }).label).toBe('busy');
    expect(nodeBadge({ ready: false, state: 'offline' }).status).toBe('error');
  });
  it('falls back to ready/offline when there is no state', () => {
    expect(nodeBadge({ ready: true })).toEqual({ label: 'ready', status: 'success' });
    expect(nodeBadge({ ready: false })).toEqual({ label: 'offline', status: 'error' });
  });
  it('carries state and reason from the endpoint onto external nodes and counts standby', () => {
    const local: Status = {
      generated_at: '2026-01-01T00:00:00Z',
      nodes: [
        { id: 'vm-1', display_name: 'vm-1', kind: 'external', ready: false, os: 'Windows', jobs: [], starting: [] },
      ],
      scale_sets: [],
      summary: { running_jobs: 0, pending_runners: 0, nodes_ready: 0, nodes_total: 1 },
    };
    const remote: Status = {
      ...local,
      nodes: [{ ...local.nodes[0], state: 'standby', state_reason: 'Halted on purpose' }],
    };
    const merged = mergeEnrichment(local, remote, true);
    expect(merged.nodes[0].state).toBe('standby');
    expect(merged.nodes[0].state_reason).toBe('Halted on purpose');
    expect(merged.summary.nodes_standby).toBe(1);
  });
});

describe('URL helpers', () => {
  it('falls back to overview for unknown tabs', () => {
    expect(tabFromParam('capacity')).toBe('capacity');
    expect(tabFromParam('nope')).toBe('overview');
    expect(tabFromParam(undefined)).toBe('overview');
  });
  it('builds tab paths relative to the current location', () => {
    expect(tabPath('/c/dev/github-runners', 'runners')).toBe('/c/dev/github-runners/runners');
    expect(tabPath('/c/dev/github-runners/runners', 'history')).toBe('/c/dev/github-runners/history');
    expect(tabPath('/c/dev/github-runners/history', 'overview')).toBe('/c/dev/github-runners');
    expect(tabPath('/github-runners/', 'capacity')).toBe('/github-runners/capacity');
  });
  it('round-trips the view', () => {
    const v = { q: 'ci shop', nodes: ['worker-1', 'worker-2'], sets: ['ci-shop-main'] };
    expect(viewFromSearch(viewToSearch(v))).toEqual(v);
    expect(viewToSearch({ q: '', nodes: [], sets: [] })).toBe('');
  });
  it('accepts repeated and comma-separated params', () => {
    expect(viewFromSearch('?node=a&node=b,c&node=a&set=x')).toEqual({
      q: '',
      nodes: ['a', 'b', 'c'],
      sets: ['x'],
    });
  });
});

describe('projectOf', () => {
  it('strips one prefix and repeated suffixes', () => {
    expect(projectOf('ci-shop', ['ci-'], ['-main'])).toBe('shop');
    expect(projectOf('ci-shop-main', ['ci-'], ['-main', '-runners'])).toBe('shop');
    expect(projectOf('shop-runners-main', [], ['-main', '-runners'])).toBe('shop');
    expect(projectOf('ci-ci-shop', ['ci-'], [])).toBe('ci-shop');
  });
  it('keeps the original name when nothing is left', () => {
    expect(projectOf('ci-', ['ci-'], [])).toBe('ci-');
    expect(projectOf('-main', [], ['-main'])).toBe('-main');
  });
});

describe('buildProjectTree', () => {
  const T0 = '2026-01-01T00:00:00Z';
  const job = (runner: string, o: Record<string, unknown> = {}) => ({
    key: runner, name: `build-${runner}`, repository: 'my-org/shop', workflow: 'ci.yml', workflow_ref: '',
    run_id: 1, run_url: 'https://github.com/my-org/shop/actions/runs/1',
    runner_name: runner, scale_set: 'ci-shop-main', status: 'in_progress', started_at: T0, ...o,
  });
  const st = (runner: string, o: Record<string, unknown> = {}) => ({
    name: runner, runner_name: runner, scale_set: 'ci-shop', phase: 'Pending', started_at: T0, ...o,
  });
  const n = (id: string, jobs: any[], starting: any[] = []) => ({
    id, display_name: id, kind: 'kubernetes' as const, ready: true, os: 'linux', jobs, starting,
  });
  const none = { nodes: [], scaleSets: [], terms: [] };
  const cfg = { projectStripPrefixes: 'ci-' };
  const tree = (nodes: any[], f = none, c: any = cfg) => buildProjectTree({ nodes }, c, f);

  it('groups by repository with the owner stripped', () => {
    const t = tree([n('worker-1', [job('r1'), job('r2', { repository: 'my-org/docs', run_id: 2 })])]);
    expect(t.map(p => p.name).sort()).toEqual(['docs', 'shop']);
  });
  it('falls back to the scale set when a job has no repository', () => {
    const t = tree([n('worker-1', [job('r1', { repository: '', run_id: null })])]);
    expect(t.map(p => p.name)).toEqual(['shop']);
    expect(tree([n('worker-1', [job('r1', { repository: '', run_id: null })])], none, { ...cfg, projectStripSuffixes: '' })[0].name).toBe('shop-main');
  });
  it('groups several jobs of one run', () => {
    const t = tree([n('worker-1', [job('r1'), job('r2')]), n('worker-2', [job('r3')])]);
    expect(t).toHaveLength(1);
    expect(t[0].runs).toHaveLength(1);
    expect(t[0].runs[0]).toMatchObject({ label: 'ci.yml', url: 'https://github.com/my-org/shop/actions/runs/1' });
    expect(t[0].runs[0].jobs.map(j => j.job.runner_name)).toEqual(['r1', 'r2', 'r3']);
    expect(t[0].running).toBe(3);
  });
  it('keeps two runs of one repository apart', () => {
    const t = tree([n('worker-1', [job('r1'), job('r2', { run_id: 2 })])]);
    expect(t[0].runs).toHaveLength(2);
  });
  it('lists starting runners as waiting, and drops idle ones', () => {
    const t = tree([n('worker-1', [job('r1')], [st('r2'), st('r3', { phase: 'Running' })])]);
    expect(t[0].waiting.map(w => w.runner_name)).toEqual(['r2', 'r3']);
    expect([t[0].running, t[0].pending]).toEqual([1, 2]);
  });
  it('excludes runners that only exist as scale-set capacity', () => {
    expect(tree([n('worker-1', [], [])])).toEqual([]);
  });
  it('sorts by most work then oldest', () => {
    const t = tree([
      n('worker-1', [
        job('a1', { repository: 'my-org/alpha', run_id: 5, started_at: '2026-01-01T00:10:00Z' }),
        job('b1', { repository: 'my-org/beta', run_id: 6, started_at: '2026-01-01T00:05:00Z' }),
        job('s1', { run_id: 7, started_at: '2026-01-01T00:20:00Z' }),
        job('s2', { run_id: 7, started_at: '2026-01-01T00:30:00Z' }),
        job('s3', { run_id: 8, started_at: '2026-01-01T00:01:00Z' }),
      ]),
    ]);
    expect(t.map(p => p.name)).toEqual(['shop', 'beta', 'alpha']);
    expect(t[0].runs.map(r => r.key.split('|')[2])).toEqual(['7', '8']);
    expect(t[0].runs[0].oldest).toBe('2026-01-01T00:20:00Z');
  });
  it('prunes by node, scale set and search', () => {
    const nodes = [
      n('worker-1', [job('r1')], [st('r2')]),
      n('worker-2', [job('r3', { scale_set: 'ci-other', repository: 'my-org/docs', run_id: 2 })]),
    ];
    expect(tree(nodes, { ...none, nodes: ['worker-2'] }).map(p => p.name)).toEqual(['docs']);
    const bySet = tree(nodes, { ...none, scaleSets: ['ci-shop'] });
    expect(bySet[0].runs).toHaveLength(0);
    expect(bySet[0].waiting).toHaveLength(1);
    expect(tree(nodes, { ...none, terms: ['r3'] }).map(p => p.name)).toEqual(['docs']);
    expect(tree(nodes, { ...none, terms: ['nomatch'] })).toEqual([]);
  });
  it('is empty with no live work', () => {
    expect(tree([])).toEqual([]);
  });
});
