# github-runners

A [Headlamp](https://headlamp.dev/) plugin for
[Actions Runner Controller](https://github.com/actions/actions-runner-controller)
(ARC, `actions.github.com/v1alpha1`). It adds a **GitHub Runners** sidebar entry.

## What it shows

- **Overview**: summary stats, one card per node (ready/offline, busy marks,
  best-effort external workers), live jobs (job, repository, workflow, run,
  node, runner, scale set, status) and starting runners. Job, repository,
  workflow and run cells link out to github.com.
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
`externalWorkerVersion`, `nodeAliases`); non-empty values a user saves in the
settings override it.

Data older than 180 seconds is flagged stale. Kubernetes data stays the source
of truth for what exists; the endpoint only overlays detail.

## Access needed

Read (`get`, `list`, `watch`) on `nodes`, `pods`, and the four ARC resources.
The built-in `view` ClusterRole plus read access to the ARC CRDs is enough.

## Development

```bash
cd plugins/github-runners
npm ci
npm run tsc && npm run lint && npm test
npm run build       # -> dist/main.js
```

The `Dockerfile` builds the plugin and ships `/plugin` (`main.js` and
`package.json`), intended as a Headlamp initContainer that copies it into the
shared plugins volume. On a shared host bound memory, for example
`systemd-run --user --scope -p MemoryMax=4G -- npm run build`, and run one
build at a time.
