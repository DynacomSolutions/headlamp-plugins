import { describe, expect, it } from 'vitest';
import {
  buildLocalStatus,
  collapseRunners,
  jobProject,
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

describe('collapseRunners', () => {
  const reg = (id: string, jobs: Status['nodes'][0]['jobs'] = [], ready = false) => ({
    id, display_name: id, kind: 'external' as const, ready, os: 'Windows', jobs, starting: [],
  });
  const job = (key: string, scale_set = 'pool-a', node_id = 'node-a') => ({
    key, name: key, repository: 'o/r', workflow: 'ci', workflow_ref: '', runner_name: key,
    scale_set, node_id, status: 'in_progress',
  });
  const wrap = (nodes: Status['nodes']): Status => ({
    generated_at: '', nodes, scale_sets: [],
    summary: { running_jobs: 0, pending_runners: 0, nodes_ready: 0, nodes_total: nodes.length },
  });
  it('drops offline idle ephemeral registrations', () => {
    const out = collapseRunners(
      wrap([
        ...Array.from({ length: 190 }, (_, i) => reg(`windows-vm-runner-${i}`)),
        ...Array.from({ length: 50 }, (_, i) => reg(`some-org-runners-x${i}-runner-q${i}`)),
      ])
    );
    expect(out.nodes).toHaveLength(0);
  });
  it('folds N ephemeral registrations of any pool into one row per node with the job count', () => {
    const out = collapseRunners(
      wrap([
        reg('org-one-runners-abc-runner-aaaaa', [job('a', 'pool-a')]),
        reg('org-two-runners-def-runner-bbbbb', [job('b', 'pool-b')]),
        reg('org-two-runners-def-runner-ccccc', [job('c', 'pool-b')]),
        reg('org-two-runners-def-runner-ddddd'),
        reg('org-two-runners-def-runner-eeeee', [job('e', 'pool-b', 'node-b')]),
      ])
    );
    expect(out.nodes.map(n => n.id)).toEqual(['node-a', 'node-b']);
    const a = out.nodes[0];
    expect(a.jobs).toHaveLength(3);
    expect(a.description).toBe('Pools: pool-a, pool-b');
    expect(out.summary.running_jobs).toBe(4);
  });
  it('folds VM runners to the VM and numbered persistent slots to their machine', () => {
    const out = collapseRunners(
      wrap([
        reg('windows-vm-runner-a', [job('a')]),
        reg('windows-vm-runner-b', [job('b')]),
        reg('machine-1', [job('c')], true),
        reg('machine-2', [], true),
        reg('machine-3'),
        reg('lab-windows'),
      ])
    );
    expect(out.nodes.map(n => n.id).sort()).toEqual(['lab-windows', 'machine', 'windows-vm-node-a']);
    expect(out.nodes.find(n => n.id === 'windows-vm-node-a')!.jobs).toHaveLength(2);
    const m = out.nodes.find(n => n.id === 'machine')!;
    expect(m.jobs).toHaveLength(1);
    expect(m.ready).toBe(true);
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

describe('jobProject', () => {
  const cfg = { projectStripPrefixes: 'ci-' };
  it('uses the repository name without its owner', () => {
    expect(jobProject({ repository: 'my-org/shop', scale_set: 'ci-docs' }, cfg)).toBe('shop');
  });
  it('falls back to the scale set when there is no repository', () => {
    expect(jobProject({ repository: '', scale_set: 'ci-shop-main' }, cfg)).toBe('shop');
    expect(jobProject({ repository: '', scale_set: 'ci-shop-main' }, { ...cfg, projectStripSuffixes: '' })).toBe('shop-main');
  });
});
