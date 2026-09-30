/*
 * Cluster-wide "Disks" page: per-node capacity (with a per-filesystem
 * breakdown), live performance (latency, IOPS, throughput, utilisation,
 * discards and IO pressure) and every SMART/NVMe disk across every node,
 * grouped by node. Reuses the same capacity, performance and SMART
 * fetchers as the Nodes list column and the per-node "Disks" details
 * section, so the figures always agree.
 *
 * The performance section exists because SMART health can look perfectly
 * clean while a disk is still taking hundreds or thousands of milliseconds
 * to service a write - exactly what happened when a control-plane node's
 * NVMe device slowed down overnight, stalling etcd's fdatasync calls and
 * crashing k3s, with every SMART counter still reading zero throughout.
 */
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import React from 'react';
import { fetchNodeCapacity, formatBytes, formatPercent, NodeCapacity } from './capacity';
import {
  DiskPerfRow,
  fetchDiskPerfRows,
  fetchNodeIoPressure,
  groupDiskPerfRowsByNode,
  NodeIoPressure,
  rowSeverity,
  Severity,
  UTILISATION_AMBER_PERCENT,
  UTILISATION_RED_PERCENT,
  WRITE_LATENCY_AMBER_MS,
  WRITE_LATENCY_RED_MS,
} from './performance';
import { DiskRow, fetchDiskRows, groupDiskRowsByNode, isRowError } from './smart';

function cell(value: number | string | undefined): string {
  return value === undefined || value === null ? '-' : String(value);
}

/** Formats a possibly-undefined number to a fixed number of decimals, or '-'. */
function decimal(value: number | undefined, digits: number): string {
  return value === undefined ? '-' : value.toFixed(digits);
}

/** Background colour for a severity bucket, matching the SMART table's error highlight. */
function severityColor(severity: Severity): string | undefined {
  if (severity === 'error') {
    return 'error.light';
  }
  if (severity === 'warn') {
    return 'warning.light';
  }
  return undefined;
}

