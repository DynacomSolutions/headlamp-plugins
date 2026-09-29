/*
 * "Disk" column for the Nodes list view, next to Headlamp's built-in CPU
 * and Memory columns. Reuses the same PercentageBar component those
 * columns render with, so the visual style matches exactly. The underlying
 * data comes from the shared capacityStore, which polls once for the whole
 * table rather than once per row.
 */
import { CommonComponents } from '@kinvolk/headlamp-plugin/lib';
import Typography from '@mui/material/Typography';
const { PercentageBar } = CommonComponents;
import React from 'react';
import { formatBytes, formatPercent, NodeCapacity } from './capacity';
import { CapacitySnapshot, getCapacitySnapshot, subscribeCapacity } from './capacityStore';

/** Subscribes to the shared, polled node disk-capacity snapshot. */
export function useNodeCapacity(): CapacitySnapshot {
  const [snapshot, setSnapshot] = React.useState<CapacitySnapshot>(getCapacitySnapshot);

  React.useEffect(() => subscribeCapacity(() => setSnapshot(getCapacitySnapshot())), []);

  return snapshot;
}

export function DiskUsageBarChart({
  nodeName,
  capacity,
  loading,
}: {
  nodeName: string;
  capacity: Map<string, NodeCapacity>;
  loading: boolean;
}): JSX.Element {
  const nodeCapacity = capacity.get(nodeName);

  if (!nodeCapacity) {
    return <Typography display="inline">{loading ? '…' : '-'}</Typography>;
  }

  const { usedBytes, totalBytes } = nodeCapacity;
  const data = [{ name: 'used', value: usedBytes }];

  function tooltipFunc() {
    return (
      <Typography>
        {formatBytes(usedBytes)} of {formatBytes(totalBytes)} ({formatPercent(usedBytes, totalBytes) || '0 %'})
      </Typography>
    );
  }

  return <PercentageBar data={data} total={totalBytes} tooltipFunc={tooltipFunc} />;
}
