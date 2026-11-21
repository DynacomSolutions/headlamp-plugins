import { describe, expect, it } from 'vitest';
import type { AgentHost, AgentProc, AgentUnit } from './agents';
import {
  buildCombinedTree,
  buildNodeTree,
  findPath,
  gapNodes,
  splitTenant,
  SunNode,
} from './tree';
import type { NodeMetrics, RunnerInfo } from './types';

const GB = 1e9;
const icon = (id: string) => `/icon/${id}`;

function metrics(over: Partial<NodeMetrics> = {}): NodeMetrics {
  return {
    node: 'worker-1',
    cpuCapacity: 8,
    cpuUsed: 10,
    memCapacity: 16,
    memUsed: 10,
    pods: [
      { namespace: 'ns', pod: 'p1', container: 'c1', cpuCores: 3, memBytes: 3 },
      { namespace: 'ns', pod: 'p1', container: 'c2', cpuCores: 1, memBytes: 1 },
    ],
    ...over,
  };
}

const proc = (pid: number, rss: number, children: AgentProc[] = [], cpu?: number): AgentProc => ({
  pid,
  command: `cmd${pid}`,
  rss,
  cpuCores: cpu,
  children,
});

function unit(over: Partial<AgentUnit>): AgentUnit {
  return { name: 'u', kind: 'scope', memBytes: 0, procs: [], ...over };
}

function host(units: AgentUnit[]): AgentHost {
  return {
    node: 'worker-1',
    backend: 'service/a/b:80',
    units,
    orchestrators: [
      { name: 't3', title: 'T3 Code' },
      { name: 'herdr', title: 'Herdr' },
    ],
  };
}

const keys = (n: SunNode) => n.children.map(c => c.key);

describe('buildNodeTree', () => {
  it('pods only: Kubernetes plus System', () => {
    const t = buildNodeTree(metrics(), null, 'memory', icon);
    expect(t.capacity).toBe(16);
    expect(t.used).toBe(10);
    expect(t.hostMetrics).toBe(true);
    expect(t.root.value).toBe(10);
    expect(t.root.children.map(c => [c.key, c.value])).toEqual([
      ['k8s', 4],
      ['system', 6],
    ]);
    const k8s = t.root.children[0];
    expect(k8s.children[0].key).toBe('k8s/ns:ns');
    expect(k8s.children[0].children[0].key).toBe('k8s/ns:ns/pod:p1');
    expect(k8s.children[0].children[0].children.map(c => c.key)).toEqual([
      'k8s/ns:ns/pod:p1/c:c1',
      'k8s/ns:ns/pod:p1/c:c2',
    ]);
  });

  it('builds an agent host in category order', () => {
    const units = [
      unit({ name: 'control.service', orchestrator: 't3', role: 'control', memBytes: 2 }),
      unit({
        name: 'agents.slice',
        kind: 'slice',
        orchestrator: 't3',
        role: 'agents',
        memBytes: 9,
      }),
      unit({
        name: 'a1',
        orchestrator: 't3',
        role: 'agent',
        memBytes: 4,
        project: 'Proj',
        projectId: 'x',
        thread: 'T1',
        threadUrl: 'https://e.com/1',
        icon: { kind: 'file' },
      }),
      unit({ name: 'a2', orchestrator: 't3', role: 'agent', memBytes: 3, thread: 'T2' }),
      unit({
        name: 'h1',
        orchestrator: 'herdr',
        role: 'agent',
        memBytes: 1,
        project: 'WS',
        thread: 'pane',
      }),
      unit({ name: 'job.scope', memBytes: 1 }),
    ];
    const t = buildNodeTree(metrics({ memUsed: 100 }), host(units), 'memory', icon);
    expect(keys(t.root)).toEqual(['k8s', 't3', 'herdr', 'scope:job.scope', 'system']);
    const t3 = t.root.children[1];
    expect(t3.value).toBe(11);
    expect(t3.children[0].key).toBe('t3/control');
    expect(t3.children[0].kind).toBe('control');
    expect(keys(t3)).toEqual(['t3/control', 't3/p:x', 't3/p:unknown']);
    const p = t3.children[1];
    expect(p.label).toBe('Proj');
    expect(p.icon).toEqual({ kind: 'file', src: '/icon/x' });
    expect(p.children[0].key).toBe('t3/p:x/t:a1');
    expect(p.children[0].href).toBe('https://e.com/1');
    expect(t3.children[2].label).toBe('Unknown project');
    expect(t3.children[2].icon).toEqual({ kind: 'mdi', name: 'folder' });
    expect(t.root.children[3].key).toBe('scope:job.scope');
    expect(t.root.children[3].label).toBe('job');
  });

  it('scales categories down on sampling skew', () => {
    const units = [unit({ name: 'a', orchestrator: 't3', role: 'agent', memBytes: 3 })];
    const t = buildNodeTree(metrics({ memUsed: 5 }), host(units), 'memory', icon);
    const sum = t.root.children.reduce((s, c) => s + c.value, 0);
    expect(sum).toBeCloseTo(5);
    expect(t.root.children.find(c => c.key === 'system')).toBeUndefined();
    expect(t.root.value).toBe(5);
  });

  it('keeps the gap under a thread whose processes sum lower', () => {
    const units = [
      unit({
        name: 'a',
        orchestrator: 't3',
        role: 'agent',
        memBytes: GB,
        procs: [proc(1, 0.2 * GB, [proc(2, 0.4 * GB)])],
      }),
    ];
    const t = buildNodeTree(
      metrics({ memUsed: 100 * GB, memCapacity: 200 * GB }),
      host(units),
      'memory',
      icon
    );
    const thread = t.root.children[1].children[0].children[0];
    expect(thread.value).toBe(GB);
    const p1 = thread.children[0];
    expect(p1.key).toBe('t3/p:unknown/t:a/pid:1');
    expect(p1.value).toBeCloseTo(0.6 * GB);
    expect(p1.children[0].key).toBe('t3/p:unknown/t:a/pid:1/pid:2');
    expect(p1.children[0].value).toBeCloseTo(0.4 * GB);
  });

  it('scales processes that exceed the thread', () => {
    const units = [
      unit({
        name: 'a',
        orchestrator: 't3',
        role: 'agent',
        memBytes: 1,
        procs: [proc(1, 1), proc(2, 1)],
      }),
    ];
    const t = buildNodeTree(
      metrics({ memUsed: 100, memCapacity: 200 }),
      host(units),
      'memory',
      icon
    );
    const thread = t.root.children[1].children[0].children[0];
    expect(thread.children.reduce((s, c) => s + c.value, 0)).toBeCloseTo(1);
  });

  it('cpu on an old backend has no agent categories', () => {
    const units = [unit({ name: 'a', orchestrator: 't3', role: 'agent', memBytes: 3 })];
    const t = buildNodeTree(metrics({ cpuUsed: 6 }), host(units), 'cpu', icon);
    expect(t.capacity).toBe(8);
    expect(t.root.children.map(c => [c.key, c.value])).toEqual([
      ['k8s', 4],
      ['system', 2],
    ]);
  });

  it('uses cpuCores for cpu', () => {
    const units = [
      unit({
        name: 'a',
        orchestrator: 't3',
        role: 'agent',
        memBytes: 3,
        cpuCores: 0.5,
        procs: [proc(1, 9, [], 0.25)],
      }),
    ];
    const t = buildNodeTree(metrics({ cpuUsed: 6 }), host(units), 'cpu', icon);
    const t3 = t.root.children[1];
    expect(t3.value).toBe(0.5);
    expect(t3.children[0].children[0].children[0].value).toBe(0.25);
  });

  it('without host metrics draws no System arc', () => {
    const t = buildNodeTree(metrics({ memUsed: null }), null, 'memory', icon);
    expect(t.hostMetrics).toBe(false);
    expect(t.used).toBeNull();
    expect(keys(t.root)).toEqual(['k8s']);
    expect(t.root.value).toBe(4);
  });

  it('drops zero-value arcs', () => {
    const units = [unit({ name: 'a', orchestrator: 't3', role: 'agent', memBytes: 0 })];
    const m = metrics({
      memUsed: 4,
      pods: [
        { namespace: 'ns', pod: 'p', container: 'z', cpuCores: 0, memBytes: 0 },
        ...metrics().pods,
      ],
    });
    const t = buildNodeTree(m, host(units), 'memory', icon);
    expect(keys(t.root)).toEqual(['k8s']);
    expect(t.root.children[0].children[0].children[0].children.map(c => c.label)).toEqual([
      'c1',
      'c2',
    ]);
  });
});

