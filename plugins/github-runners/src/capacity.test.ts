import { describe, expect, it } from 'vitest';
import {
  buildCapacity,
  externalRows,
  parseCaps,
  parsePolicy,
  parseQuantity,
  pendingReason,
  placementOf,
  specRequests,
} from './capacity';
import type { NodeStatus } from './types';

describe('parseQuantity', () => {
  it('parses cpu and memory forms', () => {
    expect(parseQuantity('2')).toBe(2);
    expect(parseQuantity('500m')).toBeCloseTo(0.5);
    expect(parseQuantity('1.5')).toBe(1.5);
    expect(parseQuantity('1Ki')).toBe(1024);
    expect(parseQuantity('2Mi')).toBe(2 * 1024 ** 2);
    expect(parseQuantity('4Gi')).toBe(4 * 1024 ** 3);
    expect(parseQuantity('1Ti')).toBe(1024 ** 4);
    expect(parseQuantity('1K')).toBe(1000);
    expect(parseQuantity('3M')).toBe(3e6);
    expect(parseQuantity('2G')).toBe(2e9);
    expect(parseQuantity('129e6')).toBe(129e6);
    expect(parseQuantity('1E')).toBe(1e18);
    expect(parseQuantity(4)).toBe(4);
    expect(parseQuantity('1000')).toBe(1000);
  });
  it('returns 0 for junk', () => {
    expect(parseQuantity(undefined)).toBe(0);
    expect(parseQuantity('abc')).toBe(0);
    expect(parseQuantity('1Xi')).toBe(0);
  });
});

describe('specRequests', () => {
  it('sums containers and sidecar init containers only', () => {
    const r = specRequests({
      containers: [
        { resources: { requests: { cpu: '500m', memory: '1Gi' } } },
        { resources: { requests: { cpu: '1' } } },
      ],
      initContainers: [
        { restartPolicy: 'Always', resources: { requests: { cpu: '250m', memory: '1Gi' } } },
        { resources: { requests: { cpu: '8' } } },
      ],
    });
    expect(r.cpu).toBeCloseTo(1.75);
    expect(r.memory).toBe(2 * 1024 ** 3);
  });
});

describe('pendingReason', () => {
  it('turns scheduler messages into short reasons', () => {
    const pod = {
      status: {
        conditions: [
          {
            type: 'PodScheduled',
            status: 'False',
            reason: 'Unschedulable',
            message:
              "0/4 nodes are available: 2 Insufficient cpu, 1 Insufficient memory, 2 node(s) didn't match Pod's node affinity/selector.",
          },
        ],
      },
    };
    expect(pendingReason(pod)).toBe('not enough CPU, not enough memory, no node matches affinity');
  });
  it('reports image pull from container state', () => {
    const pod = {
      status: { containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] },
    };
    expect(pendingReason(pod)).toBe('image pull');
  });
  it('is empty when nothing is known', () => {
    expect(pendingReason({})).toBe('');
  });
});

const hostExpr = (operator: string, values: string[]) => ({
  key: 'kubernetes.io/hostname',
  operator,
  values,
});

describe('placementOf', () => {
  it('orders preferred by weight and reads required In/NotIn', () => {
    const p = placementOf({
      affinity: {
        nodeAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [
            { weight: 10, preference: { matchExpressions: [hostExpr('In', ['worker-2'])] } },
            { weight: 90, preference: { matchExpressions: [hostExpr('In', ['worker-1'])] } },
          ],
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [{ matchExpressions: [hostExpr('NotIn', ['worker-3'])] }],
          },
        },
      },
    });
    expect(p.preferred.map(x => x.node)).toEqual(['worker-1', 'worker-2']);
    expect(p.restricted).toBe(true);
    expect(p.canRunOn('worker-1')).toBe(true);
    expect(p.canRunOn('worker-3')).toBe(false);
  });
  it('is unrestricted without affinity and honours a hostname nodeSelector', () => {
    expect(placementOf({}).canRunOn('worker-9')).toBe(true);
    const pinned = placementOf({ nodeSelector: { 'kubernetes.io/hostname': 'worker-1' } });
    expect(pinned.canRunOn('worker-2')).toBe(false);
    expect(pinned.restricted).toBe(true);
  });
});

