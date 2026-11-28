import { describe, expect, it } from 'vitest';
import type { MetricSample } from '../metrics';
import { assembleNodeMetrics, NODE_QUERIES, type QueryKey,runnerQueries } from './queries';

const s = (labels: Record<string, string>, v: number): MetricSample => ({
  metric: labels,
  value: [0, String(v)],
});

function results(
  partial: Partial<Record<QueryKey, MetricSample[]>>
): Record<QueryKey, MetricSample[]> {
  const out = {} as Record<QueryKey, MetricSample[]>;
  for (const key of Object.keys(NODE_QUERIES) as QueryKey[]) {
    out[key] = partial[key] ?? [];
  }
  return out;
}

describe('assembleNodeMetrics', () => {
  it('computes Linux CPU and memory used', () => {
    const [n] = assembleNodeMetrics(
      results({
        cpuCount: [s({ node: 'worker-1' }, 16)],
        cpuIdleRate: [s({ node: 'worker-1' }, 12)],
        memTotal: [s({ node: 'worker-1' }, 64e9)],
        memAvailable: [s({ node: 'worker-1' }, 40e9)],
      })
    );
    expect(n.node).toBe('worker-1');
    expect(n.cpuCapacity).toBe(16);
    expect(n.cpuUsed).toBe(4);
    expect(n.memCapacity).toBe(64e9);
    expect(n.memUsed).toBe(24e9);
  });

  it('measures the busy CPU against the allocatable cores', () => {
    // 64 logical cores, 62 allocatable, 59.4 busy: the ring reads 96 % of allocatable.
    const [n] = assembleNodeMetrics(
      results({
        cpuCount: [s({ node: 'big-1' }, 64)],
        cpuIdleRate: [s({ node: 'big-1' }, 10)],
        cpuBusyRate: [s({ node: 'big-1' }, 59.4)],
        kubeCpuAllocatable: [s({ node: 'big-1' }, 62)],
        kubeCpuCapacity: [s({ node: 'big-1' }, 64)],
      })
    );
    expect(n.cpuCapacity).toBe(62);
    expect(n.cpuUsed).toBe(59.4);
  });

  it('falls back to logical cores minus idle when the busy series is missing', () => {
    const [n] = assembleNodeMetrics(
      results({
        cpuCount: [s({ node: 'w' }, 8)],
        cpuIdleRate: [s({ node: 'w' }, 3)],
        kubeCpuAllocatable: [s({ node: 'w' }, 7.5)],
      })
    );
    expect(n.cpuCapacity).toBe(7.5);
    expect(n.cpuUsed).toBe(5);
  });

  it('queries the busy CPU without idle, iowait and steal over one minute', () => {
    expect(NODE_QUERIES.cpuBusyRate).toBe(
      'sum by (node) (rate(node_cpu_seconds_total{mode!~"idle|iowait|steal"}[1m]))'
    );
    expect(NODE_QUERIES.kubeCpuAllocatable).toContain('kube_node_status_allocatable');
  });

  it('computes Mac CPU and memory used', () => {
    const [n] = assembleNodeMetrics(
      results({
        kubeCpuCapacity: [s({ node: 'mac-1' }, 16)],
        macCpuRate: [s({ node: 'mac-1' }, 2.5)],
        macMemTotal: [s({ node: 'mac-1' }, 128e9)],
        macMemActive: [s({ node: 'mac-1' }, 40e9)],
        macMemWired: [s({ node: 'mac-1' }, 5e9)],
        macMemCompressed: [s({ node: 'mac-1' }, 3e9)],
      })
    );
    expect(n.cpuCapacity).toBe(16);
    expect(n.cpuUsed).toBe(2.5);
    expect(n.memCapacity).toBe(128e9);
    expect(n.memUsed).toBe(48e9);
  });

  it('leaves used null for a node with only kube capacity', () => {
    const [n] = assembleNodeMetrics(
      results({
        kubeCpuCapacity: [s({ node: 'edge-1' }, 4)],
        kubeMemCapacity: [s({ node: 'edge-1' }, 8e9)],
        podCpu: [s({ node: 'edge-1', namespace: 'ns', pod: 'p', container: 'c' }, 0.5)],
        podMem: [s({ node: 'edge-1', namespace: 'ns', pod: 'p', container: 'c' }, 1e8)],
      })
    );
    expect(n.cpuUsed).toBeNull();
    expect(n.memUsed).toBeNull();
    expect(n.cpuCapacity).toBe(4);
    expect(n.memCapacity).toBe(8e9);
    expect(n.pods).toEqual([
      { namespace: 'ns', pod: 'p', container: 'c', cpuCores: 0.5, memBytes: 1e8 },
    ]);
  });

  it('groups pods by node and drops samples without node', () => {
    const nodes = assembleNodeMetrics(
      results({
        kubeCpuCapacity: [s({ node: 'a' }, 1), s({ node: 'b' }, 1)],
        podCpu: [
          s({ node: 'a', namespace: 'n', pod: 'p1', container: 'c' }, 1),
          s({ node: 'b', namespace: 'n', pod: 'p2', container: 'c' }, 2),
          s({ namespace: 'n', pod: 'p3', container: 'c' }, 3),
        ],
        podMem: [s({ node: 'a', namespace: 'n', pod: 'p1', container: 'c' }, 10)],
      })
    );
    expect(nodes.map(n => n.pods.map(p => p.pod))).toEqual([['p1'], ['p2']]);
    expect(nodes[0].pods[0].memBytes).toBe(10);
    expect(nodes[1].pods[0].memBytes).toBe(0);
  });

  it('sorts nodes by name', () => {
    const nodes = assembleNodeMetrics(
      results({
        kubeCpuCapacity: [
          s({ node: 'worker-2' }, 1),
          s({ node: 'mac-1' }, 1),
          s({ node: 'worker-1' }, 1),
        ],
      })
    );
    expect(nodes.map(n => n.node)).toEqual(['mac-1', 'worker-1', 'worker-2']);
  });
});