describe('buildNodeTree with nested backend units', () => {
  // Mirrors the unit shapes a live agent-resource backend reports: every unit under a control
  // slice has role control, and an agents slice has role-less sub-slices.
  const live = (): AgentUnit[] => [
    unit({
      name: 't3code.service',
      kind: 'service',
      orchestrator: 't3',
      role: 'control',
      memBytes: 15 * GB,
    }),
    unit({
      name: 'app-t3code-agents.slice',
      kind: 'slice',
      orchestrator: 't3',
      role: 'agents',
      memBytes: 70 * GB,
    }),
    unit({
      name: 'app-t3code-agents-builds.slice',
      kind: 'slice',
      orchestrator: 't3',
      parent: 'app-t3code-agents.slice',
      depth: 1,
      memBytes: 32 * GB,
    }),
    unit({
      name: 'app-t3code-agents-env1.slice',
      kind: 'slice',
      orchestrator: 't3',
      parent: 'app-t3code-agents.slice',
      depth: 1,
      memBytes: 38 * GB,
    }),
    unit({
      name: 't3code-acp-1.scope',
      orchestrator: 't3',
      role: 'agent',
      parent: 'app-t3code-agents-env1.slice',
      depth: 2,
      memBytes: 3 * GB,
      project: 'P',
      projectId: 'p',
    }),
    unit({
      name: 't3code-acp-2.scope',
      orchestrator: 't3',
      role: 'agent',
      parent: 'app-t3code-agents-env1.slice',
      depth: 2,
      memBytes: 1 * GB,
      project: 'P',
      projectId: 'p',
    }),
    unit({
      name: 'run-1.scope',
      orchestrator: 't3',
      role: '',
      parent: 'app-t3code-agents-env1.slice',
      depth: 2,
      memBytes: 0.5 * GB,
    }),
    unit({
      name: 'herdr-control.slice',
      kind: 'slice',
      orchestrator: 'herdr',
      role: 'control',
      memBytes: 2 * GB,
    }),
    unit({
      name: 'herdr-host.service',
      kind: 'service',
      orchestrator: 'herdr',
      role: 'control',
      parent: 'herdr-control.slice',
      depth: 1,
      memBytes: 0.3 * GB,
    }),
    unit({
      name: 'herdr-kill-ledger.service',
      kind: 'service',
      orchestrator: 'herdr',
      role: 'control',
      parent: 'herdr-control.slice',
      depth: 1,
      memBytes: 1 * GB,
    }),
    unit({
      name: 'herdr-native-control-1.scope',
      orchestrator: 'herdr',
      role: 'control',
      parent: 'herdr-control.slice',
      depth: 1,
      memBytes: 0.2 * GB,
    }),
    unit({
      name: 'herdr-panes.slice',
      kind: 'slice',
      orchestrator: 'herdr',
      role: 'agents',
      memBytes: 1 * GB,
    }),
    unit({
      name: 'herdr-pane-1.scope',
      orchestrator: 'herdr',
      role: 'agent',
      parent: 'herdr-panes.slice',
      depth: 1,
      memBytes: 0.5 * GB,
      project: 'WS',
    }),
  ];
  const m = () =>
    metrics({
      memUsed: 200 * GB,
      memCapacity: 256 * GB,
      pods: [{ namespace: 'ns', pod: 'p', container: 'c', cpuCores: 1, memBytes: 4 * GB }],
    });
  const find = (n: SunNode, key: string) => n.children.find(c => c.key === key);

  it('counts each orchestrator once: control plus agents slice', () => {
    const t = buildNodeTree(m(), host(live()), 'memory', icon);
    expect(keys(t.root)).toEqual(['k8s', 't3', 'herdr', 'system']);
    const t3 = find(t.root, 't3')!;
    expect(t3.value).toBeCloseTo(85 * GB);
    const herdr = find(t.root, 'herdr')!;
    expect(herdr.value).toBeCloseTo(3 * GB);
    expect(find(t.root, 'system')!.value).toBeCloseTo((200 - 4 - 85 - 3) * GB);
  });

  it('draws control children inside the control arc', () => {
    const t = buildNodeTree(m(), host(live()), 'memory', icon);
    const control = find(find(t.root, 'herdr')!, 'herdr/control')!;
    expect(control.value).toBeCloseTo(2 * GB);
    expect(keys(control)).toEqual([
      'herdr/control/u:herdr-kill-ledger.service',
      'herdr/control/u:herdr-host.service',
      'herdr/control/u:herdr-native-control-1.scope',
    ]);
  });

  it('puts role-less scopes and agent-free sub-slices under the orchestrator', () => {
    const t = buildNodeTree(m(), host(live()), 'memory', icon);
    const t3 = find(t.root, 't3')!;
    expect(keys(t3)).toEqual([
      't3/control',
      't3/p:p',
      't3/u:app-t3code-agents-builds.slice',
      't3/u:run-1.scope',
    ]);
    expect(t3.children.slice(2).map(c => [c.key, c.value])).toEqual([
      ['t3/u:app-t3code-agents-builds.slice', 32 * GB],
      ['t3/u:run-1.scope', 0.5 * GB],
    ]);
    const all = JSON.stringify(t.root);
    expect(all).not.toContain('agents-env1.slice"');
    expect(keys(find(t.root, 'herdr')!).some(k => k.includes('/u:'))).toBe(false);
  });
});

