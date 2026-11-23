# workflows

A [Headlamp](https://headlamp.dev/) plugin that shows the check-in of every
recurring job of an app, and the health of the workloads that run them. It adds
a **Workflows** sidebar entry (`/workflows`) and the Dashboards widget
`workflows.status`.

An app exports Prometheus series about its own jobs. A Prometheus-compatible
service (for example VictoriaMetrics) scrapes them. The plugin reads them
through the Kubernetes API server's Service proxy. CronJobs, Deployments and
StatefulSets come from kube-state-metrics.

## The page

A summary bar on top shows four counts: failing workflows, overdue workflows,
failing CronJobs and unhealthy workloads. A count above 0 is red.

### Workflows and CronJobs

One table, grouped by app. The group key is the `namespace` series label when it
exists, else the metric prefix. Groups and rows with failing or overdue entries
come first.

Columns: Status, Workflow, Kind (`poller`, `timer`, `worker`, `cronjob`), Last
run, Last success, Failures in a row, Expected interval, Next due, Last error
class, Component or pod. Times show a relative age and the exact local time in a
tooltip. A footer counts the workflows.

| Status | When | Colour |
| --- | --- | --- |
| `ok` | The workflow ran and nothing is wrong | green |
| `failing` | 1 or 2 failures in a row | amber |
| `failing` | 3 or more failures in a row | red |
| `overdue` | `overdue` is 1 | red |
| `never run` | `last_run` is 0 and it is not overdue | grey |
| `idle` | Event driven (expected interval 0) with no failures | grey |
| `suspended` | A suspended CronJob (never overdue) | grey |

An event driven workflow with a failure streak is `failing`. The error class
`state` shows as "condition not met".

**Next due** is `next_run_timestamp` when it is above 0, else the last success
plus the expected interval (while there is no success, the registration time
plus the interval). It shows "overdue by ..." when it is in the past and "event
driven" when the expected interval is 0.

Several series of one workflow (pods or components) fold into one row that
shows the worst one. The tooltip of the last column lists every pod. A series
that vanishes (the pod is gone) leaves the list at the next refresh.

CronJobs use kube-state-metrics:

| Field | Source |
| --- | --- |
| Last success | `kube_cronjob_status_last_successful_time` |
| Last run | `kube_cronjob_status_last_schedule_time` |
| Expected interval | `kube_cronjob_next_schedule_time` minus `kube_cronjob_status_last_schedule_time` |
| Overdue | no success (else the creation time) for more than 2 intervals, and not suspended |
| Failures in a row | failed Jobs of the CronJob (`kube_job_status_failed`, `kube_job_owner`) that are newer than the last success |

### Workloads

One table of Deployments and StatefulSets, grouped by namespace, with ready and
desired replicas, how long a pod has not been Ready, container restarts in the
last 24 hours and the exit code and reason of the last terminated container.

| Status | When | Colour |
| --- | --- | --- |
| `ok` | Ready replicas equal desired replicas | green |
| `not ready` | Fewer ready than desired, for less than 2 minutes | amber |
| `not ready` | Fewer ready than desired, for 2 minutes or more | red |
| `crash loop` | A container waits in `CrashLoopBackOff` | red |
| `scaled to zero` | Desired replicas are 0 (not a failure) | grey |

Failing workloads sort first. The time that a pod has not been Ready is the time
since it was last Ready (a one-minute sample over 24 hours), never longer than
the pod age.

## Dashboards widget

With the Dashboards plugin installed, the plugin adds `workflows.status`
("Workflows", category Monitoring). It shows the summary bar, the workflows and
CronJobs in groups, and the unhealthy workloads. It fetches when the dashboard
refreshes. The dashboard namespace filter applies.

| Key | Values | Default |
| --- | --- | --- |
| `onlyFailing` | show only failing or overdue rows | `false` |
| `groupBy` | `auto`, `namespace`, `prefix` | `auto` |

## The contract: series that an app exports

Every app picks its own prefix. The plugin finds the prefixes at run time from
the series names, with `{__name__=~".+_workflow_last_success_timestamp_seconds"}`
and the other series of the family. It fixes no prefix. **Each app adds its own
`<prefix>_workflow_*` series** (the page shows a new app with no change).

All series carry the labels `workflow` (a stable kebab-case id) and `kind`
(`poller`, `timer` or `worker`). The scrape adds `namespace`, `pod` and
`component` where it can.

| Series | Meaning |
| --- | --- |
| `<prefix>_workflow_expected_interval_seconds` | Expected time between successful runs. 0 means event driven. |
| `<prefix>_workflow_registered_timestamp_seconds` | Unix time when the process registered the workflow. |
| `<prefix>_workflow_last_run_timestamp_seconds` | Unix time of the last attempt. 0 means no run yet. |
| `<prefix>_workflow_last_success_timestamp_seconds` | Unix time of the last success. 0 means none since the start. |
| `<prefix>_workflow_next_run_timestamp_seconds` | Unix time of the next planned run. 0 means unknown. |
| `<prefix>_workflow_consecutive_failures` | Failures since the last success. |
| `<prefix>_workflow_overdue` | 1 when there is no success for more than 2 intervals. Always 0 when event driven. |
| `<prefix>_workflow_last_error_info` | Value 1 with the label `error_class` of the last failure (`none` after a success). |

`error_class` values that apps use: `none`, `timeout`, `rate_limited`,
`http_4xx`, `http_5xx`, `network`, `parse`, `rights`, `internal`, `state`
(a checked condition is not met) and `other`. The plugin shows any value.
`<prefix>_workflow_runs_total` (by `result`) is not read.

## Settings

Set them on the plugin settings page, or deploy
`/plugins/workflows/defaults.json` next to `main.js`. Blank fields fall back to
the deployment default, then the built-in default.

| Key | Default | Meaning |
| --- | --- | --- |
| `metricsNamespace` | `monitoring` | Namespace of the metrics Service |
| `metricsService` | `victoria-metrics` | Name of the metrics Service |
| `metricsPort` | `8428` | Service port |
| `cronJobNamespaces` | empty | CronJobs and workloads of the namespaces that have workflow series. A comma separated list adds namespaces. `*` shows every namespace. |

## Queries

The page refreshes every 30 seconds. It reads the workflow families with one
instant query each (`{__name__=~".+_workflow_<suffix>"}`). Then, for the
namespaces in scope, it reads these kube-state-metrics series:
`kube_cronjob_status_last_successful_time`, `kube_cronjob_status_last_schedule_time`,
`kube_cronjob_next_schedule_time`, `kube_cronjob_spec_suspend`, `kube_cronjob_created`,
`kube_job_created`, `kube_job_owner`, `kube_job_status_failed`, `kube_job_status_succeeded`,
`kube_deployment_spec_replicas`, `kube_deployment_status_replicas_ready`,
`kube_statefulset_replicas`, `kube_statefulset_status_replicas_ready`, `kube_pod_owner`,
`increase(kube_pod_container_status_restarts_total[24h])`,
`kube_pod_container_status_last_terminated_exitcode`,
`kube_pod_container_status_last_terminated_reason`,
`kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}`,
`kube_pod_status_ready`, `kube_pod_status_phase` and `kube_pod_created`.
If kube-state-metrics is missing, the workflow rows still show and a warning
names the missing CronJobs and workloads.

## RBAC

`get` on `services/proxy` for the metrics Service. The plugin makes no other API
call and stores nothing.

```yaml
rules:
  - apiGroups: [""]
    resources: ["services/proxy"]
    resourceNames: ["victoria-metrics:8428"]
    verbs: ["get"]
```

## Release installation

Download `workflows-<version>.tar.gz` and `SHA256SUMS` from the matching GitHub
Release, verify the archive, and extract it into Headlamp's plugins directory.

```bash
sha256sum -c SHA256SUMS --ignore-missing
tar -xzf workflows-0.1.0.tar.gz -C /path/to/headlamp/plugins
```

## Development

```bash
npm ci
npm run tsc && npm run lint && npm test && npm run build
```
