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
  _normal_, _sticky_ at the top or bottom of the scrolling page, or _self-scroll_ (a fixed
  height with its own scrollbar, so the page does not scroll). A widget also has a
  "Self-scroll content" option. Move a widget to another section by dropping it there or
  with its menu. Reorder sections with the arrows in the section header.
- **Tabs**: several tabs per dashboard, each with a label and a Material Design icon
  (searchable picker). The tab bar sits at the top or on the left, per dashboard. On the left it is
  a compact rail by default (see [Header, footer and tab rail](#header-footer-and-tab-rail)).
- **Header and footer**: a dashboard level header above, and footer below, the tab content. They show
  with every tab (see [Header, footer and tab rail](#header-footer-and-tab-rail)).
- **Kiosk**: the Full screen button shows only the dashboard over the whole screen on a
  black background, asks the browser for full screen and has the title and the alert chips on the left, the
  clock in the exact middle, and the refresh and Exit icons on the right, in one row. It has no clock of its
  own: put a clock widget in the header.
  The styles are quiet and touch friendly. The code is adapted from the Usage plugin kiosk.
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

| Parameter        | Meaning                                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| `edit=1`         | Edit mode (needs write access)                                                 |
| `kiosk=1`        | Kiosk (full screen)                                                            |
| `view=<id>`      | A saved view of filter values                                                  |
| `ns=a,b`         | Namespaces (percent-encoded items)                                             |
| `node=a,b`       | Nodes                                                                          |
| `sel=<selector>` | Label selector, for example `app=web`                                          |
| `range=<r>`      | `5m`, `15m`, `1h`, `6h`, `24h`, `7d` or `30d`                                  |
| `refresh=<s>`    | Automatic refresh in seconds (0, 10, 30, 60, 300 or 900), over the saved value |

A filter key in the URL overrides the saved view, even with an empty value.

### Links and swipes stay inside Headlamp

The app can run as an installed web app with no browser bar, so no widget link leaves Headlamp.

- A widget link goes to a Headlamp route: a dashboard, a dashboard tab or a Headlamp page. It is a history push, so Back
  returns to the dashboard. `{cluster}` in a path becomes the current cluster. A path to a Headlamp page that is also a
  tab of the dashboard (for example `/c/{cluster}/uptime` on an uptime row) opens that tab.
- A panel row with an `http` or `https` link goes to the tab of the dashboard whose id is the panel id, else the source id
  (for example `ais-console`, `hoarddb`, `uptime`). With no such tab the row has no link. A note shows an address on
  another host as text.
- A swipe right that starts in the left edge (24 px) goes Back, on every Headlamp page, with a hint that follows the
  finger. A swipe left or right on the tab area of a dashboard shows the next or the previous tab (one history entry each).
  A swipe is ignored on a text field, in a sideways scroll area (a wide table), with a text selection, with two fingers
  and in edit mode. Mark an element `data-no-swipe` to keep a swipe for it. Alt+Left still works on a desktop.
- The tab area takes vertical pans only (`touch-action: pan-y`, `overscroll-behavior-x: none`), so a sideways drag does
  not pan the whole page on a phone. A wide table keeps its own sideways scroll.
- The title bar wraps: controls that do not fit in one row move to the next row, and the title ends with an ellipsis. No
  control is drawn over another one, from 360 px to 2560 px.

## Last good data

Every widget keeps its last good data in the browser (localStorage, a size cap of 3 million characters,
600 000 for one widget). A reload, a self reload into a new plugin version and a first load draw the
dashboard and every widget from it at once, with no spinner, and fetch in the background. The header
shows the age of that data ("Refreshed 2 min ago") until the first fresh answer. Data older than 15
minutes shows a small "Cached" mark. The dashboard spec, the cluster sources and the kiosk scroll
position are kept the same way.

A widget from another plugin reads and writes its data with the optional `cache` prop of
`WidgetProps` (see `contract.ts`). It must work when `cache` is missing.

## Header, footer and tab rail

### Header and footer

Each dashboard has a **header** and a **footer**. Each is one section with its own 12 column grid. It is
edited like any section: drag and resize widgets, add them from the palette (choose "Header (every tab)" or
"Footer (every tab)" as the target section), open the widget settings, duplicate, delete or move a widget to
another section from its menu. The footer sits below the tab content. The header widgets draw inline in the
title bar in three parts. A wide bar (1000 px and more) has three equal parts, so the clock is in the exact
middle. On the left are the title and the header widgets before the clock (the alert chips), and the Filters button, the
time range and Views in a second row (the filter fields stay behind the Filters button). On the right are the header widgets after the clock, the auto refresh select, the small
"Refreshed 12 s ago" text, the Refresh icon and the Full screen icon (Exit full screen in the kiosk) at the far
right. The Refresh and Full screen controls are plain icons with the colour of the tab rail icons. Their words are
the tooltip and the label. The "Refreshed" text goes only when the bar is narrow (under 1060 px). A narrower bar
flows the same controls in one row that wraps, and the clock follows the left part. A header with no clock draws
all its widgets on the left. The widgets draw without a card or a card title, and a widget gets
`compact: true` in its props (the clock then shows the time over the date, at the height of the row). Header and
footer stay when the tab changes (a clock keeps ticking, and nothing is fetched again). In edit mode the header
shows as an editable strip under the toolbar, so you can still add, move, configure and remove its widgets.

| Option  | Values                              | Meaning                                                                                                                                  |
| ------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Sticky  | on or off (default off)             | The title bar with the header widgets stays at the top and the footer at the bottom of the scrolling view. Sticky is off while you edit. |
| Show in | `both` (default), `normal`, `kiosk` | Where the band draws: in the normal view and the kiosk, in the normal view only, or in the kiosk only.                                   |

A band with no widgets draws nothing in view mode. In edit mode it always shows, with its two options.

### A clock in the header (kiosk)

The kiosk no longer draws its own clock at the top right. Older dashboards lose that clock, and nothing adds
a replacement, so add one yourself:

1. Open the dashboard and press Edit.
2. Press **Add widget**, choose the **Clock** widget, and set the target section to **Header (every tab)**.
3. Resize it (for example 4 columns wide and 3 rows high), set its time, date and size in the widget settings
   (the `xlarge` size suits a wall screen), and drag it to the right.
4. Leave **Show header in** at "Normal view and kiosk", or choose "Kiosk only" to show the clock only on the wall
   screen. Turn on **Sticky at the top** to keep it in view while the page scrolls. Press Save.

### Left tab rail

When the tabs sit on the left, each tab is an icon with its label under it, in a rail about 80 px wide (the
label wraps to two lines at most, and a tooltip gives the full label). Choose the **Tabs** button in edit mode,
set "Tab bar position" to "Left side", then set "Left tab style" to "Compact rail" (default) or "Wide" (the
earlier wide tabs, icon beside the label). Top tabs are not changed.

## Kiosk and rollouts

A wall kiosk stays on one dashboard for days, so a Headlamp rollout must not blank it. The plugin handles this
on the page, with no manual reload:

- **Stale data.** A widget that cannot reach its source keeps its last good data. Its card shows
  "Stale since HH:MM" in the title row. The panel, sunburst, PromQL and Kubernetes report widgets do this. Their fetch
  tries again by itself after 2 s, 4 s, 8 s and so on up to 60 s (20% spread), and the marker goes when it succeeds.
  In a kiosk the big "Refresh failed" alert of a panel does not show: the marker says it. A widget of another
  plugin keeps its own error handling.
- **Connection note.** A small note in the header, "Server unreachable since HH:MM", shows when the server does not
  answer. It shows nothing while the link is good. There is no full screen error. A kiosk that opens while the server
  is away shows a waiting line and loads the dashboard when the server answers. When the server is back, every widget
  fetches at once.
- **Reload into a new version.** A probe every 15 s (2 s to 15 s with a backoff while offline) reads the plugin's
  `package.json` and the page's HTML. When the plugin version or the Headlamp script files differ twice in a row, a kiosk
  reloads itself, with the same URL (tab, kiosk, view). The page never reloads while the server is down, so the browser
  never shows its own error page.
- **Failed chunks.** A lazy chunk or script that fails to load (the old file names are gone after a new version) is
  caught. The kiosk reloads once the server answers.
- **No reload loop.** At most three reloads in ten minutes, at least 30 s apart, counted in `sessionStorage`.
  Only a kiosk reloads. A normal page is never reloaded, because someone may be editing.
- **Own scripts only.** The probe and the chunk check count only the scripts that this server serves. A script that a
  browser extension adds to the page (for example a `chrome-extension://` address) does not make the page look old.
- **Screen stays on.** A kiosk asks the browser for a screen wake lock (`navigator.wakeLock`, needs https). Without it
  the operating system dims a screen with no touch input and turns it off, which looks like a random black screen. The
  browser then also pauses the page timers, so the data stops. The lock is asked for again each time the page shows,
  and a refusal is retried every minute. The code is in `src/kiosk/wakeLock.ts`.

The code is in `src/resilience/` (`connection.ts`, `backoff.ts`, `stale.tsx`) and `src/components/ConnectionIndicator.tsx`.

## Storage

One ConfigMap per dashboard, in the namespace set in the plugin settings (default
`headlamp-dashboards`). The namespace must exist.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ops-overview # made from the first title, never changed (URLs use it)
  namespace: headlamp-dashboards
  labels:
    headlamp.dev/dashboard: 'true'
data:
  dashboard.json: '{"version":1,"title":"Ops overview", ...}'
```

- The JSON has a `version` field (now 3). `migrateSpec` (`src/spec/model.ts`) upgrades older versions
  step by step and fills defaults. Version 2 adds `header`, `footer` and `tabRail`; a version 1 spec gets an empty
  header and footer and `tabRail: "compact"`, and nothing else changes. Version 3 adds `fitHeight` (see
  "Fit to screen height"); an older spec gets `fitHeight: false`, so it looks the same. A spec from a newer plugin version is shown as an error and is
  never overwritten.

### Fit to screen height

The grid has a fixed row height (30 px), so a dashboard can leave an empty band under the last row on a tall
screen. With `fitHeight` on, the grid rows of a tab stretch so its widgets fill the height under the title
bar and above the footer, in the normal view and in the kiosk. It measures again after a resize, a full
screen change and a tab change. The row height never goes below 30 px, so a small screen scrolls instead
of squashing the widgets, and it never goes above 240 px.

- Spec key: `fitHeight` (boolean) on the dashboard, and an optional `fitHeight` on a tab that overrides it.
  A new dashboard has it on. A spec migrated from version 2 or older has it off until you turn it on.
- Edit it in Edit, Dashboard settings, "Fit to screen height", and per tab in Tabs, "Fit height".
- A self-scroll section gives up its fixed pixel height while its tab fits the screen, because that fixed
  height is what leaves the gap. The rows set the height instead.
- The stretch is off while you edit, so a drag or a resize works on rows that stay still.

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
  - apiGroups: ['']
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
  defaultSize: { w: 6, h: 8 }, // grid units: 12 columns, rows of 30 px
  minSize: { w: 3, h: 4 },
  defaultConfig: { limit: 10 },
  configSchema: [{ key: 'limit', label: 'Rows', type: 'number', min: 1, max: 50 }],
  selfScroll: true,
  Component: TopNamespaces,
});
```

The pieces of the contract (see the comments in `src/contract.ts`):

| Name                           | Purpose                                                                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WidgetDefinition<C>`          | `type`, `title`, `description`, `icon` (Iconify), `category`, `defaultSize`, `minSize`, `maxSize`, `defaultConfig`, `configSchema` or `SettingsComponent`, `Component`, `selfScroll`, `card` |
| `WidgetProps<C>`               | `instanceId`, `config`, `filters`, `refreshSignal`, `reportRefreshed(at?)`, `editing`, `kiosk`                                                                                               |
| `WidgetSettingsProps<C>`       | `config` and `onChange(config)` for a custom settings form                                                                                                                                   |
| `ConfigField`                  | one field of a generated settings form: `text`, `multiline`, `number`, `boolean` or `select`                                                                                                 |
| `DashboardFilters`             | `namespaces`, `nodes`, `labelSelector`, `range`                                                                                                                                              |
| `registerDashboardWidget(def)` | register, in any plugin load order                                                                                                                                                           |

Rules for a widget:

- Saved settings are merged over `defaultConfig`, so a new key always has a default. Do not rename keys.
- Fetch when `filters`, your `config` or `refreshSignal` changes, and nothing else. A layout change
  (moving or resizing) never changes these props. The frame is memoised, so the widget is not
  rerendered by another widget's drag.
- Call `reportRefreshed()` after each fetch. It is stable, so it is safe in an effect dependency list.
- Fill the card: use `height: 100%`. Keep the title, stat tiles, legend and summary fixed and scroll only the
  rows, in one scroll area (`src/components/ScrollArea.tsx`: a thin always-visible scrollbar, an edge fade,
  touch scroll, and the wheel never scrolls the page). Never fold rows into a "+N more" line.
  Set `selfScroll: true` only for a widget that scrolls as a whole. The user can override it per widget.
- Do not rely on hover (the kiosk is a touch screen). When `kiosk` is true, show no focus rings and keep
  the thin scrollbar. When `editing` is true, disable links that leave the page.
- A widget that throws shows an error in its own card and leaves the rest alone.
- A dashboard that uses a type nobody registered shows a placeholder card ("The plugin that supplies
  this widget is not installed") and keeps its settings.

### Built-in widgets

| Type          | Settings                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `core.clock`  | Hours, minutes and seconds on or off, 12 or 24 hour, date on or off, a date format (preset or custom), time zone, size, zone name |
| `core.note`   | Markdown text (no raw HTML, no images, only path links), alignment                                                                |
| `core.header` | Header text, subtitle, header or line or both, size, alignment                                                                    |

The date format uses these letters: `yyyy`, `yy` (year), `MMMM`, `MMM`, `MM`, `M` (month),
`EEEE`, `EEE` (weekday), `dd`, `d` (day), `HH`, `H`, `hh`, `h` (hour), `mm`, `ss`, `a` (AM or PM).
Quote literal text in single quotes, for example `'Week' d`. Examples: `EEE d MMM yyyy`,
`yyyy-MM-dd`, `d/M/yyyy`.

## Settings

| Setting       | Meaning                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| Namespace     | The namespace that holds the dashboard ConfigMaps. Blank uses `headlamp-dashboards`. |
| Panel sources | The places the panel widgets read panels from. See [Panel sources](#panel-sources).  |

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

| Kind      | Fields                                                | How it is reached                                                                                                                                                                                                       |
| --------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service` | namespace, service, port, path prefix (default empty) | The Kubernetes API service proxy: `/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy<prefix>/api/widgets`. Kubernetes RBAC is the guard.                                                                              |
| `url`     | base URL                                              | The browser calls the URL directly with `fetch` and `credentials: 'include'`, so the cookie login of the app works. The app must allow the Headlamp origin with credentials (CORS). No token is stored in the settings. |

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
  word, never colour alone. A link goes to a Headlamp route only (see Links and swipes above). Links are off in edit mode.
- **Row icons**: a row may have `icon: { src, alt }`. `src` is a path relative to the source's `/api/widgets/`
  base, for example `icons/postgresql.svg` (for a service source that is the service proxy path, for a URL source
  it is relative to the base URL). `alt` is the kind, for example `PostgreSQL`, and defaults to the row label. A
  safe `src` has no scheme, no leading `/`, no `\`, no `.` or `..` segment, no query or fragment, only letters,
  digits and `. _ ~ -`, a `.svg` or `.png` ending and at most 200 characters. A bad value drops the icon and keeps
  the row. The plugin fetches the icon through the same request path as the panel (so the Headlamp login applies),
  accepts only `image/svg+xml` or `image/png` of at most 64 KiB, and shows it as a 20 px `<img>` from an object
  URL before the row label, in the list and in grouped bars. It fetches each icon once per page session. When
  some rows have icons, every row keeps an empty slot of the same size so the labels line up. A failed fetch
  shows nothing.
- **Display options**: `showSummary` (default true) shows the status and summary line, `showStats` (default
  true) shows the stat tiles, and `rowLayout` is `list` (default, the table above) or `grouped-bars`. A saved
  widget without these keys uses the defaults.
- **Grouped bars**: rows are grouped by `label` (for example the account or identity), in order of first sight.
  A group is exactly one horizontal track from 0 to 100 %. Every row of the group is drawn on that same track, in
  the colour of its limit name (the row `detail`), at the `fraction` of the row. The fills overlap: the largest
  fraction is at the back and the smaller ones are in front, so every colour stays visible. A thin tick in the
  limit colour marks the end of each fraction, so equal or hidden values still show. Equal fractions share the
  height of the tick. Known limit names go first in the legend by window length (5-hour, daily, weekly, weekly
  with a model name, monthly), then other names in order of first sight. The tooltip of the track lists every
  limit with its value and status. One status mark (shape and word) at the end of the row shows the worst status
  of the group. The group label column fits the longest label, up to 35 % of the widget. Only a longer label is
  clipped, and a tooltip gives the full label. Each limit name has its own colour, the same in every group, from
  the eight validated categorical hues of the data visualisation palette (light and dark), in the order of the
  legend. A legend above the rows maps the colours to the limit names. The limit colours are never status
  colours. Every group and limit shows: there is no top-N and no "Other" group. From the ninth limit name the
  hues repeat at lower opacity, and the legend names every one. Turn off `showSummary` and `showStats` to show
  the tracks alone.
- **Refresh**: the widget fetches when the dashboard refresh signal changes, and reports the time with
  `reportRefreshed`. The `refreshSeconds` of the panel is the minimum time between two fetches. The last good data
  stays on screen when a refresh fails, with a warning.
- **Shared requests**: requests are shared per source. Ten widgets on one source cause one list call (kept for one
  minute). A panel request is shared while it runs and is reused for the `refreshSeconds` of the panel. A failed
  request is not kept.
- **States**: a spinner while the first load runs, an error card with a short reason, a hint when no panel is
  chosen (a spinner while the cluster sources load), an error card when the source is not configured and a hint when the panel has nothing to show.

### AIS widget (`ais.limits`)

One widget for the limits, the pools, the identities and the sessions of an AIS source (default
source id `ais-console`). It fetches four panels of the source (`limits`, `identities`, `claude-swap`
and `agents`) and joins them in the browser by identity name and provider. No server change is
needed.

- **Fixed on top**: stat tiles for the sessions (the total of the `agents` panel), the login states
  (logged in, expiring, expired, and logged out when it is not zero), the pools and the active member of the
  pool, then the legend of the limit windows. They never scroll. All number tiles have one numeral size. The
  name of the active member has the same size and gets a wider tile.
- **One scroll area** under them. Each pool is a group header (name, member count, active member) with its
  members under it, the active one first and marked. An identity that is in no pool goes under the real
  name of its provider. There is no "Other" group, no top N and no "+N more" row.
- **One row for each identity**: its name, its login state (an expired or expiring login tints the row and
  shows a mark and a word), one lane for each limit window (5-hour, weekly, weekly for a model, monthly), its
  worst limit and one status mark. A widget at least 1000 px wide draws the identities of a group in two columns.
- **Joins**: the login panel names an identity as `tool / name` and the limits panel as `Provider / name`.
  The tool names `claude`, `codex`, `grok`, `kimi`, `zai` and `opencode` map to their providers. A tool with
  no limits (for example `pi`) is its own group. The members of the `claude-swap` panel belong to the
  Anthropic provider. A member with no limit row of its own shows the weekly value of the pool panel.
- **Links** go only to the dashboard tab whose id is the source id (for example `ais-console`). With no such
  tab, or in edit mode, a row has no link.
- **Not available from the source**: the sessions are one total. The `agents` panel names a pool, not an
  identity, so the widget cannot show sessions for each identity.

### Alerts and incidents widget (`agent.issues`)

One widget for the alerts and the incidents of a panel source (default source id `agent`). It fetches
two panels of the source (`alerts` and `incidents`) and joins them in the browser. It replaces the two
separate panels on the Overview.

- **Fixed on top**: two rows of stat tiles with one numeral size. The alert row has the critical and the
  warning alerts that fire, and the pending alerts. The incident row has the open incidents, the incidents
  that an agent works on (in progress, also counted as open) and the incidents resolved today.
- **One scroll area** under them, with one row for each issue group. A group is one alert name on one
  target, for example `KubeDeploymentDown` on `shop/web`. The alerts and the incidents of that alert are in
  the group. A group has the severity mark, the alert name, a count badge, the state (firing, pending, open
  or resolved), the target and an agent chip: **Agent working** (a diagnosis or an approved launch runs),
  **Diagnosed** (with the likely cause on the next line), **Failed**, or no chip. The worst group is first
  (severity, then state, then count). There is no "Other" group, no top N and no "+N more" row.
- **Members and count**: the members are the alerts that fire or are pending and the incidents that are open.
  The count is the number of members. A group with no such member shows only when an incident of it was
  resolved today (local time of the browser). Older resolved incidents are not shown.
- **Group key**: the agent sets `meta.group` on the rows of both panels with one function (see `issueTarget`
  in `agent/src/widgets.ts`). The target is the first of the labels `target`, `deployment`, `statefulset`,
  `daemonset`, `cronjob`, `job_name`, `persistentvolumeclaim` and `pod` (with the namespace in front), else
  `node:device` or `node:mountpoint`, else the namespace, else the instance. An older agent sends no `meta`:
  the key is then the alert name alone.
- **Links** go only to the Incidents page of Headlamp (`/incidents/<id>` for a group with an incident) or to the
  dashboard tab with the id `incidents`. In edit mode a row has no link.

### Optional row `meta` field (v1 extension)

A row may have `meta`: named text fields for a widget that joins panels. Keys match `[a-z][A-Za-z0-9_]*`
(at most 24 characters), values are strings (at most 240 characters) and a row keeps at most 16 fields. A bad
entry is dropped and the row stays. The alerts and incidents panels of the agent use `kind`, `group`, `target`,
`severity`, `state`, `at`, `resolvedAt`, `id` and `agent`.

### Runner widget (`runners.overview`)

One widget for the pools, the queue and the running workflow runs of a runner source. It fetches the `pools`
and `queue` panels of the source, and the `runs` panel when the source lists it. The `runs` panel is optional.

- **Fixed on top**: five stat tiles (running, queued, free, pools, oldest wait) with one numeral size. Then one
  ring for each pool: the blue arc is the running slots, the amber arc is the queued jobs and the crosshatch is
  the free capacity. The icon is in the ring. The pool name and its `running/cap` value sit under it, with the
  same size in every pool.
- **One scroll area** under them, with every row. There is no "+N more" row. With nothing to show, one quiet line
  says "No queued jobs". A fixed summary line is at the bottom.
- **With the `runs` panel the list is a tree**, collapsed at first: one row for each running or queued run
  (repository, workflow, branch or pull request, pool, time). Open a run to see its jobs and open a job to see
  its steps. A run row and a job row have a step bar with one segment for each step: done (green), running
  (amber, a soft pulse that stops when the user prefers reduced motion), failed (red), skipped (grey) and
  pending (faint). The text "step N of M" and the name of the current step are next to the bar. Running runs come
  first (longest first), then queued runs (longest wait first).
- **Without the `runs` panel** the list is the rows of the `queue` panel: repository, pool, queued count and the
  oldest wait. There is no tree.
- **Links** go only to the dashboard tab whose id is the source id. With no such tab, or in edit mode, a row has
  no link.

#### Optional `runs` panel (v1 extension)

```json
{
  "version": 1,
  "id": "runs",
  "title": "Runs",
  "status": "ok",
  "summary": "3 running, 2 queued",
  "link": "/overview",
  "runs": [
    {
      "id": "run-1",
      "repo": "my-org/my-repo",
      "workflow": "CI",
      "ref": "PR 12",
      "pool": "pool-a",
      "state": "running",
      "seconds": 642,
      "jobs": [
        {
          "id": "job-1",
          "name": "build",
          "state": "running",
          "pool": "pool-a",
          "seconds": 640,
          "steps": [
            { "name": "Checkout", "state": "done" },
            { "name": "Build", "state": "running" },
            { "name": "Test", "state": "pending" }
          ]
        }
      ]
    }
  ]
}
```

`state` of a run or job is `running` or `queued`. `state` of a step is `done`, `running`, `failed`, `skipped`
or `pending`. `seconds` is the time that the run has run or waited. A bad value is dropped or replaced by a
default, and the widget never throws on bad data.

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

Option `groupBy` sets the first ring. `category` (the default) keeps the category first. `node` splits the
circle by node first (node-1, node-2 and so on), then category, then child. Each node is sized by its
capacity, and its free capacity is a faint crosshatch on a transparent fill. It needs an agent that sends
`nodes` for each ring. Without `nodes` the chart stays category first. To turn it on, set `"groupBy": "node"`
in the `config` of the widget.

### Agent usage pair (`agent.usage-pair`)

Draws two rings of one panel (by default `cpu` and `memory` of `usage-dashboard` on the agent) as two
node-first sunbursts side by side with ONE shared legend. It has the same source and panel settings as the
panel widget, and it keeps the last good panel (the `cache` of the widget) like the other panel widgets.
It is sized for 6 columns and 8 rows (`w` 6, `h` 8). Options: `first` and `second` set the two rings.

- The same node and the same category have the same colour in both rings and in the legend.
- The legend lists the node, then its categories, then its free capacity (faint crosshatch). Each row has one
  value for each ring, in two columns of equal width. A group that only one ring has shows a dash in the other.
- The legend stays in place and scrolls inside itself when it is long. There is no "+N more" row and no "Other" group.
- A hover on a legend row or on an arc shows the same group in both rings. In kiosk mode a tap selects instead.
- Without per-node data from the agent, the widget draws two category-first charts, each with its own legend.

### The sunburst component

`src/widgets/sunburst/SunburstChart.tsx` is a reusable two-level sunburst: the inner ring has one arc per
category and the outer ring has one arc per child. The full circle is the capacity and the filled part is the
used part, so the unused part stays empty. The geometry (`geometry.ts`) is like the Usage plugin rings, with a
larger centre hole (36 % of the radius), and the centre text shrinks to fit the hole. The colours are the Usage
palette (Okabe-Ito, with lighter hues for dark mode and the kiosk). Rules:

- Every group is its own arc at its real size. There is no "Other" arc and no top-N cut.
- A mouse hover shows the label and the value in the centre. A tap selects an arc, and a second tap clears it.
  In kiosk mode hover is off and a tap selects, because the kiosk is a touch screen.
- The legend lists every category (every node, category and free row in node mode), and the SVG has a text
  summary, so colour is never the only encoding. A long legend scrolls and never folds into "+N more".
- The Usage plugin has its own copy (separate bundles cannot share code).

### Kiosk

The widgets use theme colours only, so they follow the black kiosk background. The kiosk has no focus rings
and no hover. The legend lists every group and scrolls, with a thin scrollbar that also shows in the kiosk.

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
  - _Tabular_: the columns, sortable.
  - _Summary_: group by up to two fields, with row counts and sum, avg, min or max of numeric fields.
    Groups collapse. Each group has a subtotal and the report has a grand total. The rows can show inside
    the groups.
  - _Matrix_: rows by one field, columns by another, with a row count or an aggregate in each cell, and
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
- **Kiosk**: the widget uses the black background, larger rows and a thin scrollbar on every scrolling list.

Users need `list` (and `watch`) access to the chosen kind. A refused list shows a message in the widget.

## PromQL widgets

Six widgets in the **Monitoring** group query a Prometheus-compatible service (VictoriaMetrics,
Prometheus). They use the plain HTTP API (`/api/v1/query` and `/api/v1/query_range`) through the
Kubernetes API service proxy, as the other plugins do. The signed in user needs the `get` verb on
`services/proxy` for that Service.

Set where the service is in the plugin settings (blank fields use the defaults): namespace
(`monitoring`), service (`victoria-metrics`), port (`8428`) and an optional path prefix such as
`/prometheus`.

| Type                | What it shows                                                                        |
| ------------------- | ------------------------------------------------------------------------------------ |
| `promql.timeseries` | Line, area, stacked area or bars from a range query. Several queries per chart.      |
| `promql.stat`       | One value, an optional sparkline and thresholds.                                     |
| `promql.gauge`      | One value against a scale, with thresholds.                                          |
| `promql.table`      | One row per series of an instant query. Pick the label columns. Sortable.            |
| `promql.breakdown`  | A pie (donut) or bars from an instant query, grouped by a label.                     |
| `promql.matrix`     | A rows by columns matrix from an instant query, for example ping loss per node pair. |

**Template variables.** They follow the filter bar, so one query serves every filter. An unknown
`$name` stays as typed. Use double quotes around them.

| Variable     | Value                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------- |
| `$namespace` | The chosen namespaces as a regex, for `namespace=~"$namespace"`. None chosen gives `.*`. |
| `$node`      | The same for nodes. Dots and other regex characters are escaped.                         |
| `$range`     | The time range as a PromQL duration, for example `[$range]`.                             |
| `$step`      | The query step, for example `30s`.                                                       |
| `$rate`      | A window for `rate()`: four steps, at least one minute.                                  |
| `$selector`  | The label selector as PromQL matchers, for `up{$selector}`.                              |

**Several queries.** In the time series chart and the table, put a line with only `---` between
queries. A first line `# {{pod}}` names the series from labels (chart). In the table, a first line
such as `# Memory | bytes` names the value column and sets its unit. The `#` line is a PromQL comment
and is removed before the query runs.

**Units.** Plain (1.5k, 2.5M), bytes (KiB, MiB, GiB), CPU cores, percent (0 to 100), ratio (0 to 1,
shown as percent) and seconds (ms, s, min, h, d).

**Thresholds.** `70:warning, 90:critical` gives the status from a value up. Below the first step the
status is good. The statuses are good, warning, serious and critical. "A lower value is worse" reads
the steps as "or less". A status always shows an icon and a word, so colour is never the only cue.

**Matrix.** `promql.matrix` draws one cell for each pair of a row label and a column label (default
`source` and `target`). The value query gives the cell value. An optional path query (1 direct, 0 relayed)
puts an `R` mark on a relayed pair. An optional round trip query (seconds) goes in the cell tooltip. With
"same members" on, rows and columns are the union of every label value that a query returned, and the
diagonal is blank. A pair with no sample shows a dash on a hatched cell ("no data"), never 0. A value above
"Warning above" gets a triangle and an amber fill. A value above "Critical above" gets a square and a red
fill. A value equal to a limit is not above it. A summary line stays in the widget footer: "30 pairs, 2 above
2%, 4 no data, worst a to b 3.5%". The matrix shows every pair, scrolls when the widget is small and has no
"+N more" row and no "Other" group.

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
- The kiosk (black background) uses light ink, a thin scrollbar on scrolling lists and no focus rings.

Each widget settings dialog has a multiline query editor and a **Run** button. The preview is an
instant query with no filters, so it shows every namespace and node.