describe('findPath', () => {
  it('returns the deepest existing prefix', () => {
    const units = [
      unit({
        name: 'a',
        orchestrator: 't3',
        role: 'agent',
        memBytes: 3,
        project: 'P',
        projectId: 'x',
      }),
    ];
    const t = buildNodeTree(metrics({ memUsed: 100 }), host(units), 'memory', icon);
    const r = findPath(t.root, ['t3', 't3/p:x', 't3/p:x/t:missing']);
    expect(r.map(n => n.key)).toEqual(['root', 't3', 't3/p:x']);
  });
});

describe('buildCombinedTree', () => {
  const src = (_node: string, id: string) => icon(id);
  const two = [
    metrics({ node: 'worker-1', cpuCapacity: 8, cpuUsed: 6 }),
    metrics({ node: 'worker-2', cpuCapacity: 16, cpuUsed: 10 }),
  ];
  const noHost = () => null;

  it('gives one node its own tree, with no node ring', () => {
    const t = buildCombinedTree([two[0]], noHost, 'cpu', src);
    expect(t.nodeRing).toBeUndefined();
    expect(t.root.key).toBe('root');
    expect(t.root.children.map(c => c.key)).toEqual(['k8s', 'system']);
    expect(t.capacity).toBe(8);
  });

  it('makes the first ring one arc per node, sized against the summed capacity', () => {
    const t = buildCombinedTree(two, noHost, 'cpu', src);
    expect(t.nodeRing).toBe(true);
    expect(t.capacity).toBe(24);
    expect(t.used).toBe(16);
    expect(t.root.value).toBe(16);
    expect(t.root.children.map(c => [c.key, c.label, c.value])).toEqual([
      ['node:worker-2', 'worker-2', 10],
      ['node:worker-1', 'worker-1', 6],
    ]);
    // Under each node arc is its own tree.
    expect(t.root.children[1].children.map(c => c.key)).toEqual(['k8s', 'system']);
  });

  it('drops filtered-out categories and leaves the gap, without rescaling', () => {
    const all = buildCombinedTree(two, noHost, 'cpu', src);
    const t = buildCombinedTree(two, noHost, 'cpu', src, ['k8s']);
    const w1 = t.root.children.find(c => c.key === 'node:worker-1')!;
    expect(w1.children.map(c => c.key)).toEqual(['k8s']);
    // The node arc keeps its total; the k8s arc keeps its value.
    expect(w1.value).toBe(6);
    expect(w1.children[0].value).toBe(
      all.root.children.find(c => c.key === 'node:worker-1')!.children[0].value
    );
    expect(t.root.value).toBe(16);
    // The dropped share is a gap the layout can draw.
    expect(gapNodes(t, w1, false)[0]).toMatchObject({
      key: 'node:worker-1/~unattributed',
      kind: 'unused',
    });
  });

  it('sizes each node wedge by capacity and keeps the use as the value', () => {
    const t = buildCombinedTree(two, noHost, 'cpu', src);
    expect(t.root.children.map(c => [c.key, c.span, c.capacity, c.value])).toEqual([
      ['node:worker-2', 16, 16, 10],
      ['node:worker-1', 8, 8, 6],
    ]);
  });

  it('keeps an idle node and sorts the ring by capacity', () => {
    const idle = metrics({ node: 'worker-3', cpuCapacity: 32, cpuUsed: 0, pods: [] });
    const t = buildCombinedTree([two[0], idle], noHost, 'cpu', src);
    expect(t.root.children.map(c => [c.key, c.span, c.value])).toEqual([
      ['node:worker-3', 32, 0],
      ['node:worker-1', 8, 6],
    ]);
  });

  it('gives a node using more than its capacity a span equal to its use', () => {
    const hot = metrics({ node: 'worker-3', cpuCapacity: 4, cpuUsed: 5, pods: [] });
    const t = buildCombinedTree([two[0], hot], noHost, 'cpu', src);
    const n = t.root.children.find(c => c.key === 'node:worker-3')!;
    expect([n.span, n.capacity, n.value]).toEqual([5, 4, 5]);
    expect(gapNodes(t, n, false).some(g => g.key.endsWith('/~unused'))).toBe(false);
  });

  it('counts a node without host metrics by what is attributed to it', () => {
    const bare = metrics({ node: 'worker-3', cpuCapacity: 4, cpuUsed: null });
    const t = buildCombinedTree([two[0], bare], noHost, 'cpu', src);
    expect(t.hostMetrics).toBe(false);
    expect(t.capacity).toBe(12);
    // worker-3 holds 4 cores of pods, worker-1 used 6.
    expect(t.root.children.find(c => c.key === 'node:worker-3')!.value).toBe(4);
    expect(t.root.value).toBe(10);
  });
});

