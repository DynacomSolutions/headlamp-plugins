/**
 * Made-up cluster for the usage dashboard tool: nodes, pods, system cgroups and one agent host.
 * Tests and the sample-panel script share it. All names are placeholders.
 */
import type { KubeClient } from '../src/kube.js';
import type { PromClient, Sample } from '../src/prom.js';
import type { ToolContext } from '../src/sdk.js';
import { NODE_QUERIES, type QueryKey } from '../../plugins/usage/src/nodes/nodeMetrics.js';

export const AGENT_STATE_URL = 'http://agent-memory.agent-memory.svc/api/state';
export const GIB = 2 ** 30;
export const CORES_PER_NODE = 16;
export const MEMORY_PER_NODE = 64 * GIB;

export interface FixtureOptions {
  /** Number of nodes, `worker-1` to `worker-N`. Default 3. */
  nodes?: number;
  /** CPU use of each node as a percent of its capacity. Default 53. */
  cpuPct?: number;
  /** Memory use of each node as a percent of its capacity. Default 65. */
  memPct?: number;
  /** Projects of the agent host: 2 or 3. Default 2. */
  projects?: 2 | 3;
}

/** Share of the Kubernetes use that each namespace holds, in percent. Tiny ones test the 0.2 % rule. */
const NAMESPACES: Array<{ name: string; cpu: number; mem: number; displayName?: string }> = [
  { name: 'shop', cpu: 24, mem: 18 },
  { name: 'ci-runners', cpu: 18, mem: 6 },
  { name: 'web', cpu: 16, mem: 10 },
  { name: 'monitoring', cpu: 12, mem: 22, displayName: 'Monitoring stack' },
  { name: 'databases', cpu: 9, mem: 24 },
  { name: 'kube-system', cpu: 7, mem: 5 },
  { name: 'search', cpu: 5, mem: 8 },
  { name: 'mail', cpu: 4, mem: 3 },
  { name: 'media', cpu: 3, mem: 2.5 },
  { name: 'auth', cpu: 1.5, mem: 1.4 },
  { name: 'cert-manager', cpu: 0.05, mem: 0.02 },
];

// The alphabet of Kubernetes pod name hashes has no vowels and no 0, 1 or 3.
const HASHES = ['6c8d9f7b5', '7d4f9b8c6', '5b9c7d8f4'];
const SUFFIXES = ['x7k2p', 'q9v5t', 'm4z8r', 'w2h6n'];

type Series = Array<{ metric: Record<string, string>; value: number }>;

function agentState(projects: 2 | 3) {
  const thread = (unit: string, project: string, projectId: string, title: string, gib: number, cpu: number) => ({
    name: unit,
    kind: 'scope',
    orchestrator: 't3',
    role: 'agent',
    parent: 't3-agents.slice',
    anon: gib * GIB,
    shmem: 0,
    kernel: 0,
    cpuCores: cpu,
    agent: { names: { workspace: project, projectId, title } },
    processes: { roots: [{ pid: 100, command: 'node /opt/agent/cli.js', rss: gib * GIB * 0.6, cpuCores: cpu * 0.7, children: [] }] },
  });
  const units = [
    { name: 't3-control.service', kind: 'service', orchestrator: 't3', role: 'control', anon: 1.2 * GIB, shmem: 0, kernel: 0, cpuCores: 0.3, processes: { roots: [] } },
    thread('agent-1.scope', 'web-shop', 'p-web-shop', 'Fix the cart page', 2.4, 0.5),
    thread('agent-2.scope', 'web-shop', 'p-web-shop', 'Add a coupon field', 1.6, 0.3),
    thread('agent-3.scope', 'mobile-app', 'p-mobile-app', 'Update the login screen', 2, 0.4),
    ...(projects === 3 ? [thread('agent-4.scope', 'docs-site', 'p-docs-site', 'Write the guide', 0.9, 0.2)] : []),
  ];
  return { node: 'worker-1', orchestrators: [{ name: 't3', title: 'T3 Code' }], units };
}

