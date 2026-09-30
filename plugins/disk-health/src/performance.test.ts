import { describe, expect, it } from 'vitest';
import type { MetricSample } from './metrics';
import {
  groupDiskPerfRowsByNode,
  isPerfDevice,
  mergeDiskPerfRows,
  mergeNodeIoPressure,
  rowSeverity,
  utilisationSeverity,
  writeLatencySeverity,
} from './performance';

const sample = (labels: Record<string, string>, value: number): MetricSample => ({
  metric: labels,
  value: [0, String(value)],
});

describe('isPerfDevice', () => {
  it('excludes loop and zram devices', () => {
    expect(isPerfDevice('loop0')).toBe(false);
    expect(isPerfDevice('zram0')).toBe(false);
  });

  it('keeps physical, RAID and device-mapper devices', () => {
    expect(isPerfDevice('nvme0n1')).toBe(true);
    expect(isPerfDevice('sda')).toBe(true);
    expect(isPerfDevice('md0')).toBe(true);
    // dm- devices are kept: a node's root filesystem can live on one, and
    // that is exactly the path etcd's fsync goes through.
    expect(isPerfDevice('dm-0')).toBe(true);
  });
});

describe('writeLatencySeverity', () => {
  it('buckets by the documented thresholds', () => {
    expect(writeLatencySeverity(undefined)).toBe('ok');
    expect(writeLatencySeverity(0.5)).toBe('ok');
    expect(writeLatencySeverity(4.9)).toBe('ok');
    expect(writeLatencySeverity(5)).toBe('warn');
    expect(writeLatencySeverity(19.9)).toBe('warn');
    expect(writeLatencySeverity(20.1)).toBe('error');
    expect(writeLatencySeverity(1700)).toBe('error');
  });
});

describe('utilisationSeverity', () => {
  it('buckets by the documented thresholds', () => {
    expect(utilisationSeverity(undefined)).toBe('ok');
    expect(utilisationSeverity(69.9)).toBe('ok');
    expect(utilisationSeverity(70)).toBe('warn');
    expect(utilisationSeverity(90.1)).toBe('error');
  });
});

describe('rowSeverity', () => {
  it('takes the worst of latency and utilisation', () => {
    expect(rowSeverity({ node: 'n', device: 'd', writeLatencyMs: 1, utilisationPercent: 95 })).toBe('error');
    expect(rowSeverity({ node: 'n', device: 'd', writeLatencyMs: 10, utilisationPercent: 1 })).toBe('warn');
    expect(rowSeverity({ node: 'n', device: 'd' })).toBe('ok');
  });
});

describe('mergeDiskPerfRows', () => {
  it('joins every signal for one (node, device) row', () => {
    const writeLatencyMs = [sample({ node: 'worker-1', device: 'nvme0n1' }, 1700)];
    const readLatencyMs = [sample({ node: 'worker-1', device: 'nvme0n1' }, 3)];
    const writeIops = [sample({ node: 'worker-1', device: 'nvme0n1' }, 12)];
    const readIops = [sample({ node: 'worker-1', device: 'nvme0n1' }, 40)];
    const writeMBs = [sample({ node: 'worker-1', device: 'nvme0n1' }, 1.2)];
    const readMBs = [sample({ node: 'worker-1', device: 'nvme0n1' }, 5.5)];
    const utilisationPercent = [sample({ node: 'worker-1', device: 'nvme0n1' }, 98)];
    const discardOpsPerSec = [sample({ node: 'worker-1', device: 'nvme0n1' }, 0)];
    const discardMBs = [sample({ node: 'worker-1', device: 'nvme0n1' }, 0)];

    const rows = mergeDiskPerfRows(
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

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      node: 'worker-1',
      device: 'nvme0n1',
      writeLatencyMs: 1700,
      readLatencyMs: 3,
      writeIops: 12,
      readIops: 40,
      writeMBs: 1.2,
      readMBs: 5.5,
      utilisationPercent: 98,
      discardOpsPerSec: 0,
      discardMBs: 0,
    });
  });

  it('drops excluded devices even if a query returns them', () => {
    const writeLatencyMs = [sample({ node: 'n', device: 'loop0' }, 1)];
    const rows = mergeDiskPerfRows(writeLatencyMs, [], [], [], [], [], [], [], []);
    expect(rows).toHaveLength(0);
  });
});

describe('mergeNodeIoPressure', () => {
  it('builds one row per node', () => {
    const samples = [sample({ node: 'a' }, 12.5), sample({ node: 'b' }, 0)];
    const rows = mergeNodeIoPressure(samples);
    expect(rows).toEqual([
      { node: 'a', stalledPercent: 12.5 },
      { node: 'b', stalledPercent: 0 },
    ]);
  });
});

describe('groupDiskPerfRowsByNode', () => {
  it('sorts worst severity first within each node', () => {
    const rows = [
      { node: 'n', device: 'sda', writeLatencyMs: 1 },
      { node: 'n', device: 'nvme0n1', writeLatencyMs: 1700 },
      { node: 'n', device: 'sdb', writeLatencyMs: 8 },
    ];

    const grouped = groupDiskPerfRowsByNode(rows);
    const devices = grouped.get('n')?.map(r => r.device);
    expect(devices).toEqual(['nvme0n1', 'sdb', 'sda']);
  });
});
