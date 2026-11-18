import { defineProvider, defineTool, z } from '../sdk.js';
import { MAX_SERIES, parseDuration } from '../prom.js';

const labels = z.record(z.string(), z.string());

function labelText(metric: Record<string, string>): string {
  const name = metric.__name__ ?? '';
  const rest = Object.entries(metric)
    .filter(([k]) => k !== '__name__')
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ');
  return rest ? `${name}{${rest}}` : name || '{}';
}

const query = defineTool({
  name: 'query_metrics',
  title: 'Query metrics (instant)',
  description:
    'Runs a PromQL (MetricsQL) instant query against VictoriaMetrics and returns at most 40 series with their current value. Use topk/sort_desc to keep the answer small. Common sources: kube-state-metrics (kube_*), node-exporter (node_*), cAdvisor (container_*), smartctl_exporter (smartctl_*), blackbox probes (probe_*).',
  input: z.object({
    query: z.string().min(1).max(4000),
    at: z.string().optional().describe('ISO time to evaluate at; default now'),
  }),
  output: z.object({ query: z.string(), total: z.number(), samples: z.array(z.object({ metric: labels, value: z.number(), time: z.string() })) }),
  async run(args, ctx) {
    const samples = await ctx.prom.query(args.query, args.at ? new Date(args.at) : undefined);
    const kept = samples.slice(0, MAX_SERIES);
    return {
      data: { query: args.query, total: samples.length, samples: kept },
      summary: `${samples.length} series for ${args.query}${samples.length > kept.length ? `, showing ${kept.length}` : ''}.`,
      view: { title: 'Metrics', summary: args.query, rows: kept.map(s => ({ label: labelText(s.metric), detail: s.time, status: String(s.value) })) },
    };
  },
});

const range = defineTool({
  name: 'query_metrics_range',
  title: 'Query metrics over time',
  description:
    'Runs a PromQL range query and returns at most 40 series, each cut to 40 points (the highest value of each bucket is kept so spikes survive) with min, max, average, first and last. Start wide (a day) to see when something changed, then narrow.',
  input: z.object({
    query: z.string().min(1).max(4000),
    since: z.string().default('1h').describe('How far back, for example 30m, 6h, 2d (max 30d)'),
    until: z.string().optional().describe('ISO end time; default now'),
    step: z.string().optional().describe('Resolution, for example 1m; default chosen from the range'),
  }),
  output: z.object({
    query: z.string(),
    start: z.string(),
    end: z.string(),
    total: z.number(),
    series: z.array(
      z.object({
        metric: labels,
        points: z.array(z.tuple([z.string(), z.number()])),
        stats: z.object({ min: z.number(), max: z.number(), avg: z.number(), first: z.number(), last: z.number() }),
      }),
    ),
  }),
  async run(args, ctx) {
    const end = args.until ? new Date(args.until) : ctx.now;
    const seconds = Math.min(parseDuration(args.since), 30 * 86400);
    const start = new Date(end.getTime() - seconds * 1000);
    const all = await ctx.prom.queryRange(args.query, start, end, args.step ? parseDuration(args.step) : undefined);
    const series = all.slice(0, MAX_SERIES);
    return {
      data: { query: args.query, start: start.toISOString(), end: end.toISOString(), total: all.length, series },
      summary: `${all.length} series for ${args.query} over ${args.since}${all.length > series.length ? `, showing ${series.length}` : ''}.`,
      view: {
        title: `Metrics over ${args.since}`,
        summary: args.query,
        rows: series.map(s => ({ label: labelText(s.metric), detail: `min ${s.stats.min} · avg ${s.stats.avg} · max ${s.stats.max}`, status: `now ${s.stats.last}` })),
      },
    };
  },
});

