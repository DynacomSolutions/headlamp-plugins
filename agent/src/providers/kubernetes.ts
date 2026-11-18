import { defineProvider, defineTool, z, type ToolContext } from '../sdk.js';
import type { KubeObject } from '../kube.js';
import { age, capJson, summarize } from './summarize.js';

const rowSchema = z.object({
  kind: z.string(),
  name: z.string(),
  namespace: z.string().optional(),
  status: z.string(),
  detail: z.string(),
  age: z.string(),
});

const eventSchema = z.object({
  type: z.string(),
  reason: z.string(),
  object: z.string(),
  namespace: z.string().optional(),
  message: z.string(),
  count: z.number(),
  last: z.string(),
  age: z.string(),
});

type Event = z.infer<typeof eventSchema>;

function toEvent(e: any, now: number): Event {
  const last = e.lastTimestamp ?? e.eventTime ?? e.series?.lastObservedTime ?? e.metadata?.creationTimestamp ?? '';
  return {
    type: e.type ?? '',
    reason: e.reason ?? '',
    object: `${e.involvedObject?.kind ?? e.regarding?.kind ?? ''}/${e.involvedObject?.name ?? e.regarding?.name ?? ''}`,
    namespace: e.metadata?.namespace,
    message: String(e.message ?? e.note ?? '').slice(0, 400),
    count: e.count ?? e.series?.count ?? 1,
    last,
    age: age(last, now),
  };
}

async function events(
  ctx: ToolContext,
  opts: { namespace?: string; kind?: string; name?: string; type?: string; sinceMinutes?: number; limit?: number },
): Promise<{ events: Event[]; total: number }> {
  const fields: string[] = [];
  if (opts.kind) fields.push(`involvedObject.kind=${opts.kind}`);
  if (opts.name) fields.push(`involvedObject.name=${opts.name}`);
  if (opts.type) fields.push(`type=${opts.type}`);
  const { items } = await ctx.kube.list('events', { namespace: opts.namespace, fieldSelector: fields.join(',') || undefined, limit: 1000 });
  const now = ctx.now.getTime();
  const since = opts.sinceMinutes ? now - opts.sinceMinutes * 60_000 : 0;
  const all = items
    .map(e => toEvent(e, now))
    .filter(e => !since || Date.parse(e.last) >= since)
    .sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
  return { events: all.slice(0, opts.limit ?? 50), total: all.length };
}

const listResources = defineTool({
  name: 'list_resources',
  title: 'List Kubernetes resources',
  description:
    'Lists objects of one resource type with a one-line status each (pods: phase, readiness, restarts, node; workloads: ready replicas; nodes: readiness and pressure). Any type the cluster serves except Secrets. Use label or field selectors to narrow (for example fieldSelector "status.phase!=Running" or "spec.nodeName=worker-1").',
  input: z.object({
    kind: z.string().describe('Kind, plural, short name or plural.group, for example Pod, deployments, deploy, certificates.cert-manager.io'),
    namespace: z.string().optional().describe('Namespace; omit for all namespaces or cluster-scoped types'),
    labelSelector: z.string().optional(),
    fieldSelector: z.string().optional(),
    onlyProblems: z.boolean().optional().describe('Keep only rows whose status is not healthy (not Running/Ready/Complete/Bound/Succeeded)'),
    limit: z.number().int().min(1).max(500).optional().describe('Rows to return, default 100'),
  }),
  output: z.object({ kind: z.string(), total: z.number(), truncated: z.boolean(), rows: z.array(rowSchema) }),
  async run(args, ctx) {
    const { info, items, truncated } = await ctx.kube.list(args.kind, {
      namespace: args.namespace,
      labelSelector: args.labelSelector,
      fieldSelector: args.fieldSelector,
      limit: 2000,
    });
    const now = ctx.now.getTime();
    let rows = items.map(item => summarize(item, now));
    if (args.onlyProblems) rows = rows.filter(r => !/^(Running|Ready|Complete|Completed|Bound|Succeeded|Active|Available|Healthy|True|ClusterIP|NodePort|LoadBalancer|)$/.test(r.status));
    const total = rows.length;
    rows = rows.slice(0, args.limit ?? 100);
    const where = args.namespace ? ` in ${args.namespace}` : '';
    return {
      data: { kind: info.kind, total, truncated: truncated || total > rows.length, rows },
      summary: `${total} ${info.kind}${total === 1 ? '' : 's'}${where}${args.onlyProblems ? ' with problems' : ''}${total > rows.length ? `, showing ${rows.length}` : ''}.`,
      view: {
        title: `${info.kind}${where}`,
        rows: rows.map(r => ({ label: r.namespace ? `${r.namespace}/${r.name}` : r.name, detail: `${r.detail}${r.age ? ` · ${r.age}` : ''}`, status: r.status })),
      },
    };
  },
});

