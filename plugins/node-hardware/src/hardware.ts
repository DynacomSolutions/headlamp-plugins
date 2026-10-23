/*
 * Queries and pure aggregation for node temperatures and power. Every series
 * carries a `node` label. Temperature series are joined in code (not PromQL)
 * so sensors without a label or limit are not dropped.
 */
import { MetricSample, numberFromValue, queryMetrics } from './metrics';

export const CPU_CHIPS = ['coretemp', 'k10temp', 'zenpower', 'apple_soc'];

// Fallback thresholds (C) used when the sensor exposes no max / crit.
export const DEFAULT_WARN_C = 80;
export const DEFAULT_CRIT_C = 90;

export const QUERIES = {
  temp: 'node_hwmon_temp_celsius',
  label: 'node_hwmon_sensor_label',
  chipNames: 'node_hwmon_chip_names',
  max: 'node_hwmon_temp_max_celsius',
  crit: 'node_hwmon_temp_crit_celsius',
  packageW: 'sum by (node) (rate(node_rapl_package_joules_total[5m]))',
  dramW: 'sum by (node) (rate(node_rapl_dram_joules_total[5m]))',
  macPower: '{__name__=~"node_mac_power_.+"}',
  battery: '{__name__=~"node_mac_battery_.+"}',
  gpuW: 'sum by (node) (node_hwmon_power_average_watt * on (node, chip) group_left (chip_name) node_hwmon_chip_names{chip_name=~"amdgpu|nouveau|i915|xe"})',
};

export interface TempSensor {
  node: string;
  chip: string;
  chipName: string;
  sensor: string;
  label: string;
  value: number;
  max?: number;
  crit?: number;
}

export interface NodePower {
  packageW?: number;
  dramW?: number;
  gpuW?: number;
  // Mac nodes: measured whole-system power plus per-domain figures.
  systemW?: number;
  cpuW?: number;
  aneW?: number;
}

export interface Battery {
  cycles?: number;
  designCycles?: number;
  designMah?: number;
  maxMah?: number;
  currentMah?: number;
  tempC?: number;
  volts?: number;
  amps?: number;
  external?: boolean;
  charging?: boolean;
  failure?: boolean;
}

export type Severity = 'ok' | 'warn' | 'crit';

const sensorKey = (m: Record<string, string>) => `${m.node}|${m.chip}|${m.sensor}`;

/** Joins the five temperature queries into one row per sensor. */
export function buildSensors(
  temps: MetricSample[],
  labels: MetricSample[],
  chipNames: MetricSample[],
  maxes: MetricSample[],
  crits: MetricSample[],
): TempSensor[] {
  const labelOf = new Map(labels.map(s => [sensorKey(s.metric), s.metric.label ?? '']));
  const chipNameOf = new Map(chipNames.map(s => [`${s.metric.node}|${s.metric.chip}`, s.metric.chip_name ?? '']));
  const maxOf = new Map(maxes.map(s => [sensorKey(s.metric), numberFromValue(s)]));
  const critOf = new Map(crits.map(s => [sensorKey(s.metric), numberFromValue(s)]));

  const sensors: TempSensor[] = [];
  for (const s of temps) {
    const value = numberFromValue(s);
    const { node, chip, sensor } = s.metric;
    if (value === undefined || !node) {
      continue;
    }
    const key = sensorKey(s.metric);
    sensors.push({
      node,
      chip,
      chipName: chipNameOf.get(`${node}|${chip}`) ?? '',
      sensor,
      label: labelOf.get(key) ?? '',
      value,
      max: maxOf.get(key),
      crit: critOf.get(key),
    });
  }
  return sensors.sort((a, b) => a.chipName.localeCompare(b.chipName) || a.sensor.localeCompare(b.sensor));
}

/** Hottest CPU-chip sensor per node; falls back to the hottest sensor of any chip. */
export function pickCpuTemps(sensors: TempSensor[]): Map<string, TempSensor> {
  const hottest = (list: TempSensor[]) => list.reduce((a, b) => (b.value > a.value ? b : a));
  const byNode = new Map<string, TempSensor[]>();
  for (const s of sensors) {
    byNode.set(s.node, [...(byNode.get(s.node) ?? []), s]);
  }
  const result = new Map<string, TempSensor>();
  for (const [node, list] of byNode) {
    const cpu = list.filter(s => CPU_CHIPS.includes(s.chipName));
    result.set(node, hottest(cpu.length > 0 ? cpu : list));
  }
  return result;
}

/** Warn at the sensor's max (default 80 C), critical at its crit (default 90 C). */
export function tempSeverity(value: number, max?: number, crit?: number): Severity {
  if (value >= (crit ?? DEFAULT_CRIT_C)) {
    return 'crit';
  }
  return value >= (max ?? DEFAULT_WARN_C) ? 'warn' : 'ok';
}

