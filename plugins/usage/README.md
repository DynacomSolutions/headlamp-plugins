# usage

A [Headlamp](https://headlamp.dev/) plugin built with the official
`@kinvolk/headlamp-plugin` tooling (TypeScript + React). It adds a **Usage**
entry to the sidebar (route `/usage`): a dashboard of donut charts that break
down resource usage over a chosen period. A **Dashboard** entry under it shows
each node's CPU and memory as touch-friendly sunburst charts (see
[Usage dashboard](#usage-dashboard)).

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

## Usage dashboard

A **Dashboard** entry under **Usage** (route `/usage/dashboard`) shows the CPU
and memory of your nodes as two large sunburst charts, made for a touch screen
in a server cabinet: finger only, no mouse and no hover. The page uses the
whole width of the main area. The old `/usage/nodes` URL redirects here and
keeps its query.

- **Charts:** one **CPU** and one **Memory** sunburst. There is no side
  column and no upper limit on the diameter. A top bar holds the **Nodes** and
  **Category** filters, the breadcrumb, **Up**, **Open** and **Full screen**
  (**Exit full screen** in the kiosk, which is pure black in a dark theme for OLED screens), wrapping on a narrow screen. Under it a
  compact strip shows the selected segment (icon, name, raw id, kind, CPU and
  memory with their shares, thread link) and a horizontal, scrollable row of
  chips, one per child, sorted by value; tapping a chip selects that arc. The
  charts then share the full width and the rest of the height, side by side on
  a landscape screen and one above the other on a narrow one. Text and icons
  in the charts grow with their size. Each is sized against capacity, so the
  unused share is a real arc.
- **Filters:** a bar at the top, with **Nodes** and **Category** (Kubernetes,
  T3 Code, Herdr, Other scopes, System). Nothing selected means all. With one
  node selected the rings are that node's tree. With more than one, the first
  ring is one arc per node, each sized against the summed capacity of the
  selected nodes, and its tree sits under it. A category filter drops the other
  category arcs; the gap they leave stays empty and the rest is not rescaled.
- **Rings:** node (only for several nodes) > group (Kubernetes, each agent
  orchestrator, System) > namespace or project > pod or thread > container or
  process, three rings at a time.
- **Icons first:** an arc shows its icon, as large as fits (16 to 40 px), and
  its name beside it only when both fit. Project icons come from the agent
  backend. Apps and processes (node, git, claude, nginx and so on) and
  Kubernetes containers get icons from a local table, bundled with the plugin,
  so they are not fetched from the internet. Unknown ones get a generic icon.
  (A project icon of kind lucide set by the backend is still looked up by
  Iconify.)
- **Runner pool rings (optional):** the **Runner pool prefix** setting (`runnerPoolPrefix`) turns on the extra runner rings. It is the word that starts the metric and label names of your runner pool service. Blank: off, and no query for it goes out. A `defaults.json` next to `main.js` can preset it.
- **Names:** arcs, the centre, the breadcrumb and the list show a friendly
  name, for example `my-runners` as "My runners". The details card shows
  that name as its title and the raw id under it. A name comes from, in order:
  the **Display names** setting (`id=Name` lines, one per line); the cluster
  (a Namespace's `app.kubernetes.io/display-name` annotation, then its
  `app.kubernetes.io/part-of`, `name` or `instance` label); the app table
  (processes and containers such as `node` as "Node.js"); and last a plain
  humaniser that drops a suffix such as `-runners` or `-system`, splits on `-`
  and `_` and title-cases. Pods show their workload name, without the
  ReplicaSet hash. T3 project and thread names are used as they are.
- **Select, then open:** a tap on an arc selects it in both charts. It grows a
  little and gets an outline. Tap it again, or empty space, to clear it. A card
  below the charts gives its icon, name and kind, its CPU and memory with the
  share of capacity, of its parent and of the zoom root, and an **Open thread**
  link for a T3 thread (on the usage page; in a dashboard widget it is a **Copy thread link** button, because no
  dashboard link leaves the dashboard). Next to it is the list of its children (tap a row to
  select it). **Open** zooms both charts to the selected segment. **Up**, the
  centre of a chart and the breadcrumb go up a level.
- **Empty space:** the capacity nothing uses (**Unused**) and what a parent
  holds beyond its children (**Unattributed**) are arcs with a dotted outline
  and a very faint crosshatch fill. They can be selected and show their value and shares, but they
  cannot be opened.
  - Every arc is also a focusable button named with its value and share, so
    keyboards and screen readers reach every value (Enter or Space selects).
  - The centre of each chart describes the zoom root: icon, name, cores (CPU)
    or bytes (memory), and its share of capacity and of its parent.
- **Full screen:** the **Full screen** button shows only the dashboard (filters,
  charts, details) over the whole window, with no Headlamp header or sidebar,
  and asks the browser for full screen too. **Exit full screen**, always in the
  top right, leaves it; so do Escape and leaving browser full screen by any
  other way.
- **Idle:** with no touch for the idle time (default 2 minutes) the zoom and
  selection go back to the root. The filters and full screen stay.
- **URL:** the whole view is in the query string and is replaced (not pushed) on
  every change, so a URL reproduces the view after a reload or on another
  device, and a cabinet browser can boot into a fixed view. Defaults are left
  out.

  | Param | Meaning |
  | --- | --- |
  | `nodes` | selected nodes, comma separated (all when absent) |
  | `cats` | selected categories: `k8s`, `t3`, `herdr`, `other`, `system` |
  | `path` | zoom path: arc keys from the root, comma separated |
  | `sel` | selected segment, same form as `path` |
  | `kiosk` | `1` for the full screen view |

  Commas and percent signs inside a name are escaped, so any node name or arc
  key survives. Example:
  `/usage/dashboard?nodes=worker-1&cats=k8s,t3&kiosk=1`. Opened with `kiosk=1`
  the page shows the full screen view without the browser's own full screen
  (browsers allow that only after a tap). An old `?node=worker-1` link maps to
  `nodes=worker-1`.
- **States:** a loader on the first load; an error if the first metrics query
  fails; a warning banner when a refresh fails (the last data stays on screen);
  a warning on one node only when its agent backend fails (the other nodes keep
  rendering, and that node shows Kubernetes and System only); "No host
  metrics" when a node has no node-exporter series (the charts then show only
  what Kubernetes and the agents report).

Data sources, refreshed every 10 seconds:

- The metrics service (as above): node CPU and memory from node-exporter
  (`node_cpu_seconds_total`, `node_memory_MemTotal_bytes`,
  `node_memory_MemAvailable_bytes`, or the macOS exporter equivalents), and
  per-container CPU and memory from cAdvisor.
  - **CPU used** is the node's busy CPU: the rate over one minute of every
    `node_cpu_seconds_total` mode except `idle`, `iowait` and `steal`. Without
    that series the page falls back to the logical cores minus the idle rate.
    The CPU chart carries a small label under its heading that says where the
    figure comes from and over what time, for example "node exporter, 1 min
    average". The window in the label is the same constant that builds the
    query. The runner widget of the Dashboards plugin shows the node figure of
    the runner source (a short metrics-server sample), so the two numbers can
    differ for the same node.
  - **CPU capacity** is the allocatable cores
    (`kube_node_status_allocatable`), the base of `kubectl top`. The charts
    say "of allocatable". The node's logical core count and
    `kube_node_status_capacity` are fallbacks. Memory keeps the node's memory
    capacity.
  - **System** is the node's busy CPU minus the pods and the agents. It never
    goes below zero, so the ring adds up to the node figure.
- The agent-resource backends (`/api/state`, read through the Kubernetes API
  service proxy): the agent orchestrators, projects, threads and processes of
  the node each backend runs on. CPU or memory not explained by Kubernetes or
  the agents is shown as **System**.

Settings (Headlamp **Settings > Plugins > usage**, stored in the browser):

- **Agent backends:** comma-separated `service/<namespace>/<name>:<port>`
  entries. Default `service/agent-resource/agent-resource:80`. The backend
  ran in the namespace `agent-memory` before. When the Service is in the
  namespace `agent-resource` or `agent-memory`, the plugin falls back to
  `service/agent-memory/agent-resource` if the new place does not answer.
  In any other namespace, an `agent-resource` Service falls back to an
  `agent-memory` Service of the same namespace.
- **Idle threshold (seconds):** how long without a touch before the page goes
  back to the overview. Default 120, at least 30.

## Dashboards widgets

When the [Dashboards plugin](../dashboards/README.md) is installed, this plugin adds three widgets to its palette,
through the cross-plugin `window.headlampDashboards` contract (`src/dashboardsContract.ts` is a copy of the
contract file). The registration works in any plugin load order. The Usage pages do not change.

| Type | What it shows |
| --- | --- |
| `usage.sunburst` | CPU or memory as a two-level sunburst: the full circle is the cluster capacity (`kube_node_status_capacity`), the filled part is the use. The groups are the namespaces, workloads, nodes or a pod label. Each group has its children inside it (workloads, nodes or namespaces). Every group has its own arc. |
| `usage.donut` | One donut for CPU, memory, disk or network, with a legend of every group (the `DonutCard` of the Usage page). |
| `usage.dashboard-rings` | The Usage > Dashboard page itself: the CPU and memory sunbursts of every node, drawn by the same code, with zoom, Up, Open, the details card, the ring toggle and the node and category filters. Settings: `rings` (2 to 6, start value, default 4) and `filters` (show the filters, default on). |

Both use the same data code as the Usage page. They take the dashboard filters into account: the namespaces,
the nodes and the time range (5 and 15 minutes use the 1 hour data). The label selector is not used. They fetch
when a filter, a setting or the dashboard refresh signal changes. Grouping by pod label needs
`kube_pod_labels` (kube-state-metrics) and, over 24 hours, one of the recorded label keys.

`usage.dashboard-rings` ignores the dashboard filters. It has its own node and category filters, as the page
has. It keeps the zoom, the selection, the filters and the ring count in local state and never writes to the
page URL. It fills the widget: the charts sit side by side, or one above the other in a narrow widget. It
fetches once and then when the dashboard refresh signal changes, with no timer, and not when widgets move.
In the kiosk it uses black surfaces, touch filters and the idle reset of the page.

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

- `get` on the Services proxy (`services/proxy`) of the metrics service,
- `list` on Pods and Services (cluster-wide), and
- for the Usage dashboard, `get` on the Services proxy of each agent-resource backend. Grant it on the old namespace `agent-memory` too until the backend rollout is complete.

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