describe('parsePolicy', () => {
  it('is unconfigured by default and defaults the cap to 3', () => {
    expect(parsePolicy({}).configured).toBe(false);
    const p = parsePolicy({ policyPreferredNodes: 'worker-1, worker-2' });
    expect(p.configured).toBe(true);
    expect(p.preferredNodes).toEqual(['worker-1', 'worker-2']);
    expect(p.repoCap).toBe(3);
    expect(parsePolicy({ policyRepoCap: 5 }).repoCap).toBe(5);
  });
  it('parses caps', () => {
    expect(parseCaps('my-org/my-repo=32,bad=x')).toEqual({ 'my-org/my-repo': 32 });
  });
});

const node = (name: string, cpu: string, mem: string) => ({
  metadata: { name },
  status: { allocatable: { cpu, memory: mem }, conditions: [{ type: 'Ready', status: 'True' }] },
});
const tmpl = (cpu: string, memory: string, extra: Record<string, unknown> = {}) => ({
  template: { spec: { containers: [{ resources: { requests: { cpu, memory } } }], ...extra } },
});
const ars = (name: string, labels: Record<string, string>, max: number, spec: Record<string, unknown>) => ({
  metadata: { name, namespace: 'runners', labels },
  spec: { runnerScaleSetName: name, maxRunners: max, ...spec },
});
const rpod = (name: string, pool: string, nodeName: string | undefined, phase: string, extra = {}) => ({
  metadata: { name, namespace: 'runners', labels: { 'actions.github.com/scale-set-name': pool, 'actions-ephemeral-runner': 'True' } },
  spec: { nodeName, containers: [{ resources: { requests: { cpu: '1', memory: '2Gi' } } }] },
  status: { phase, ...extra },
});

