# incidents

A [Headlamp](https://headlamp.dev/) plugin that shows the diagnoses made by the
read-only `headlamp-agent` service. It adds an **Incidents** sidebar entry. It
is read-only.

## What it shows

- `/incidents`: a table of diagnoses, newest first, with time, alert name,
  severity (critical red, warning amber, any other severity grey), status (queued, running,
  done, failed), likely cause (or the error), confidence, source and whether the
  alert is resolved. It refreshes every 15 seconds and lists every diagnosis (it reads all pages).
  Click a row to open it. The filters (status, severity, search, open only) and the selection are
  query strings (`?status=failed&severity=critical&q=disk&resolved=1&sel=<id>,<id>`). A change replaces the
  history entry, so Back leaves the page and the URL alone shows the same view.
  The table scrolls inside the page. Its header, the filters and the selection bar stay fixed.
  A failed row has a "Run again" button. It calls
  `POST /api/diagnoses/<id>/rerun` on the agent, stays disabled while the request runs
  and shows an error under the button. The same button is in the `incidents.list`
  dashboard widget and on the incident page of a failed diagnosis.
- **Chat about several incidents**: each row has a checkbox, and the header checkbox selects every
  shown row. Space toggles the focused row, Shift+click and Shift+Space select a range, and Escape
  clears the selection. The bar shows "N selected" with **Clear** and **Select all shown**. **Chat
  about N incidents** makes ONE chat thread: the agent gets the alert, summary, likely cause, fixes
  and evidence of every selected incident. A chat holds at most 20 incidents. The thread opens at
  `/incidents/chat/<id>` (pushed to history). It shows under each linked incident on the incident
  page ("Chats about this incident") and in the chat list with its number of incidents. A chat about
  one incident works as before.
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
- **Approval card**: it shows the exact stored brief, open by default in a scrollable
  block, with the line "This is the exact brief the agent gets." **Approve and
  launch** (off until the brief has loaded) starts the agent. **Reject** ends the
  request. One operator may approve their own request. The card says so. The
  card shows on the diagnosis page and on the launch page. A request that nobody
  decides expires after 24 hours. The page then shows **Expired**.
- The dialog sends the fix as its index in the diagnosis. The server builds the
  brief. The plugin cannot send its own brief text.
- `/incidents/launches`: the **Agents** list, newest first, with status pills.
  The status filter is the query string `?status=running`. A change of the filter
  replaces the history entry, so Back leaves the page.
- `/incidents/launches/<id>`: the launch. The header has a status pill (pending
  approval, launching, running, waiting, completed, failed, rejected or
  cancelled, each with a colour and an icon) and the elapsed time. Below it a
  vertical timeline shows the runs and their steps with live timers. A step is
  an expandable card (title, status, time, detail) for a command, a tool call or
  a file change. When the agent service cannot read T3, the pill shows **Tracking lost,
  retrying** and the page keeps polling. The agent's latest reply is rendered as Markdown. A box sends a
  follow-up message. A link opens the thread in T3 Code when the agent settings
  have a `threadUrlTemplate`. The page reads the launch every 1.5 seconds while
  it is launching, running or waiting, and stops when it is final.

The item identity is a path segment. Filters are query strings.

## Dashboard widgets

The plugin adds two widgets to the [Dashboards](../dashboards/README.md) plugin, through its
cross-plugin contract (`src/dashboardsContract.ts` is a copy of `plugins/dashboards/src/contract.ts`).
Both fetch when the dashboard refresh signal changes, call `reportRefreshed`, and never refetch on a
layout change. The Incidents pages are unchanged.

| Type | Config | What it shows |
| --- | --- | --- |
| `incidents.list` | `{ status: 'all' \| 'queued' \| 'running' \| 'done' \| 'failed', severity: 'all' \| 'critical' \| 'warning' \| 'other', openOnly: boolean }` | A summary (counts by severity and status) that stays at the top. The list below it scrolls on its own, so the last card can always be reached. |
| `incidents.chat` | `{}` | The incident agent chat, with the same model picker and backend as the chat page. The message list scrolls and the input stays at the bottom. |

- The list widget reads every diagnosis page by page (`limit` and `offset`, with the `total` that the agent
  reports), so the summary counts the real total and never the first page only.
- The summary counts the rows that the filters leave. The summary shows each severity that is not
  `critical` or `warning` by its own name (for example `info`, or `unrated` for none), never as one
  "other" count. The `other` filter value (shown as "Info, none and unrated") matches all of them. `openOnly` (on by default) hides the diagnoses whose alert is resolved, so the counts match the alert chips. The Incidents page has a "Show resolved" box (`?resolved=1`). A link with `?open=1` shows the default view.
- When a dashboard has both widgets, a click on a list row selects that incident for the chat
  (the alert name link still opens the incident page). A second click on the same row clears it.
  The chat then talks about that incident (`diagnosisId`). Each incident keeps its own chat while the
  dashboard stays open. Without a selection, the chat is a general chat about the cluster and the
  open incidents, with a hint above it.
- Without a chat widget on the dashboard, a row click opens the incident page.
- Both widgets come from this one bundle, so they share a small in-memory store
  (`src/selection.ts`). The selection is not saved.

## Notifications

The sidebar entry **Notifications** (`/incidents/notifications`) turns push notifications on for
this device. It is a subscription of its own, with its own service worker (`sw.js`, served at
`/plugins/incidents/sw.js`) and its own key from the agent. It does not change the Alerting plugin.

- **Diagnosis ready** sends the alert name, its severity and the likely cause. A tap opens the
  incident. A filter limits it to Critical, Warning and Other (default: Critical and Warning).
- **Chat answers** sends the start of the answer when you asked a question and then left the page.
  Nothing is sent while the chat is visible (Page Visibility).
- Each switch saves at once. **Disable on this device** deletes the subscription.
- On iPhone and iPad, notifications work only from an app added to the Home Screen. The page says so.
- A notification opens a path on this site, so it never leaves the site.

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
