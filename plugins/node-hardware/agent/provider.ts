/** Agent data provider for the node-hardware plugin: temperatures and estimated power per node. */
import { buildProfiles, InventoryData, QUERIES, summarizeProfile } from '../src/inventory.js';
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

const slotCount = z.object({ total: z.number(), inUse: z.number() });

const profileTool = defineTool({
  name: 'node_hardware_profile',
  title: 'Node hardware profile',
  description:
    'Hardware profile per node: motherboard, CPU sockets, memory (installed, maximum, slots used), PCIe and M.2 slots in use, GPUs with VRAM and kind (discrete, integrated, BMC display), NVMe drives, and PCI links running below their maximum width or speed. Use it to answer what hardware a node has and whether it can take more RAM, GPUs or drives.',
  input: z.object({ node: z.string().optional() }),
  output: z.object({
    nodes: z.array(
      z.object({
        node: z.string(),
        collector: z.string(),
        board: z.string().nullable(),
        cpu: z.array(z.string()),
        memory: z.string(),
        pcieSlots: slotCount,
        m2Slots: slotCount,
        gpus: z.array(z.string()),
        discreteGpus: z.number(),
        nvme: z.array(z.string()),
        belowMaxLinks: z.array(z.string()),
      }),
    ),
  }),
  async run(args, ctx) {
    const keys = Object.keys(QUERIES) as (keyof typeof QUERIES)[];
    const results = await Promise.all(
      keys.map(k =>
        // A series that does not exist yet gives an empty list, never a failed profile.
        ctx.prom
          .query(QUERIES[k])
          .then(list => list.map(x => ({ metric: x.metric, value: [0, String(x.value)] as [number, string] })))
          .catch(() => []),
      ),
    );
    const data = Object.fromEntries(keys.map((k, i) => [k, results[i]])) as InventoryData;
    const nodes = [...buildProfiles(data).values()].filter(p => !args.node || p.node === args.node).map(summarizeProfile);
    return {
      data: { nodes },
      summary: nodes.length > 0 ? `Hardware profile for ${nodes.length} node(s).` : 'No hardware metrics found.',
      view: {
        title: 'Node hardware',
        rows: nodes.map(n => ({
          label: n.node,
          detail: `${n.memory}${n.gpus.length > 0 ? ` · ${n.discreteGpus} GPU${n.gpus.length > n.discreteGpus ? ` (+${n.gpus.length - n.discreteGpus} integrated or BMC)` : ''}` : ''}${n.nvme.length > 0 ? ` · ${n.nvme.length} NVMe` : ''}`,
          status: n.belowMaxLinks.length > 0 ? `${n.belowMaxLinks.length} link(s) below max` : n.collector,
        })),
      },
    };
  },
});

export const provider = defineProvider({
  name: 'node_hardware',
  title: 'Node hardware',
  description: 'Temperatures, estimated power and hardware profile per node (node-hardware plugin)',
  tools: [hardware, profileTool],
});
