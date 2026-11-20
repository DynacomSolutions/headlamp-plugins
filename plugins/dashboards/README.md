# dashboards

A [Headlamp](https://headlamp.dev/) plugin built with the official
`@kinvolk/headlamp-plugin` tooling (TypeScript + React). It adds a **Dashboards**
entry to the sidebar: build, save and view dashboards of widgets, in the spirit of
the Salesforce Lightning App Builder and Salesforce reports. Other plugins supply
widgets (tables, charts, status cards). The plugin ships a clock, a Markdown note
and a header or divider.

## What it does

- **List** (`/dashboards`): create, open, rename, duplicate and delete dashboards.
- **Dashboard** (`/dashboards/<name>` or `/dashboards/<name>/<tab>`): view mode and edit mode.
- **Layout builder**: drag, drop and resize widgets on a 12 column grid
  ([react-grid-layout](https://github.com/react-grid-layout/react-grid-layout)),
  with responsive breakpoints. A palette drawer lists the registered widgets. Each
  widget has a settings dialog, a duplicate action and a delete action. Layout changes
  rerender only the widget that moved and never refetch data.
- **Sections**: a tab holds sections, and each section has its own grid. A section is
  *normal*, *sticky* at the top or bottom of the scrolling page, or *self-scroll* (a fixed
  height with its own scrollbar, so the page does not scroll). A widget also has a
  "Self-scroll content" option. Move a widget to another section by dropping it there or
  with its menu. Reorder sections with the arrows in the section header.
- **Tabs**: several tabs per dashboard, each with a label and a Material Design icon
  (searchable picker). The tab bar sits at the top or on the left, per dashboard.
- **Kiosk**: the Full screen button shows only the dashboard over the whole screen on a
  black background, asks the browser for full screen and has an Exit control and a clock.
  The styles are quiet and touch friendly. The code is a copy of the Usage plugin kiosk.
- **Refresh**: a Refresh button, an automatic interval per dashboard (off, 10 s, 30 s, 1 min,
  5 min, 15 min) and a "Refreshed 12 s ago" text that updates on its own. Its tooltip gives the
  exact time. Widgets get a shared refresh signal and report their own fetch time.
- **Filters and views**: a filter bar (namespaces, nodes, label selector, time range) whose
  values reach every widget. Saved views are named sets of filter values stored in the
  dashboard and chosen from a menu.

## URLs

The URL alone reproduces the view. The dashboard and the tab are path segments (a tab change is
a history push). View options are query parameters, written with history replace and left out
when they have their default value.

| Parameter | Meaning |
| --- | --- |
| `edit=1` | Edit mode (needs write access) |
| `kiosk=1` | Kiosk (full screen) |
| `view=<id>` | A saved view of filter values |
| `ns=a,b` | Namespaces (percent-encoded items) |
| `node=a,b` | Nodes |
| `sel=<selector>` | Label selector, for example `app=web` |
| `range=<r>` | `5m`, `15m`, `1h`, `6h`, `24h`, `7d` or `30d` |
| `refresh=<s>` | Automatic refresh in seconds (0, 10, 30, 60, 300 or 900), over the saved value |

A filter key in the URL overrides the saved view, even with an empty value.

## Storage

One ConfigMap per dashboard, in the namespace set in the plugin settings (default
`headlamp-dashboards`). The namespace must exist.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ops-overview          # made from the first title, never changed (URLs use it)
  namespace: headlamp-dashboards
  labels:
    headlamp.dev/dashboard: "true"
data:
  dashboard.json: '{"version":1,"title":"Ops overview", ...}'
```

- The JSON has a `version` field. `migrateSpec` (`src/spec/model.ts`) upgrades older versions
  step by step and fills defaults. A spec from a newer plugin version is shown as an error and is
  never overwritten.
- A save sends the ConfigMap `resourceVersion`. If someone else saved first, the API server
  answers HTTP 409 and the page shows a conflict message with two choices: reload (discard
  your changes) or overwrite with your changes. It never overwrites silently.
- Needed RBAC in the namespace: `get` and `list` on `configmaps` to view, plus `create`,
  `update` and `delete` to change. The plugin asks the API server (SelfSubjectAccessReview).
  Without write access the UI is read-only and says so.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: dashboards-editor
  namespace: headlamp-dashboards
rules:
  - apiGroups: [""]
    resources: [configmaps]
    verbs: [get, list, create, update, delete]
```

## Widget contract (for plugin authors)

Headlamp plugins are separate bundles, so a plugin that supplies widgets cannot import from this
one. The contract is one self-contained file, [`src/contract.ts`](src/contract.ts). **Copy it into
your plugin** (for example as `src/dashboardsContract.ts`) and call `registerDashboardWidget`.
It needs only React types and `window`.

The registry is `window.headlampDashboards`. A plugin may load before the Dashboards plugin: then
`registerDashboardWidget` leaves a stub with a queue on `window.headlampDashboards`, and the
Dashboards plugin takes over the stub and registers every queued widget when it loads. Registering a
type twice replaces the first definition (the last one wins). A bad definition is logged and
ignored, and never breaks the dashboards.

```tsx
import { registerDashboardWidget, WidgetProps } from './dashboardsContract';

interface Config {
  limit: number;
}

function TopNamespaces({ config, filters, refreshSignal, reportRefreshed }: WidgetProps<Config>) {
  const [rows, setRows] = React.useState<Row[]>([]);
  React.useEffect(() => {
    let live = true;
    fetchRows(filters.namespaces, filters.range, config.limit).then(r => {
      if (!live) return;
      setRows(r);
      reportRefreshed(); // the header shows "Refreshed 3 s ago"
    });
    return () => {
      live = false;
    };
    // Fetch again when a filter, a setting or the refresh signal changes.
  }, [filters, config.limit, refreshSignal, reportRefreshed]);
  return <Table rows={rows} />;
}

registerDashboardWidget<Config>({
  type: 'myplugin.top-namespaces', // unique, lower case, never renamed after release
  title: 'Top namespaces',
  description: 'The namespaces that use the most CPU.',
  icon: 'mdi:table',
  category: 'Tables',
  defaultSize: { w: 6, h: 8 },     // grid units: 12 columns, rows of 30 px
  minSize: { w: 3, h: 4 },
  defaultConfig: { limit: 10 },
  configSchema: [{ key: 'limit', label: 'Rows', type: 'number', min: 1, max: 50 }],
  selfScroll: true,
  Component: TopNamespaces,
});
```

The pieces of the contract (see the comments in `src/contract.ts`):

| Name | Purpose |
| --- | --- |
| `WidgetDefinition<C>` | `type`, `title`, `description`, `icon` (Iconify), `category`, `defaultSize`, `minSize`, `maxSize`, `defaultConfig`, `configSchema` or `SettingsComponent`, `Component`, `selfScroll`, `card` |
| `WidgetProps<C>` | `instanceId`, `config`, `filters`, `refreshSignal`, `reportRefreshed(at?)`, `editing`, `kiosk` |
| `WidgetSettingsProps<C>` | `config` and `onChange(config)` for a custom settings form |
| `ConfigField` | one field of a generated settings form: `text`, `multiline`, `number`, `boolean` or `select` |
| `DashboardFilters` | `namespaces`, `nodes`, `labelSelector`, `range` |
| `registerDashboardWidget(def)` | register, in any plugin load order |

Rules for a widget:

- Saved settings are merged over `defaultConfig`, so a new key always has a default. Do not rename keys.
- Fetch when `filters`, your `config` or `refreshSignal` changes, and nothing else. A layout change
  (moving or resizing) never changes these props. The frame is memoised, so the widget is not
  rerendered by another widget's drag.
- Call `reportRefreshed()` after each fetch. It is stable, so it is safe in an effect dependency list.
- Fill the card: use `height: 100%`. Set `selfScroll: true` for lists and tables. The user can
  override it per widget.
- Do not rely on hover (the kiosk is a touch screen). When `kiosk` is true, avoid scrollbars and
  focus rings. When `editing` is true, disable links that leave the page.
- A widget that throws shows an error in its own card and leaves the rest alone.
- A dashboard that uses a type nobody registered shows a placeholder card ("The plugin that supplies
  this widget is not installed") and keeps its settings.

### Built-in widgets

| Type | Settings |
| --- | --- |
| `core.clock` | Hours, minutes and seconds on or off, 12 or 24 hour, date on or off, a date format (preset or custom), time zone, size, zone name |
| `core.note` | Markdown text (no raw HTML, no images, only web, mail and path links), alignment |
| `core.header` | Header text, subtitle, header or line or both, size, alignment |

The date format uses these letters: `yyyy`, `yy` (year), `MMMM`, `MMM`, `MM`, `M` (month),
`EEEE`, `EEE` (weekday), `dd`, `d` (day), `HH`, `H`, `hh`, `h` (hour), `mm`, `ss`, `a` (AM or PM).
Quote literal text in single quotes, for example `'Week' d`. Examples: `EEE d MMM yyyy`,
`yyyy-MM-dd`, `d/M/yyyy`.

## Settings

| Setting | Meaning |
| --- | --- |
| Namespace | The namespace that holds the dashboard ConfigMaps. Blank uses `headlamp-dashboards`. |
| Panel sources | The places the panel widgets read panels from. See [Panel sources](#panel-sources). |

## Development

```sh
npm ci
npm run tsc && npm run lint && npm run test && npm run build
```

`react-grid-layout` is bundled into `main.js`, and its CSS is injected by the build. Icons for the
picker and the built-in widgets are bundled (`node scripts/gen-icons.mjs` rewrites
`src/icons/bundledIcons.generated.ts`). Any other `mdi:` icon name still works where the browser can reach the
Iconify service.

## Panel sources

The panel widgets read panels from a **source**. The agent layer is the built-in source. Any app that serves the
same panel API can be another source, and there can be any number of sources.

### The panel API (version 1)

A source serves two read-only JSON paths:

- `GET /api/widgets` gives `{ "version": 1, "panels": [{ id, title, description, plugin, link, refreshSeconds }] }`.
- `GET /api/widgets/<id>` gives one panel: `{ "version": 1, id, title, generatedAt, link, status, summary, stats, rows, series?, rings?, tables? }`.
  The agent README describes the fields (`agent/README.md`, "Widget panels").

The plugin checks the shape. A response with no `version`, with another version or with the wrong shape gives an
error card, not a broken widget. Unknown extra fields are ignored.

### Sources (settings)

The Dashboards settings page has a **Panel sources** section. Each source has an id (lower case letters, digits,
dashes and underscores), a title, an optional `mdi:` icon and a kind:

| Kind | Fields | How it is reached |
| --- | --- | --- |
| `service` | namespace, service, port, path prefix (default empty) | The Kubernetes API service proxy: `/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy<prefix>/api/widgets`. Kubernetes RBAC is the guard. |
| `url` | base URL | The browser calls the URL directly with `fetch` and `credentials: 'include'`, so the cookie login of the app works. The app must allow the Headlamp origin with credentials (CORS). No token is stored in the settings. |

- **The agent** is always the first source, with the id `agent`. It uses the three agent fields of earlier versions
  (`agentNamespace`, `agentService`, `agentPort`), kept under the same keys, so an old setting works with no change.
  Blank fields use `headlamp-agent`, `headlamp-agent` and `80`.
- **Cluster sources** are shared by every browser. See [Cluster sources](#cluster-sources).
- **Browser sources** are stored as a list under `panelSources`. An entry with an invalid or repeated id is ignored.
- **Order and clashes**: the effective list is the agent, then the cluster sources, then the browser sources. When a
  browser source has the id of a cluster source, the browser source wins, in that browser only. The settings page shows
  which cluster sources are overridden.
- **Test**: each source has a Test button. It calls `/api/widgets` and shows the panel count or the error.
- **Errors**: a wrong shape, a CORS or network failure, 401, 403 and 404 each give a clear message on the widget
  and on the Test button.

### Cluster sources

A source of this kind is saved in the cluster, so a shared dashboard works in every new browser with no setup. The
sources live in one ConfigMap in the dashboards namespace (the same namespace setting as the dashboards):

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dashboard-sources
  namespace: headlamp-dashboards
  labels:
    headlamp.dev/dashboard-sources: 'true'
data:
  sources.json: |
    {
      "version": 1,
      "sources": [
        { "id": "my-app", "title": "My app", "icon": "mdi:database", "kind": "service",
          "namespace": "apps", "service": "my-app", "port": "80" }
      ]
    }
```

- **Shape**: each entry has the same fields as a browser source (`id`, `title`, `icon`, `kind`, and `namespace`,
  `service`, `port`, `pathPrefix` or `baseUrl`).
- **The content is untrusted**: it is checked before use. An entry is ignored (the settings page says why) when the id
  is not valid or repeated, the id is `agent`, the namespace or service is not a Kubernetes name, the port is not 1 to
  65535 or a port name, the path prefix has a `.` or `..` segment or a character that is not URL safe, or a `url`
  source does not use http or https or holds a user name or password. The file may have 50 sources and 64 KiB at most.
  A file that is not valid JSON or has another `version` gives no sources and an error on the settings page.
- **Caching**: the ConfigMap is read once and shared by all widgets and the palette. It is read again with the
  dashboards list (open or reload the list), when the page asks after 5 minutes (a dashboard that stays open), and
  with the Reload button on the settings page. A failed read keeps the last good sources.
- **Palette**: each cluster source has "Panel from <title>" and "Sunburst from <title>" like a browser source.
  A widget saves the base type with `config.source`.
- **Settings page**: cluster sources show as read-only rows with a **Cluster** badge and a Test button. A user with
  create and update on ConfigMaps in the namespace can use **Edit cluster sources**. It saves the ConfigMap with its
  resourceVersion and keeps other labels, annotations and data keys. A change by someone else gives a conflict message
  and the edits stay in the dialog. Without write access the page shows a read-only message.
- **Access**: reading needs `list` on ConfigMaps in the dashboards namespace (the same as the dashboards). A user who
  cannot read the ConfigMap sees an error on the settings page and gets "source not configured" on widgets that use a
  cluster source.
- **GitOps**: when Argo CD or another tool owns the ConfigMap, it reverts edits made on the settings page. Change
  the source in Git then.

### Panel widget (`agent.panel`)

Shows one panel of a source. The widget settings pick a **source**, then a **panel** of that source. The config is
`{ source, panel }`. A saved widget with no `source` uses `agent`, so saved dashboards keep working.

- **Palette**: besides the base entry, the palette has "Panel from <source title>" and "Sunburst from <source title>"
  for each extra source. They are widget types `agent.panel.<source id>` and `agent.sunburst.<source id>` that
  pre-select the source. A saved widget keeps its own `source`. A removed source leaves its entry until the page
  reloads. This includes the cluster sources.
- **What it draws**: the status and summary, the stats as tiles, the rows as a table (a fraction bar and a link
  when the row has them), the series as sparklines, the rings as sunbursts and the tables. A status is a shape and a
  word, never colour alone. A link must be a web or path link: other schemes are dropped. Links are off in edit mode.
- **Refresh**: the widget fetches when the dashboard refresh signal changes, and reports the time with
  `reportRefreshed`. The `refreshSeconds` of the panel is the minimum time between two fetches. The last good data
  stays on screen when a refresh fails, with a warning.
- **Shared requests**: requests are shared per source. Ten widgets on one source cause one list call (kept for one
  minute). A panel request is shared while it runs and is reused for the `refreshSeconds` of the panel. A failed
  request is not kept.
- **States**: a spinner while the first load runs, an error card with a short reason, a hint when no panel is
  chosen (a spinner while the cluster sources load), an error card when the source is not configured and a hint when the panel has nothing to show.

### Optional `tables` field (v1 extension)

A panel may add `tables`. A source that does not send it is still valid version 1.

```json
"tables": [
  {
    "title": "Hosts",
    "columns": [
      { "key": "name", "label": "Name" },
      { "key": "load", "label": "Load", "align": "right" }
    ],
    "rows": [{ "name": "worker-1", "load": 0.42 }, { "name": "worker-2", "load": 1.8 }]
  }
]
```

- `columns[].align` is `left` (default) or `right`. A column with no `key` is dropped.
- A row is an object. Each cell is a string or a number, read by the column `key`. Other values show as empty.
- The widget draws each table with a heading that sorts on click (numbers as numbers, text in natural order, a
  second click reverses it). The heading has `aria-sort`. A panel with only tables is not empty.

### Agent sunburst (`agent.sunburst`)

Draws one ring (`cpu` or `memory`, or the first ring) of a panel that has rings, from any source, by default
`usage-dashboard` on the agent. It has the same source and panel settings as the panel widget.

### The sunburst component

`src/widgets/sunburst/SunburstChart.tsx` is a reusable two-level sunburst: the inner ring has one arc per
category and the outer ring has one arc per child. The full circle is the capacity and the filled part is the
used part, so the unused part stays empty. The geometry (`geometry.ts`) is like the Usage plugin rings, with a
larger centre hole (36 % of the radius), and the centre text shrinks to fit the hole. The colours are the Usage
palette (Okabe-Ito, with lighter hues for dark mode and the kiosk). Rules:

- Every group is its own arc at its real size. There is no "Other" arc and no top-N cut.
- A mouse hover shows the label and the value in the centre. A tap selects an arc, and a second tap clears it.
  In kiosk mode hover is off and a tap selects, because the kiosk is a touch screen.
- The legend lists every category, and the SVG has a text summary, so colour is never the only encoding.
- The Usage plugin has its own copy (separate bundles cannot share code).

### Kiosk

The widgets use theme colours only, so they follow the black kiosk background. The kiosk has no scrollbars,
no focus rings and no hover. The legend and the donut do not scroll in the kiosk.

## Kubernetes reports

The **Kubernetes report** widget (`core.k8s-report`, category Kubernetes) is a Salesforce style report
over any resource kind. Its settings editor has five steps (Source, Columns, Filters, Grouping, Chart)
and a live preview that uses the real cluster data.

- **Source**: any listable kind. The editor asks API discovery for the kinds. Built-in kinds come first
  (Pods, Deployments and so on), then custom resources (CRDs). The dashboard filters narrow the report:
  namespaces, the label selector (sent to the API server) and nodes (Pods and Nodes).
- **Columns**: pick, reorder and rename columns. A column is a common field (`name`, `namespace`, `age`,
  `status`, `labels`, `owner`, `node`, `restarts`, `ready`) or a field path such as `.spec.replicas`,
  `.metadata.labels.app`, `.metadata.labels["app.kubernetes.io/name"]`, `.spec.containers[0].image` or
  `.spec.containers[*].image`. The editor suggests paths found in the loaded objects. Quantities such as
  `250m` and `1Gi` count as numbers.
- **Filters**: field, operator (equals, not equals, contains, starts with, exists, greater than, less than,
  in), value. All filters apply with AND. An optional logic string such as `1 AND (2 OR 3)` (also `NOT`)
  replaces that. A wrong logic string shows a message and falls back to AND. For `exists`, the value
  `false` means "does not exist". Text tests ignore case.
- **Report types**:
  - *Tabular*: the columns, sortable.
  - *Summary*: group by up to two fields, with row counts and sum, avg, min or max of numeric fields.
    Groups collapse. Each group has a subtotal and the report has a grand total. The rows can show inside
    the groups.
  - *Matrix*: rows by one field, columns by another, with a row count or an aggregate in each cell, and
    row, column and grand totals.
- **Chart** (summary only): bar, horizontal bar, donut or stacked bar (two group fields). Every group is its
  own bar or slice at its real size. There is no "Other" group and no top-N cut. After eight groups the
  chart reuses the eight series hues at lower opacity, and the tooltips and the legend name every group.
- **Table**: sort by any column header, a link to the Headlamp page of each resource (turned off in edit
  mode), a sticky header, windowed rows (only the visible rows are in the DOM) and a CSV export (hidden in
  the kiosk). The CSV neutralises cells that start with `=`, `+`, `-` or `@`.
- **Live data**: one Headlamp list and watch stream per chosen namespace (or one for the cluster).
  Updates are coalesced. The streams restart only when the kind, the namespaces, the label selector or the
  refresh signal changes, so moving a widget never refetches. The grouping is a memoised pure model in
  `src/widgets/k8s/model.ts`.
- **Kiosk**: the widget uses the black background, larger rows and no scrollbars.

Users need `list` (and `watch`) access to the chosen kind. A refused list shows a message in the widget.

## PromQL widgets

Five widgets in the **Monitoring** group query a Prometheus-compatible service (VictoriaMetrics,
Prometheus). They use the plain HTTP API (`/api/v1/query` and `/api/v1/query_range`) through the
Kubernetes API service proxy, as the other plugins do. The signed in user needs the `get` verb on
`services/proxy` for that Service.

Set where the service is in the plugin settings (blank fields use the defaults): namespace
(`monitoring`), service (`victoria-metrics`), port (`8428`) and an optional path prefix such as
`/prometheus`.

| Type | What it shows |
| --- | --- |
| `promql.timeseries` | Line, area, stacked area or bars from a range query. Several queries per chart. |
| `promql.stat` | One value, an optional sparkline and thresholds. |
| `promql.gauge` | One value against a scale, with thresholds. |
| `promql.table` | One row per series of an instant query. Pick the label columns. Sortable. |
| `promql.breakdown` | A pie (donut) or bars from an instant query, grouped by a label. |

**Template variables.** They follow the filter bar, so one query serves every filter. An unknown
`$name` stays as typed. Use double quotes around them.

| Variable | Value |
| --- | --- |
| `$namespace` | The chosen namespaces as a regex, for `namespace=~"$namespace"`. None chosen gives `.*`. |
| `$node` | The same for nodes. Dots and other regex characters are escaped. |
| `$range` | The time range as a PromQL duration, for example `[$range]`. |
| `$step` | The query step, for example `30s`. |
| `$rate` | A window for `rate()`: four steps, at least one minute. |
| `$selector` | The label selector as PromQL matchers, for `up{$selector}`. |

**Several queries.** In the time series chart and the table, put a line with only `---` between
queries. A first line `# {{pod}}` names the series from labels (chart). In the table, a first line
such as `# Memory | bytes` names the value column and sets its unit. The `#` line is a PromQL comment
and is removed before the query runs.

**Units.** Plain (1.5k, 2.5M), bytes (KiB, MiB, GiB), CPU cores, percent (0 to 100), ratio (0 to 1,
shown as percent) and seconds (ms, s, min, h, d).

**Thresholds.** `70:warning, 90:critical` gives the status from a value up. Below the first step the
status is good. The statuses are good, warning, serious and critical. "A lower value is worse" reads
the steps as "or less". A status always shows an icon and a word, so colour is never the only cue.

**Performance and behaviour.**

- The step comes from the chart width and the range, so a series has at most 300 points. The width is
  read when a fetch starts. Moving or resizing a widget never fetches again. A filter change, a query
  change or a refresh does.
- The request in flight is aborted when a new one starts and when the widget unmounts. The previous
  picture stays on screen, dimmed, while new data loads.
- The chart has a legend (click an entry to hide a series), a crosshair that snaps to the nearest time
  (pointer, touch or the arrow keys) and one tooltip with every series at that time. "Show table" lists
  the last, minimum, average and maximum of each series.
- In the breakdown every group is its own slice or bar at its real size. There is no "Other" group and no
  top-N. After eight groups the colours are generated, and the list names every group with its value and
  share.
- The kiosk (black background) uses light ink, no scrollbars and no focus rings.

Each widget settings dialog has a multiline query editor and a **Run** button. The preview is an
instant query with no filters, so it shows every namespace and node.
