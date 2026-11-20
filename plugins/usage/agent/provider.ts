/** Agent data provider for the usage plugin: who uses CPU, memory and network. */
import { defineProvider, defineTool, promString, setting, z } from '../../../agent/src/sdk.js';
// Pure logic of the nodes dashboard, shared with the Headlamp page (no React, no network).
import { parseAgentState, type AgentHost } from '../src/nodes/agentState.js';
import { namespaceDataName, nameOf, NO_NAMES, type NameContext } from '../src/nodes/names.js';
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
    limit: z.number().int().min(1).max(50).default(15),
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
/** Children below this share of the ring's capacity stay inside their parent's value. */
const MIN_CHILD_SHARE = 0.002;
export const MAX_CHILDREN = 60;

const segmentSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  children: z.array(z.object({ key: z.string(), label: z.string(), value: z.number() })).optional(),
});
const ringSchema = z.object({
  id: z.enum(['cpu', 'memory']),
  label: z.enum(['CPU', 'Memory']),
  unit: z.enum(['cores', 'bytes']),
  capacity: z.number(),
  used: z.number(),
  segments: z.array(segmentSchema),
});

type Segment = { key: string; label: string; value: number; children?: Segment[] };

/** Adds up the nodes of all trees that share a key. Values add up, the first label wins. */
function mergeByKey(lists: SunNode[][]): Map<string, { key: string; label: string; value: number; kids: SunNode[][] }> {
  const out = new Map<string, { key: string; label: string; value: number; kids: SunNode[][] }>();
  for (const list of lists) {
    for (const n of list) {
      const hit = out.get(n.key) ?? { key: n.key, label: nameOf(n), value: 0, kids: [] };
      hit.value += n.value;
      hit.kids.push(n.children);
      out.set(n.key, hit);
    }
  }
  return out;
}

function ring(id: 'cpu' | 'memory', trees: NodeTree[]): z.infer<typeof ringSchema> {
  const cores = id === 'cpu';
  const round = (n: number) => (cores ? Math.round(n * 1000) / 1000 : Math.round(n));
  const capacity = trees.reduce((sum, t) => sum + t.capacity, 0);
  const used = trees.reduce((sum, t) => sum + t.root.value, 0);
  const minChild = capacity * MIN_CHILD_SHARE;
  const segments: Segment[] = [];
  for (const seg of mergeByKey(trees.map(t => t.root.children)).values()) {
    if (!(seg.value > 0)) continue;
    const kids = [...mergeByKey(seg.kids).values()]
      .filter(k => k.value > 0 && k.value >= minChild)
      .sort((a, b) => b.value - a.value)
      .slice(0, MAX_CHILDREN)
      .map(k => ({ key: k.key, label: k.label, value: round(k.value) }));
    segments.push({ key: seg.key, label: seg.label, value: round(seg.value), ...(kids.length ? { children: kids } : {}) });
  }
  segments.sort((a, b) => b.value - a.value);
  return { id, label: cores ? 'CPU' : 'Memory', unit: cores ? 'cores' : 'bytes', capacity: round(capacity), used: round(used), segments };
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
    'CPU and memory rings of the whole cluster, as the usage dashboard shows them: capacity, use, and who uses it (Kubernetes namespaces, agent orchestrators, system), with the biggest children of each.',
  input: z.object({}),
  output: z.object({ nodes: z.number(), hostMetrics: z.boolean(), rings: z.array(ringSchema) }),
  async run(_args, ctx) {
    const keys = Object.keys(NODE_QUERIES) as QueryKey[];
    const settled = await Promise.allSettled(keys.map(key => ctx.prom.query(NODE_QUERIES[key])));
    const failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length === keys.length) throw failed[0].reason;
    const results = {} as Record<QueryKey, NodeSample[]>;
    keys.forEach((key, i) => {
      const r = settled[i];
      results[key] = r.status === 'fulfilled' ? r.value.map(s => ({ metric: s.metric, value: [0, String(s.value)] as [number, string] })) : [];
    });
    const metrics = assembleNodeMetrics(results);

    const urls = setting(ctx.settings, 'agentStateUrls', DEFAULT_AGENT_STATE_URLS)
      .split(',')
      .map(u => u.trim())
      .filter(Boolean);
    const hosts = await agentHosts(urls, url => ctx.serviceGet(url));

    let names: NameContext = NO_NAMES;
    try {
      const { items } = await ctx.kube.list('namespaces', { limit: 2000 });
      const namespaces = new Map<string, string>();
      for (const item of items) {
        const id = item.metadata?.name;
        const name = item.metadata ? namespaceDataName(item.metadata) : undefined;
        if (id && name) namespaces.set(id, name);
      }
      names = { overrides: {}, namespaces };
    } catch {
      names = NO_NAMES;
    }

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
