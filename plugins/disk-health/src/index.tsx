/*
 * disk-health: a Headlamp plugin that shows per-disk SMART health on the
 * Node details page, sourced from a Prometheus-compatible metrics service
 * that scrapes smartctl_exporter.
 */
import { ApiProxy, registerDetailsViewSection } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import React from 'react';

// A Prometheus-compatible Service (VictoriaMetrics, Prometheus, ...). Adjust
// these defaults to match your cluster. Only the plain Prometheus HTTP API
// (instant `/api/v1/query`) is used.
const VM_NAMESPACE = 'monitoring';
const VM_SERVICE = 'victoria-metrics';
const VM_PORT = '8428';

/** One row of the disk table, merged from several PromQL queries. */
interface DiskRow {
  device: string;
  model?: string;
  serial?: string;
  healthy?: boolean;
  reallocatedSectorCt?: number;
  currentPendingSector?: number;
  offlineUncorrectable?: number;
  mediaErrors?: number;
  temperatureC?: number;
  powerOnHours?: number;
}

/** True if this row should be flagged red: failed health or any non-zero error counter. */
function isRowError(row: DiskRow): boolean {
  if (row.healthy === false) {
    return true;
  }
  const counters = [row.reallocatedSectorCt, row.currentPendingSector, row.offlineUncorrectable, row.mediaErrors];
  return counters.some(v => typeof v === 'number' && v > 0);
}

/**
 * Runs a single PromQL instant query against the metrics service through the
 * Kubernetes API server's Service proxy - the same
 * /api/v1/namespaces/<ns>/services/<name>:<port>/proxy/... path the
 * bundled Prometheus plugin uses for its own Service-backed queries.
 */
async function queryMetrics(promql: string): Promise<any[]> {
  const params = new URLSearchParams({ query: promql });
  const url =
    `/api/v1/namespaces/${VM_NAMESPACE}/services/${VM_SERVICE}:${VM_PORT}` +
    `/proxy/api/v1/query?${params.toString()}`;

  const response = await ApiProxy.request(url, { method: 'GET', isJSON: false });
  if (!response.ok) {
    throw new Error(`Metrics service returned HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body.status !== 'success') {
    throw new Error(body.error || 'Metrics query failed');
  }
  return body.data?.result ?? [];
}

function numberFromValue(sample: any): number | undefined {
  const raw = sample?.value?.[1];
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

function deviceKey(labels: Record<string, string>): string | undefined {
  return labels.device || labels.disk || labels.name;
}

/**
 * Fetches and merges every disk-health signal for one node into a table of
 * DiskRow, one row per SMART/NVMe device.
 */
async function fetchDiskRows(nodeName: string): Promise<DiskRow[]> {
  const nodeFilter = `node="${nodeName}"`;

  const [status, mediaErrors, attributes, temperature, powerOnSeconds, info] = await Promise.all([
    queryMetrics(`smartctl_device_smart_status{${nodeFilter}}`),
    queryMetrics(`smartctl_device_media_errors{${nodeFilter}}`).catch(() => []),
    queryMetrics(
      `smartctl_device_attribute{${nodeFilter},attribute_name=~"Reallocated_Sector_Ct|Current_Pending_Sector|Offline_Uncorrectable|Power_On_Hours|Temperature_Celsius"}`
    ).catch(() => []),
    queryMetrics(`smartctl_device_temperature{${nodeFilter}}`).catch(() => []),
    queryMetrics(`smartctl_device_power_on_seconds{${nodeFilter}}`).catch(() => []),
    queryMetrics(`smartctl_device_info{${nodeFilter}}`).catch(() => []),
  ]);

  const rows = new Map<string, DiskRow>();

  const rowFor = (device: string | undefined): DiskRow | undefined => {
    if (!device) {
      return undefined;
    }
    let row = rows.get(device);
    if (!row) {
      row = { device };
      rows.set(device, row);
    }
    return row;
  };

  for (const sample of status) {
    const device = deviceKey(sample.metric);
    const row = rowFor(device);
    if (row) {
      row.healthy = numberFromValue(sample) === 1;
    }
  }

  for (const sample of mediaErrors) {
    const row = rowFor(deviceKey(sample.metric));
    if (row) {
      row.mediaErrors = numberFromValue(sample);
    }
  }

  for (const sample of temperature) {
    const row = rowFor(deviceKey(sample.metric));
    if (row) {
      row.temperatureC = numberFromValue(sample);
    }
  }

  for (const sample of powerOnSeconds) {
    const row = rowFor(deviceKey(sample.metric));
    if (row) {
      const seconds = numberFromValue(sample);
      row.powerOnHours = seconds !== undefined ? Math.round(seconds / 3600) : undefined;
    }
  }

  for (const sample of info) {
    const row = rowFor(deviceKey(sample.metric));
    if (row) {
      row.model = sample.metric.model_name || sample.metric.model || row.model;
      row.serial = sample.metric.serial_number || sample.metric.serial || row.serial;
    }
  }

  for (const sample of attributes) {
    const row = rowFor(deviceKey(sample.metric));
    if (!row) {
      continue;
    }
    const value = numberFromValue(sample);
    switch (sample.metric.attribute_name) {
      case 'Reallocated_Sector_Ct':
        row.reallocatedSectorCt = value;
        break;
      case 'Current_Pending_Sector':
        row.currentPendingSector = value;
        break;
      case 'Offline_Uncorrectable':
        row.offlineUncorrectable = value;
        break;
      case 'Power_On_Hours':
        if (row.powerOnHours === undefined) {
          row.powerOnHours = value;
        }
        break;
      case 'Temperature_Celsius':
        if (row.temperatureC === undefined) {
          row.temperatureC = value;
        }
        break;
      default:
        break;
    }
  }

  return Array.from(rows.values()).sort((a, b) => a.device.localeCompare(b.device));
}

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

    fetchDiskRows(nodeName)
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
