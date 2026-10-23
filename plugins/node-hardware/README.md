# node-hardware

A [Headlamp](https://headlamp.dev/) plugin built with the official
`@kinvolk/headlamp-plugin` tooling (TypeScript + React). It shows server
temperatures and power draw:

- **Temp** and **Power (est.)** columns on the Nodes list
  (`/c/<cluster>/nodes`), after the built-in CPU and Memory columns (and the
  disk-health "Disk" column when installed). Temp is the hottest CPU
  temperature in C, amber at the sensor's max and red at its crit. If the
  sensor exposes no limits, the fixed defaults 80 C and 90 C apply (see
  `src/hardware.ts`). Power is **an estimate**: CPU package (RAPL) plus GPU
  power. It is not wall power and leaves out fans, disks, PSU losses and DRAM.
- A "Hardware sensors" section on every Node's details page: a table of every
  temperature sensor (chip, sensor label, value, max, crit) and a power
  breakdown (CPU package, DRAM if present, GPU). Loading, error and no-data
  states are handled explicitly. Missing values render as "-".

One shared poll serves the whole Nodes table and the details page, refreshing
every 60 seconds (`src/hardwareStore.ts`).

## Where the data comes from

The plugin queries a Prometheus-compatible service (for example
VictoriaMetrics) through the Kubernetes API server's Service proxy (see
`src/metrics.ts`; the defaults are constants there, change them to match your
cluster). All series must carry a `node` label. The queries are instant
queries, joined in code:

- Temperatures: `node_hwmon_temp_celsius`, with labels from
  `node_hwmon_sensor_label` (`node`, `chip`, `sensor`, `label`) and chip names
  from `node_hwmon_chip_names` (`chip_name`, for example `coretemp`).
- Limits: `node_hwmon_temp_max_celsius` and `node_hwmon_temp_crit_celsius`.
- CPU temperature for the column: the maximum over chips named `coretemp`,
  `k10temp` or `zenpower` or `apple_soc`; if the node has none, the maximum of all its
  temperatures.
- CPU package power (W): `sum by (node) (rate(node_rapl_package_joules_total[5m]))`.
- DRAM power (W): `sum by (node) (rate(node_rapl_dram_joules_total[5m]))`.
- GPU power (W): `sum by (node) (node_hwmon_power_average_watt * on (node, chip) group_left (chip_name) node_hwmon_chip_names{chip_name=~"amdgpu|nouveau|i915|xe"})`
  (GPU chips only: `amdgpu`, `nouveau`, `i915`, `xe`).
- Mac power (W): `{__name__=~"node_mac_power_.+"}`, i.e.
  `node_mac_power_system_watts` (measured whole-system power),
  `node_mac_power_cpu_watts`, `node_mac_power_gpu_watts` and
  `node_mac_power_ane_watts`.
- Mac battery: `{__name__=~"node_mac_battery_.+"}` (cycle count, design cycle
  count, design / max / current capacity in mAh, temperature, voltage, signed
  current, and the 0/1 flags external connected, charging, permanent failure).

The RAPL series may not exist in your cluster yet (they need the node-exporter
`rapl` collector and readable energy counters); the plugin then shows "-".

## Mac nodes

A Mac node exports its temperatures as hwmon series (chip names `apple_soc`
and `battery`) and the `node_mac_*` gauges above. The exporter is part of the
cluster's Mac node provisioning, not of this plugin. For such a node:

- The **Power** column shows the measured `node_mac_power_system_watts`
  (tooltip "Measured system power") instead of the CPU + GPU estimate, and the
  details page lists System, CPU, GPU and ANE.
- A "Battery" table appears on the details page only when battery series exist
  for the node: health (max / design capacity, amber below 80 %, red below
  60 % or on permanent failure), cycles, charge, temperature, voltage,
  current, power source, charging and permanent failure.

No extra RBAC is needed beyond Services proxy access, which the built-in
`view` ClusterRole grants.

## Release installation

Download `node-hardware-<version>.tar.gz` and `SHA256SUMS` from the matching
GitHub Release, verify the archive, and extract it into Headlamp's plugins
directory.

```bash
sha256sum -c SHA256SUMS --ignore-missing
mkdir -p /path/to/headlamp/plugins
tar -xzf node-hardware-0.1.0.tar.gz -C /path/to/headlamp/plugins
```

## Local development

```bash
cd plugins/node-hardware
npm ci
npm run tsc      # typecheck
npm run lint
npm run test
npm run build    # -> dist/main.js
```

On a shared host, bound the memory these commands can use, for example
`systemd-run --user --scope -p MemoryMax=4G -- npm run build`.