function NodeCapacityCard({ capacity }: { capacity: NodeCapacity }): JSX.Element {
  const { node, usedBytes, totalBytes, filesystems } = capacity;
  return (
    <Box mb={3}>
      <Typography variant="h6">{node}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {formatBytes(usedBytes)} of {formatBytes(totalBytes)} used ({formatPercent(usedBytes, totalBytes) || '0 %'})
      </Typography>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Mountpoint</TableCell>
            <TableCell>Device</TableCell>
            <TableCell>Filesystem</TableCell>
            <TableCell align="right">Size</TableCell>
            <TableCell align="right">Used</TableCell>
            <TableCell align="right">Available</TableCell>
            <TableCell align="right">%</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {filesystems.map(fs => (
            <TableRow key={fs.mountpoint}>
              <TableCell>{fs.mountpoint}</TableCell>
              <TableCell>{fs.device}</TableCell>
              <TableCell>{fs.fstype}</TableCell>
              <TableCell align="right">{formatBytes(fs.sizeBytes)}</TableCell>
              <TableCell align="right">{formatBytes(fs.usedBytes)}</TableCell>
              <TableCell align="right">{formatBytes(fs.availBytes)}</TableCell>
              <TableCell align="right">{fs.percentUsed === null ? '-' : `${fs.percentUsed.toFixed(1)} %`}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

function PerformanceTable({ rows }: { rows: DiskPerfRow[] }): JSX.Element {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Device</TableCell>
          <TableCell align="right">Write latency</TableCell>
          <TableCell align="right">Read latency</TableCell>
          <TableCell align="right">Write IOPS</TableCell>
          <TableCell align="right">Read IOPS</TableCell>
          <TableCell align="right">Write MB/s</TableCell>
          <TableCell align="right">Read MB/s</TableCell>
          <TableCell align="right">Utilisation</TableCell>
          <TableCell align="right">Discard ops/s</TableCell>
          <TableCell align="right">Discard MB/s</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map(row => (
          <TableRow key={row.device} sx={{ backgroundColor: severityColor(rowSeverity(row)) }}>
            <TableCell>{row.device}</TableCell>
            <TableCell align="right">{decimal(row.writeLatencyMs, 1)} ms</TableCell>
            <TableCell align="right">{decimal(row.readLatencyMs, 1)} ms</TableCell>
            <TableCell align="right">{decimal(row.writeIops, 0)}</TableCell>
            <TableCell align="right">{decimal(row.readIops, 0)}</TableCell>
            <TableCell align="right">{decimal(row.writeMBs, 1)}</TableCell>
            <TableCell align="right">{decimal(row.readMBs, 1)}</TableCell>
            <TableCell align="right">{decimal(row.utilisationPercent, 0)} %</TableCell>
            <TableCell align="right">{decimal(row.discardOpsPerSec, 1)}</TableCell>
            <TableCell align="right">{decimal(row.discardMBs, 2)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SmartTable({ rows }: { rows: DiskRow[] }): JSX.Element {
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
            <TableRow key={row.device} sx={error ? { backgroundColor: 'error.light' } : undefined}>
              <TableCell>{row.device}</TableCell>
              <TableCell>
                {row.model || '-'}
                {row.serial ? ` / ${row.serial}` : ''}
              </TableCell>
              <TableCell>{row.healthy === undefined ? '-' : row.healthy ? 'PASSED' : 'FAILED'}</TableCell>
              <TableCell align="right">{cell(row.reallocatedSectorCt)}</TableCell>
              <TableCell align="right">{cell(row.currentPendingSector)}</TableCell>
              <TableCell align="right">{cell(row.offlineUncorrectable)}</TableCell>
              <TableCell align="right">{cell(row.mediaErrors)}</TableCell>
              <TableCell align="right">{row.temperatureC === undefined ? '-' : `${row.temperatureC} C`}</TableCell>
              <TableCell align="right">{cell(row.powerOnHours)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function DisksPage(): JSX.Element {
  const [capacity, setCapacity] = React.useState<Map<string, NodeCapacity> | null>(null);
  const [diskRows, setDiskRows] = React.useState<DiskRow[] | null>(null);
  const [perfRows, setPerfRows] = React.useState<DiskPerfRow[] | null>(null);
  const [ioPressure, setIoPressure] = React.useState<NodeIoPressure[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([fetchNodeCapacity(), fetchDiskRows(), fetchDiskPerfRows(), fetchNodeIoPressure()])
      .then(([capacityResult, rows, perfResult, pressureResult]) => {
        if (!cancelled) {
          setCapacity(capacityResult);
          setDiskRows(rows);
          setPerfRows(perfResult);
          setIoPressure(pressureResult);
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
  }, []);

  if (loading) {
    return (
      <Box p={2}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (error) {
    return (
      <Box p={2}>
        <Alert severity="error">Could not query the metrics service: {error}</Alert>
      </Box>
    );
  }

  const capacityByNode = Array.from(capacity?.values() ?? []).sort((a, b) => a.node.localeCompare(b.node));
  const smartByNode = groupDiskRowsByNode(diskRows ?? []);
  const failingDisks = (diskRows ?? []).filter(isRowError);
  const failingNodes = new Set(failingDisks.map(row => row.node));
  const perfByNode = groupDiskPerfRowsByNode(perfRows ?? []);
  const slowDisks = (perfRows ?? []).filter(row => rowSeverity(row) === 'error');
  const slowNodes = new Set(slowDisks.map(row => row.node));
  const pressureByNode = new Map((ioPressure ?? []).map(p => [p.node, p.stalledPercent]));

  return (
    <Box p={2}>
      <Typography variant="h4" gutterBottom>
        Disks
      </Typography>

      <SectionBox title="Capacity by node">
        {capacityByNode.length === 0 ? (
          <Alert severity="info">No disk-capacity metrics found yet.</Alert>
        ) : (
          capacityByNode.map(c => <NodeCapacityCard key={c.node} capacity={c} />)
        )}
      </SectionBox>

      <SectionBox title="Performance">
        <Typography variant="body2" sx={{ mb: 1 }} color="text.secondary">
          Write/read latency, IOPS, throughput, utilisation and discard (TRIM) activity per physical
          disk, averaged over the last 5 minutes. SMART health can stay "PASSED" while a disk is this
          slow, so watch this table, not just the one below: write latency above {WRITE_LATENCY_AMBER_MS}&nbsp;ms
          is amber, above {WRITE_LATENCY_RED_MS}&nbsp;ms is red; utilisation above{' '}
          {UTILISATION_AMBER_PERCENT}&nbsp;% is amber, above {UTILISATION_RED_PERCENT}&nbsp;% is red.
        </Typography>
        {slowDisks.length > 0 && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {slowDisks.length} disk{slowDisks.length === 1 ? '' : 's'} with high write latency or
            utilisation across {slowNodes.size} node{slowNodes.size === 1 ? '' : 's'}.
          </Alert>
        )}
        {perfByNode.size === 0 ? (
          <Alert severity="info">
            No disk-performance metrics found yet. Check that node-exporter is running and that the
            metrics service has scraped it at least once.
          </Alert>
        ) : (
          Array.from(perfByNode.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([node, rows]) => {
              const stalledPercent = pressureByNode.get(node);
              return (
                <Box key={node} mb={3}>
                  <Typography variant="h6">{node}</Typography>
                  {stalledPercent !== undefined && (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      IO pressure (PSI, some stalled): {stalledPercent.toFixed(1)} %
                    </Typography>
                  )}
                  <PerformanceTable rows={rows} />
                </Box>
              );
            })
        )}
      </SectionBox>

      <SectionBox title="SMART / NVMe health">
        {failingDisks.length > 0 ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {failingDisks.length} failing disk{failingDisks.length === 1 ? '' : 's'} across {failingNodes.size} node
            {failingNodes.size === 1 ? '' : 's'}.
          </Alert>
        ) : (
          (diskRows ?? []).length > 0 && (
            <Alert severity="success" sx={{ mb: 2 }}>
              No failing disks detected.
            </Alert>
          )
        )}
        {smartByNode.size === 0 ? (
          <Alert severity="info">
            No SMART metrics found yet. Check that smartctl-exporter is running and that the metrics
            service has scraped it at least once.
          </Alert>
        ) : (
          Array.from(smartByNode.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([node, rows]) => (
              <Box key={node} mb={3}>
                <Typography variant="h6">{node}</Typography>
                <SmartTable rows={rows} />
              </Box>
            ))
        )}
      </SectionBox>
    </Box>
  );
}
