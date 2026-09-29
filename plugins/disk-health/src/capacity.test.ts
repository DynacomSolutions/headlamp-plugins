import { describe, expect, it } from 'vitest';
import {
  aggregateNodeCapacity,
  capacityQueries,
  formatBytes,
  formatPercent,
  isCountableFstype,
  mergeFsSamples,
} from './capacity';
import type { MetricSample } from './metrics';

const sample = (labels: Record<string, string>, value: number): MetricSample => ({
  metric: labels,
  value: [0, String(value)],
});

describe('isCountableFstype', () => {
  it('excludes pseudo and network filesystems', () => {
    for (const fstype of ['tmpfs', 'overlay', 'squashfs', 'nsfs', 'ramfs', 'devtmpfs', 'fuse.sshfs', 'nfs4', 'cifs']) {
      expect(isCountableFstype(fstype)).toBe(false);
    }
  });
  it('keeps real block-device filesystems', () => {
    for (const fstype of ['ext4', 'xfs', 'zfs', 'btrfs', 'vfat']) {
      expect(isCountableFstype(fstype)).toBe(true);
    }
  });
});

describe('capacityQueries', () => {
  it('filters excluded fstypes and aggregates by device before summing by node', () => {
    const { sizeQuery, availQuery } = capacityQueries();
    expect(sizeQuery).toContain('node_filesystem_size_bytes');
    expect(sizeQuery).toContain('fstype!~');
    expect(sizeQuery).toContain('max by (node, device, mountpoint, fstype)');
    expect(availQuery).toContain('node_filesystem_avail_bytes');
  });
});

describe('mergeFsSamples', () => {
  it('joins size and avail samples by (node, device, mountpoint)', () => {
    const size = [sample({ node: 'n1', device: '/dev/sda1', mountpoint: '/', fstype: 'ext4' }, 1000)];
    const avail = [sample({ node: 'n1', device: '/dev/sda1', mountpoint: '/', fstype: 'ext4' }, 400)];
    const merged = mergeFsSamples(size, avail);
    expect(merged).toEqual([
      { node: 'n1', device: '/dev/sda1', mountpoint: '/', fstype: 'ext4', sizeBytes: 1000, availBytes: 400 },
    ]);
  });

  it('drops excluded fstypes even if the caller forgot to filter in PromQL', () => {
    const size = [sample({ node: 'n1', device: 'tmpfs', mountpoint: '/run', fstype: 'tmpfs' }, 1000)];
    expect(mergeFsSamples(size, [])).toEqual([]);
  });

  it('defaults avail to 0 when no matching avail sample exists', () => {
    const size = [sample({ node: 'n1', device: '/dev/sda1', mountpoint: '/', fstype: 'ext4' }, 1000)];
    const merged = mergeFsSamples(size, []);
    expect(merged[0].availBytes).toBe(0);
  });
});

describe('aggregateNodeCapacity', () => {
  it('dedupes bind mounts of the same device by taking the max per device', () => {
    const samples = [
      { node: 'n1', device: '/dev/sda1', mountpoint: '/', fstype: 'ext4', sizeBytes: 1000, availBytes: 200 },
      // Bind mount of the same device at a second mountpoint: must not double-count.
      { node: 'n1', device: '/dev/sda1', mountpoint: '/mnt/bind', fstype: 'ext4', sizeBytes: 1000, availBytes: 200 },
    ];
    const result = aggregateNodeCapacity(samples);
    const n1 = result.get('n1')!;
    expect(n1.totalBytes).toBe(1000);
    expect(n1.availBytes).toBe(200);
    expect(n1.usedBytes).toBe(800);
    expect(n1.filesystems).toHaveLength(2);
  });

  it('sums distinct devices on the same node', () => {
    const samples = [
      { node: 'n1', device: '/dev/sda1', mountpoint: '/', fstype: 'ext4', sizeBytes: 1000, availBytes: 300 },
      { node: 'n1', device: '/dev/sdb1', mountpoint: '/data', fstype: 'ext4', sizeBytes: 2000, availBytes: 500 },
    ];
    const result = aggregateNodeCapacity(samples);
    const n1 = result.get('n1')!;
    expect(n1.totalBytes).toBe(3000);
    expect(n1.availBytes).toBe(800);
    expect(n1.usedBytes).toBe(2200);
  });

  it('keeps nodes independent', () => {
    const samples = [
      { node: 'n1', device: '/dev/sda1', mountpoint: '/', fstype: 'ext4', sizeBytes: 1000, availBytes: 300 },
      { node: 'n2', device: '/dev/sda1', mountpoint: '/', fstype: 'ext4', sizeBytes: 5000, availBytes: 1000 },
    ];
    const result = aggregateNodeCapacity(samples);
    expect(result.get('n1')!.totalBytes).toBe(1000);
    expect(result.get('n2')!.totalBytes).toBe(5000);
  });

  it('computes per-filesystem used bytes and percentage, sorted by mountpoint', () => {
    const samples = [
      { node: 'n1', device: '/dev/sdb1', mountpoint: '/data', fstype: 'ext4', sizeBytes: 2000, availBytes: 500 },
      { node: 'n1', device: '/dev/sda1', mountpoint: '/', fstype: 'ext4', sizeBytes: 1000, availBytes: 300 },
    ];
    const result = aggregateNodeCapacity(samples);
    const [root, data] = result.get('n1')!.filesystems;
    expect(root.mountpoint).toBe('/');
    expect(root.usedBytes).toBe(700);
    expect(root.percentUsed).toBeCloseTo(70);
    expect(data.mountpoint).toBe('/data');
    expect(data.usedBytes).toBe(1500);
  });
});

describe('formatBytes', () => {
  it('picks the largest unit that keeps the value readable', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(7_937_290_891_264)).toBe('7.94 TB');
    expect(formatBytes(226_894_055_063_552)).toBe('227 TB');
  });
});

describe('formatPercent', () => {
  it('formats a used/total ratio', () => {
    expect(formatPercent(50, 100)).toBe('50 %');
    expect(formatPercent(1, 3)).toBe('33.3 %');
  });
  it('returns null for a zero total', () => {
    expect(formatPercent(0, 0)).toBeNull();
  });
});