describe('gapNodes', () => {
  it('gives the unused capacity at the root and the unattributed rest below it', () => {
    const t = buildNodeTree(metrics({ cpuUsed: 6 }), null, 'cpu', icon);
    const gaps = gapNodes(t, t.root, true);
    expect(gaps.map(g => [g.key, g.value])).toEqual([['root/~unused', 2]]);
    const ns = t.root.children[0].children[0];
    expect(gapNodes(t, ns, false)).toEqual([]);
  });
});

describe('gapNodes on a node ring', () => {
  const src = (_node: string, id: string) => icon(id);
  const two = [
    metrics({ node: 'worker-1', cpuCapacity: 8, cpuUsed: 6 }),
    metrics({ node: 'worker-2', cpuCapacity: 16, cpuUsed: 10 }),
  ];
  const t = buildCombinedTree(two, () => null, 'cpu', src);

  it('has no unused arc at the root', () => {
    expect(gapNodes(t, t.root, true).map(g => g.key)).toEqual([]);
  });

  it('gives each node wedge its own unused gap', () => {
    const w1 = t.root.children.find(c => c.key === 'node:worker-1')!;
    const un = gapNodes(t, w1, false).find(g => g.key === 'node:worker-1/~unused')!;
    expect(un).toMatchObject({ label: 'Unused on worker-1', kind: 'unused', value: 2 });
  });
});

