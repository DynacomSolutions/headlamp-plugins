/*
 * disk-health: a Headlamp plugin that shows per-disk SMART health on the
 * Node details page, disk capacity on the Nodes list, and a cluster-wide
 * Disks page, all sourced from a Prometheus-compatible metrics service that
 * scrapes smartctl_exporter and the node/host filesystem collector.
 */
import {
  registerDetailsViewSection,
  registerResourceTableColumnsProcessor,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import { CommonComponents } from '@kinvolk/headlamp-plugin/lib';
import type { ResourceTableColumn } from '@kinvolk/headlamp-plugin/lib';
const { SectionBox } = CommonComponents;
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import React from 'react';
import { getCapacitySnapshot, startCapacityPolling } from './capacityStore';
import { DiskUsageBarChart, useNodeCapacity } from './DiskColumn';
import { DisksPage } from './DisksPage';
import { DiskRow, fetchDiskRows, isRowError } from './smart';

function cell(value: number | string | undefined): string {
  return value === undefined || value === null ? '-' : String(value);
}

function DiskHealthSection({ nodeName }: { nodeName: string }): JSX.Element {
  const [rows, setRows] = React.useState<DiskRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchDiskRows(`node="${nodeName}"`)
      .then(result => {
        if (!cancelled) {
          setRows(result);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message || 'Failed to query metrics service');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [nodeName]);

  if (loading) {
    return <CircularProgress size={24} />;
  }

  if (error) {
    return (
      <Alert severity="error">
        Could not query the metrics service for disk health on {nodeName}: {error}
      </Alert>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <Alert severity="info">
        No SMART metrics found for node {nodeName} yet. Check that smartctl-exporter
        is running on this node and that the metrics service has scraped it at least once.
      </Alert>
    );
  }

  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Device</TableCell>
          <TableCell>Model / Serial</TableCell>
          <TableCell>SMART health</TableCell>
          <TableCell align="right">Reallocated sectors</TableCell>
          <TableCell align="right">Pending sectors</TableCell>
          <TableCell align="right">Offline uncorrectable</TableCell>
          <TableCell align="right">Media errors (NVMe)</TableCell>
          <TableCell align="right">Temperature</TableCell>
          <TableCell align="right">Power-on hours</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map(row => {
          const error = isRowError(row);
          return (
            <TableRow
              key={row.device}
              sx={error ? { backgroundColor: 'error.light' } : undefined}
            >
              <TableCell>{row.device}</TableCell>
              <TableCell>
                {row.model || '-'}
                {row.serial ? ` / ${row.serial}` : ''}
              </TableCell>
              <TableCell>
                {row.healthy === undefined ? '-' : row.healthy ? 'PASSED' : 'FAILED'}
              </TableCell>
              <TableCell align="right">{cell(row.reallocatedSectorCt)}</TableCell>
              <TableCell align="right">{cell(row.currentPendingSector)}</TableCell>
              <TableCell align="right">{cell(row.offlineUncorrectable)}</TableCell>
              <TableCell align="right">{cell(row.mediaErrors)}</TableCell>
              <TableCell align="right">
                {row.temperatureC === undefined ? '-' : `${row.temperatureC} C`}
              </TableCell>
              <TableCell align="right">{cell(row.powerOnHours)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

registerDetailsViewSection(({ resource }) => {
  if (!resource || resource.kind !== 'Node') {
    return null;
  }

  const nodeName: string | undefined = resource.jsonData?.metadata?.name || resource.metadata?.name;
  if (!nodeName) {
    return null;
  }

  return (
    <SectionBox title="Disks">
      <Typography variant="body2" sx={{ mb: 1 }} color="text.secondary">
        SMART health per physical disk on this node, from the metrics service.
      </Typography>
      <DiskHealthSection nodeName={nodeName} />
    </SectionBox>
  );
});

/**
 * Adds a "Disk" column to the Nodes list view, next to the built-in CPU and
 * Memory columns, showing capacity the same way (usage bar, used/total,
 * percentage). One shared, polled query covers every node in the table.
 */
type NodeLike = { jsonData?: { metadata?: { name?: string } }; metadata?: { name?: string } };

function nodeNameOf(node: NodeLike): string {
  return node.jsonData?.metadata?.name || node.metadata?.name || '';
}

/** The actual table cell: a real component, so it can subscribe to the shared capacityStore. */
function NodeDiskCell({ nodeName }: { nodeName: string }): JSX.Element {
  const { capacity, loading } = useNodeCapacity();
  return <DiskUsageBarChart nodeName={nodeName} capacity={capacity} loading={loading} />;
}

/**
 * The processor itself is a plain function called synchronously during
 * NodeList's render (it is not a React component), so it must not call
 * hooks. It starts/reads the shared capacityStore snapshot directly for
 * sorting/filtering (getValue), while `render` mounts NodeDiskCell, a real
 * component that subscribes to the store so the cell re-renders as new
 * data arrives.
 */
function NodesDiskColumn({ id, columns }: { id: string; columns: unknown[] }): unknown[] {
  if (id !== 'headlamp-nodes') {
    return columns;
  }

  // Ensures the shared poll starts even before any row has mounted.
  startCapacityPolling();

  const diskColumn: ResourceTableColumn<NodeLike> = {
    id: 'disk',
    label: 'Disk',
    gridTemplate: 'min-content',
    disableFiltering: true,
    getValue: node => getCapacitySnapshot().capacity.get(nodeNameOf(node))?.usedBytes ?? 0,
    render: node => <NodeDiskCell nodeName={nodeNameOf(node)} />,
  };

  // Insert right after the built-in "memory" column, matching where the
  // spec asks for it to sit ("next to CPU and Memory").
  const memoryIndex = columns.findIndex((c: any) => c?.id === 'memory');
  const newColumns = [...columns];
  newColumns.splice(memoryIndex >= 0 ? memoryIndex + 1 : columns.length, 0, diskColumn);
  return newColumns;
}

registerResourceTableColumnsProcessor(NodesDiskColumn as any);

registerSidebarEntry({
  parent: null,
  name: 'disks',
  label: 'Disks',
  url: '/disks',
  icon: 'mdi:harddisk',
});

registerRoute({
  path: '/disks',
  sidebar: 'disks',
  name: 'disks',
  exact: true,
  component: DisksPage,
});
