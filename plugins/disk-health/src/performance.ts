/*
 * Disk performance data: per (node, device) write/read latency, IOPS,
 * throughput, utilisation and discard activity, plus per-node IO pressure
 * (PSI), all derived from node-exporter's block-device counters over a 5m
 * rate window. SMART health can look perfectly healthy while a disk is
 * still catastrophically slow (high write latency without any error
 * counters moving), which is what this module exists to surface - see
 * README for the incident that prompted it.
 */
import { MetricSample, numberFromValue, queryMetrics } from './metrics';

/** Pseudo devices that never represent real, independently-monitorable storage. */
export const EXCLUDED_PERF_DEVICES = 'loop.*|zram.*';

/**
 * dm- (device-mapper) devices are kept rather than filtered: on nodes that
 * boot from an LVM root, the root filesystem's latency is only visible on
 * its dm- device, and that is exactly the path etcd's fsync goes through.
 * Only loop and zram devices are pseudo enough to always exclude.
 */
const EXCLUDED_DEVICE_RE = new RegExp(`^(${EXCLUDED_PERF_DEVICES})$`);

/** True if this device should appear in the performance table. */
export function isPerfDevice(device: string): boolean {
  return !EXCLUDED_DEVICE_RE.test(device);
}

/** One row of the disk-performance table, merged from several PromQL queries. */
export interface DiskPerfRow {
  node: string;
  device: string;
  writeLatencyMs?: number;
  readLatencyMs?: number;
  writeIops?: number;
  readIops?: number;
  writeMBs?: number;
  readMBs?: number;
  utilisationPercent?: number;
  discardOpsPerSec?: number;
  discardMBs?: number;
}

/** One node's IO pressure (PSI "some" stall), independent of any one device. */
export interface NodeIoPressure {
  node: string;
  stalledPercent: number;
}

/** Write-latency thresholds (ms): green below amber, amber below red. */
export const WRITE_LATENCY_AMBER_MS = 5;
export const WRITE_LATENCY_RED_MS = 20;

/** Utilisation thresholds (%): green below amber, amber below red. */
export const UTILISATION_AMBER_PERCENT = 70;
export const UTILISATION_RED_PERCENT = 90;

export type Severity = 'ok' | 'warn' | 'error';

/** Colour bucket for a write-latency figure, or 'ok' if unknown. */
export function writeLatencySeverity(ms: number | undefined): Severity {
  if (ms === undefined) {
    return 'ok';
  }
  if (ms > WRITE_LATENCY_RED_MS) {
    return 'error';
  }
  if (ms >= WRITE_LATENCY_AMBER_MS) {
    return 'warn';
  }
  return 'ok';
}

/** Colour bucket for a utilisation figure, or 'ok' if unknown. */
export function utilisationSeverity(percent: number | undefined): Severity {
  if (percent === undefined) {
    return 'ok';
  }
  if (percent > UTILISATION_RED_PERCENT) {
    return 'error';
  }
  if (percent >= UTILISATION_AMBER_PERCENT) {
    return 'warn';
  }
  return 'ok';
}

/** Worst (highest-severity) of a row's write-latency and utilisation buckets. */
export function rowSeverity(row: DiskPerfRow): Severity {
  const severities = [writeLatencySeverity(row.writeLatencyMs), utilisationSeverity(row.utilisationPercent)];
  if (severities.includes('error')) {
    return 'error';
  }
  if (severities.includes('warn')) {
    return 'warn';
  }
  return 'ok';
}

function deviceKey(labels: Record<string, string>): string | undefined {
  return labels.device;
}

/**
 * Merges the raw PromQL rate-query results for every performance signal
 * into one DiskPerfRow per (node, device). Devices excluded by
 * isPerfDevice are dropped even if a query happened to return them.
 */
export function mergeDiskPerfRows(
  writeLatencyMs: MetricSample[],
  readLatencyMs: MetricSample[],
  writeIops: MetricSample[],
  readIops: MetricSample[],
  writeMBs: MetricSample[],
  readMBs: MetricSample[],
  utilisationPercent: MetricSample[],
  discardOpsPerSec: MetricSample[],
  discardMBs: MetricSample[]
): DiskPerfRow[] {
  const rows = new Map<string, DiskPerfRow>();

  const rowFor = (labels: Record<string, string>): DiskPerfRow | undefined => {
    const node = labels.node;
    const device = deviceKey(labels);
    if (!node || !device || !isPerfDevice(device)) {
      return undefined;
    }
    const key = `${node}/${device}`;
    let row = rows.get(key);
    if (!row) {
      row = { node, device };
      rows.set(key, row);
    }
    return row;
  };

  const assign = (samples: MetricSample[], field: keyof Omit<DiskPerfRow, 'node' | 'device'>): void => {
    for (const sample of samples) {
      const row = rowFor(sample.metric);
      if (row) {
        row[field] = numberFromValue(sample);
      }
    }
  };

  assign(writeLatencyMs, 'writeLatencyMs');
  assign(readLatencyMs, 'readLatencyMs');
  assign(writeIops, 'writeIops');
  assign(readIops, 'readIops');
  assign(writeMBs, 'writeMBs');
  assign(readMBs, 'readMBs');
  assign(utilisationPercent, 'utilisationPercent');
  assign(discardOpsPerSec, 'discardOpsPerSec');
  assign(discardMBs, 'discardMBs');

  return Array.from(rows.values()).sort(
    (a, b) => a.node.localeCompare(b.node) || a.device.localeCompare(b.device)
  );
}

