/**
 * Agent data provider for the disk-health plugin: the same SMART and disk
 * performance signals the Disks page shows, as MCP tools.
 */
import { defineProvider, defineTool, promString, z } from '../../../agent/src/sdk.js';

const ATTRIBUTES = 'Reallocated_Sector_Ct|Current_Pending_Sector|Offline_Uncorrectable|Reported_Uncorrect|Wear_Leveling_Count|Media_Wearout_Indicator';
const RATE = '5m';

const diskSchema = z.object({
  node: z.string(),
  device: z.string(),
  model: z.string(),
  smartPassed: z.boolean().nullable(),
  temperatureC: z.number().nullable(),
  mediaErrors: z.number().nullable(),
  percentageUsed: z.number().nullable(),
  attributes: z.record(z.string(), z.number()),
  problems: z.array(z.string()),
});

function key(m: { node?: string; instance?: string; device?: string }): string {
  return `${m.node ?? m.instance ?? ''}/${m.device ?? ''}`;
}

const smart = defineTool({
  name: 'disk_health_smart',
  title: 'SMART disk health',
  description:
    'SMART health per disk (pass/fail, temperature, NVMe media errors and wear, reallocated and pending sectors), optionally for one node. Problems lists anything that suggests a failing disk.',
  input: z.object({ node: z.string().optional().describe('Node name as in the node label, for example worker-1') }),
  output: z.object({ disks: z.array(diskSchema) }),
  async run(args, ctx) {
    const sel = args.node ? `node="${promString(args.node)}"` : '';
    const s = sel ? `{${sel}}` : '';
    const attrSel = `{${sel ? `${sel},` : ''}attribute_name=~"${ATTRIBUTES}",attribute_value_type="raw"}`;
    const [status, temp, media, used, attrs, info] = await Promise.all([
      ctx.prom.query(`smartctl_device_smart_status${s}`),
      ctx.prom.query(`smartctl_device_temperature${s}`).catch(() => []),
      ctx.prom.query(`smartctl_device_media_errors${s}`).catch(() => []),
      ctx.prom.query(`smartctl_device_percentage_used${s}`).catch(() => []),
      ctx.prom.query(`smartctl_device_attribute${attrSel}`).catch(() => []),
      ctx.prom.query(`smartctl_device${s}`).catch(() => []),
    ]);
    const disks = new Map<string, z.infer<typeof diskSchema>>();
    const get = (m: Record<string, string>) => {
      const k = key(m);
      let d = disks.get(k);
      if (!d) {
        d = { node: m.node ?? m.instance ?? '', device: m.device ?? '', model: '', smartPassed: null, temperatureC: null, mediaErrors: null, percentageUsed: null, attributes: {}, problems: [] };
        disks.set(k, d);
      }
      return d;
    };
    for (const x of status) get(x.metric).smartPassed = x.value === 1;
    for (const x of temp) if (!x.metric.temperature_type || x.metric.temperature_type === 'current') get(x.metric).temperatureC = x.value;
    for (const x of media) get(x.metric).mediaErrors = x.value;
    for (const x of used) get(x.metric).percentageUsed = x.value;
    for (const x of attrs) get(x.metric).attributes[x.metric.attribute_name] = x.value;
    for (const x of info) if (disks.has(key(x.metric))) get(x.metric).model = x.metric.model_name ?? '';
    for (const d of disks.values()) {
      if (d.smartPassed === false) d.problems.push('SMART overall health check failed');
      if ((d.mediaErrors ?? 0) > 0) d.problems.push(`${d.mediaErrors} NVMe media errors`);
      if ((d.percentageUsed ?? 0) >= 90) d.problems.push(`${d.percentageUsed}% of rated endurance used`);
      for (const name of ['Reallocated_Sector_Ct', 'Current_Pending_Sector', 'Offline_Uncorrectable', 'Reported_Uncorrect']) {
        if ((d.attributes[name] ?? 0) > 0) d.problems.push(`${name} = ${d.attributes[name]}`);
      }
      if ((d.temperatureC ?? 0) >= 70) d.problems.push(`temperature ${d.temperatureC} °C`);
    }
    const list = [...disks.values()].sort((a, b) => b.problems.length - a.problems.length || key(a).localeCompare(key(b)));
    const bad = list.filter(d => d.problems.length).length;
    return {
      data: { disks: list },
      summary: `${list.length} disks${args.node ? ` on ${args.node}` : ''}, ${bad} with problems.`,
      view: {
        title: 'SMART disk health',
        rows: list.map(d => ({
          label: `${d.node} ${d.device}${d.model ? ` (${d.model})` : ''}`,
          detail: d.problems.join('; ') || `${d.temperatureC ?? '?'} °C`,
          status: d.smartPassed === false ? 'FAILED' : d.problems.length ? 'warning' : 'ok',
        })),
      },
    };
  },
});

