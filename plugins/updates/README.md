# updates

A [Headlamp](https://headlamp.dev/) plugin that shows which cluster components
have updates, which updates are blocked and why. It adds an **Updates** sidebar
entry. It is read-only.

## Data source

The plugin reads the `report.json` key of a ConfigMap named
`version-tracker-report`, labelled `app.kubernetes.io/name=version-tracker`. The
ConfigMap is found by label across all namespaces; the `monitoring` namespace is
preferred when several match. If the user cannot list ConfigMaps cluster-wide,
the plugin falls back to the `monitoring` namespace. Grant `get` and `list` on
ConfigMaps accordingly. The page refreshes every five minutes.

The report must have `schemaVersion: 1`. Other versions, malformed JSON and a
missing ConfigMap each produce a clear message instead of a broken page.

## What it shows

- Summary cards: updates available, blocked, security and unknown; the
  Kubernetes server version and every node version (a node newer or older than
  the server is highlighted and labelled); the report age, with a warning when it
  is more than 13 hours old.
- A table of components with category, current and latest version, status,
  blockers (reason, required version and a link to the source), what each
  component blocks, and release notes. Filter by status or category, search, and
  sort by any column heading.
- A detail view per component with every field, the blocker chain in both
  directions, and the last check error if there was one.

## URLs

- `/updates` is the list; `/updates/<componentId>` is a component's detail view.
- Filters and sorting are query parameters (`q`, `status`, `category`, `sort`,
  `dir`) written without adding history entries, so the URL alone reproduces the
  view. Opening a component keeps them, so Back returns to the same view.

## Development

```bash
npm ci && npm run tsc && npm run lint && npm test && npm run build
```