/** What the fake cluster answers. Query results follow `NODE_QUERIES`. */
export function usageFixture(options: FixtureOptions = {}) {
  const count = options.nodes ?? 3;
  const cpuPct = options.cpuPct ?? 53;
  const memPct = options.memPct ?? 65;
  const names = Array.from({ length: count }, (_, i) => `worker-${i + 1}`);
  const state = agentState(options.projects ?? 2);
  const agentCpu = state.units.reduce((s, u) => s + u.cpuCores, 0);
  const agentMem = state.units.reduce((s, u) => s + u.anon, 0);

  const answers = {} as Record<QueryKey, Series>;
  for (const key of Object.keys(NODE_QUERIES) as QueryKey[]) answers[key] = [];
  const add = (key: QueryKey, metric: Record<string, string>, value: number) => answers[key].push({ metric, value });

  names.forEach((node, n) => {
    const cpuUsed = (cpuPct / 100) * CORES_PER_NODE;
    const memUsed = (memPct / 100) * MEMORY_PER_NODE;
    add('cpuCount', { node }, CORES_PER_NODE);
    add('cpuIdleRate', { node }, CORES_PER_NODE - cpuUsed);
    add('memTotal', { node }, MEMORY_PER_NODE);
    add('memAvailable', { node }, MEMORY_PER_NODE - memUsed);
    const k8sCpu = 0.6 * cpuUsed;
    const k8sMem = 0.6 * memUsed;
    NAMESPACES.forEach((ns, i) => {
      // Each node weighs the namespaces a little differently.
      const jitter = 1 + 0.1 * ((n + i) % 3);
      const total = NAMESPACES.reduce((s, x, j) => s + x.cpu * (1 + 0.1 * ((n + j) % 3)), 0);
      const totalMem = NAMESPACES.reduce((s, x, j) => s + x.mem * (1 + 0.1 * ((n + j) % 3)), 0);
      [0.7, 0.3].forEach((part, p) => {
        const pod = `${ns.name}-app-${HASHES[(i + p) % HASHES.length]}-${SUFFIXES[(n + p) % SUFFIXES.length]}`;
        const labels = { node, namespace: ns.name, pod, container: 'app' };
        add('podCpu', labels, k8sCpu * ((ns.cpu * jitter) / total) * part);
        add('podMem', labels, k8sMem * ((ns.mem * jitter) / totalMem) * part);
      });
    });
    if (n === 0) {
      // The host with the agents also exports system cgroups. System gets 90 % of what is left.
      const restCpu = (cpuUsed - k8sCpu - agentCpu) * 0.9;
      const restMem = (memUsed - k8sMem - agentMem) * 0.9;
      const cgroups: Array<[string, string, number]> = [
        ['system.slice', '', 0.45],
        ['k3s.service', 'system.slice', 0.3],
        ['user.slice', '', 0.25],
        ['user-1000.slice', 'user.slice', 0.15],
      ];
      for (const [unit, parent, share] of cgroups) {
        add('cgroupInfo', { node, unit, parent, agent_unit: '' }, 1);
        add('cgroupCpu', { node, unit }, restCpu * share);
        add('cgroupMem', { node, unit }, restMem * share);
      }
      add('remainderCpu', { node }, restCpu * 0.15);
      add('remainderMem', { node }, restMem * 0.15);
    }
  });

  const byQuery = new Map(Object.entries(NODE_QUERIES).map(([key, query]) => [query, answers[key as QueryKey]] as const));
  const queries: string[] = [];
  const prom = {
    async query(query: string): Promise<Sample[]> {
      queries.push(query);
      const rows = byQuery.get(query);
      if (!rows) throw new Error(`unexpected query ${query}`);
      return rows.map(r => ({ ...r, time: '2026-11-20T08:00:00Z' }));
    },
  } as unknown as PromClient;

  const namespaceItems = NAMESPACES.map(ns => ({
    metadata: { name: ns.name, ...(ns.displayName ? { annotations: { 'app.kubernetes.io/display-name': ns.displayName } } : {}) },
  }));
  const kube = {
    async list(kind: string) {
      if (kind !== 'namespaces') throw new Error(`unexpected kind ${kind}`);
      return { info: {}, items: namespaceItems, truncated: false };
    },
  } as unknown as KubeClient;

  const urls: string[] = [];
  const serviceGet = async (url: string): Promise<unknown> => {
    urls.push(url);
    if (url !== AGENT_STATE_URL) throw new Error('not reachable');
    return state;
  };

  /** A tool context over the fake cluster. Pass overrides to break one backend. */
  function context(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      kube,
      prom,
      vmalert: async () => ({}),
      serviceGet,
      settings: {},
      now: new Date('2026-11-20T08:00:00Z'),
      ...overrides,
    };
  }

  return { nodes: names, namespaces: NAMESPACES, queries, urls, context };
}
