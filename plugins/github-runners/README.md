# github-runners

A [Headlamp](https://headlamp.dev/) plugin for
[Actions Runner Controller](https://github.com/actions/actions-runner-controller)
(ARC, `actions.github.com/v1alpha1`). It adds a **GitHub Runners** sidebar entry.

## What it shows

- **Overview**: summary stats, one card per node (ready/offline, busy marks,
  best-effort external workers), live jobs (job, repository, workflow, run,
  node, runner, scale set, status) and starting runners. Job, repository,
  workflow and run cells link out to github.com.
- **Capacity**: live, from watched Kubernetes lists and the polled endpoint.
  Pools (one row per `AutoscalingRunnerSet`: repo or organisation served, cap,
  running, waiting to start with a short reason such as "not enough CPU",
  preferred and spill nodes); per-node allocatable CPU and memory split into
  runner, other and free, with the runners on each node by pool; demand at cap
  versus capacity, with a warning when demand exceeds it and per starved pool;
  runners outside the cluster (online/offline, idle/busy, standby with reason);
  and a policy check (below).
- **Scale sets**: `AutoscalingRunnerSet` (min/max, current/pending/running/failed,
  phase, GitHub org/repo link) and `EphemeralRunnerSet`.
- **Runners**: `EphemeralRunner` with phase, reason, node, and the job,
  repository and workflow from its status. The runner name links to its Pod.
- **Listeners**: `AutoscalingListener`, linked to its Pod.
- **History**: past jobs (needs the optional endpoint, below).

Filters (search, node, scale set) apply across tabs. Job, repo and workflow
fields come from the `EphemeralRunner` status (`jobDisplayName`,
`jobRepositoryName`, `jobWorkflowRef`, `workflowRunId`). ARC does not expose the
numeric GitHub job id, so job links point at the workflow run unless the
optional endpoint supplies the exact job URL.

The plugin makes **no GitHub API calls** and the browser never holds a token.
If the ARC CRDs are absent, each tab shows an explanatory notice instead of
failing; nodes and the rest of the page still load.

## URL scheme

Tabs are path segments, opened with history push so back and forward work:
`/github-runners` (overview), `/github-runners/capacity`, `/github-runners/scalesets`,
`/github-runners/runners`, `/github-runners/listeners`, `/github-runners/history`.
Headlamp's cluster prefix (`/c/<cluster>/...`) is kept. An unknown tab shows the
overview.

Filters live in the query string and are written with history replace, so
the URL alone reproduces the view and tab switches keep it: `q` (search),
`node` (comma-separated node ids, or repeated) and `set` (comma-separated scale
set names, or repeated). Example: `/github-runners/history?node=worker-1&q=shop`.

## Overview live jobs table

The Overview's "Live jobs" table is grouped in two levels: project, then
workflow run, with the jobs as rows. Idle runners are not listed.

- Project: the repository name without its owner (`my-org/shop` becomes `shop`).
  A job without a repository uses the scale set name with the configured prefix
  and suffixes stripped, so `ci-shop` and `ci-shop-main` both land in `shop`
  with prefix `ci-`.
- Workflow run: one per repository and run id, labelled with the workflow name
  and linked to the run.
- Group rows show the number of jobs and the age of the oldest job start.
- Everything starts expanded. Search and the node and scale-set filters apply
  to the job rows. Expand state is not kept in the URL.

## Optional: status endpoint (enrichment and history)

Everything above works from Kubernetes objects alone. To add GitHub-side detail
(exact job URLs and status, org runners registered outside the cluster) and job
history, point the plugin at a JSON endpoint serving a scanner's
`status.json` (and `history.json`). Configure it in Headlamp under
Settings, Plugins, GitHub Runners:

| Setting | Meaning |
| --- | --- |
| Status endpoint | Either a same-cluster path, fetched through the Kubernetes API (for example `/api/v1/namespaces/NS/services/NAME:PORT/proxy/data/status.json`), or an absolute URL such as `https://status.example.com/data/status.json` |
| History endpoint | Defaults to the status URL with `status.json` replaced by `history.json` |
| External worker API group / version | Optional CRD group serving `externalworkers` (a builder registered outside the cluster). Empty disables |
| Node display names | `id=Label,id2=Label2` |
| Pool repositories | `pool=owner/repo,pool2=owner/repo2`. Names the repo an organisation-level pool serves (repo-level pools are read from the ARC labels; otherwise the organisation and runner group are shown) |
| Policy: preferred nodes | Comma-separated node ids every pool must prefer, for example `worker-1,worker-2` |
| Policy: spill nodes | Comma-separated node ids every pool must be allowed to spill onto, for example `worker-3` |
| Policy: default repo cap | Maximum total `maxRunners` across all pools serving one repo. Default 3 once any policy setting is present |
| Policy: repo cap overrides | `my-org/my-repo=32,my-org/other-repo=5` |
| Project: strip prefixes | Comma-separated, empty by default. At most one is removed from a scale set name to get the project of a job without a repository or of a starting runner, for example `ci-` |
| Project: strip suffixes | Comma-separated, default `-main,-runners`. Removed repeatedly from the end of the name. Only used for that fallback. If nothing would be left, the original name is the project |

The Capacity tab flags a pool when it does not prefer every preferred node, is
not allowed on every spill node (excluded by a required `NotIn`, or missing from
a required `In`), prefers a spill node at equal or higher weight than the
preferred nodes, or its repo's total `maxRunners` exceeds the cap. With no
policy settings it shows a notice instead.

Expected schema (all fields are optional except those listed):

```jsonc
// status.json
{ "generated_at": "2026-01-01T00:00:00Z",             // required
  "nodes": [{ "id": "worker-1", "display_name": "Worker 1", "kind": "kubernetes|external",
              "ready": true, "os": "linux", "jobs": [/* Job */], "starting": [] }],
  "scale_sets": [{ "name": "set-a", "min_runners": 0, "max_runners": 5,
                   "pending": 0, "running": 1, "phase": "Running" }],
  "summary": { "running_jobs": 1, "pending_runners": 0, "nodes_ready": 1, "nodes_total": 1 } }
// Job: key, name, repository, workflow, workflow_ref, run_id, job_id, numeric_job_id,
//      url, run_url, runner_name, scale_set, node_id, status, conclusion, started_at, completed_at
// history.json: { "generated_at": "...", "jobs": [/* Job */] }
```

To preconfigure every browser, ship a `defaults.json` next to `main.js` in the
plugin directory (for example written by an initContainer). It uses the same keys
as the settings (`statusUrl`, `historyUrl`, `externalWorkerGroup`,
`externalWorkerVersion`, `nodeAliases`, `poolRepos`, `policyPreferredNodes`,
`policySpillNodes`, `policyRepoCap`, `policyRepoCaps`, `projectStripPrefixes`,
`projectStripSuffixes`); non-empty values a user saves in the
settings override it.

Data older than 180 seconds is flagged stale. Kubernetes data stays the source
of truth for what exists; the endpoint only overlays detail.

## Access needed

Read (`get`, `list`, `watch`) on `nodes`, `pods`, and the four ARC resources.
The built-in `view` ClusterRole plus read access to the ARC CRDs is enough.

## Release installation

Download `github-runners-<version>.tar.gz` and `SHA256SUMS` from the matching
GitHub Release, verify the archive, and extract it into Headlamp's plugins
directory.

```bash
sha256sum -c SHA256SUMS --ignore-missing
mkdir -p /path/to/headlamp/plugins
tar -xzf github-runners-0.1.0.tar.gz -C /path/to/headlamp/plugins
```

## Development

```bash
cd plugins/github-runners
npm ci
npm run tsc && npm run lint && npm test
npm run build       # -> dist/main.js
```
