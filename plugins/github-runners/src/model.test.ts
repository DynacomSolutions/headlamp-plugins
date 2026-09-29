import { describe, expect, it } from 'vitest';
import { buildLocalStatus, mergeEnrichment, workflowName, workflowUrl } from './model';
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
