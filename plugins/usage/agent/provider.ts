/** Agent data provider for the usage plugin: who uses CPU, memory and network. */
import { defineProvider, defineTool, promString, z } from '../../../agent/src/sdk.js';

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

export const provider = defineProvider({
  name: 'usage',
  title: 'Usage',
  description: 'Top CPU, memory and network consumers (usage plugin)',
  tools: [top],
});
