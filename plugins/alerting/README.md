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
  type: ntfy            # email | ntfy | pushover | webhook
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
- **Git-managed resources:** the UI still writes live, so a GitOps tool will
  see drift and may revert your edit. Either edit in Git instead, or tell the
  tool to ignore drift in `/spec`. Argo CD example:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
spec:
  ignoreDifferences:
    - group: alerting.example.com
      kind: NotificationChannel
      jsonPointers:
        - /spec
    - group: alerting.example.com
      kind: AlertRoute
      jsonPointers:
        - /spec
```

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