describe('system breakdown', () => {
  const cg = (unit: string, parent: string, mem: number, agentUnit = '') => ({
    unit,
    parent,
    agentUnit,
    cpuCores: mem / 10,
    memBytes: mem,
  });
  const prog = (unit: string, program: string, mem: number) => ({
    unit,
    program,
    cpuCores: mem / 10,
    memBytes: mem,
  });
  const withSystem = (
    system: Omit<NonNullable<NodeMetrics['system']>, 'agentUnits'> &
      Partial<Pick<NonNullable<NodeMetrics['system']>, 'agentUnits'>>,
    over: Partial<NodeMetrics> = {}
  ) => metrics({ memUsed: 100, pods: [], system: { agentUnits: [], ...system }, ...over });
  const sysOf = (t: ReturnType<typeof buildNodeTree>) =>
    t.root.children.find(c => c.key === 'system') as SunNode;

  it('builds cgroups, child cgroups, programs and the remainder', () => {
    const m = withSystem({
      cgroups: [
        cg('system.slice', '', 40),
        cg('sshd.service', 'system.slice', 10),
        cg('user.slice', '', 20),
        cg('user-1000.slice', 'user.slice', 15),
      ],
      programs: [prog('sshd.service', 'sshd', 8)],
      remainderMem: 30,
      remainderCpu: null,
    });
    const sys = sysOf(buildNodeTree(m, null, 'memory', icon));
    expect(sys.value).toBe(100);
    expect(sys.children.map(c => [c.key, c.value])).toEqual([
      ['system/cg:system.slice', 40],
      ['system/kernel', 30],
      ['system/cg:user.slice', 20],
    ]);
    const top = sys.children[0];
    expect(top.children.map(c => [c.key, c.value])).toEqual([['system/cg:sshd.service', 10]]);
    const ssh = top.children[0];
    expect(ssh.displayName).toBe('sshd');
    expect(ssh.label).toBe('sshd.service');
    expect(ssh.children.map(c => [c.key, c.kind, c.value])).toEqual([
      ['system/cg:sshd.service/prog:sshd', 'process', 8],
    ]);
    expect(ssh.children[0].icon).toEqual({ kind: 'mdi', name: 'ssh' });
    const user = sys.children[2].children[0];
    expect(user.displayName).toBe('User 1000 session');
  });

  it('subtracts agent cgroups from their parents and never counts them twice', () => {
    const m = withSystem({
      cgroups: [
        cg('user.slice', '', 50),
        cg('user-1000.slice', 'user.slice', 50),
        cg('app-t3.scope', 'user-1000.slice', 30, 'agent-1'),
        cg('child.scope', 'app-t3.scope', 10, 'agent-2'),
      ],
      programs: [prog('app-t3.scope', 'node', 5)],
      remainderMem: null,
      remainderCpu: null,
    });
    const sys = sysOf(buildNodeTree(m, null, 'memory', icon));
    const user = sys.children[0];
    expect(user.value).toBe(20);
    expect(user.children[0].value).toBe(20);
    // Agent cgroups and their programs are not drawn under System.
    const flat: string[] = [];
    const walk = (n: SunNode) => {
      flat.push(n.key);
      n.children.forEach(walk);
    };
    walk(sys);
    expect(flat.some(k => k.includes('app-t3') || k.includes('child.scope'))).toBe(false);
  });

  it('subtracts an agent cgroup through an unexported parent', () => {
    const m = withSystem({
      cgroups: [cg('user.slice', '', 50), cg('app.scope', 'user.slice', 30, 'agent-1')],
      programs: [],
      remainderMem: null,
      remainderCpu: null,
    });
    expect(sysOf(buildNodeTree(m, null, 'memory', icon)).children[0].value).toBe(20);
  });

  it('draws the kernel and cache remainder for the resource asked', () => {
    const m = withSystem({
      cgroups: [cg('system.slice', '', 10)],
      programs: [],
      remainderMem: 7,
      remainderCpu: 0.5,
    });
    const mem = sysOf(buildNodeTree(m, null, 'memory', icon));
    expect(mem.children.find(c => c.key === 'system/kernel')?.value).toBe(7);
    expect(mem.children.find(c => c.key === 'system/kernel')?.label).toBe('Kernel and cache');
    const cpu = sysOf(buildNodeTree({ ...m, cpuUsed: 5 }, null, 'cpu', icon));
    expect(cpu.children.find(c => c.key === 'system/kernel')?.value).toBe(0.5);
  });

  it('falls back to the flat System arc without the series', () => {
    const sys = sysOf(buildNodeTree(metrics(), null, 'memory', icon));
    expect(sys.children).toEqual([]);
    expect(sys.value).toBe(6);
  });

  it('scales children down to fit their parent', () => {
    const m = withSystem(
      {
        cgroups: [
          cg('system.slice', '', 80),
          cg('a.service', 'system.slice', 60),
          cg('b.service', 'system.slice', 60),
        ],
        programs: [],
        remainderMem: 100,
        remainderCpu: null,
      },
      { memUsed: 100 }
    );
    const sys = sysOf(buildNodeTree(m, null, 'memory', icon));
    const sum = (n: SunNode) => n.children.reduce((a, c) => a + c.value, 0);
    expect(sum(sys)).toBeCloseTo(sys.value);
    const top = sys.children.find(c => c.key === 'system/cg:system.slice') as SunNode;
    expect(sum(top)).toBeLessThanOrEqual(top.value + 1e-9);
  });

  it('keeps the agent categories and adds no extra for agent cgroups', () => {
    const m = withSystem({
      cgroups: [cg('user.slice', '', 50), cg('app.scope', 'user.slice', 30, 'agent-1')],
      programs: [],
      remainderMem: null,
      remainderCpu: null,
    });
    const h = host([
      unit({ name: 'agent-1', orchestrator: 'herdr', role: 'agent', memBytes: 30, thread: 't' }),
    ]);
    const t = buildNodeTree(m, h, 'memory', icon);
    const herdr = t.root.children.find(c => c.key === 'herdr') as SunNode;
    expect(herdr.value).toBe(30);
    expect(sysOf(t).value).toBe(70);
    expect(t.root.children.reduce((a, c) => a + c.value, 0)).toBe(100);
  });

  // An agent host shaped like a live one: the agents sit under user.slice, whose cgroup values
  // include them, and the backend's own agent numbers come from another poll than the series.
  describe('agent host with agents under user.slice', () => {
    const AGENTS = 'app-agents.slice';
    const manager = `user.slice/user-1000.slice/user${'@'}1000.service`;
    const cgs = (mult: number) => [
      { unit: 'system.slice', parent: '', agentUnit: '', cpuCores: 1 * mult, memBytes: 4 * GB },
      { unit: 'user.slice', parent: '', agentUnit: '', cpuCores: 15.5 * mult, memBytes: 60 * GB },
      {
        unit: 'user.slice/user-1000.slice',
        parent: 'user.slice',
        agentUnit: '',
        cpuCores: 15.5 * mult,
        memBytes: 60 * GB,
      },
      {
        unit: manager,
        parent: 'user.slice/user-1000.slice',
        agentUnit: '',
        cpuCores: 15.5 * mult,
        memBytes: 60 * GB,
      },
      {
        unit: `${manager}/app.slice`,
        parent: manager,
        agentUnit: '',
        cpuCores: 15 * mult,
        memBytes: 58 * GB,
      },
      {
        unit: `${manager}/app.slice/${AGENTS}`,
        parent: `${manager}/app.slice`,
        agentUnit: AGENTS,
        cpuCores: 0,
        memBytes: 0,
      },
    ];
    const system = (agentCpu: number, agentMem: number) => ({
      cgroups: cgs(1).map(c =>
        c.agentUnit ? { ...c, cpuCores: agentCpu, memBytes: agentMem } : c
      ),
      programs: [],
      agentUnits: [{ unit: AGENTS, cpuCores: agentCpu, memBytes: agentMem }],
      remainderMem: 11 * GB,
      remainderCpu: 4.5,
    });
    const agentHost = (cpu: number, mem: number) =>
      host([
        unit({
          name: AGENTS,
          kind: 'slice',
          orchestrator: 't3',
          role: 'agents',
          cpuCores: cpu,
          memBytes: mem,
        }),
        unit({
          name: 'a1.scope',
          orchestrator: 't3',
          role: 'agent',
          parent: AGENTS,
          cpuCores: cpu,
          memBytes: mem,
          thread: 'T',
        }),
      ]);
    const m = (agentCpu: number, agentMem: number) =>
      metrics({
        cpuUsed: 22.5,
        memUsed: 150 * GB,
        cpuCapacity: 32,
        memCapacity: 256 * GB,
        pods: [{ namespace: 'ns', pod: 'p', container: 'c', cpuCores: 1.5, memBytes: 37 * GB }],
        system: system(agentCpu, agentMem),
      });
    const childSum = (n: SunNode) => n.children.reduce((a, c) => a + c.value, 0);

    it('keeps System and subtracts the agents once', () => {
      const t = buildNodeTree(m(9, 55 * GB), agentHost(9, 55 * GB), 'cpu', icon);
      const sys = sysOf(t);
      expect(sys.value).toBeCloseTo(22.5 - 1.5 - 9);
      expect(t.root.children.reduce((a, c) => a + c.value, 0)).toBeCloseTo(22.5);
      expect(childSum(sys)).toBeLessThanOrEqual(sys.value + 1e-9);
      const user = sys.children.find(c => c.key === 'system/cg:user.slice') as SunNode;
      expect(user.value).toBeCloseTo(15.5 - 9);
      expect(sys.children.find(c => c.key === 'system/kernel')?.value).toBe(4.5);
    });

    it('does not let backend agent numbers from another poll empty System', () => {
      // The backend says the agents use 30 cores, more than the node: the series say 9.
      const t = buildNodeTree(m(9, 55 * GB), agentHost(30, 90 * GB), 'cpu', icon);
      expect(sysOf(t).value).toBeCloseTo(22.5 - 1.5 - 9);
      const mem = buildNodeTree(m(9, 55 * GB), agentHost(30, 90 * GB), 'memory', icon);
      expect(mem.root.children.find(c => c.key === 't3')?.value).toBe(55 * GB);
      expect(sysOf(mem).value).toBeCloseTo(150 * GB - 37 * GB - 55 * GB);
    });

    it('keeps System when its own cgroups hold more than is left', () => {
      const t = buildNodeTree(m(9, 55 * GB), agentHost(9, 55 * GB), 'cpu', icon);
      expect(sysOf(t)).toBeDefined();
      const skewed = { ...m(9, 55 * GB), cpuUsed: 14 };
      const s = sysOf(buildNodeTree(skewed, agentHost(9, 55 * GB), 'cpu', icon));
      expect(s).toBeDefined();
      expect(s.value).toBeGreaterThan(0);
    });

    it('labels cgroups by their last segment and keeps the path as the id', () => {
      const sys = sysOf(buildNodeTree(m(9, 55 * GB), agentHost(9, 55 * GB), 'memory', icon));
      const user = sys.children.find(c => c.key === 'system/cg:user.slice') as SunNode;
      const session = user.children[0];
      expect(session.label).toBe('user.slice/user-1000.slice');
      expect(session.displayName).toBe('User 1000 session');
      expect(session.children[0].displayName).toBe('User 1000 services');
    });
  });
});

