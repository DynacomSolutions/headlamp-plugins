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
  filesystem, size, used, available, percentage) and every SMART/NVMe disk
  across every node, grouped by node, with failing disks sorted to the top
  and highlighted.

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

No extra RBAC is needed beyond Services proxy access, which the built-in
`view` ClusterRole grants.

## How it reaches Headlamp

Headlamp loads every subdirectory of its `-plugins-dir`. The `Dockerfile`
here builds the plugin and ships only `dist/` plus `package.json` in a small
image, intended to run as an initContainer that copies `/plugin` into a shared
volume mounted at the plugins directory before Headlamp starts.

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
