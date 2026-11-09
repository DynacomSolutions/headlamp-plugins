# usage

A [Headlamp](https://headlamp.dev/) plugin built with the official
`@kinvolk/headlamp-plugin` tooling (TypeScript + React). It adds a **Usage**
entry to the sidebar (route `/usage`): a dashboard of donut charts that break
down resource usage over a chosen period.

## What it shows

- One donut per enabled resource: **CPU**, **Memory**, **Disk read**,
  **Disk write**, **Network in**, **Network out**. Every group gets its own
  slice at its real size (no top-N, no "Other"); a scrollable legend under the
  donut lists every group with its value and percentage. Hovering a slice or a
  legend row highlights the pair. Colours are stable per group across the
  donuts and never repeat inside one donut.
- A sortable table of every group below the donuts, with each resource's value
  and share.
- Units: CPU as average cores over the window plus core-hours; memory as the
  time-weighted average and the sum of pod peaks; disk and network as
  total bytes over the window plus the average rate.
- Controls, all mirrored into the URL query string (history replace), so a URL
  reproduces the view:
  - time range: `1h`, `6h`, `24h`, `7d`, `30d` (`range`)
  - group by: namespace, workload, Service, node, pod, or a pod label chosen
    from the label keys of live pods and `kube_pod_labels` (`group`, for example `label:app`)
  - resources shown (`res`)
  - namespace and node filters, the node filter being the hardware filter
    (`ns`, `node`)
  - only include or exclude specific groups of the chosen grouping (`only`,
    `skip`)
  - drill-down path (`drill`)
- Click a slice, a legend row or a table row to drill down: namespace to
  workload to pod; every other grouping goes straight to the pods of that
  group. A breadcrumb above the charts steps back.
- Explicit loading, error and no-data states. The data refreshes on a timer
  (see below) while the page is open; if a refresh fails the last data stays on
  screen with a warning.

## Where the data comes from

The plugin queries a Prometheus-compatible service (for example
VictoriaMetrics) through the Kubernetes API server's Service proxy (see
`src/metrics.ts`; the defaults are constants there, change them to match your
cluster). `<R>` is the selected range. All queries are built in
`src/resources.ts`, one per measure, and only the sets a view needs are run.

**Aggregated queries** (namespace, workload, node and label grouping). Per
measure, pod-level usage is joined server-side with the pod's controlling owner
and summed to `(namespace, node, owner_kind, owner_name)`, so the result is one
row per owner and node, not per pod:

`sum by (namespace, node, owner_kind, owner_name) (<pod usage> * on (namespace, pod) group_left (owner_kind, owner_name) <owner>)`

- Pod usage, by `(namespace, pod, node)`:
  - CPU (core-seconds): `increase(container_cpu_usage_seconds_total{container!=""}[<R>])`
  - Memory average (time-weighted): `integrate(container_memory_working_set_bytes{container!=""}[<R>]) / <R in seconds>`. `integrate` is MetricsQL, so this needs VictoriaMetrics (plain Prometheus does not have it).
  - Memory peak, shown as "sum of pod peaks": `max_over_time(...)` of the same selector, summed per pod and then per group, so it overstates the true simultaneous peak.
  - Disk read and write: `increase(container_fs_reads_bytes_total{container!=""}[<R>])` and `..._writes_...`
  - Network in and out: `increase(container_network_receive_bytes_total{pod!="", interface=~"eth[0-9]+"}[<R>])` and `..._transmit_...`
  - Pod count (for the fallback caption): `count by (...)` over one series per pod.
- Owner: `max by (namespace, pod, owner_kind, owner_name) (last_over_time(kube_pod_owner{owner_is_controller="true"}[<R>]))`.
  One-per-pod owner names are rolled up on the server before they cross the
  wire (ReplicaSet to Deployment, Job to CronJob, EphemeralRunner to its
  AutoscalingRunnerSet), and again in `workloadOf()` so both sides agree.
  Remainder branch: `<owner> or on (namespace, pod) <pods seen in the window>`
  adds every pod without an owner series back, with a workload derived from
  the pod name by `label_replace` (`<set>-runner-xxxxx` to AutoscalingRunnerSet,
  `<name>-<hash>-xxxxx` to Deployment, `<name>-<digits>-xxxxx` to CronJob,
  `<name>-xxxxx` to `Pod/<name>`, else `Pod/<pod name>`; same targets as the
  roll-ups above, so owned and ownerless pods of one workload merge), so
  nothing is dropped and the per-namespace totals match the plain pod-level
  query (checked within 1 % at 24h).

**Label grouping.** The same query also carries the label, joined server-side
from `kube_pod_labels`:
`... group_left (owner_kind, owner_name, label_x) (<owner> * on (namespace, pod) group_left (label_x) (max by (namespace, pod, label_x) (last_over_time(kube_pod_labels[<R>])) or on (namespace, pod) <pods seen in the window>))`,
where `label_x` is the key with a `label_` prefix and every character outside
`[a-zA-Z0-9_]` replaced by `_` (`app.kubernetes.io/name` becomes
`label_app_kubernetes_io_name`). This needs kube-state-metrics to export pod
labels: `--metric-labels-allowlist=pods=[*]` (or the keys you need). Pods
without a label series (including everything before the metric was first
exported) carry no value and use the workload fallback. If `kube_pod_labels`
is not exported at all, the labels of live pods are used. The key picker offers
the original keys of live pods plus any `label_*` names seen on
`kube_pod_labels` (shown sanitised).

