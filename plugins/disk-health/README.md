# disk-health

A [Headlamp](https://headlamp.dev/) plugin built with the official
`@kinvolk/headlamp-plugin` tooling (TypeScript + React). It adds a "Disks"
section to every Node's details page, showing one row per physical disk:

device, model/serial (where available), SMART health, `Reallocated_Sector_Ct`,
`Current_Pending_Sector`, `Offline_Uncorrectable`, NVMe media errors,
temperature and power-on hours. A row is highlighted red when SMART health
has failed or any of those counters is non-zero. A no-data state and a
query-error state are both handled explicitly (see `src/index.tsx`).

## Where the data comes from

The plugin queries a Prometheus-compatible service (for example
VictoriaMetrics) through the Kubernetes API server's Service proxy,
`/api/v1/namespaces/<namespace>/services/<service>:<port>/proxy/api/v1/query`,
filtered to the node being viewed (`{node="<name>"}`). The defaults are set as
constants at the top of `src/index.tsx`; change them to match your cluster.
The `node` label must be attached by your scrape config to
`smartctl_exporter` series. No extra RBAC is needed beyond Services proxy
access, which the built-in `view` ClusterRole grants.

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
