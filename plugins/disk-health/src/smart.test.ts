import { describe, expect, it } from 'vitest';
import type { MetricSample } from './metrics';
import { groupDiskRowsByNode,mergeDiskRows } from './smart';

const sample = (labels: Record<string, string>, value: number = 1): MetricSample => ({
  metric: labels,
  value: [0, String(value)],
});

describe('mergeDiskRows', () => {
  it('joins disk health and info metrics correctly for a single node', () => {
    const status = [sample({ node: 'node1', device: 'sda', __name__: 'smartctl_device_smart_status' }, 1)];
    const info = [sample({ node: 'node1', device: 'sda', model_name: 'Samsung 870', serial_number: 'ABC123' })];

    const rows = mergeDiskRows(status, [], [], [], [], info);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      node: 'node1',
      device: 'sda',
      model: 'Samsung 870',
      serial: 'ABC123',
      healthy: true,
    });
  });

  it('keeps model/serial separate for different nodes with same device name', () => {
    const status = [
      sample({ node: 'node1', device: 'nvme0', __name__: 'smartctl_device_smart_status' }, 1),
      sample({ node: 'node2', device: 'nvme0', __name__: 'smartctl_device_smart_status' }, 1),
    ];
    const info = [
      sample({ node: 'node1', device: 'nvme0', model_name: 'ModelA', serial_number: 'SN001' }),
      sample({ node: 'node2', device: 'nvme0', model_name: 'ModelB', serial_number: 'SN002' }),
    ];

    const rows = mergeDiskRows(status, [], [], [], [], info);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      node: 'node1',
      device: 'nvme0',
      model: 'ModelA',
      serial: 'SN001',
    });
    expect(rows[1]).toMatchObject({
      node: 'node2',
      device: 'nvme0',
      model: 'ModelB',
      serial: 'SN002',
    });
  });

  it('handles missing info metric gracefully', () => {
    const status = [sample({ node: 'node1', device: 'sda', __name__: 'smartctl_device_smart_status' }, 1)];

    const rows = mergeDiskRows(status, [], [], [], [], []);

    expect(rows).toHaveLength(1);
    expect(rows[0].node).toBe('node1');
    expect(rows[0].device).toBe('sda');
    expect(rows[0].model).toBeUndefined();
    expect(rows[0].serial).toBeUndefined();
  });

  it('uses alternative device label names when device label is missing', () => {
    const status = [sample({ node: 'node1', disk: 'sda', __name__: 'smartctl_device_smart_status' }, 1)];
    const info = [sample({ node: 'node1', disk: 'sda', model_name: 'Samsung 870', serial_number: 'ABC123' })];

    const rows = mergeDiskRows(status, [], [], [], [], info);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      node: 'node1',
      device: 'sda',
      model: 'Samsung 870',
      serial: 'ABC123',
    });
  });

  it('uses device_name label when device label is not present', () => {
    const status = [sample({ node: 'node1', device_name: 'nvme0' })];
    const info = [sample({ node: 'node1', device_name: 'nvme0', model_name: 'NVMe Model', serial_number: 'NVMe123' })];

    const rows = mergeDiskRows(status, [], [], [], [], info);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      node: 'node1',
      device: 'nvme0',
      model: 'NVMe Model',
      serial: 'NVMe123',
    });
  });

  it('ensures cluster-wide queries merge model/serial for multiple nodes independently', () => {
    // Simulate cluster-wide query results where each node has the same device names
    const status = [
      sample({ node: 'worker-1', device: 'sda' }),
      sample({ node: 'worker-1', device: 'sdb' }),
      sample({ node: 'worker-2', device: 'sda' }),
      sample({ node: 'worker-2', device: 'sdb' }),
    ];

    const info = [
      sample({ node: 'worker-1', device: 'sda', model_name: 'WD Red 4TB', serial_number: 'WD-001' }),
      sample({ node: 'worker-1', device: 'sdb', model_name: 'WD Red 4TB', serial_number: 'WD-002' }),
      sample({ node: 'worker-2', device: 'sda', model_name: 'ST16000NM001J-2TW113', serial_number: 'ZRS0Z0TB' }),
      sample({ node: 'worker-2', device: 'sdb', model_name: 'ST16000NM001J-2TW113', serial_number: 'ZRS0Z0TC' }),
    ];

    const rows = mergeDiskRows(status, [], [], [], [], info);

    expect(rows).toHaveLength(4);

    // Verify each (node, device) pair has its own model/serial
    const rowMap = new Map(rows.map(r => [`${r.node}/${r.device}`, r]));

    expect(rowMap.get('worker-1/sda')).toMatchObject({
      model: 'WD Red 4TB',
      serial: 'WD-001',
    });
    expect(rowMap.get('worker-1/sdb')).toMatchObject({
      model: 'WD Red 4TB',
      serial: 'WD-002',
    });
    expect(rowMap.get('worker-2/sda')).toMatchObject({
      model: 'ST16000NM001J-2TW113',
      serial: 'ZRS0Z0TB',
    });
    expect(rowMap.get('worker-2/sdb')).toMatchObject({
      model: 'ST16000NM001J-2TW113',
      serial: 'ZRS0Z0TC',
    });
  });
});

describe('groupDiskRowsByNode', () => {
  it('groups rows by node', () => {
    const rows = [
      { node: 'node1', device: 'sda', healthy: true },
      { node: 'node1', device: 'sdb', healthy: true },
      { node: 'node2', device: 'sda', healthy: false },
    ] as any[];

    const grouped = groupDiskRowsByNode(rows);

    expect(grouped.get('node1')).toHaveLength(2);
    expect(grouped.get('node2')).toHaveLength(1);
  });
});