const find = defineTool({
  name: 'find_metrics',
  title: 'Find metric names',
  description: 'Lists metric names that exist, filtered by a substring or regular expression, so you can write a correct query.',
  input: z.object({ pattern: z.string().min(2).describe('Regular expression matched against metric names, for example "^kube_pod_" or "restart"') }),
  output: z.object({ total: z.number(), names: z.array(z.string()) }),
  async run(args, ctx) {
    const names = await ctx.prom.labelValues('__name__', `{__name__=~".*${args.pattern.replace(/"/g, '\\"').replace(/^\^/, '')}.*"}`);
    return {
      data: { total: names.length, names: names.slice(0, 200) },
      summary: `${names.length} metric names match ${args.pattern}.`,
      view: { title: 'Metric names', rows: names.slice(0, 60).map(n => ({ label: n, detail: '', status: '' })) },
    };
  },
});

const alertSchema = z.object({
  name: z.string(),
  state: z.string(),
  severity: z.string(),
  labels,
  annotations: labels,
  activeAt: z.string(),
  value: z.string(),
  expression: z.string(),
});

const alerts = defineTool({
  name: 'list_alerts',
  title: 'List active alerts',
  description: 'Alerts that vmalert currently has pending or firing, with labels, annotations, value and the rule expression.',
  input: z.object({ state: z.enum(['firing', 'pending', 'any']).default('any') }),
  output: z.object({ alerts: z.array(alertSchema) }),
  async run(args, ctx) {
    const body = (await ctx.vmalert('/api/v1/alerts')) as { data?: { alerts?: any[] } };
    const list = (body.data?.alerts ?? [])
      .filter(a => args.state === 'any' || a.state === args.state)
      .map(a => ({
        name: a.name ?? a.labels?.alertname ?? '',
        state: a.state ?? '',
        severity: a.labels?.severity ?? '',
        labels: a.labels ?? {},
        annotations: a.annotations ?? {},
        activeAt: a.activeAt ?? '',
        value: String(a.value ?? ''),
        expression: a.expression ?? '',
      }));
    return {
      data: { alerts: list },
      summary: `${list.length} ${args.state === 'any' ? 'active' : args.state} alert${list.length === 1 ? '' : 's'}.`,
      view: {
        title: 'Active alerts',
        rows: list.map(a => ({ label: a.name, detail: a.annotations.summary ?? a.annotations.description ?? labelText(a.labels), status: `${a.severity} ${a.state}` })),
      },
    };
  },
});

const rules = defineTool({
  name: 'list_alert_rules',
  title: 'List alerting and recording rules',
  description: 'The rule groups vmalert evaluates, with each rule expression, health and last error, to see what an alert actually measures.',
  input: z.object({ filter: z.string().optional().describe('Substring of the rule or group name') }),
  output: z.object({
    rules: z.array(z.object({ group: z.string(), name: z.string(), type: z.string(), expression: z.string(), health: z.string(), lastError: z.string(), forSeconds: z.number() })),
  }),
  async run(args, ctx) {
    const body = (await ctx.vmalert('/api/v1/rules')) as { data?: { groups?: any[] } };
    const f = args.filter?.toLowerCase();
    const out = (body.data?.groups ?? []).flatMap(g =>
      (g.rules ?? []).map((r: any) => ({
        group: g.name ?? '',
        name: r.name ?? '',
        type: r.type ?? '',
        expression: r.query ?? r.expression ?? '',
        health: r.health ?? '',
        lastError: r.lastError ?? '',
        forSeconds: Number(r.duration ?? 0),
      })),
    ).filter(r => !f || r.name.toLowerCase().includes(f) || r.group.toLowerCase().includes(f));
    return {
      data: { rules: out.slice(0, 200) },
      summary: `${out.length} rules${f ? ` matching "${args.filter}"` : ''}.`,
      view: { title: 'Rules', rows: out.slice(0, 60).map(r => ({ label: `${r.group} / ${r.name}`, detail: r.expression.slice(0, 200), status: `${r.type} ${r.health}` })) },
    };
  },
});

export default defineProvider({
  name: 'metrics',
  title: 'Metrics and alerts',
  description: 'VictoriaMetrics queries and the vmalert rules and alerts',
  tools: [query, range, find, alerts, rules],
});
