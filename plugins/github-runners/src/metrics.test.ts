import { describe, expect, it } from 'vitest';
import {
  buildFromMetrics,
  DEFAULT_METRICS,
  metricsConfigured,
  MetricsInput,
  parseVector,
  QUERIES,
  queryPath,
  resolveMetricsSource,
  Sample,
} from './metrics';

const SCAN = 1_800_000_000; // seconds
const at = (s: number): string => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
const sample = (labels: Record<string, string>, value = SCAN): Sample => ({ labels, value });
const empty = (): MetricsInput => ({ nodes: [], starting: [], scaleSets: [], scaleSetRunners: [], jobs: [] });

const node = (id: string, extra: Record<string, string> = {}, value = SCAN) =>
  sample(
    { node: id, display_name: id, kind: 'kubernetes', os: 'linux', ready: '1', state: '', state_reason: '', ...extra },
    value
  );
const job = (key: string, extra: Record<string, string> = {}, value = SCAN) =>
  sample(
    {
      key,
      node: 'worker-1',
      name: `job ${key}`,
      repository: 'my-org/my-repo',
      workflow: 'ci.yml',
      workflow_ref: 'my-org/my-repo/.github/workflows/ci.yml@refs/heads/main',
      run_id: '42',
      job_id: 'abc',
      numeric_job_id: '4242',
      url: 'https://github.com/my-org/my-repo/actions/runs/42/job/4242',
      run_url: 'https://github.com/my-org/my-repo/actions/runs/42',
      runner_name: 'runner-1',
      scale_set: 'set-a',
      status: 'in_progress',
      conclusion: '',
      started_at: at(SCAN - 120),
      completed_at: '',
      ...extra,
    },
    value
  );

describe('source and paths', () => {
  it('is off until a service is named', () => {
    expect(metricsConfigured({})).toBe(false);
    expect(metricsConfigured({ metricsService: ' ' })).toBe(false);
    expect(metricsConfigured({ metricsService: 'victoria-metrics' })).toBe(true);
  });

  it('uses the generic defaults for blank fields', () => {
    expect(resolveMetricsSource({ metricsService: 'vm' })).toEqual({
      namespace: DEFAULT_METRICS.namespace,
      service: 'vm',
      port: DEFAULT_METRICS.port,
      problem: null,
    });
  });

  it('rejects names that are not Kubernetes names', () => {
    expect(resolveMetricsSource({ metricsService: 'a/b' }).problem).not.toBeNull();
    expect(resolveMetricsSource({ metricsNamespace: '../x' }).problem).not.toBeNull();
    expect(resolveMetricsSource({ metricsPort: '80/../x' }).problem).not.toBeNull();
  });

  it('builds an encoded service proxy path', () => {
    const src = resolveMetricsSource({ metricsService: 'vm', metricsNamespace: 'mon', metricsPort: '8428' });
    expect(queryPath(src, QUERIES.nodes)).toBe(
      '/api/v1/namespaces/mon/services/vm:8428/proxy/api/v1/query?query=' +
        encodeURIComponent('last_over_time(gh_runner_node_info[150s])')
    );
  });
});

describe('parseVector', () => {
  it('reads the samples of an instant query', () => {
    const body = {
      status: 'success',
      data: { resultType: 'vector', result: [{ metric: { node: 'a' }, value: [1, '1800000000'] }] },
    };
    expect(parseVector(body)).toEqual([{ labels: { node: 'a' }, value: 1_800_000_000 }]);
  });

  it('returns null for an error or a non-vector body', () => {
    expect(parseVector({ status: 'error' })).toBeNull();
    expect(parseVector(null)).toBeNull();
    expect(parseVector({ status: 'success', data: {} })).toBeNull();
  });

  it('skips samples without a number', () => {
    const body = { status: 'success', data: { result: [{ metric: { a: '1' }, value: [1, 'NaN'] }] } };
    expect(parseVector(body)).toEqual([]);
  });
});

