# Headlamps for Android

Headlamps is an Android app. It shows home-screen widgets with CPU and memory use
for each node of a Kubernetes cluster. It also shows the use as rings, so that you see
who uses the capacity. It reads the data from one or more
[Headlamp](https://headlamp.dev/) instances.

## What the app does

- You add Headlamp instances: a display name, a base URL and an optional bearer token.
- "Test connection" fetches the cluster list and shows the clusters or a clear error.
- The app shows a warning for `http://` URLs.
- You add the "Node usage" widget and pick an instance and a cluster.
- A small widget shows the cluster totals for CPU and memory.
- A larger widget shows a scrollable node list. The worst node is first (the higher of CPU and memory).
- Bars are green below 75%, amber above 75% and red above 90%.
- Tap the widget body to open the Usage dashboard of the usage plugin in the browser.
- Tap Refresh in the widget header to update at once.
- The widget shows an error text when the server is not reachable, when the token is refused (401 or 403), or when the metrics API is missing (404 or 503).

## Headlamp panel widget

The "Headlamp panel" widget shows one panel of the headlamp-agent: uptime, usage,
alerts, disks, hardware, sites, updates, incidents or agent memory.
You pick the instance, the cluster and the panel when you add the widget.
The widget shows a status colour, up to four numbers and a list of rows, worst first.
It needs the headlamp-agent in the cluster. The app reads the agent through the
Headlamp Kubernetes service proxy.

## Usage dashboard widget

The "Usage dashboard" widget shows CPU and memory use of one cluster as rings.
You pick the instance and the cluster when you add the widget.
Each ring is a circle of the cluster capacity. The coloured arcs say who uses it.
The rest of the circle stays empty. The centre shows the used percent.

- The inner ring is a status ring. It is green up to 75%, amber above 75% and red above 90%.
- The middle ring has one arc per category: Kubernetes, system, other and each orchestrator.
- The outer ring has the consumers of each category, for example the namespaces of Kubernetes.
  Below 76 dp the widget draws the category ring only.
- Sizes are exact. The widget adds no "Other" entry and cuts nothing.

The legend is one list for both rings. It has two value columns, CPU and Mem.
First it lists each category (Kubernetes, system and so on). Then it lists the consumers, such as namespaces.
Each group is sorted by the higher of its two shares, biggest first.
Each dot has the colour of its arc. A consumer takes the colour of the ring where its share is higher.
A share is a whole percent of that ring's capacity, "<1%" below 0.5%, or "-" when the ring does not hold the entry.

The widget shows more when you make it bigger:

- Small: the ring of the resource with the higher use, and a small bar for the other one.
- Narrow and tall: CPU above memory.
- Wide and short: both rings side by side. When there is room, a key (dot and name) sits beside the rings.
  When there is more room, the full legend with both columns sits there. Otherwise only the rings show.
- Tall and wide: a caption under each ring, such as "CPU 51 of 96 cores", then the legend header and a scrolling legend.
  The list is as high as a whole number of rows, so no row is cut at rest.
- The "Updated" line shows only from 250 dp wide and 180 dp high.

Tap anywhere on the widget (also a legend row) to open the dashboard of the usage plugin for the cluster.
Tap Refresh in the header to update at once.
The widget draws each ring into a bitmap at the exact pixel size, in a light and a dark version.
The launcher can switch the theme without the app.

The widget needs the headlamp-agent with the `usage-dashboard` panel and the usage plugin of this repository.
When the agent is too old, the widget says so.

## Data the app reads

The app sends only GET requests. `<base>` is the base URL of the instance.

| Request | Use |
| --- | --- |
| `<base>/config` | Cluster names |
| `<base>/clusters/<cluster>/apis/metrics.k8s.io/v1beta1/nodes` | Node CPU and memory use |
| `<base>/clusters/<cluster>/api/v1/nodes` | Node allocatable CPU and memory (the 100% value) |

The panel widget reads these paths (GET only):

| Request | Use |
| --- | --- |
| `<base>/clusters/<cluster>/api/v1/namespaces/headlamp-agent/services/headlamp-agent:80/proxy/api/widgets` | List of panels |
| `<base>/clusters/<cluster>/api/v1/namespaces/headlamp-agent/services/headlamp-agent:80/proxy/api/widgets/<id>` | One panel |

The usage dashboard widget reads one panel (GET only):

| Request | Use |
| --- | --- |
| `<base>/clusters/<cluster>/api/v1/namespaces/headlamp-agent/services/headlamp-agent:80/proxy/api/widgets/usage-dashboard` | CPU and memory rings |

The node usage widget needs the Kubernetes metrics server in the cluster.
The widget opens `<base>/c/<cluster>/usage/dashboard`. This page needs the usage plugin of this repository.
The usage dashboard widget opens the same page.
The old `/usage/nodes` path still redirects to the dashboard, for older app versions and bookmarks.

## Authentication

If you set a token, the app sends `Authorization: Bearer <token>`.
Some instances need no token because the network limits access. Leave the field empty for them.
The app encrypts the token with an Android Keystore key (AES/GCM) before it writes the token to DataStore.
The app excludes its data from backup.

The network security config allows cleartext traffic, because some instances run on private networks.
It trusts the system CAs and the CAs that the user adds.

## Refresh

A WorkManager job runs every 15 minutes while at least one widget exists.
The app cancels the job when the last widget is removed.
The app also refreshes after you configure a widget and when you tap Refresh.

## Build

You need Java 17 or later and the Android SDK with platform 36 and build-tools 36.0.0.

```sh
export ANDROID_HOME=$HOME/Android/Sdk
cd android
./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug bundleRelease
```

The debug APK is in `app/build/outputs/apk/debug/`.
The release bundle is in `app/build/outputs/bundle/release/`.

The Kotlin namespace is `app.headlamps`. The application ID comes from the
environment variable `HEADLAMPS_APPLICATION_ID`. Without it, the build uses `app.headlamps`.

The release build uses R8 with resource shrinking. It is signed only when all four
variables are set: `HEADLAMPS_UPLOAD_KEYSTORE_BASE64`, `HEADLAMPS_UPLOAD_STORE_PASSWORD`,
`HEADLAMPS_UPLOAD_KEY_ALIAS` and `HEADLAMPS_UPLOAD_KEY_PASSWORD`.
Without them, the release build is unsigned.

CI builds the app on every pull request that changes `android/`.

## Release

1. In a pull request, raise `versionCode` in `version.properties` by one.
   Change `versionName` if needed.
2. Add `fastlane/metadata/android/en-GB/changelogs/<versionCode>.txt`. Use 500 characters or fewer.
3. Merge the pull request. The "Release Headlamps to Play" workflow builds the signed bundle and publishes it to the internal testing track.

A manual run of the workflow is a dry run by default. Play checks the release, but nothing is published.
To publish by hand, set the `publish` input.

The workflow needs these repository secrets: the four `HEADLAMPS_UPLOAD_*` values,
`HEADLAMPS_APPLICATION_ID` and `HEADLAMPS_PLAY_SERVICE_ACCOUNT_JSON_BASE64`.
The workflow checks the signing certificate against a fixed SHA-256 fingerprint.
It keeps the bundle and the R8 `mapping.txt` as an artifact for three days.

## Store listing

The Play store listing comes from `fastlane/metadata/android/<language>/`.

- `title.txt` is the app title ("Headlamps").
- `short_description.txt` and `full_description.txt` are optional. Play keeps the text that it holds when a file is missing.
- `images/icon.png` is the 512 by 512 store icon. Its source is `images/icon.svg`. Render it again with `rsvg-convert -w 512 -h 512 icon.svg -o icon.png`.

A push to `main` that changes these files publishes the listing only. It makes no bundle and needs no new version code.
For a manual run, set the `listing_only` input. The run is a dry run unless `publish` is also set.
The script replaces the icon only when its SHA-256 differs from the icon on Play.

## First release (one time, for the owner)

Play has no API to create an app or to upload the first bundle. Do these steps by hand.

1. In Play Console, create the app "Headlamps".
2. Run the "Release Headlamps to Play" workflow by hand. Download the signed bundle from the workflow artifact.
3. In Play Console, open Testing, then Internal testing. Create a release and upload the bundle. Use Play App Signing.
4. Under Testers, select the existing tester email list.
5. After this, each merge that raises the version publishes to internal testing.
