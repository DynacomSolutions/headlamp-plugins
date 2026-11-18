# Headlamps for Android

Headlamps is an Android app. It shows home-screen widgets with CPU and memory use
for each node of a Kubernetes cluster. It reads the data from one or more
[Headlamp](https://headlamp.dev/) instances.

## What the app does

- You add Headlamp instances: a display name, a base URL and an optional bearer token.
- "Test connection" fetches the cluster list and shows the clusters or a clear error.
- The app shows a warning for `http://` URLs.
- You add the "Node usage" widget and pick an instance and a cluster.
- A small widget shows the cluster totals for CPU and memory.
- A larger widget shows a scrollable node list. The worst node is first (the higher of CPU and memory).
- Bars are green below 75%, amber above 75% and red above 90%.
- Tap the widget body to open the Nodes page of the usage plugin in the browser.
- Tap Refresh in the widget header to update at once.
- The widget shows an error text when the server is not reachable, when the token is refused (401 or 403), or when the metrics API is missing (404 or 503).

## Headlamp panel widget

The "Headlamp panel" widget shows one panel of the headlamp-agent: uptime, usage,
alerts, disks, hardware, sites, updates, incidents or agent memory.
You pick the instance, the cluster and the panel when you add the widget.
The widget shows a status colour, up to four numbers and a list of rows, worst first.
It needs the headlamp-agent in the cluster. The app reads the agent through the
Headlamp Kubernetes service proxy.

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

The node usage widget needs the Kubernetes metrics server in the cluster.
The widget opens `<base>/c/<cluster>/usage/nodes`. This page needs the usage plugin of this repository.

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

## First release (one time, for the owner)

Play has no API to create an app or to upload the first bundle. Do these steps by hand.

1. In Play Console, create the app "Headlamps".
2. Run the "Release Headlamps to Play" workflow by hand. Download the signed bundle from the workflow artifact.
3. In Play Console, open Testing, then Internal testing. Create a release and upload the bundle. Use Play App Signing.
4. Under Testers, select the existing tester email list.
5. After this, each merge that raises the version publishes to internal testing.
