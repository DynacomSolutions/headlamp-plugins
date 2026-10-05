# agent-memory

A [Headlamp](https://headlamp.dev/) plugin that shows the memory restrictions
on an agent host and lets you change them live. It adds an **Agent memory**
sidebar entry with one page.

The host runs agent panes under a systemd user manager: one slice holds every
pane, a second slice holds the protected control plane, and each pane is a
transient scope with its own `memory.high` (soft) and `memory.max` (hard) limit.
The page lists those slices and scopes and, for each:

- a usage bar with the soft limit (amber line) and hard limit (red line);
- used, soft, hard and swap figures;
- the kernel's `memory.events` counts (`high`, `max`, `oom`, `oom_kill`) as events over a recent window (for example the last 10 minutes), with the cumulative total in the tooltip. Badges are coloured from the windowed count only, so a unit that has been quiet for a full window clears on its own;
- memory stall time (PSI `full` and `some`) over the same window, with the cumulative total and 10 and 60 second averages in the tooltip;
- an expandable process tree under each pane or agent row, when the backend
  provides one: indented, with collapsible nodes, the command, PID, RSS and the
  RSS of each subtree, largest subtree first. A process whose parent exited and
  was adopted by init or the user manager carries an **Orphaned process** badge;
- active alert badges, and a summary of all active alerts at the top;
- the Herdr chat name as the row label (`workspace / chat title`), with the tab,
  agent and scope name underneath, when the backend can resolve it;
- an **Orphaned** badge on a pane scope whose Herdr pane no longer exists, an
  **Orphans only** filter, and orphans sorted to the top;
- an **Edit** button that opens an editor for the limits;
- a **Close** button on pane scopes that stops the scope (SIGTERM, then SIGKILL)
  after a confirmation: an orphan needs one confirmation, a live pane shows a
  stronger warning that the agent session will be terminated. A reason is
  required and is recorded in the audit log.

The editor validates in the browser with the same rules the backend enforces
(soft not above hard, sane minimum and maximum, a confirmation before a hard
limit is set below current usage, `MemoryMin` and `MemoryLow` on slices only).
It can persist a change on a slice instead of applying it to the running unit
only. Every change is recorded by the backend, with the old and new values and
an optional reason, and the recent ones (including closed scopes and the
processes stopped) are listed under the table. The search box matches names,
workspace, tab, agent, the scope name and the commands in its process tree.

## Backend

The plugin has no data of its own. It talks to a small backend that runs on the
agent host, reads the cgroup tree, serves JSON and Prometheus metrics, and
applies limit changes through the systemd user manager's D-Bus API (the same
call as `systemctl --user set-property`). The backend is not part of this
repository.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/state` | GET | Units, limits, usage, events, pressure, host memory, active alerts |
| `/api/changes` | GET | Recent limit changes |
| `/api/units/stop` | POST | Close a pane scope: `{unit, reason, force?}` (`force` is needed for a live pane); same header and authorisation as `/api/limits` |
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
| `backend` | `service/agent-memory/agent-memory:80` | Backend Service as `service/<namespace>/<name>:<port>` |
| `refreshSeconds` | `10` | Refresh interval, 2 to 300 |

Example `defaults.json`:

```json
{ "backend": "service/agent-memory/agent-memory:80", "refreshSeconds": 10 }
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
tar -xzf agent-memory-0.1.0.tar.gz -C /path/to/headlamp/plugins
```