const perf = defineTool({
  name: 'disk_health_performance',
  title: 'Disk performance',
  description:
    'Five-minute disk latency (ms per read and write), IOPS, throughput, utilisation and I/O pressure stall per node and device, to see whether a disk is the reason a workload is slow.',
  input: z.object({ node: z.string().optional() }),
  output: z.object({
    devices: z.array(
      z.object({
        node: z.string(),
        device: z.string(),
        readLatencyMs: z.number().nullable(),
        writeLatencyMs: z.number().nullable(),
        readIops: z.number().nullable(),
        writeIops: z.number().nullable(),
        utilisationPercent: z.number().nullable(),
      }),
    ),
    ioPressurePercent: z.record(z.string(), z.number()),
  }),
  async run(args, ctx) {
    const base = `device!~"loop.*|ram.*|dm-.*|zram.*|sr.*"${args.node ? `,node="${promString(args.node)}"` : ''}`;
    const q = {
      writeLatencyMs: `rate(node_disk_write_time_seconds_total{${base}}[${RATE}]) / rate(node_disk_writes_completed_total{${base}}[${RATE}]) * 1000`,
      readLatencyMs: `rate(node_disk_read_time_seconds_total{${base}}[${RATE}]) / rate(node_disk_reads_completed_total{${base}}[${RATE}]) * 1000`,
      writeIops: `rate(node_disk_writes_completed_total{${base}}[${RATE}])`,
      readIops: `rate(node_disk_reads_completed_total{${base}}[${RATE}])`,
      utilisationPercent: `rate(node_disk_io_time_seconds_total{${base}}[${RATE}]) * 100`,
    } as const;
    const keys = Object.keys(q) as Array<keyof typeof q>;
    const results = await Promise.all(keys.map(k => ctx.prom.query(q[k]).catch(() => [])));
    const pressure = await ctx.prom
      .query(`rate(node_pressure_io_stalled_seconds_total${args.node ? `{node="${promString(args.node)}"}` : ''}[${RATE}]) * 100`)
      .catch(() => []);
    const rows = new Map<string, any>();
    keys.forEach((k, i) => {
      for (const x of results[i]) {
        const id = key(x.metric);
        const row = rows.get(id) ?? { node: x.metric.node ?? x.metric.instance ?? '', device: x.metric.device ?? '', readLatencyMs: null, writeLatencyMs: null, readIops: null, writeIops: null, utilisationPercent: null };
        row[k] = Number.isFinite(x.value) ? x.value : null;
        rows.set(id, row);
      }
    });
    const devices = [...rows.values()].sort((a, b) => (b.utilisationPercent ?? 0) - (a.utilisationPercent ?? 0));
    const ioPressurePercent: Record<string, number> = {};
    for (const p of pressure) ioPressurePercent[p.metric.node ?? p.metric.instance ?? ''] = p.value;
    const busiest = devices[0];
    return {
      data: { devices, ioPressurePercent },
      summary: busiest ? `Busiest disk ${busiest.node}/${busiest.device} at ${busiest.utilisationPercent ?? '?'}% utilisation, write latency ${busiest.writeLatencyMs ?? '?'} ms.` : 'No disk metrics.',
      view: {
        title: 'Disk performance (5 min)',
        rows: devices.slice(0, 40).map(d => ({
          label: `${d.node} ${d.device}`,
          detail: `read ${d.readLatencyMs ?? '-'} ms · write ${d.writeLatencyMs ?? '-'} ms · ${Math.round((d.readIops ?? 0) + (d.writeIops ?? 0))} IOPS`,
          status: `${d.utilisationPercent ?? '-'}% busy`,
        })),
      },
    };
  },
});