**Service and pod grouping (live pods only).** The same pod-level expressions
restricted to pods that exist now with `... and on (namespace, pod) kube_pod_info`,
plus the live owners
`max by (namespace, pod, owner_kind, owner_name) (kube_pod_owner{owner_is_controller="true"})`.
These return a few hundred rows. Ended pods are not shown in these views.
Services are matched client-side against each live pod's labels. Drilling from
a workload to its pods uses the same live-pod path.

**Long ranges (7d, 30d): recorded series.** One raw query over a month exceeds
the metrics proxy's ~31 s limit, so 7d and 30d read only the hourly recording
rules of the vmalert group `usage` (1h interval, each sample covers the
previous full hour). They carry `namespace`, `node`, `owner_kind`, `owner_name`
(rolled up with the same rules as `ROLL_UPS` and `POD_NAME_RULES` in
`src/resources.ts`, which the rules copy) and the pod labels
`label_app_kubernetes_io_name`, `..._instance`, `..._component`, `..._part_of`
and `label_app` (empty string when absent):

| Series | Used for |
| --- | --- |
| `usage:cpu_seconds:increase1h` | CPU |
| `usage:memory_byte_seconds:integrate1h` | memory average |
| `usage:memory_peak_bytes:max1h` | memory peak |
| `usage:disk_read_bytes:increase1h`, `usage:disk_write_bytes:increase1h` | disk |
| `usage:net_in_bytes:increase1h`, `usage:net_out_bytes:increase1h` | network |
| `usage:pods:count1h` | pods |

One query per measure, `sum by (<grouping labels>) (sum_over_time(<series>[<R>]))`.
The memory average is the summed byte-seconds divided by the seconds that have
recorded data; the peak is `max_over_time(sum by (...) (<series>)[<R>:1h])`,
the highest hour of the summed pod peaks. The pods column is the sum of the
hourly counts and is labelled "pod-hours".

Limits on these ranges: Service and pod grouping and opening a workload to see
its pods are disabled ("available up to 24h"), because the recorded data has no
per-pod detail; label grouping offers only the five recorded keys (others are
disabled with the same tooltip). A pod or label value that is empty in the
recorded data follows the usual workload fallback. 1h, 6h and 24h keep the
raw queries above.

Coverage: the first and last recorded hour come from
`min(min_over_time(timestamp(usage:cpu_seconds:increase1h)[<R>]))` and the
`max` equivalent. When the first hour is later than the window start, a caption
says "Recorded data starts <date time> ICT, so this view covers <N> days", and
averages use the covered seconds. When no recorded data exists yet, the page
shows an info alert ("Long ranges need the usage recording rules (vmalert); see
README") instead of an error. Requirement: deploy the vmalert rules that record
the series above, or only 1h, 6h and 24h work.

Only the queries the current grouping and drill-down need are run. Namespace,
workload and node grouping run just the aggregated queries; Service and pod
grouping just the live ones.

Notes:

- Network series are pod-level (they have no container label), so they are
  not filtered on `container`. Host-network pods report the node's physical
  interfaces, which would count the same traffic once per such pod, so only
  `eth*` interfaces are summed (`POD_INTERFACE_FILTER` in `src/resources.ts`).
  Change it if your CNI names pod interfaces differently.
- CPU, disk and network use `increase()`, which handles counter resets and
  extrapolates at the window edges. Pods that existed for only part of the
  window count for the part they existed. Memory average is time-weighted over
  the whole window, so a short-lived pod contributes only for the time it ran.
- Refresh interval by range: 1h and 6h every minute, 24h every 5 minutes, 7d
  and 30d every 15 minutes. The last data stays on screen while a refresh
  runs, and "Updated hh:mm" shows when it was fetched.
- A VictoriaMetrics that returns no series shows the "No usage metrics found"
  state rather than empty charts.

## Groups that cannot be placed (workload fallback)

There is no "Other", "unknown" or "no label" bucket and no top-N: every group
with usage is its own slice at its real size. When a pod cannot be placed in
the chosen grouping (no value for the chosen label, no matching Service, no
node), it is shown under its workload identity, for example
`arc-runners/AutoscalingRunnerSet/linux-x64` (ReplicaSet rolled up to
Deployment, Job to CronJob), marked with a small "workload" chip in the legend
and table. A pod with no owner is `<namespace>/Pod/<pod name>`. One caption
above the charts says how many pods are shown that way, for example "12 pods
shown under their workload because they have no app label" (or "no matching
Service").

Service grouping is client-side: the plugin lists the live Pods and Services
through Headlamp's Kubernetes API and maps each pod to the Service whose
`spec.selector` matches the pod's labels. Services with an empty selector match
nothing. If several Services match, the first by name is used so usage is never
counted twice.

## Permissions (RBAC)

- `get` on the Services proxy (`services/proxy`) of the metrics service, and
- `list` on Pods and Services (cluster-wide).

The built-in `view` ClusterRole grants these.

## Release installation

Download `usage-<version>.tar.gz` and `SHA256SUMS` from the matching GitHub
Release, verify the archive, and extract it into Headlamp's plugins directory.

```bash
sha256sum -c SHA256SUMS --ignore-missing
mkdir -p /path/to/headlamp/plugins
tar -xzf usage-0.1.0.tar.gz -C /path/to/headlamp/plugins
```

## Local development

```bash
cd plugins/usage
npm ci
npm run tsc      # typecheck
npm run lint
npm run test
npm run build    # -> dist/main.js
```

The pure logic (queries, pod rows, grouping, filters, URL state, units) lives
in plain `.ts` modules with unit tests. Charts use the `recharts` module that
Headlamp shares with plugins, so it is not bundled.

On a shared host, bound the memory these commands can use, for example
`systemd-run --user --scope -p MemoryMax=4G -- npm run build`.
