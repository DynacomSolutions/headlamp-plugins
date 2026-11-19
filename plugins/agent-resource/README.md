# agent-resource

A [Headlamp](https://headlamp.dev/) plugin that shows the memory restrictions
on an agent host and lets you change them live. It adds an **Agent resources**
sidebar entry with one page at `/agent-resource`.

The plugin was called agent-memory before. The old route `/agent-memory`
redirects to `/agent-resource` (history replace, query kept).

The host runs agents under orchestrators (T3 Code, Herdr, ...) inside a
systemd user manager. Every orchestrator has three layers: its own control
unit (`t3code.service`, `herdr-host.service`), one slice that holds every
agent and caps them all together (`app-t3code-agents.slice`,
`herdr-panes.slice`), and one transient scope per agent session
(`t3code-<provider>-<id>.scope`, `herdr-*.scope`) with its own `memory.high`
(soft) and `memory.max` (hard) limit. The page has one section per
orchestrator with:

- its status (running, agent count, control unit up), the shared policy for
  the three layers and whether the live limits match it (drift);
- its per-agent default (editable, or read-only when the backend mounts the
  file read-only, as for Herdr);
- its control unit, agents slice and agents, and for each:

- a usage bar with the soft limit (amber line) and hard limit (red line);
- used, peak (`memory.peak`), soft, hard and swap figures, and the lifetime
  `oom_kill` count;
- the kernel's `memory.events` counts (`high`, `max`, `oom`, `oom_kill`) as events over a recent window (for example the last 10 minutes), with the cumulative total in the tooltip. Badges are coloured from the windowed count only, so a unit that has been quiet for a full window clears on its own. Soft-limit (`high`) events are shown uncoloured, and a `high-events` alert from the backend is ignored, because they are routine kernel reclaim at `memory.high`;
- the warnings the backend has sent to agents in the last 24 hours (older ones drop off), with delivery result;
- memory stall time (PSI `full` and `some`) over the same window, with the cumulative total and 10 and 60 second averages in the tooltip;
- an expandable process tree under each agent row, when the backend provides
  one: indented, with collapsible nodes, the command, PID, RSS and the RSS of
  each subtree, largest subtree first. A process whose parent exited and was
  adopted by init or the user manager carries an **Orphaned process** badge;
- active alert badges, and a summary of all active alerts at the top;
- which session it is: the row label is `provider · directory · session`
  (`claude · .cluster · 32a684cb`), with the full session id (resumed or new),
  the thread id, the agent's pid and working directory underneath, and a
  **thread** link that opens the T3 thread (T3 agents); Herdr panes are named
  `workspace / tab`;
- an **Own limit** badge on an agent whose limit was set on this page;
- an **Edit** button on each agents slice and on each agent. A change to a
  slice is always persistent (systemd writes
  `~/.config/systemd/user.control/app-t3code-agents.slice.d/50-Memory*.conf`,
  which override T3's runtime values); a change to one agent lasts until that
  agent ends;
- the **default for every agent** of the orchestrator with an **Edit
  default** button (soft, hard and swap): for T3 it rewrites the backend
  host's `t3code-.scope.d/50-agent-cap.conf` and reloads the user manager, so
  new and running agents get it (agents with their own limit keep theirs);
- the memory of the node's Kubernetes pods by QoS class (Guaranteed, Burstable,
  BestEffort), with the pod count and the program / page cache split.

The page never stops an agent.

The agents are one tree with connector lines: host, orchestrator, project (the
T3 project or Herdr workspace) and thread. Each orchestrator lists its control
unit and all-agents slice before its projects, and shows its policy, drift
and default panel directly under its row. Host, orchestrator and project rows
collapse with a chevron; project rows show the agent count and summed memory. Non-agent
scopes (for example systemd-run jobs) sit in an "Other scopes" group after the
projects; agents without a project name go in "Unknown project", listed last.
An agent row carries only the thread name (the Herdr tab), linked to the T3
thread when the backend supplies a URL; ids, session and directory are in the
tooltip. A **Raised by request** chip marks an agent whose limit was raised on
its own request after a verified approval; its tooltip gives the approval time,
label, reason and the old and new limit.

The editors validate in the browser with the same rules the backend enforces
(soft not above hard, sane minimum and maximum, a confirmation before a hard
limit is set below current usage, including running agents a lower default
would apply to). Every change is recorded by the backend, with the old and new
values and an optional reason, and the recent ones are listed under the table.
The search box matches names, provider, session, thread, directory and the
commands in the process tree.

## Backend

The plugin has no data of its own. It talks to a small backend that runs on the
agent host, reads the cgroup tree, serves JSON and Prometheus metrics, and
applies limit changes through the systemd user manager's D-Bus API (the same
call as `systemctl --user set-property`). The backend is not part of this
repository.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/state` | GET | Units, limits, usage, events, pressure, agents, the per-agent default, own agent limits, pods by QoS class, host memory, active alerts |
| `/api/changes` | GET | Recent limit changes |
| `/api/defaults` | POST | Change the default for every agent: `{memoryHigh?, memoryMax?, force?, reason?}`; same header and authorisation as `/api/limits` |
| `/api/limits` | POST | Change limits: `{unit, memoryHigh?, memoryMax?, memorySwapMax?, memoryMin?, memoryLow?, persist?, force?, reason?}`; sizes such as `8G`, `512M`, `infinity`; requires the header `X-Agent-Memory-Write: 1` |

The `/api/state` payload shape is described by the types at the top of
[`src/model.ts`](src/model.ts). A limit that is unlimited is `null`.

## How requests are authorised

The plugin never calls the backend directly. Every request goes through the
Kubernetes API server's Service proxy
(`/api/v1/namespaces/<ns>/services/<name>:<port>/proxy/...`), so the API server
authenticates and authorises it first:

- reading needs `get` on `services/proxy` for the backend Service;
- changing limits is a `POST`, which needs `create` on `services/proxy` for the
  same Service.

Grant `create` only to people who may change limits. The backend should also
refuse writes that do not come from the API server (a source address check),
because the proxy does not forward the caller's identity: the backend's audit
log can record the proxy hop and the reason text, not the user. If Headlamp runs
with a shared service account, that account is the identity RBAC sees.

## Configuration

Settings are layered: the browser's own plugin settings, then an optional
`defaults.json` placed next to `main.js` in the plugin directory, then the
built-ins.

| Key | Default | Meaning |
| --- | --- | --- |
| `backend` | `service/agent-memory/agent-resource:80` | Backend Service as `service/<namespace>/<name>:<port>` |
| `refreshSeconds` | `10` | Refresh interval, 2 to 300 |

The backend Service was called `agent-memory` before. When the Service is
named `agent-resource`, the plugin falls back to the `agent-memory` Service in
the same namespace if the new Service does not answer. When the setting names
`agent-memory`, the plugin tries `agent-resource` first. The Service that
answers is used for the next requests and for changes. This keeps the page
working before and after the backend rollout.

Settings saved under the old plugin name `agent-memory` stay in use until you
save new ones. A `defaults.json` under the old plugin directory is read when
the new directory has none.

Example `defaults.json`:

```json
{ "backend": "service/agent-memory/agent-resource:80", "refreshSeconds": 10 }
```

## Development

```bash
npm ci
npm run tsc
npm run lint
npm test
npm run build
```

## Installing a release

Download the versioned archive from a GitHub Release, verify it with the
matching `SHA256SUMS` file, and extract it into Headlamp's plugins directory:

```bash
sha256sum -c SHA256SUMS --ignore-missing
mkdir -p /path/to/headlamp/plugins
tar -xzf agent-resource-0.1.0.tar.gz -C /path/to/headlamp/plugins
```
