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

## Development

```sh
npm ci
npm run tsc && npm run lint && npm run test && npm run build
```

`react-grid-layout` is bundled into `main.js`, and its CSS is injected by the build. Icons for the
picker and the built-in widgets are bundled (`node scripts/gen-icons.mjs` rewrites
`src/icons/bundledIcons.generated.ts`). Any other `mdi:` icon name still works where the browser can reach the
Iconify service.
