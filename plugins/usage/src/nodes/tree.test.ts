import { describe, expect, it } from 'vitest';
import type { AgentHost, AgentProc, AgentUnit } from './agents';
import { buildNodeTree, findPath, SunNode } from './tree';
import type { NodeMetrics } from './types';

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
    expect(keys(t.root)).toEqual(['k8s', 't3', 'herdr', 'other', 'system']);
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
    expect(t.root.children[3].children[0].key).toBe('other/job.scope');
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