/** Merges the per-node power queries into one record per node. */
export function buildPower(
  packageW: MetricSample[],
  dramW: MetricSample[],
  gpuW: MetricSample[],
  macPower: MetricSample[] = [],
): Map<string, NodePower> {
  const result = new Map<string, NodePower>();
  const add = (samples: MetricSample[], field: keyof NodePower) => {
    for (const s of samples) {
      const v = numberFromValue(s);
      if (v !== undefined && s.metric.node) {
        result.set(s.metric.node, { ...result.get(s.metric.node), [field]: v });
      }
    }
  };
  add(packageW, 'packageW');
  add(dramW, 'dramW');
  add(gpuW, 'gpuW');
  const macField: Record<string, keyof NodePower> = {
    node_mac_power_system_watts: 'systemW',
    node_mac_power_cpu_watts: 'cpuW',
    node_mac_power_gpu_watts: 'gpuW',
    node_mac_power_ane_watts: 'aneW',
  };
  for (const [name, field] of Object.entries(macField)) {
    add(macPower.filter(s => s.metric.__name__ === name), field);
  }
  return result;
}

/** Estimate shown in the Nodes list: CPU package + GPU. DRAM is a separate RAPL domain and is left out. */
export function totalPowerW(p: NodePower | undefined): number | undefined {
  if (!p || (p.packageW === undefined && p.gpuW === undefined)) {
    return undefined;
  }
  return (p.packageW ?? 0) + (p.gpuW ?? 0);
}

/** Nodes-list power: measured system power when exported, else the CPU + GPU estimate. */
export function columnPower(p: NodePower | undefined): { watts: number; measured: boolean } | undefined {
  if (p?.systemW !== undefined) {
    return { watts: p.systemW, measured: true };
  }
  const watts = totalPowerW(p);
  return watts === undefined ? undefined : { watts, measured: false };
}

/** Parses node_mac_battery_* samples into one record per node. */
export function buildBatteries(samples: MetricSample[]): Map<string, Battery> {
  const num: Record<string, keyof Battery> = {
    node_mac_battery_cycle_count: 'cycles',
    node_mac_battery_design_cycle_count: 'designCycles',
    node_mac_battery_design_capacity_mah: 'designMah',
    node_mac_battery_max_capacity_mah: 'maxMah',
    node_mac_battery_current_capacity_mah: 'currentMah',
    node_mac_battery_temperature_celsius: 'tempC',
    node_mac_battery_voltage_volts: 'volts',
    node_mac_battery_current_amperes: 'amps',
  };
  const flag: Record<string, keyof Battery> = {
    node_mac_battery_external_connected: 'external',
    node_mac_battery_charging: 'charging',
    node_mac_battery_permanent_failure: 'failure',
  };
  const flagSet = new Set(Object.values(flag));
  const result = new Map<string, Battery>();
  for (const s of samples) {
    const v = numberFromValue(s);
    const name = s.metric.__name__;
    const field = num[name] ?? flag[name];
    if (v === undefined || !s.metric.node || !field) {
      continue;
    }
    result.set(s.metric.node, { ...result.get(s.metric.node), [field]: flagSet.has(field) ? v !== 0 : v });
  }
  return result;
}

/** Battery health (max / design capacity, %), if both are known. */
export function batteryHealthPct(b: Battery): number | undefined {
  return b.maxMah !== undefined && b.designMah ? (100 * b.maxMah) / b.designMah : undefined;
}

/** Red below 60 % health or on permanent failure, amber below 80 %. */
export function batterySeverity(b: Battery): Severity {
  const h = batteryHealthPct(b);
  if (b.failure || (h !== undefined && h < 60)) {
    return 'crit';
  }
  return h !== undefined && h < 80 ? 'warn' : 'ok';
}

export interface Hardware {
  sensors: TempSensor[];
  power: Map<string, NodePower>;
  batteries: Map<string, Battery>;
}

export async function fetchHardware(): Promise<Hardware> {
  const [temps, labels, chipNames, maxes, crits, packageW, dramW, gpuW, macPower, battery] = await Promise.all(
    [QUERIES.temp, QUERIES.label, QUERIES.chipNames, QUERIES.max, QUERIES.crit, QUERIES.packageW, QUERIES.dramW, QUERIES.gpuW, QUERIES.macPower, QUERIES.battery].map(
      queryMetrics,
    ),
  );
  return {
    sensors: buildSensors(temps, labels, chipNames, maxes, crits),
    power: buildPower(packageW, dramW, gpuW, macPower),
    batteries: buildBatteries(battery),
  };
}
