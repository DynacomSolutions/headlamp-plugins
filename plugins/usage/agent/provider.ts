/** Agent data provider for the usage plugin: who uses CPU, memory and network. */
import { defineProvider, defineTool, promString, setting, z } from '../../../agent/src/sdk.js';
// Pure logic of the nodes dashboard, shared with the Headlamp page (no React, no network).
import { parseAgentState, type AgentHost } from '../src/nodes/agentState.js';
import { idOf, namespaceDataName, nameOf, NO_NAMES, uniqueNames, type NameContext } from '../src/nodes/names.js';
import { assembleNodeMetrics, NODE_QUERIES, type NodeSample, type QueryKey } from '../src/nodes/nodeMetrics.js';
import { buildNodeTree, type NodeTree, type Resource, type SunNode } from '../src/nodes/tree.js';

const QUERIES = {
  cpu: (sel: string, w: string) => `sum by (GROUP) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"${sel}}[${w}]))`,
  memory: (sel: string, w: string) => `sum by (GROUP) (avg_over_time(container_memory_working_set_bytes{container!="",container!="POD"${sel}}[${w}]))`,
  network_in: (sel: string, w: string) => `sum by (GROUP) (rate(container_network_receive_bytes_total{interface=~"eth[0-9]+"${sel}}[${w}]))`,
  network_out: (sel: string, w: string) => `sum by (GROUP) (rate(container_network_transmit_bytes_total{interface=~"eth[0-9]+"${sel}}[${w}]))`,
} as const;

const UNITS = { cpu: 'cores', memory: 'bytes', network_in: 'bytes/s', network_out: 'bytes/s' } as const;

const top = defineTool({
  name: 'usage_top',
  title: 'Top resource consumers',
  description: 'The biggest users of CPU, memory or network, grouped by namespace, pod or node, averaged over a window (default 5m), optionally inside one namespace or node.',
  input: z.object({
    resource: z.enum(['cpu', 'memory', 'network_in', 'network_out']),
    by: z.enum(['namespace', 'pod', 'node']).default('namespace'),
    window: z.string().regex(/^\d+[mhd]$/).default('5m'),
    namespace: z.string().optional(),
    node: z.string().optional(),
    limit: z.number().int().min(1).max(1000).default(15),
  }),
  output: z.object({ unit: z.string(), rows: z.array(z.object({ group: z.string(), namespace: z.string().optional(), value: z.number() })) }),
  async run(args, ctx) {
    let sel = '';
    if (args.namespace) sel += `,namespace="${promString(args.namespace)}"`;
    if (args.node) sel += `,node="${promString(args.node)}"`;
    const group = args.by === 'pod' ? 'namespace, pod' : args.by;
    const query = `topk(${args.limit}, ${QUERIES[args.resource](sel, args.window).replace('GROUP', group)})`;
    const samples = await ctx.prom.query(query);
    const rows = samples
      .map(s => ({ group: s.metric[args.by] ?? '', namespace: args.by === 'pod' ? s.metric.namespace : undefined, value: s.value }))
      .sort((a, b) => b.value - a.value);
    const fmt = (v: number) => (args.resource === 'cpu' ? `${Math.round(v * 1000)}m` : args.resource === 'memory' ? `${Math.round(v / 2 ** 20)} MiB` : `${Math.round(v / 1024)} KiB/s`);
    return {
      data: { unit: UNITS[args.resource], rows },
      summary: rows[0] ? `Top ${args.resource} by ${args.by}: ${rows[0].namespace ? `${rows[0].namespace}/` : ''}${rows[0].group} with ${fmt(rows[0].value)}.` : 'No usage data.',
      view: { title: `Top ${args.resource} by ${args.by} (${args.window})`, rows: rows.map(r => ({ label: r.namespace ? `${r.namespace}/${r.group}` : r.group, detail: '', status: fmt(r.value) })) },
    };
  },
});

// The backend moved to the namespace agent-resource: the new place comes first, the old
// namespace is the rollout fallback.
const DEFAULT_AGENT_STATE_URLS =
  'http://agent-resource.agent-resource.svc/api/state,http://agent-resource.agent-memory.svc/api/state';
const segmentSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  children: z.array(z.object({ key: z.string(), label: z.string(), value: z.number() })).optional(),
});
const nodeSchema = z.object({
  key: z.string(),
  label: z.string(),
  capacity: z.number(),
  used: z.number(),
  segments: z.array(segmentSchema),
});
const ringSchema = z.object({
  id: z.enum(['cpu', 'memory']),
  label: z.enum(['CPU', 'Memory']),
  unit: z.enum(['cores', 'bytes']),
  capacity: z.number(),
  used: z.number(),
  segments: z.array(segmentSchema),
  /** One entry per node, with the categories of that node. Lets a chart split the ring by node first. */
  nodes: z.array(nodeSchema).optional(),
});

type Segment = { key: string; label: string; value: number; children?: Segment[] };

type Merged = { key: string; label: string; id: string; repeatable: boolean; value: number; kids: SunNode[][] };

/** Adds up the nodes of all trees that share a key. Values add up, the first label wins. */
function mergeByKey(lists: SunNode[][]): Map<string, Merged> {
  const out = new Map<string, Merged>();
  for (const list of lists) {
    for (const n of list) {
      const hit = out.get(n.key) ?? {
        key: n.key,
        label: nameOf(n),
        id: idOf(n),
        repeatable: n.kind === 'process' || n.kind === 'unused',
        value: 0,
        kids: [],
      };
      hit.value += n.value;
      hit.kids.push(n.children);
      out.set(n.key, hit);
    }
  }
  return out;
}

/**
 * Labels of merged siblings. Two segments of one list can share a label after the merge (the
 * same display name on two namespaces of different nodes), so they get the unique name again.
 */
function labelled(items: Merged[]): Map<string, string> {
  const some = items.filter(i => !i.repeatable);
  const names = uniqueNames(some.map(i => ({ name: i.label, id: i.id })));
  const out = new Map(items.map(i => [i.key, i.label]));
  some.forEach((i, idx) => out.set(i.key, names[idx]));
  return out;
}

/** The categories of the given trees, merged by key, each with its children. Every category and child keeps its real size. */
function segmentsOf(lists: SunNode[][], round: (n: number) => number): Segment[] {
  const segments: Segment[] = [];
  const cats = [...mergeByKey(lists).values()].filter(c => c.value > 0);
  const catLabels = labelled(cats);
  for (const seg of cats) {
    const kidList = [...mergeByKey(seg.kids).values()].filter(k => k.value > 0);
    const kidLabels = labelled(kidList);
    const kids = kidList
      .sort((a, b) => b.value - a.value)
      .map(k => ({ key: k.key, label: kidLabels.get(k.key) ?? k.label, value: round(k.value) }));
    segments.push({ key: seg.key, label: catLabels.get(seg.key) ?? seg.label, value: round(seg.value), ...(kids.length ? { children: kids } : {}) });
  }
  return segments.sort((a, b) => b.value - a.value);
}

function ring(id: 'cpu' | 'memory', trees: NodeTree[]): z.infer<typeof ringSchema> {
  const cores = id === 'cpu';
  const round = (n: number) => (cores ? Math.round(n * 1000) / 1000 : Math.round(n));
  const capacity = trees.reduce((sum, t) => sum + t.capacity, 0);
  const used = trees.reduce((sum, t) => sum + t.root.value, 0);
  const segments = segmentsOf(
    trees.map(t => t.root.children),
    round,
  );
  // The same data, split by node first. A node with no capacity and no use has nothing to show.
  const nodes = trees
    .map(t => ({
      key: `node:${t.root.label}`,
      label: t.root.label,
      capacity: round(t.capacity),
      used: round(t.root.value),
      segments: segmentsOf([t.root.children], round),
    }))
    .filter(n => n.capacity > 0 || n.used > 0)
    .sort((a, b) => Math.max(b.capacity, b.used) - Math.max(a.capacity, a.used) || a.key.localeCompare(b.key));
  return { id, label: cores ? 'CPU' : 'Memory', unit: cores ? 'cores' : 'bytes', capacity: round(capacity), used: round(used), segments, ...(nodes.length ? { nodes } : {}) };
}