const getResource = defineTool({
  name: 'get_resource',
  title: 'Get a Kubernetes object',
  description:
    'Reads one object (spec, status, metadata) with secrets masked and managedFields removed, optionally with its recent events. Secrets cannot be read. Use section to limit the size (for example "status" or "spec.containers").',
  input: z.object({
    kind: z.string(),
    name: z.string(),
    namespace: z.string().optional(),
    section: z.string().optional().describe('Dotted path inside the object to return, for example status, spec.template.spec.containers'),
    includeEvents: z.boolean().optional().describe('Also return the events about this object, newest first'),
  }),
  output: z.object({ kind: z.string(), name: z.string(), namespace: z.string().optional(), summary: rowSchema, object: z.unknown(), events: z.array(eventSchema).optional() }),
  async run(args, ctx) {
    const { info, object } = await ctx.kube.get(args.kind, args.name, args.namespace);
    const typed = { ...object, kind: info.kind } as KubeObject;
    const row = summarize(typed, ctx.now.getTime());
    let part: unknown = typed;
    if (args.section) {
      for (const key of args.section.split('.')) part = part && typeof part === 'object' ? (part as Record<string, unknown>)[key] : undefined;
    }
    const evts = args.includeEvents ? (await events(ctx, { namespace: args.namespace, kind: info.kind, name: args.name, limit: 20 })).events : undefined;
    return {
      data: { kind: info.kind, name: args.name, namespace: args.namespace, summary: row, object: capJson(part ?? null), events: evts },
      summary: `${info.kind} ${args.namespace ? `${args.namespace}/` : ''}${args.name}: ${row.status}${row.detail ? ` (${row.detail})` : ''}.`,
      view: {
        title: `${info.kind} ${args.name}`,
        summary: `${row.status}${row.detail ? ` · ${row.detail}` : ''}`,
        rows: (evts ?? []).map(e => ({ label: `${e.reason} (${e.count}×)`, detail: e.message, status: `${e.type} · ${e.age}` })),
      },
    };
  },
});

