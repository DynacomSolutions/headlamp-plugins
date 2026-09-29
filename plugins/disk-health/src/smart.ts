/*
 * SMART/NVMe disk-health data: fetches and merges smartctl_exporter series
 * into one row per physical disk, either for a single node (the Node
 * details "Disks" section) or across the whole cluster (the "Disks" page).
 */
import { MetricSample, numberFromValue, queryMetrics } from './metrics';

/** One row of the disk table, merged from several PromQL queries. */
export interface DiskRow {
  node: string;
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
export function isRowError(row: DiskRow): boolean {
  if (row.healthy === false) {
    return true;
  }
  const counters = [row.reallocatedSectorCt, row.currentPendingSector, row.offlineUncorrectable, row.mediaErrors];
  return counters.some(v => typeof v === 'number' && v > 0);
}

/**
 * Extracts the device name from metric labels. Tries multiple label names
 * to handle different metrics and smartctl_exporter versions.
 */
function deviceKey(labels: Record<string, string>): string | undefined {
  return labels.device || labels.disk || labels.name || labels.device_name;
}

/**
 * Merges the raw PromQL results for every disk-health signal into one
 * DiskRow per (node, device). Shared by the single-node and all-node
 * fetchers below.
 */
export function mergeDiskRows(
  status: MetricSample[],
  mediaErrors: MetricSample[],
  attributes: MetricSample[],
  temperature: MetricSample[],
  powerOnSeconds: MetricSample[],
  info: MetricSample[]
): DiskRow[] {
  const rows = new Map<string, DiskRow>();

  const rowFor = (labels: Record<string, string>): DiskRow | undefined => {
    const node = labels.node;
    const device = deviceKey(labels);
    if (!node || !device) {
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

  for (const sample of status) {
    const row = rowFor(sample.metric);
    if (row) {
      row.healthy = numberFromValue(sample) === 1;
    }
  }

  for (const sample of mediaErrors) {
    const row = rowFor(sample.metric);
    if (row) {
      row.mediaErrors = numberFromValue(sample);
    }
  }

  for (const sample of temperature) {
    const row = rowFor(sample.metric);
    if (row) {
      row.temperatureC = numberFromValue(sample);
    }
  }

  for (const sample of powerOnSeconds) {
    const row = rowFor(sample.metric);
    if (row) {
      const seconds = numberFromValue(sample);
      row.powerOnHours = seconds !== undefined ? Math.round(seconds / 3600) : undefined;
    }
  }

  // Process info samples which contain model_name and serial_number labels.
  // These samples must match by (node, device) to merge into rows.
  for (const sample of info) {
    const row = rowFor(sample.metric);
    if (row) {
      row.model = sample.metric.model_name || sample.metric.model || row.model;
      row.serial = sample.metric.serial_number || sample.metric.serial || row.serial;
    }
    // If no row found, the device key extraction may have failed.
    // Log this for debugging cluster-wide vs node-level differences.
  }

  for (const sample of attributes) {
    const row = rowFor(sample.metric);
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

  return Array.from(rows.values()).sort(
    (a, b) => a.node.localeCompare(b.node) || a.device.localeCompare(b.device)
  );
}

/** Attribute names read from smartctl_device_attribute, raw values only. */
const ATTRIBUTE_NAMES =
  'Reallocated_Sector_Ct|Current_Pending_Sector|Offline_Uncorrectable|Power_On_Hours|Temperature_Celsius';

/**
 * Fetches and merges every disk-health signal into a table of DiskRow, one
 * row per SMART/NVMe device. Pass a PromQL label matcher fragment (for
 * example `node="worker-1"`) to scope to one node, or omit it to fetch for
 * every node in the cluster in a single batch of queries.
 */
export async function fetchDiskRows(nodeFilter?: string): Promise<DiskRow[]> {
  const sel = nodeFilter ? `{${nodeFilter}}` : '';
  const attrSel = nodeFilter
    ? `{${nodeFilter},attribute_name=~"${ATTRIBUTE_NAMES}",attribute_value_type="raw"}`
    : `{attribute_name=~"${ATTRIBUTE_NAMES}",attribute_value_type="raw"}`;

  // For cluster-wide info queries, explicitly group by node and device to ensure
  // model/serial labels are properly joined. smartctl_device metric has labels:
  // model_name, serial_number, keyed by node and device.
  const infoSel = nodeFilter
    ? `{${nodeFilter}}`
    : '{model_name!=""}';  // Filter to info series that have model data in cluster-wide queries

  const [status, mediaErrors, attributes, temperature, powerOnSeconds, info] = await Promise.all([
    queryMetrics(`smartctl_device_smart_status${sel}`),
    queryMetrics(`smartctl_device_media_errors${sel}`).catch(() => []),
    queryMetrics(`smartctl_device_attribute${attrSel}`).catch(() => []),
    queryMetrics(`smartctl_device_temperature${sel}`).catch(() => []),
    queryMetrics(`smartctl_device_power_on_seconds${sel}`).catch(() => []),
    queryMetrics(`smartctl_device${infoSel}`).catch(() => []),  // Use smartctl_device instead of smartctl_device_info
  ]);

  return mergeDiskRows(status, mediaErrors, attributes, temperature, powerOnSeconds, info);
}

/** Groups disk rows by node, each node's rows sorted with failing disks first. */
export function groupDiskRowsByNode(rows: DiskRow[]): Map<string, DiskRow[]> {
  const byNode = new Map<string, DiskRow[]>();
  for (const row of rows) {
    const list = byNode.get(row.node) ?? [];
    list.push(row);
    byNode.set(row.node, list);
  }
  for (const [node, list] of byNode) {
    byNode.set(
      node,
      [...list].sort((a, b) => Number(isRowError(b)) - Number(isRowError(a)) || a.device.localeCompare(b.device))
    );
  }
  return byNode;
}