describe('buildFromMetrics', () => {
  it('returns null when no scan is in the window', () => {
    expect(buildFromMetrics(empty())).toBeNull();
  });

  it('builds nodes, summary and the scan time', () => {
    const input = empty();
    input.nodes = [
      node('worker-2'),
      node('worker-1'),
      node('win-1', {
        kind: 'external',
        os: 'Windows',
        ready: '0',
        state: 'standby',
        state_reason: 'VM halted',
        best_effort: '1',
      }),
    ];
    const built = buildFromMetrics(input)!;
    expect(built.status.generated_at).toBe(at(SCAN));
    expect(built.status.nodes.map(n => n.id)).toEqual(['win-1', 'worker-1', 'worker-2']);
    const win = built.status.nodes[0];
    expect(win).toMatchObject({
      kind: 'external',
      ready: false,
      state: 'standby',
      state_reason: 'VM halted',
      best_effort: true,
      os: 'Windows',
    });
    expect(built.status.summary).toEqual({
      running_jobs: 0,
      pending_runners: 0,
      nodes_ready: 2,
      nodes_standby: 1,
      nodes_total: 3,
    });
  });

  it('keeps the newest row of a node whose state label changed', () => {
    const input = empty();
    input.nodes = [
      node('win-1', { state: 'starting', ready: '0' }, SCAN - 60),
      node('win-1', { state: 'online', ready: '1' }, SCAN),
    ];
    const built = buildFromMetrics(input)!;
    expect(built.status.nodes).toHaveLength(1);
    expect(built.status.nodes[0]).toMatchObject({ state: 'online', ready: true });
  });

  it('puts a live job on its node and keeps its fields', () => {
    const input = empty();
    input.nodes = [node('worker-1'), node('worker-2')];
    input.jobs = [job('k1')];
    const built = buildFromMetrics(input)!;
    const live = built.status.nodes.find(n => n.id === 'worker-1')!.jobs;
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      key: 'k1',
      name: 'job k1',
      repository: 'my-org/my-repo',
      run_id: 42,
      numeric_job_id: 4242,
      status: 'in_progress',
      conclusion: null,
      node_id: 'worker-1',
      completed_at: null,
    });
    expect(built.status.nodes.find(n => n.id === 'worker-2')!.jobs).toEqual([]);
    expect(built.status.summary.running_jobs).toBe(1);
  });

  it('turns a job that left the live list into a completed history row', () => {
    const input = empty();
    input.nodes = [node('worker-1')];
    input.jobs = [job('old', {}, SCAN - 600), job('live')];
    const built = buildFromMetrics(input)!;
    expect(built.status.summary.running_jobs).toBe(1);
    const finished = built.history.jobs.find(j => j.key === 'old')!;
    expect(finished.status).toBe('completed');
    expect(finished.completed_at).toBe(at(SCAN - 600));
    // The live job is in the history too, with no completion time.
    expect(built.history.jobs.find(j => j.key === 'live')!.completed_at).toBeNull();
  });

  it('keeps one row per job when its status label changed', () => {
    const input = empty();
    input.nodes = [node('worker-1')];
    input.jobs = [
      job('k', { status: 'in_progress' }, SCAN - 120),
      job('k', { status: 'completed', conclusion: 'success', completed_at: at(SCAN - 30) }, SCAN - 90),
    ];
    const built = buildFromMetrics(input)!;
    expect(built.history.jobs).toHaveLength(1);
    expect(built.history.jobs[0]).toMatchObject({ status: 'completed', conclusion: 'success', completed_at: at(SCAN - 30) });
  });

  it('orders history newest first, drops jobs past 14 days and caps the list', () => {
    const input = empty();
    input.nodes = [node('worker-1')];
    input.jobs = [
      job('a', {}, SCAN - 3600),
      job('b', {}, SCAN - 600),
      job('ancient', { started_at: at(SCAN - 20 * 86400) }, SCAN - 15 * 86400),
    ];
    const built = buildFromMetrics(input)!;
    expect(built.history.jobs.map(j => j.key)).toEqual(['b', 'a']);
  });

  it('lists starting runners on their node and counts them as pending', () => {
    const input = empty();
    input.nodes = [node('worker-1')];
    input.starting = [
      sample({ node: 'worker-1', name: 'r1', runner_name: 'run-1', scale_set: 'set-a', phase: 'Pending', started_at: at(SCAN - 20) }),
      sample({ node: 'worker-1', name: 'r0', runner_name: 'run-0', scale_set: 'set-a', phase: 'Pending' }, SCAN - 300),
    ];
    const built = buildFromMetrics(input)!;
    expect(built.status.nodes[0].starting).toEqual([
      { name: 'r1', runner_name: 'run-1', scale_set: 'set-a', phase: 'Pending', started_at: at(SCAN - 20) },
    ]);
    expect(built.status.summary.pending_runners).toBe(1);
  });

  it('builds scale sets from the info series and the numbers', () => {
    const input = empty();
    input.nodes = [node('worker-1')];
    input.scaleSets = [sample({ scale_set: 'set-b', organisation: 'my-org', phase: 'Running' }), sample({ scale_set: 'Set-a', organisation: '', phase: '' })];
    input.scaleSetRunners = [
      sample({ scale_set: 'set-b', field: 'max' }, 5),
      sample({ scale_set: 'set-b', field: 'running' }, 2),
      sample({ scale_set: 'set-b', field: 'pending' }, 3),
    ];
    const built = buildFromMetrics(input)!;
    expect(built.status.scale_sets).toEqual([
      { name: 'Set-a', min_runners: null, max_runners: null, current_runners: null, pending: null, running: null, phase: null, organisation: null },
      { name: 'set-b', min_runners: null, max_runners: 5, current_runners: null, pending: 3, running: 2, phase: 'Running', organisation: 'my-org' },
    ]);
    expect(built.status.summary.pending_runners).toBe(3);
  });
});