/** Merges raw PSI samples into one NodeIoPressure per node. */
export function mergeNodeIoPressure(stalledPercent: MetricSample[]): NodeIoPressure[] {
  const rows: NodeIoPressure[] = [];
  for (const sample of stalledPercent) {
    const node = sample.metric.node;
    if (!node) {
      continue;
    }
    const value = numberFromValue(sample);
    if (value !== undefined) {
      rows.push({ node, stalledPercent: value });
    }
  }
  return rows.sort((a, b) => a.node.localeCompare(b.node));
}

const RATE_WINDOW = '5m';

/** The PromQL queries behind fetchDiskPerfRows/fetchNodeIoPressure, exposed for tests and reuse. */
export function diskPerfQueries(nodeFilter?: string): {
  writeLatencyMs: string;
  readLatencyMs: string;
  writeIops: string;
  readIops: string;
  writeMBs: string;
  readMBs: string;
  utilisationPercent: string;
  discardOpsPerSec: string;
  discardMBs: string;
} {
  const sel = nodeFilter ? `{${nodeFilter}}` : '';
  return {
    writeLatencyMs:
      `(rate(node_disk_write_time_seconds_total${sel}[${RATE_WINDOW}]) / ` +
      `rate(node_disk_writes_completed_total${sel}[${RATE_WINDOW}])) * 1000`,
    readLatencyMs:
      `(rate(node_disk_read_time_seconds_total${sel}[${RATE_WINDOW}]) / ` +
      `rate(node_disk_reads_completed_total${sel}[${RATE_WINDOW}])) * 1000`,
    writeIops: `rate(node_disk_writes_completed_total${sel}[${RATE_WINDOW}])`,
    readIops: `rate(node_disk_reads_completed_total${sel}[${RATE_WINDOW}])`,
    writeMBs: `rate(node_disk_written_bytes_total${sel}[${RATE_WINDOW}]) / 1e6`,
    readMBs: `rate(node_disk_read_bytes_total${sel}[${RATE_WINDOW}]) / 1e6`,
    utilisationPercent: `rate(node_disk_io_time_seconds_total${sel}[${RATE_WINDOW}]) * 100`,
    discardOpsPerSec: `rate(node_disk_discards_completed_total${sel}[${RATE_WINDOW}])`,
    // node_disk_discarded_sectors_total is in 512-byte sectors (the kernel's
    // fixed sector size for these counters, independent of the device's
    // actual block size).
    discardMBs: `(rate(node_disk_discarded_sectors_total${sel}[${RATE_WINDOW}]) * 512) / 1e6`,
  };
}

/** The PromQL query behind fetchNodeIoPressure, exposed for tests and reuse. */
export function nodeIoPressureQuery(nodeFilter?: string): string {
  const sel = nodeFilter ? `{${nodeFilter}}` : '';
  return `rate(node_pressure_io_stalled_seconds_total${sel}[${RATE_WINDOW}]) * 100`;
}

/**
 * Fetches and merges every disk-performance signal into a table of
 * DiskPerfRow, one row per block device. Pass a PromQL label matcher
 * fragment (for example `node="worker-1"`) to scope to one node, or omit
 * it to fetch for every node in the cluster in a single batch of queries.
 */
export async function fetchDiskPerfRows(nodeFilter?: string): Promise<DiskPerfRow[]> {
  const q = diskPerfQueries(nodeFilter);
  const [
    writeLatencyMs,
    readLatencyMs,
    writeIops,
    readIops,
    writeMBs,
    readMBs,
    utilisationPercent,
    discardOpsPerSec,
    discardMBs,
  ] = await Promise.all([
    queryMetrics(q.writeLatencyMs),
    queryMetrics(q.readLatencyMs),
    queryMetrics(q.writeIops),
    queryMetrics(q.readIops),
    queryMetrics(q.writeMBs).catch(() => []),
    queryMetrics(q.readMBs).catch(() => []),
    queryMetrics(q.utilisationPercent),
    queryMetrics(q.discardOpsPerSec).catch(() => []),
    queryMetrics(q.discardMBs).catch(() => []),
  ]);

  return mergeDiskPerfRows(
    writeLatencyMs,
    readLatencyMs,
    writeIops,
    readIops,
    writeMBs,
    readMBs,
    utilisationPercent,
    discardOpsPerSec,
    discardMBs
  );
}

/**
 * Fetches per-node IO pressure (PSI "some" stall percentage). Some kernels
 * or container runtimes don't expose pressure stall information, so an
 * empty result is expected and not an error.
 */
export async function fetchNodeIoPressure(nodeFilter?: string): Promise<NodeIoPressure[]> {
  const samples = await queryMetrics(nodeIoPressureQuery(nodeFilter)).catch(() => []);
  return mergeNodeIoPressure(samples);
}

/** Groups disk-performance rows by node, worst severity first within each node. */
export function groupDiskPerfRowsByNode(rows: DiskPerfRow[]): Map<string, DiskPerfRow[]> {
  const severityRank: Record<Severity, number> = { error: 2, warn: 1, ok: 0 };
  const byNode = new Map<string, DiskPerfRow[]>();
  for (const row of rows) {
    const list = byNode.get(row.node) ?? [];
    list.push(row);
    byNode.set(row.node, list);
  }
  for (const [node, list] of byNode) {
    byNode.set(
      node,
      [...list].sort(
        (a, b) => severityRank[rowSeverity(b)] - severityRank[rowSeverity(a)] || a.device.localeCompare(b.device)
      )
    );
  }
  return byNode;
}