describe('Runner pool runner hierarchy', () => {
  const NS = 'acme-runners';
  const pod = (name: string, mem: number, runner?: RunnerInfo): NodeMetrics['pods'][number] => ({
    namespace: NS,
    pod: name,
    container: 'runner',
    cpuCores: mem,
    memBytes: mem,
    ...(runner ? { runner } : {}),
  });
  const job = (over: Partial<NonNullable<RunnerInfo['job']>> = {}): RunnerInfo => ({
    tenant: 'ExampleOrg..dotrepo',
    pool: 'rw-linux',
    role: 'runner',
    job: {
      owner: 'ExampleOrg',
      repo: '.dotrepo',
      runsOn: 'linux-runners',
      workflow: 'CI',
      job: 'build',
      runId: '42',
      ...over,
    },
  });
  const nsNode = (pods: NodeMetrics['pods']) => {
    const t = buildNodeTree(metrics({ pods, cpuUsed: 100, memUsed: 100 }), null, 'memory', icon);
    return t.root.children[0].children[0];
  };
  const leaves = (n: SunNode): SunNode[] =>
    n.children.length ? n.children.flatMap(leaves) : [n];

  it('nests owner / label, repo, workflow, job, run and containers', () => {
    const ns = nsNode([pod('rw-a', 5, job())]);
    expect(ns.key).toBe(`k8s/ns:${NS}`);
    const chain: SunNode[] = [];
    let cur = ns;
    while (cur.children.length) {
      cur = cur.children[0];
      chain.push(cur);
    }
    expect(chain.map(c => [c.kind, c.label])).toEqual([
      ['runner', 'ExampleOrg / linux-runners'],
      ['repo', '.dotrepo'],
      ['workflow', 'CI'],
      ['job', 'build'],
      ['run', '#42'],
      ['container', 'runner'],
    ]);
    expect(chain[chain.length - 1].key).toBe(
      `k8s/ns:${NS}/rw:ExampleOrg|linux-runners/repo:.dotrepo/wf:CI/job:build/run:42/pod:rw-a/c:runner`
    );
    expect(chain.every(c => c.value === 5)).toBe(true);
  });

  it('splits the tenant on the first dot only', () => {
    expect(splitTenant('ExampleOrg..dotrepo')).toEqual({
      owner: 'ExampleOrg',
      repo: '.dotrepo',
    });
    expect(splitTenant('Acme.web')).toEqual({ owner: 'Acme', repo: 'web' });
  });

  it('groups a pod with labels but no job under Waiting for job', () => {
    const ns = nsNode([
      pod('rw-b', 2, { tenant: 'ExampleOrg..dotrepo', pool: 'rw-linux', role: 'runner' }),
    ]);
    const group = ns.children[0];
    expect(group.label).toBe('ExampleOrg / rw-linux');
    expect(group.children[0].label).toBe('.dotrepo');
    const waiting = group.children[0].children[0];
    expect(waiting.label).toBe('Waiting for job');
    expect(waiting.children[0].kind).toBe('pod');
    expect(waiting.children[0].label).toBe('rw-b');
    expect(waiting.children[0].children[0].key).toBe(
      `k8s/ns:${NS}/rw:ExampleOrg|rw-linux/repo:.dotrepo/wf:~waiting/pod:rw-b/c:runner`
    );
  });

  it('groups a warm pod under Warm pool and its pool', () => {
    const ns = nsNode([pod('rw-w', 1, { tenant: '', pool: 'rw-linux', role: 'warm' })]);
    expect(ns.children[0].label).toBe('Warm pool');
    expect(ns.children[0].children[0].label).toBe('rw-linux');
    expect(ns.children[0].children[0].children[0].label).toBe('rw-w');
  });

  it('keeps pod and container for a pod with no Runner pool data', () => {
    const ns = nsNode([pod('plain', 1)]);
    expect(ns.children[0].kind).toBe('pod');
    expect(ns.children[0].key).toBe(`k8s/ns:${NS}/pod:plain`);
    expect(ns.children[0].children[0].key).toBe(`k8s/ns:${NS}/pod:plain/c:runner`);
  });

  it('keeps the namespace total and unique, URL-safe keys', () => {
    const pods = [
      pod('rw-a', 5, job()),
      pod('rw-c', 3, job({ runId: '43' })),
      pod('rw-d', 4, job({ workflow: 'Release / deploy', job: 'a b' })),
      pod('rw-b', 2, { tenant: 'ExampleOrg..dotrepo', pool: 'rw-linux', role: 'runner' }),
      pod('rw-w', 1, { tenant: '', pool: 'rw-linux', role: 'warm' }),
      pod('plain', 6),
    ];
    for (const r of ['cpu', 'memory'] as const) {
      const t = buildNodeTree(metrics({ pods, cpuUsed: 100, memUsed: 100 }), null, r, icon);
      const ns = t.root.children[0].children[0];
      expect(ns.value).toBe(21);
      expect(leaves(ns).reduce((s, l) => s + l.value, 0)).toBe(21);
      const all: SunNode[] = [];
      const walk = (n: SunNode) => {
        all.push(n);
        n.children.forEach(walk);
      };
      walk(t.root);
      const ks = all.map(n => n.key);
      expect(new Set(ks).size).toBe(ks.length);
      // A parent equals the sum of its children, so nothing is rescaled.
      for (const n of all) {
        if (n.children.length && n.kind !== 'node' && n.kind !== 'category') {
          expect(n.children.reduce((s, c) => s + c.value, 0)).toBe(n.value);
        }
      }
      // Two runs of one job share the job arc.
      const jobArc = all.find(n => n.key.endsWith('/wf:CI/job:build'));
      expect(jobArc?.children.map(c => c.label).sort()).toEqual(['#42', '#43']);
    }
  });
});

