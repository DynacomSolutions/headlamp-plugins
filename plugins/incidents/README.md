# incidents

A [Headlamp](https://headlamp.dev/) plugin that shows the diagnoses made by the
read-only `headlamp-agent` service. It adds an **Incidents** sidebar entry. It
is read-only.

## What it shows

- `/incidents`: a table of diagnoses, newest first, with time, alert name,
  severity (critical red, warning amber, other grey), status (queued, running,
  done, failed), likely cause (or the error), confidence, source and whether the
  alert is resolved. It refreshes every 15 seconds. Click a row to open it.
- `/incidents/:id`: the full diagnosis. The report is not built in React: the
  diagnosis carries an [A2UI v1.0](https://a2ui.org/specification/v1.0-a2ui/)
  surface and the plugin renders it. The page polls every 5 seconds while the
  diagnosis is queued or running.

## Agents

When `GET /api/launches/config` answers `enabled: true`, the diagnosis page has a
**Run with an agent** section. It is hidden when launching is off.

- **Run with an agent**: a button on each suggested fix. A fix that cites the
  `dns_placement_plan` fact (or is about DNS while a plan exists) gets a
  prominent button. The dialog holds the purpose (filled in), the project
  (keys from the agent settings) and a read-only, collapsible preview of the
  brief. **Request** stores a request. It starts nothing.
- **Approval card**: **Approve and launch** starts the agent. **Reject** ends the
  request. One operator may approve their own request. The card says so. The
  card shows on the diagnosis page and on the launch page.
- `/incidents/launches`: the **Agents** list, newest first, with status pills.
  The status filter is the query string `?status=running`. A change of the filter
  replaces the history entry, so Back leaves the page.
- `/incidents/launches/<id>`: the launch. The header has a status pill (pending
  approval, launching, running, waiting, completed, failed, rejected or
  cancelled, each with a colour and an icon) and the elapsed time. Below it a
  vertical timeline shows the runs and their steps with live timers. A step is
  an expandable card (title, status, time, detail) for a command, a tool call or
  a file change. The agent's latest reply is rendered as Markdown. A box sends a
  follow-up message. A link opens the thread in T3 Code when the agent settings
  have a `threadUrlTemplate`. The page reads the launch every 1.5 seconds while
  it is launching, running or waiting, and stops when it is final.

The item identity is a path segment. Filters are query strings.

## Settings

Set them on the plugin settings page, or deploy
`/plugins/incidents/defaults.json` next to `main.js`. Blank fields fall back to
the deployment default, then the built-in default.

| Key | Default | Meaning |
| --- | --- | --- |
| `namespace` | `headlamp-agent` | Namespace of the agent Service |
| `serviceName` | `headlamp-agent` | Name of the agent Service |
| `servicePort` | `80` | Service port (number or name) |

Requests go through the Kubernetes API service proxy, for example
`/api/v1/namespaces/headlamp-agent/services/headlamp-agent:80/proxy/api/diagnoses`.

## RBAC

The signed-in user needs `get` on `services/proxy` for the agent Service. To
request, approve, reject or message an agent, the user also needs `create` on it
(the same right the chat needs):

```yaml
rules:
  - apiGroups: [""]
    resources: ["services/proxy"]
    resourceNames: ["headlamp-agent:80"]
    verbs: ["get", "create"]
```

## A2UI renderer

`src/a2ui/` is a small renderer for the A2UI v1.0 basic catalog that does not
depend on the incidents code, so other plugins can copy it.

- Messages: `createSurface`, `updateComponents` (merged by id),
  `updateDataModel` (JSON Pointer `path`, default `/`, `null` deletes) and
  `deleteSurface`. Messages with another `version` are ignored with a visible
  warning.
- Layout: an adjacency list rendered from the component `root`. `child` is one
  id; `children` is a list of ids or a template `{ path, componentId }` repeated
  per array item, where relative paths (no leading `/`) resolve against the item.
  Depth is capped at 50; missing ids show a note.
- Dynamic values: literals or `{ "@path": "/pointer" }`. The only function call
  supported is `openUrl` in a Button action.
- Components: Text (simple Markdown: headings, bold, italic, code, line breaks,
  bullets; no HTML, no images, links as plain text), Row, Column, List, Card,
  Divider, Icon, Tabs, Button (`openUrl` with http(s) URLs opens a new tab; any
  other action is disabled), Image (https only) and a grey note for unknown
  components. Nothing uses `dangerouslySetInnerHTML`.

## Development

```sh
npm ci
npm run tsc && npm run lint && npm test && npm run build
```