describe('buildCapacity', () => {
  const affinity = {
    affinity: {
      nodeAffinity: {
        preferredDuringSchedulingIgnoredDuringExecution: [
          { weight: 100, preference: { matchExpressions: [hostExpr('In', ['worker-1'])] } },
        ],
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [{ matchExpressions: [hostExpr('In', ['worker-1', 'worker-2'])] }],
        },
      },
    },
  };
  const input = {
    nodes: [node('worker-1', '4', '16Gi'), node('worker-2', '4', '16Gi'), node('worker-3', '8', '32Gi')],
    pods: [
      rpod('r1', 'pool-a', 'worker-1', 'Running'),
      rpod('r2', 'pool-a', undefined, 'Pending', {
        conditions: [{ type: 'PodScheduled', status: 'False', message: '0/3 nodes are available: 3 Insufficient cpu.' }],
      }),
      {
        metadata: { name: 'other', namespace: 'x' },
        spec: { nodeName: 'worker-1', containers: [{ resources: { requests: { cpu: '500m', memory: '1Gi' } } }] },
        status: { phase: 'Running' },
      },
    ],
    runners: [],
    scaleSets: [
      ars('pool-a', { 'actions.github.com/repository': 'my-repo', 'actions.github.com/organization': 'my-org' }, 4, tmpl('1', '2Gi', affinity)),
      ars('pool-b', { 'actions.github.com/organization': 'my-org' }, 2, {
        githubConfigUrl: 'https://github.com/my-org',
        ...tmpl('1', '2Gi'),
      }),
    ],
    externalWorkers: [],
    status: null,
    cfg: {
      nodeAliases: 'worker-1=Primary',
      poolRepos: 'pool-b=my-org/my-repo',
      policyPreferredNodes: 'worker-1,worker-2',
      policySpillNodes: 'worker-3',
      policyRepoCap: '3',
    },
  };
  const cap = buildCapacity(input);
  const a = cap.pools.find(p => p.name === 'pool-a')!;
  const b = cap.pools.find(p => p.name === 'pool-b')!;

  it('derives pool rows', () => {
    expect(a.serves).toBe('my-org/my-repo');
    expect(b.repo).toBe('my-org/my-repo');
    expect(a.running).toBe(0);
    expect(a.pending).toBe(1);
    expect(a.pendingReason).toBe('not enough CPU');
    expect(a.preferred).toEqual(['Primary']);
    expect(a.spill).toEqual(['worker-2']);
  });
  it('computes node usage', () => {
    const n1 = cap.nodes.find(n => n.id === 'worker-1')!;
    expect(n1.name).toBe('Primary');
    expect(n1.runner.cpu).toBe(1);
    expect(n1.other.cpu).toBeCloseTo(0.5);
    expect(n1.free.cpu).toBeCloseTo(2.5);
    expect(n1.pools).toEqual([{ pool: 'pool-a', count: 1 }]);
  });
  it('computes demand and capacity', () => {
    expect(cap.demand.demand.cpu).toBe(6);
    expect(cap.demand.capacity.cpu).toBeCloseTo(4 - 0.5 + 4 + 8);
    expect(cap.demand.short.cpu).toBe(false);
  });
  it('flags policy violations', () => {
    expect(a.violations.some(v => v.includes('does not prefer worker-2'))).toBe(true);
    expect(a.violations.some(v => v.includes('not allowed on spill node worker-3'))).toBe(true);
    expect(a.violations.some(v => v.includes('over its cap of 3'))).toBe(true);
    expect(cap.violationCount).toBe(2);
  });
  it('treats listener pods as other, not runners', () => {
    const listener = {
      metadata: {
        name: 'listener-1',
        namespace: 'arc-systems',
        labels: {
          'actions.github.com/scale-set-name': 'pool-a',
          'app.kubernetes.io/component': 'runner-scale-set-listener',
        },
      },
      spec: { nodeName: 'worker-2', containers: [{ resources: { requests: { cpu: '2', memory: '1Gi' } } }] },
      status: { phase: 'Running' },
    };
    const c = buildCapacity({ ...input, pods: [...input.pods, listener] });
    const n2 = c.nodes.find(n => n.id === 'worker-2')!;
    expect(n2.runner.cpu).toBe(0);
    expect(n2.other.cpu).toBe(2);
    expect(n2.pools).toEqual([]);
    expect(c.pools.find(p => p.name === 'pool-a')!.pending).toBe(1);
  });
  it('has no violations when policy is unset', () => {
    const c = buildCapacity({ ...input, cfg: {} });
    expect(c.policy.configured).toBe(false);
    expect(c.violationCount).toBe(0);
  });
  it('copes with no data', () => {
    const c = buildCapacity({ nodes: [], pods: [], runners: [], scaleSets: [], externalWorkers: [], status: null, cfg: {} });
    expect(c.pools).toEqual([]);
    expect(c.demand.short).toEqual({ cpu: false, memory: false });
  });
});

describe('externalRows', () => {
  const ext = (o: Partial<NodeStatus>): NodeStatus => ({
    id: 'ext-1',
    display_name: 'Ext 1',
    kind: 'external',
    ready: true,
    os: 'macOS',
    jobs: [],
    starting: [],
    ...o,
  });
  it('maps online, busy and standby', () => {
    const rows = externalRows(
      [ext({}), ext({ id: 'e2', ready: false }), ext({ id: 'e3', state: 'standby', ready: false, state_reason: 'idle' })],
      [{ metadata: { name: 'ext-1' }, status: { busy: true } }]
    );
    expect(rows[0]).toMatchObject({ online: true, busy: true });
    expect(rows[1]).toMatchObject({ online: false, busy: false });
    expect(rows[2]).toMatchObject({ online: false, state: 'standby', reason: 'idle' });
  });
});
