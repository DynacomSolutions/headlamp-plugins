/*
 * Node disk-capacity data: aggregates node_filesystem_size_bytes /
 * node_filesystem_avail_bytes into one used/total/avail figure per node
 * (for the Nodes list column and the Disks page summary) plus a
 * per-filesystem breakdown (for the Disks page detail table).
 *
 * The dedupe-by-device logic below exists because a single physical/logical
 * device can be bind-mounted at more than one mountpoint; counting every
 * mountpoint would double-count its capacity.
 */
import { MetricSample, numberFromValue, queryMetrics } from './metrics';

/** Pseudo filesystems and network mounts excluded from capacity figures. */
export const EXCLUDED_FSTYPES = 'tmpfs|overlay|squashfs|nsfs|ramfs|devtmpfs|fuse.*|nfs.*|cifs';

/** One raw (node, device, mountpoint) sample, before dedupe. */
export interface FsSample {
  node: string;
  device: string;
  mountpoint: string;
  fstype: string;
  sizeBytes: number;
  availBytes: number;
}

/** One row of the per-filesystem breakdown table. */
export interface FsRow extends FsSample {
  usedBytes: number;
  percentUsed: number | null;
}

/** One node's aggregate capacity figure, deduped by device. */
export interface NodeCapacity {
  node: string;
  totalBytes: number;
  availBytes: number;
  usedBytes: number;
  filesystems: FsRow[];
}

const EXCLUDED_FSTYPE_RE = new RegExp(`^(${EXCLUDED_FSTYPES})$`);

/** True if this fstype should count toward node capacity figures. */
export function isCountableFstype(fstype: string): boolean {
  return !EXCLUDED_FSTYPE_RE.test(fstype);
}

/**
 * The PromQL queries for node disk capacity: one pair of instant queries,
 * each returning one series per (node, device, mountpoint, fstype) across
 * every node in the cluster in a single batch. The `fstype!~` filter is
 * applied in PromQL too (belt-and-braces with isCountableFstype, which
 * exists so the exclusion logic itself is unit-testable).
 */
export function capacityQueries(): { sizeQuery: string; availQuery: string } {
  const sel = `{fstype!~"${EXCLUDED_FSTYPES}"}`;
  return {
    sizeQuery: `max by (node, device, mountpoint, fstype) (node_filesystem_size_bytes${sel})`,
    availQuery: `max by (node, device, mountpoint, fstype) (node_filesystem_avail_bytes${sel})`,
  };
}

function sampleKey(labels: Record<string, string>): string {
  return `${labels.node}/${labels.device}/${labels.mountpoint}`;
}

/** Merges the raw size/avail samples into one FsSample per (node, device, mountpoint). */
export function mergeFsSamples(sizeSamples: MetricSample[], availSamples: MetricSample[]): FsSample[] {
  const byKey = new Map<string, FsSample>();

  for (const sample of sizeSamples) {
    const { node, device, mountpoint, fstype } = sample.metric;
    if (!node || !device || !mountpoint || !isCountableFstype(fstype || '')) {
      continue;
    }
    const sizeBytes = numberFromValue(sample);
    if (sizeBytes === undefined) {
      continue;
    }
    byKey.set(sampleKey(sample.metric), { node, device, mountpoint, fstype, sizeBytes, availBytes: 0 });
  }

  for (const sample of availSamples) {
    const existing = byKey.get(sampleKey(sample.metric));
    if (!existing) {
      continue;
    }
    existing.availBytes = numberFromValue(sample) ?? 0;
  }

  return Array.from(byKey.values());
}

/**
 * Aggregates raw filesystem samples into one NodeCapacity per node:
 * - total = sum over distinct devices of max(size) for that device
 * - avail = sum over distinct devices of max(avail) for that device
 * - used  = total - avail
 * plus the full (non-deduped) per-filesystem breakdown, sorted by mountpoint.
 */
export function aggregateNodeCapacity(samples: FsSample[]): Map<string, NodeCapacity> {
  const byNode = new Map<string, FsSample[]>();
  for (const s of samples) {
    const list = byNode.get(s.node) ?? [];
    list.push(s);
    byNode.set(s.node, list);
  }

  const result = new Map<string, NodeCapacity>();
  for (const [node, nodeSamples] of byNode) {
    const maxByDevice = new Map<string, { size: number; avail: number }>();
    for (const s of nodeSamples) {
      const existing = maxByDevice.get(s.device);
      if (!existing) {
        maxByDevice.set(s.device, { size: s.sizeBytes, avail: s.availBytes });
      } else {
        existing.size = Math.max(existing.size, s.sizeBytes);
        existing.avail = Math.max(existing.avail, s.availBytes);
      }
    }
    let totalBytes = 0;
    let availBytes = 0;
    for (const { size, avail } of maxByDevice.values()) {
      totalBytes += size;
      availBytes += avail;
    }

    const filesystems: FsRow[] = nodeSamples
      .map(s => ({
        ...s,
        usedBytes: Math.max(0, s.sizeBytes - s.availBytes),
        percentUsed: s.sizeBytes > 0 ? (100 * (s.sizeBytes - s.availBytes)) / s.sizeBytes : null,
      }))
      .sort((a, b) => a.mountpoint.localeCompare(b.mountpoint));

    result.set(node, {
      node,
      totalBytes,
      availBytes,
      usedBytes: Math.max(0, totalBytes - availBytes),
      filesystems,
    });
  }
  return result;
}

/** Fetches and aggregates node disk-capacity figures for every node, in one batch of two queries. */
export async function fetchNodeCapacity(): Promise<Map<string, NodeCapacity>> {
  const { sizeQuery, availQuery } = capacityQueries();
  const [sizeSamples, availSamples] = await Promise.all([queryMetrics(sizeQuery), queryMetrics(availQuery)]);
  return aggregateNodeCapacity(mergeFsSamples(sizeSamples, availSamples));
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Formats a byte count as a compact decimal (SI) string, e.g. "7.94 TB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const decimals = value < 10 && unit > 0 ? 2 : value < 100 && unit > 0 ? 1 : 0;
  return `${value.toFixed(decimals)} ${BYTE_UNITS[unit]}`;
}

/** Formats a used/total pair as a percentage string, e.g. "78.5 %", or null if total is 0. */
export function formatPercent(used: number, total: number): string | null {
  if (total <= 0) {
    return null;
  }
  const percentage = (used / total) * 100;
  const decimals = percentage % 10 > 0 ? 1 : 0;
  return `${percentage.toFixed(decimals)} %`;
}
