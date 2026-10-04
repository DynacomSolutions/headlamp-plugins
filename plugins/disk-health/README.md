# disk-health

A [Headlamp](https://headlamp.dev/) plugin built with the official
`@kinvolk/headlamp-plugin` tooling (TypeScript + React). It shows disk
capacity and SMART/NVMe health throughout the cluster:

- A "Disks" section on every Node's details page, showing one row per
  physical disk: device, model/serial (where available), SMART health,
  `Reallocated_Sector_Ct`, `Current_Pending_Sector`, `Offline_Uncorrectable`,
  NVMe media errors, temperature and power-on hours. A row is highlighted red
  when SMART health has failed or any of those counters is non-zero. A
  no-data state and a query-error state are both handled explicitly (see
  `src/index.tsx`).
- A "Disk" column on the Nodes list view (`/c/<cluster>/nodes`), next to the
  built-in CPU and Memory columns, showing a usage bar plus used/total and a
  percentage - the same style as those columns.
- A cluster-wide "Disks" page (`/c/<cluster>/disks`) with a per-node capacity
  summary (used/total plus a per-filesystem breakdown: mountpoint, device,
  filesystem, size, used, available, percentage), a per-node, per-disk
  **performance** table, and every SMART/NVMe disk across every node,
  grouped by node, with failing disks sorted to the top and highlighted.

  The performance table exists because SMART health can look perfectly
  clean while a disk is still catastrophically slow to service IO - no
  error counter moves, but every write takes hundreds or thousands of
  milliseconds. It shows, per physical disk, over a trailing 5-minute
  window: write and read latency (ms), write and read IOPS, write and read
  throughput (MB/s), utilisation (%), and discard/TRIM activity (ops/s and
  MB/s). Rows are highlighted amber/red by write latency or utilisation
  (see thresholds in `src/performance.ts`), and each node also shows its IO
  pressure (PSI "some" stalled percentage) where the kernel exposes it.
  Only current values are shown - this repository's plugin has no charting
  library or history-store dependency yet, so a sparkline/history view was
  out of scope for this change; see "Where the data comes from" below for
  the counters a future history view could read from.

## Where the data comes from

The plugin queries a Prometheus-compatible service (for example
VictoriaMetrics) through the Kubernetes API server's Service proxy,
`/api/v1/namespaces/<namespace>/services/<service>:<port>/proxy/api/v1/query`
(see `src/metrics.ts`; the defaults are set as constants there - change them
to match your cluster). SMART/NVMe queries are filtered to the node being
viewed with `{node="<name>"}` on the Node details page, and run unfiltered,
in one batch, everywhere else (the Nodes list column and the Disks page).
The `node` label must be attached by your scrape config to `smartctl_exporter`
series.

Disk-capacity figures come from the host filesystem collector's
`node_filesystem_size_bytes` / `node_filesystem_avail_bytes` series (see
`src/capacity.ts`). Pseudo and network filesystems (`tmpfs`, `overlay`,
`squashfs`, `nsfs`, `ramfs`, `devtmpfs`, `fuse.*`, `nfs*`, `cifs`) are
excluded, and figures are deduped by `(node, device)` so a device that is
bind-mounted at more than one mountpoint is only counted once. The Nodes
list column polls once for the whole table (not once per row) and refreshes
every 60 seconds.

Disk-performance figures (see `src/performance.ts`) come from node-exporter's
per-device block-IO counters, each turned into a 5-minute rate:

- Write/read latency (ms): `rate(node_disk_write_time_seconds_total[5m]) /
  rate(node_disk_writes_completed_total[5m]) * 1000` (same shape for `read_*`).
- Write/read IOPS: `rate(node_disk_writes_completed_total[5m])` (and `reads_*`).
- Write/read throughput (MB/s): `rate(node_disk_written_bytes_total[5m]) / 1e6`
  (and `read_bytes_total`).
- Utilisation (%): `rate(node_disk_io_time_seconds_total[5m]) * 100`.
- Discard ops/s: `rate(node_disk_discards_completed_total[5m])`; discarded
  MB/s: `rate(node_disk_discarded_sectors_total[5m]) * 512 / 1e6` (the
  counter is in fixed 512-byte sectors).
- Per-node IO pressure (%): `rate(node_pressure_io_stalled_seconds_total[5m])
  * 100`, from the kernel's PSI accounting where available.

`loop*` and `zram*` devices are excluded as pseudo devices; `dm-` (device
mapper) devices are deliberately kept, because a node that boots from an LVM
root only exposes that root filesystem's latency on its `dm-` device, and
that is exactly the IO path etcd's `fsync`/`fdatasync` calls go through.

No extra RBAC is needed beyond Services proxy access, which the built-in
`view` ClusterRole grants.

## Release installation

Download `disk-health-<version>.tar.gz` and `SHA256SUMS` from the matching
GitHub Release, verify the archive, and extract it into Headlamp's plugins
directory.

```bash
sha256sum -c SHA256SUMS --ignore-missing
mkdir -p /path/to/headlamp/plugins
tar -xzf disk-health-0.1.0.tar.gz -C /path/to/headlamp/plugins
```

## Local development

```bash
cd plugins/disk-health
npm ci
npm run tsc      # typecheck
npm run lint
npm run build    # -> dist/main.js
```

On a shared host, bound the memory these commands can use, for example
`systemd-run --user --scope -p MemoryMax=4G -- npm run build`.
