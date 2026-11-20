# node-hardware

A [Headlamp](https://headlamp.dev/) plugin built with the official
`@kinvolk/headlamp-plugin` tooling (TypeScript + React). It shows server
temperatures, power draw and a full hardware profile:

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

- **RAM** and **GPUs** columns on the Nodes list, after Temp and Power. RAM is
  installed / maximum capacity (for example "128 / 512 GiB"), with slots used
  of total in the tooltip. GPUs is the count, with the models in the tooltip.
  Both sort by value.
- A "Hardware profile" section on every Node's details page, with sub-tables:
  Motherboard (vendor, model, version, BIOS), CPU (sockets populated of total,
  model, cores, threads, speeds), Memory (summary like "128 GiB of 512 GiB max,
  4 of 8 slots used", ECC, EDAC error counts and a per-slot table with size,
  type, rated and configured speed, manufacturer, part number), Expansion
  slots (PCIe and M.2: total and in use, lanes, generation, the device in each
  slot), PCI devices, GPUs (with VRAM) and NVMe drives (capacity, link). A
  link below its maximum width or speed shows in amber. When the inventory
  collector is not reporting, the section says so and shows what the existing
  series give.

One shared poll serves the whole Nodes table and the details page, refreshing
every 60 seconds (`src/hardwareStore.ts`). The hardware profile has its own
shared poll that refreshes every 5 minutes (`src/inventoryStore.ts`), because
hardware rarely changes.

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
- Mac thermal pressure: `node_mac_thermal_pressure_level` (macOS's own throttling
  signal: 0 nominal, 1 moderate, 2 heavy, 3 trapping, 4 sleeping).

### Hardware profile series

The profile joins series from a node inventory collector (SMBIOS and sysfs data
written to the node-exporter textfile directory) with series that already
exist. Every query is optional: a missing series shows "-" and never fails the
profile. All series carry a `node` label. The queries are in `src/inventory.ts`.

- Collector health: `node_hw_inventory_up`,
  `node_hw_inventory_last_run_timestamp_seconds`. When `node_hw_inventory_up`
  is absent, the page shows a "collector not reporting yet" note.
- Motherboard and BIOS: `node_dmi_info` (`board_vendor`, `board_name`,
  `board_version`, `bios_vendor`, `bios_version`, `bios_date`).
- CPU: `node_hw_cpu_info` (`socket`, `model`, `populated`), `node_hw_cpu_cores`,
  `node_hw_cpu_threads`, `node_hw_cpu_max_speed_hertz`,
  `node_hw_cpu_current_speed_hertz`, `node_hw_cpu_sockets{state}`.
- Memory: `node_hw_memory_max_capacity_bytes`, `node_hw_memory_slots{state}`,
  `node_hw_memory_ecc_info`, `node_hw_memory_module_info`,
  `node_hw_memory_module_size_bytes`, `node_hw_memory_module_speed_mts`,
  `node_hw_memory_module_configured_speed_mts`. Installed memory is the sum of
  the module sizes, with `node_memory_MemTotal_bytes` as a fallback. Error
  counts come from `node_edac_correctable_errors_total` and
  `node_edac_uncorrectable_errors_total`.
- Slots: `node_hw_slot_info` (`designation`, `kind`, `slot_type`,
  `bus_address`, `usage`), `node_hw_slot_lanes`, `node_hw_slot_generation`. A
  device sits in a slot when `node_hw_pci_device_info` names the slot or the
  bus address matches.
- PCI devices: `node_hw_pci_device_info`, `node_hw_pci_device_link_width`,
  `node_hw_pci_device_max_link_width`, `node_hw_pci_device_link_speed_gts`,
  `node_hw_pci_device_max_link_speed_gts`.
- GPUs: `node_hw_gpu_info`, `node_hw_gpu_memory_bytes`, and the DCGM series
  `DCGM_FI_DEV_FB_CAPACITY_BYTES` (`pci_bus_id`, `modelName`). The two
  sources are joined by PCI address.
- NVMe: `node_hw_nvme_info`, `node_hw_nvme_capacity_bytes` and the existing
  `node_nvme_info` as a fallback for model and firmware.

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
- A "Thermal pressure" row (Nominal, Moderate, Heavy, Trapping or Sleeping)
  appears in the power table only when the series exists for the node: green
  when nominal, amber when moderate, red from heavy upwards.

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