describe('no catch-all arcs', () => {
  const CATCH_ALL = /^(other|others|misc|rest|remaining|scopes with no role)$/i;
  const fixtureUnits = () => [
    unit({ name: 't3-agents.slice', kind: 'slice', orchestrator: 't3', role: 'agents', memBytes: 40 * GB }),
    unit({
      name: 'agent-1.scope',
      orchestrator: 't3',
      role: 'agent',
      parent: 't3-agents.slice',
      memBytes: 8 * GB,
      project: 'Proj',
      projectId: 'x',
      thread: 'T1',
    }),
    unit({
      name: 'build-a.scope',
      orchestrator: 't3',
      parent: 't3-agents.slice',
      memBytes: 3 * GB,
      procs: [proc(1, 2 * GB)],
    }),
    unit({ name: 'build-b.scope', orchestrator: 't3', parent: 't3-agents.slice', memBytes: 2 * GB }),
    unit({ name: 'lone-job.scope', memBytes: 5 * GB, procs: [proc(2, 4 * GB)] }),
    unit({ name: 'lone-task.scope', memBytes: 1 * GB }),
  ];
  const build = () => buildNodeTree(metrics({ memUsed: 100 * GB, memCapacity: 128 * GB }), host(fixtureUnits()), 'memory', icon);
  const walk = (n: SunNode, fn: (n: SunNode) => void) => {
    fn(n);
    n.children.forEach(c => walk(c, fn));
  };

  it('has no key ending in /other or equal to other, and no catch-all label', () => {
    const t = build();
    walk(t.root, n => {
      expect(n.key.endsWith('/other')).toBe(false);
      expect(n.key).not.toBe('other');
      expect(n.label).not.toMatch(CATCH_ALL);
      expect(n.displayName ?? '').not.toMatch(CATCH_ALL);
    });
  });

  it('draws every role-less scope under its own name at its real size', () => {
    const t = build();
    const t3 = t.root.children.find(c => c.key === 't3')!;
    const own = t3.children.filter(c => c.key.startsWith('t3/u:'));
    expect(own.map(c => [c.key, c.label, c.value])).toEqual([
      ['t3/u:build-a.scope', 'build-a', 3 * GB],
      ['t3/u:build-b.scope', 'build-b', 2 * GB],
    ]);
    expect(own[0].children.map(c => c.value)).toEqual([2 * GB]);
    const loose = t.root.children.filter(c => c.key.startsWith('scope:'));
    expect(loose.map(c => [c.key, c.label, c.kind, c.value])).toEqual([
      ['scope:lone-job.scope', 'lone-job', 'category', 5 * GB],
      ['scope:lone-task.scope', 'lone-task', 'category', 1 * GB],
    ]);
    expect(loose[0].children.map(c => c.value)).toEqual([4 * GB]);
  });

  it('keeps the totals', () => {
    const t = build();
    const t3 = t.root.children.find(c => c.key === 't3')!;
    // The agents slice (40) already holds the agent scope and the role-less scopes inside it.
    expect(t3.value).toBe(40 * GB);
    expect(t.root.value).toBe(100 * GB);
    const cats = t.root.children.reduce((s, c) => s + c.value, 0);
    expect(cats).toBeCloseTo(100 * GB);
    const system = t.root.children.find(c => c.key === 'system')!;
    expect(system.value).toBeCloseTo(54 * GB, -3);
  });

  it('counts role-less scopes outside the slice in the orchestrator total', () => {
    const t = buildNodeTree(
      metrics({ memUsed: 100 * GB }),
      host([
        unit({ name: 't3-agents.slice', kind: 'slice', orchestrator: 't3', role: 'agents', memBytes: 10 * GB }),
        unit({ name: 'free.scope', orchestrator: 't3', memBytes: 2 * GB }),
      ]),
      'memory',
      icon
    );
    const t3 = t.root.children.find(c => c.key === 't3')!;
    expect(t3.value).toBe(12 * GB);
    expect(t3.children.map(c => [c.key, c.label, c.value])).toEqual([['t3/u:free.scope', 'free', 2 * GB]]);
  });
});
