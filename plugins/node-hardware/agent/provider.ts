/** Agent data provider for the node-hardware plugin: temperatures and estimated power per node. */
import { defineProvider, defineTool, promString, z } from '../../../agent/src/sdk.js';

const hardware = defineTool({
  name: 'node_hardware_thermals',
  title: 'Node temperatures and power',
  description:
    'Hottest temperature sensor per node with its max/critical limits, CPU package and DRAM power (RAPL, an estimate) and GPU power, to check for thermal throttling or a hot node.',
  input: z.object({ node: z.string().optional() }),
  output: z.object({
    nodes: z.array(
      z.object({
        node: z.string(),
        hottestC: z.number().nullable(),
        hottestSensor: z.string(),
        critC: z.number().nullable(),
        packageW: z.number().nullable(),
        dramW: z.number().nullable(),
        gpuW: z.number().nullable(),
      }),
    ),
  }),
  async run(args, ctx) {
    const sel = args.node ? `{node="${promString(args.node)}"}` : '';
    const [temps, crit, pkg, dram, gpu] = await Promise.all([
      ctx.prom.query(`topk by (node) (1, node_hwmon_temp_celsius${sel})`),
      ctx.prom.query(`max by (node) (node_hwmon_temp_crit_celsius${sel})`).catch(() => []),
      ctx.prom.query(`sum by (node) (rate(node_rapl_package_joules_total${sel}[5m]))`).catch(() => []),
      ctx.prom.query(`sum by (node) (rate(node_rapl_dram_joules_total${sel}[5m]))`).catch(() => []),
      ctx.prom
        .query(`sum by (node) (node_hwmon_power_average_watt${sel} * on (node, chip) group_left (chip_name) node_hwmon_chip_names{chip_name=~"amdgpu|nouveau|i915|xe"})`)
        .catch(() => []),
    ]);
    const byNode = (list: Array<{ metric: Record<string, string>; value: number }>) => new Map(list.map(x => [x.metric.node ?? '', x.value]));
    const c = byNode(crit);
    const p = byNode(pkg);
    const d = byNode(dram);
    const g = byNode(gpu);
    const nodes = temps
      .map(t => ({
        node: t.metric.node ?? '',
        hottestC: t.value,
        hottestSensor: `${t.metric.chip ?? ''} ${t.metric.sensor ?? ''}`.trim(),
        critC: c.get(t.metric.node ?? '') ?? null,
        packageW: p.get(t.metric.node ?? '') ?? null,
        dramW: d.get(t.metric.node ?? '') ?? null,
        gpuW: g.get(t.metric.node ?? '') ?? null,
      }))
      .sort((a, b) => (b.hottestC ?? 0) - (a.hottestC ?? 0));
    return {
      data: { nodes },
      summary: nodes[0] ? `Hottest node ${nodes[0].node} at ${nodes[0].hottestC} °C (${nodes[0].hottestSensor}).` : 'No temperature metrics.',
      view: {
        title: 'Node temperatures',
        rows: nodes.map(n => ({
          label: n.node,
          detail: `${n.hottestSensor}${n.packageW !== null ? ` · CPU ${n.packageW} W` : ''}${n.gpuW !== null ? ` · GPU ${n.gpuW} W` : ''}`,
          status: `${n.hottestC} °C${n.critC ? ` / ${n.critC}` : ''}`,
        })),
      },
    };
  },
});

export const provider = defineProvider({
  name: 'node_hardware',
  title: 'Node hardware',
  description: 'Temperatures and estimated power per node (node-hardware plugin)',
  tools: [hardware],
});