/** Reads the agent state of each URL. A failed or invalid backend is skipped. Hosts are keyed by node name, so two URLs that answer for the same node count once. */
async function agentHosts(urls: string[], get: (url: string) => Promise<unknown>): Promise<Map<string, AgentHost>> {
  const results = await Promise.allSettled(urls.map(async url => parseAgentState(await get(url), url)));
  const hosts = new Map<string, AgentHost>();
  for (const r of results) if (r.status === 'fulfilled' && r.value.node) hosts.set(r.value.node, r.value);
  return hosts;
}

const pct = (used: number, capacity: number) => (capacity > 0 ? `${((used / capacity) * 100).toFixed(1)}%` : 'n/a');

const dashboard = defineTool({
  name: 'usage_dashboard',
  title: 'Usage dashboard',
  description:
    'CPU and memory rings of the whole cluster, as the usage dashboard shows them: capacity, use, and who uses it (Kubernetes namespaces, agent orchestrators, system), with every child of each.',
  input: z.object({}),
  output: z.object({ nodes: z.number(), hostMetrics: z.boolean(), rings: z.array(ringSchema) }),
  async run(_args, ctx) {
    // The three reads do not depend on each other, so they run together: the panel waits for the
    // slowest one, not for the sum of them.
    const keys = Object.keys(NODE_QUERIES) as QueryKey[];
    const urls = setting(ctx.settings, 'agentStateUrls', DEFAULT_AGENT_STATE_URLS)
      .split(',')
      .map(u => u.trim())
      .filter(Boolean);
    const readNames = async (): Promise<NameContext> => {
      try {
        const { items } = await ctx.kube.list('namespaces', { limit: 2000 });
        const namespaces = new Map<string, string>();
        for (const item of items) {
          const id = item.metadata?.name;
          const name = item.metadata ? namespaceDataName(item.metadata) : undefined;
          if (id && name) namespaces.set(id, name);
        }
        return { overrides: {}, namespaces };
      } catch {
        return NO_NAMES;
      }
    };
    const [settled, hosts, names] = await Promise.all([
      Promise.allSettled(keys.map(key => ctx.prom.query(NODE_QUERIES[key]))),
      agentHosts(urls, url => ctx.serviceGet(url)),
      readNames(),
    ]);
    const failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length === keys.length) throw failed[0].reason;
    const results = {} as Record<QueryKey, NodeSample[]>;
    keys.forEach((key, i) => {
      const r = settled[i];
      results[key] = r.status === 'fulfilled' ? r.value.map(s => ({ metric: s.metric, value: [0, String(s.value)] as [number, string] })) : [];
    });
    const metrics = assembleNodeMetrics(results);

    const rings = (['cpu', 'memory'] as Resource[]).map(r =>
      ring(
        r,
        metrics.map(m => buildNodeTree(m, hosts.get(m.node) ?? null, r, () => '', [], names)),
      ),
    );
    const hostMetrics = metrics.length > 0 && metrics.every(m => m.cpuUsed !== null && m.memUsed !== null);
    const [cpu, mem] = rings;
    // The biggest named user: the biggest child of any category, or a category with no children.
    const users = cpu.segments.flatMap(seg => seg.children ?? [seg]);
    const biggest = users.reduce<Segment | undefined>((best, u) => (!best || u.value > best.value ? u : best), undefined);
    const summary =
      metrics.length === 0
        ? 'No usage data.'
        : `CPU ${pct(cpu.used, cpu.capacity)} and memory ${pct(mem.used, mem.capacity)} used on ${metrics.length} nodes.${biggest ? ` Biggest CPU user: ${biggest.label}.` : ''}`;
    return {
      data: { nodes: metrics.length, hostMetrics, rings },
      summary,
      view: {
        title: 'Usage dashboard',
        rows: rings.flatMap(r => r.segments.map(s => ({ label: `${r.label}: ${s.label}`, detail: '', status: pct(s.value, r.capacity) }))),
      },
    };
  },
});

export const provider = defineProvider({
  name: 'usage',
  title: 'Usage',
  description: 'Top CPU, memory and network consumers (usage plugin)',
  tools: [top, dashboard],
});
