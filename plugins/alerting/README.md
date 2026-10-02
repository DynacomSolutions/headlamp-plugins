# alerting

A [Headlamp](https://headlamp.dev/) plugin for managing alerting notification
channels and routes. It adds an **Alerting** sidebar entry with three pages:
**Channels**, **Routes** and **Status**.

The UI creates, updates and deletes the custom resources live through the
Kubernetes API. It never opens pull requests.

## Custom resources

Both kinds live in a configurable group, version and namespace (defaults
`alerting.example.com`, `v1alpha1`, `monitoring`).

```yaml
apiVersion: alerting.example.com/v1alpha1
kind: NotificationChannel
metadata:
  name: phone
  namespace: monitoring
spec:
  type: ntfy            # email | ntfy | pushover | webhook | webpush
  enabled: true
  ntfy:
    server: https://ntfy.example.com
    topic: alerts
    priority: 4
    tokenSecretRef:
      name: ntfy-auth
      key: token
---
apiVersion: alerting.example.com/v1alpha1
kind: AlertRoute
metadata:
  name: out-of-hours
  namespace: monitoring
spec:
  channels: [phone]
  match:
    targets: [web]
    kinds: [urgent, recovery]   # urgent | recovery | summary
  quietHours:
    start: "22:00"
    end: "07:00"
    timezone: Europe/London
    allowUrgent: true
```

Other channel types: `email.to[]`, `pushover{userKeySecretRef,tokenSecretRef}`,
`webhook{url,headersSecretRef?}`. Channel `status` carries `lastSendTime`,
`lastResult` and `lastError`. Secret references are chosen from the Secrets in
the configured namespace (names and key names only; values are never displayed).
If listing Secrets is forbidden or fails, the pickers become free-text inputs
for the Secret name and key, so no Secret read access is needed.

## Web push (desktop and app notifications)

A `webpush` channel (`spec.webpush` with optional `ttl` seconds and `urgency`)
delivers to browsers and installed web apps. Each device is a namespaced
`PushSubscription` resource (`spec.channel`, `endpoint`, `keys.p256dh`,
`keys.auth`, optional `label` and `userAgent`; `status.lastResult` and
`lastError` written by the backend). On the Channels page, a section appears
when a webpush channel exists:

- **Enable on this device** asks for notification permission, registers the
  service worker, subscribes with the public key the state API returns as
  `webpush.publicKey`, and creates the `PushSubscription`.
- **Disable on this device** deletes it and unsubscribes the browser.
- **Send test** uses the normal test-send annotation and reaches every device
  of the channel.
- The device list shows every subscription and can delete any of them.

The service worker (`sw.js`) is shipped beside `main.js`, so it is served at
`/plugins/alerting/sw.js` with the default scope `/plugins/alerting/`, which is
enough for push. It shows the notification (urgent ones stay until dismissed)
and focuses or opens the dashboard on click. Push needs a secure context. On
iPhone and iPad it only works from an app added to the Home Screen; the page
says so. The service account needs get, list, watch, create and delete on
`pushsubscriptions` in the namespace.

## Settings

Set under Settings, Plugins, Alerting. Blank fields use the default.

| Setting | Default | Meaning |
| --- | --- | --- |
| CRD group | `alerting.example.com` | API group of the resources |
| CRD version | `v1alpha1` | API version |
| Namespace | `monitoring` | Namespace of channels, routes and Secrets |
| State API URL | empty | Empty hides the Status page. `service/<ns>/<name>:<port>/<path>` goes through the cluster API proxy |

To preconfigure every browser, ship a `defaults.json` at
`/plugins/alerting/defaults.json` (next to `main.js` in the plugin directory,
for example written by an initContainer) using the setting keys `group`,
`version`, `namespace` and `stateApiUrl`. Values a user saves in the settings
override it, and it overrides the built-in defaults.

## Git and the UI

Custom resources can be managed in Git (GitOps) or live in the UI. Pick one per
resource:

- **UI-created resources:** keep them out of Git. Nothing else is needed.
- **Git-managed resources:** every write from the UI is recorded under the
  field manager `headlamp-alerting`. Fields you change in the UI are owned by
  that manager; fields you have not touched stay owned by the GitOps tool. Tell
  the tool to leave only the UI-owned fields alone, rather than ignoring the
  whole `/spec`. Argo CD example (also set `RespectIgnoreDifferences=true` in
  the Application's sync options so syncs honour it):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
spec:
  ignoreDifferences:
    - group: alerting.example.com
      kind: NotificationChannel
      managedFieldsManagers:
        - headlamp-alerting
    - group: alerting.example.com
      kind: AlertRoute
      managedFieldsManagers:
        - headlamp-alerting
```

  With this, a UI edit survives self-heal, while a later Git change to a field
  the UI has not edited still reaches the cluster. A field edited in the UI
  keeps its live value until you revert it live or remove the resource.

To bring a UI edit back into Git, use **Copy YAML** or **Download YAML** in the
save dialog and commit the file yourself.

## Test sends

**Send test** on a channel sets the annotation
`alerting.example.com/test-requested` to the current RFC 3339 time (the group
follows the setting). The row shows pending until the backend sets
`alerting.example.com/test-handled` to the same value, then shows
`status.lastResult`. Test sends are ephemeral, not configuration, so they are
always applied live. If the channel is Git-managed and you do not already ignore `/spec`,
tell Argo CD to ignore these annotations:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
spec:
  ignoreDifferences:
    - group: alerting.example.com
      kind: NotificationChannel
      jqPathExpressions:
        - '.metadata.annotations["alerting.example.com/test-requested"]'
        - '.metadata.annotations["alerting.example.com/test-handled"]'
```

## Status page

`GET <state API URL>` is polled every 15 seconds and rendered as a table, with
the reported `routing` mode and `channels` above it. Expected shape (extra
fields are ignored; episodes are grouped by `target` client-side, and nested
per-target `episodes` are still accepted):

```json
{
  "generated_at": "2026-01-01T00:10:00Z",
  "routing": "crds",
  "channels": [{ "name": "phone", "type": "ntfy" }],
  "targets": [{ "target": "web", "state": "down" }],
  "episodes": [
    { "id": 1, "target": "web", "started": "2026-01-01T00:00:00Z", "ended": null, "alerted": true, "recoverySent": false }
  ]
}
```

## Development

```bash
npm ci && npm run tsc && npm run lint && npm test && npm run build
```