const capacity = defineTool({
  name: 'disk_health_capacity',
  title: 'Filesystem capacity',
  description: 'Free space and free inodes per node filesystem, fullest first, with the growth over the last 6 hours.',
  input: z.object({ node: z.string().optional(), minUsedPercent: z.number().min(0).max(100).optional().describe('Only filesystems at least this full; default 0') }),
  output: z.object({ filesystems: z.array(z.object({ node: z.string(), mountpoint: z.string(), device: z.string(), usedPercent: z.number(), availGiB: z.number(), growthGiB6h: z.number().nullable(), inodesUsedPercent: z.number().nullable() })) }),
  async run(args, ctx) {
    const sel = `fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|devtmpfs|autofs|fuse.*",mountpoint!~"/run.*|/var/lib/kubelet.*|/boot.*"${args.node ? `,node="${promString(args.node)}"` : ''}`;
    const [avail, size, growth, inodes] = await Promise.all([
      ctx.prom.query(`node_filesystem_avail_bytes{${sel}}`),
      ctx.prom.query(`node_filesystem_size_bytes{${sel}}`),
      ctx.prom.query(`(node_filesystem_size_bytes{${sel}} - node_filesystem_avail_bytes{${sel}}) - (node_filesystem_size_bytes{${sel}} offset 6h - node_filesystem_avail_bytes{${sel}} offset 6h)`).catch(() => []),
      ctx.prom.query(`1 - node_filesystem_files_free{${sel}} / node_filesystem_files{${sel}}`).catch(() => []),
    ]);
    const id = (m: Record<string, string>) => `${m.node ?? m.instance}|${m.mountpoint}|${m.device}`;
    const sizes = new Map(size.map(s => [id(s.metric), s.value]));
    const grow = new Map(growth.map(s => [id(s.metric), s.value]));
    const ino = new Map(inodes.map(s => [id(s.metric), s.value]));
    const seen = new Set<string>();
    const filesystems = avail
      .filter(a => {
        const k = `${a.metric.node ?? a.metric.instance}|${a.metric.device}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map(a => {
        const total = sizes.get(id(a.metric)) ?? 0;
        return {
          node: a.metric.node ?? a.metric.instance ?? '',
          mountpoint: a.metric.mountpoint ?? '',
          device: a.metric.device ?? '',
          usedPercent: total ? Math.round((1 - a.value / total) * 1000) / 10 : 0,
          availGiB: Math.round((a.value / 2 ** 30) * 10) / 10,
          growthGiB6h: grow.has(id(a.metric)) ? Math.round(((grow.get(id(a.metric)) ?? 0) / 2 ** 30) * 100) / 100 : null,
          inodesUsedPercent: ino.has(id(a.metric)) ? Math.round((ino.get(id(a.metric)) ?? 0) * 1000) / 10 : null,
        };
      })
      .filter(f => f.usedPercent >= (args.minUsedPercent ?? 0))
      .sort((a, b) => b.usedPercent - a.usedPercent);
    return {
      data: { filesystems },
      summary: filesystems[0] ? `Fullest filesystem ${filesystems[0].node}:${filesystems[0].mountpoint} at ${filesystems[0].usedPercent}% (${filesystems[0].availGiB} GiB free).` : 'No filesystems match.',
      view: {
        title: 'Filesystem capacity',
        rows: filesystems.slice(0, 40).map(f => ({ label: `${f.node} ${f.mountpoint}`, detail: `${f.availGiB} GiB free${f.growthGiB6h !== null ? ` · ${f.growthGiB6h >= 0 ? '+' : ''}${f.growthGiB6h} GiB in 6 h` : ''}`, status: `${f.usedPercent}%` })),
      },
    };
  },
});

export const provider = defineProvider({
  name: 'disk_health',
  title: 'Disk health',
  description: 'SMART health, disk performance and filesystem capacity per node (disk-health plugin)',
  tools: [smart, perf, capacity],
});