const listEvents = defineTool({
  name: 'list_events',
  title: 'List Kubernetes events',
  description: 'Recent events, newest first, optionally for one namespace or object and only Warnings. Events expire after about an hour in most clusters.',
  input: z.object({
    namespace: z.string().optional(),
    kind: z.string().optional().describe('Kind of the involved object, for example Pod'),
    name: z.string().optional().describe('Name of the involved object'),
    type: z.enum(['Warning', 'Normal']).optional(),
    sinceMinutes: z.number().int().min(1).max(1440).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.object({ total: z.number(), events: z.array(eventSchema) }),
  async run(args, ctx) {
    const result = await events(ctx, args);
    return {
      data: result,
      summary: `${result.total} ${args.type ?? ''} event${result.total === 1 ? '' : 's'}${args.namespace ? ` in ${args.namespace}` : ''}${args.sinceMinutes ? ` in the last ${args.sinceMinutes} minutes` : ''}.`.replace('  ', ' '),
      view: {
        title: 'Events',
        rows: result.events.map(e => ({ label: `${e.object} · ${e.reason}`, detail: e.message, status: `${e.type} ${e.count}× · ${e.age}` })),
      },
    };
  },
});

const podLogs = defineTool({
  name: 'get_pod_logs',
  title: 'Get pod logs',
  description:
    'The last lines of a container log, with timestamps and secrets masked. Use previous=true for the container instance that crashed. Use grep to keep only matching lines (case-insensitive regular expression).',
  input: z.object({
    namespace: z.string(),
    pod: z.string(),
    container: z.string().optional().describe('Required when the pod has more than one container'),
    tailLines: z.number().int().min(1).max(2000).optional().describe('Default 200'),
    sinceMinutes: z.number().int().min(1).max(10080).optional(),
    previous: z.boolean().optional(),
    grep: z.string().max(200).optional(),
  }),
  output: z.object({ pod: z.string(), container: z.string().optional(), lines: z.number(), matched: z.number(), text: z.string() }),
  async run(args, ctx) {
    const raw = await ctx.kube.logs(args.namespace, args.pod, {
      container: args.container,
      tailLines: args.grep ? Math.max(args.tailLines ?? 1000, 1000) : args.tailLines,
      sinceSeconds: args.sinceMinutes ? args.sinceMinutes * 60 : undefined,
      previous: args.previous,
    });
    let lines = raw.split('\n').filter(Boolean);
    const total = lines.length;
    if (args.grep) {
      const re = new RegExp(args.grep, 'i');
      lines = lines.filter(l => re.test(l));
    }
    lines = lines.slice(-(args.tailLines ?? 200)).map(l => (l.length > 600 ? `${l.slice(0, 600)}…` : l));
    const text = lines.join('\n').slice(-48_000);
    return {
      data: { pod: args.pod, container: args.container, lines: total, matched: lines.length, text },
      summary: `${lines.length} log line${lines.length === 1 ? '' : 's'} from ${args.namespace}/${args.pod}${args.container ? `/${args.container}` : ''}${args.previous ? ' (previous instance)' : ''}${args.grep ? ` matching /${args.grep}/` : ''}.`,
      view: {
        title: `Logs ${args.pod}${args.container ? `/${args.container}` : ''}`,
        rows: lines.slice(-30).map(l => {
          const [ts, ...rest] = l.split(' ');
          return { label: rest.join(' ').slice(0, 200), detail: ts, status: '' };
        }),
      },
    };
  },
});

const apiResources = defineTool({
  name: 'list_api_resources',
  title: 'List resource types',
  description: 'The resource types this cluster serves (core, built-in and CRDs), so you can find the right kind for list_resources. Secrets are left out.',
  input: z.object({ filter: z.string().optional().describe('Case-insensitive substring of kind, plural or group') }),
  output: z.object({ resources: z.array(z.object({ kind: z.string(), resource: z.string(), group: z.string(), namespaced: z.boolean() })) }),
  async run(args, ctx) {
    const all = await ctx.kube.resources();
    const f = args.filter?.toLowerCase();
    const resources = all
      .filter(r => r.verbs.includes('list'))
      .filter(r => !f || r.kind.toLowerCase().includes(f) || r.resource.includes(f) || r.group.includes(f))
      .map(r => ({ kind: r.kind, resource: r.resource, group: r.group, namespaced: r.namespaced }));
    return {
      data: { resources },
      summary: `${resources.length} resource types${f ? ` matching "${args.filter}"` : ''}.`,
      view: { title: 'Resource types', rows: resources.slice(0, 100).map(r => ({ label: r.kind, detail: r.group ? `${r.resource}.${r.group}` : r.resource, status: r.namespaced ? 'namespaced' : 'cluster' })) },
    };
  },
});

const overview = defineTool({
  name: 'cluster_overview',
  title: 'Cluster overview',
  description:
    'Starting point for any investigation: node readiness and pressure, pods that are not running or ready, workloads with unavailable replicas, and the count of Warning events in the last hour by reason.',
  input: z.object({}),
  output: z.object({
    nodes: z.array(rowSchema),
    problemPods: z.array(rowSchema),
    degradedWorkloads: z.array(rowSchema),
    warningReasons: z.array(z.object({ reason: z.string(), count: z.number() })),
  }),
  async run(_args, ctx) {
    const now = ctx.now.getTime();
    const [nodes, pods, deployments, statefulsets, daemonsets, warn] = await Promise.all([
      ctx.kube.list('nodes'),
      ctx.kube.list('pods', { limit: 2000 }),
      ctx.kube.list('deployments', { limit: 2000 }),
      ctx.kube.list('statefulsets', { limit: 2000 }),
      ctx.kube.list('daemonsets', { limit: 2000 }),
      events(ctx, { type: 'Warning', sinceMinutes: 60, limit: 1000 }),
    ]);
    const nodeRows = nodes.items.map(n => summarize(n, now));
    const problemPods = pods.items
      .map(p => ({ p, row: summarize(p, now) }))
      .filter(({ p, row }) => {
        if (p.status?.phase === 'Succeeded') return false;
        const statuses: any[] = p.status?.containerStatuses ?? [];
        return p.status?.phase !== 'Running' || statuses.some(c => !c.ready) || row.status !== 'Running';
      })
      .map(({ row }) => row)
      .slice(0, 60);
    const degraded = [...deployments.items, ...statefulsets.items, ...daemonsets.items]
      .map(w => summarize(w, now))
      .filter(r => r.status === 'Degraded');
    const reasons = new Map<string, number>();
    for (const e of warn.events) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + e.count);
    const warningReasons = [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
    const notReady = nodeRows.filter(n => n.status !== 'Ready').length;
    return {
      data: { nodes: nodeRows, problemPods, degradedWorkloads: degraded, warningReasons },
      summary: `${nodeRows.length} nodes (${notReady} not ready), ${problemPods.length} pods not running or not ready, ${degraded.length} degraded workloads, ${warn.total} warning events in the last hour.`,
      view: {
        title: 'Cluster overview',
        rows: [
          ...nodeRows.map(n => ({ label: `node ${n.name}`, detail: n.detail, status: n.status })),
          ...degraded.map(w => ({ label: `${w.kind} ${w.namespace}/${w.name}`, detail: w.detail, status: w.status })),
          ...problemPods.slice(0, 20).map(p => ({ label: `pod ${p.namespace}/${p.name}`, detail: p.detail, status: p.status })),
        ],
      },
    };
  },
});

export default defineProvider({
  name: 'kubernetes',
  title: 'Kubernetes',
  description: 'Cluster resources, events and pod logs, read-only and without Secrets',
  tools: [overview, listResources, getResource, listEvents, podLogs, apiResources],
});