describe('assembleNodeMetrics system series', () => {
  const info = (unit: string, parent: string, agent = '') =>
    s({ node: 'worker-1', unit, parent, agent_unit: agent }, 1);

  it('joins cgroups, agent values and programs per node', () => {
    const [n] = assembleNodeMetrics(
      results({
        cgroupInfo: [info('system.slice', ''), info('app-agent.scope', 'user.slice', 'agent-1')],
        cgroupMem: [s({ node: 'worker-1', unit: 'system.slice' }, 5e9)],
        cgroupCpu: [s({ node: 'worker-1', unit: 'system.slice' }, 0.5)],
        agentUnitMem: [s({ node: 'worker-1', unit: 'agent-1' }, 1e9)],
        programMem: [s({ node: 'worker-1', unit: 'system.slice', program: 'sshd' }, 1e6)],
        programCpu: [s({ node: 'worker-1', unit: 'system.slice', program: 'sshd' }, 0.1)],
        remainderMem: [s({ node: 'worker-1' }, 2e9)],
      })
    );
    expect(n.system?.cgroups).toEqual([
      { unit: 'system.slice', parent: '', agentUnit: '', cpuCores: 0.5, memBytes: 5e9 },
      {
        unit: 'app-agent.scope',
        parent: 'user.slice',
        agentUnit: 'agent-1',
        cpuCores: 0,
        memBytes: 1e9,
      },
    ]);
    expect(n.system?.programs).toEqual([
      { unit: 'system.slice', program: 'sshd', cpuCores: 0.1, memBytes: 1e6 },
    ]);
    expect(n.system?.agentUnits).toEqual([{ unit: 'agent-1', cpuCores: 0, memBytes: 1e9 }]);
    expect(n.system?.remainderMem).toBe(2e9);
    expect(n.system?.remainderCpu).toBeNull();
  });

  it('leaves system absent without cgroup info', () => {
    const [n] = assembleNodeMetrics(results({ kubeCpuCapacity: [s({ node: 'mac-1' }, 4)] }));
    expect(n.system).toBeUndefined();
  });
});

describe('Runner pool runner info', () => {
  const pod = (namespace: string, name: string) => ({ node: 'n1', namespace, pod: name, container: 'runner' });
  const base = {
    kubeCpuCapacity: [s({ node: 'n1' }, 4)],
    podCpu: [
      s(pod('acme-runners', 'pool-a'), 1),
      s(pod('acme-runners', 'pool-b'), 1),
      s(pod('other', 'x'), 1),
    ],
  };
  const labels = [
    s(
      {
        namespace: 'acme-runners',
        pod: 'pool-a',
        label_acme_io_tenant: 'ExampleOrg..dotrepo',
        label_acme_io_pool: 'pool-linux',
        label_acme_io_role: 'runner',
      },
      1
    ),
  ];
  const jobs = [
    s(
      {
        namespace: 'acme-runners',
        pod: 'pool-a',
        owner: 'ExampleOrg',
        repo: '.dotrepo',
        pool: 'pool-linux',
        runs_on: 'linux-runners',
        workflow: 'CI',
        job: 'build',
        run_id: '42',
      },
      1
    ),
  ];

  it('queries pod labels and job info', () => {
    const q = runnerQueries('acme');
    expect(q.runnerLabels).toContain('label_acme_io_managed_by="acme"');
    expect(q.runnerJobs).toContain('acme_runner_job_info');
    // The scrape renames the runner's pod and job labels. The query copies them back.
    expect(q.runnerJobs).toContain('"pod", "$1", "exported_pod"');
    expect(q.runnerJobs).toContain('"job", "$1", "exported_job"');
    // A dash in the prefix is an underscore in metric and label names.
    expect(runnerQueries('my-pool').runnerJobs).toContain('my_pool_runner_job_info');
  });

  it('has no runner pool query without a prefix, or with an unsafe one', () => {
    for (const prefix of [undefined, '', '  ', 'a"b', 'a b}']) {
      expect(runnerQueries(prefix)).toEqual({ runnerLabels: '', runnerJobs: '' });
    }
    expect(NODE_QUERIES.runnerLabels).toBe('');
    expect(NODE_QUERIES.runnerJobs).toBe('');
  });

  it('attaches labels and job info to pods', () => {
    const [n] = assembleNodeMetrics(results({ ...base, runnerLabels: labels, runnerJobs: jobs }), 'acme');
    const a = n.pods.find(p => p.pod === 'pool-a');
    expect(a?.runner).toEqual({
      tenant: 'ExampleOrg..dotrepo',
      pool: 'pool-linux',
      role: 'runner',
      job: {
        owner: 'ExampleOrg',
        repo: '.dotrepo',
        runsOn: 'linux-runners',
        workflow: 'CI',
        job: 'build',
        runId: '42',
      },
    });
    expect(n.pods.find(p => p.pod === 'pool-b')?.runner).toBeUndefined();
    expect(n.pods.find(p => p.pod === 'x')?.runner).toBeUndefined();
  });

  it('treats an empty job result as no job info', () => {
    const [n] = assembleNodeMetrics(results({ ...base, runnerLabels: labels }), 'acme');
    const a = n.pods.find(p => p.pod === 'pool-a');
    expect(a?.runner?.job).toBeUndefined();
    expect(a?.runner?.pool).toBe('pool-linux');
  });
});
