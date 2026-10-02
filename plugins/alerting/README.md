# alerting

A [Headlamp](https://headlamp.dev/) plugin for managing alerting notification
channels and routes. It adds an **Alerting** sidebar entry with three pages:
**Channels**, **Routes** and **Status**.

Git is the source of truth for configuration. The UI is another way to produce
that configuration, so by default it never writes live resources: it generates
the changed manifest and ships it as a pull request.

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
the configured namespace (names and key names only; values are never read).

## Settings

Set under Settings, Plugins, Alerting. Blank fields use the default.

| Setting | Default | Meaning |
| --- | --- | --- |
| CRD group | `alerting.example.com` | API group of the resources |
| CRD version | `v1alpha1` | API version |
| Namespace | `monitoring` | Namespace of channels, routes and Secrets |
| State API URL | empty | Empty hides the Status page. `service/<ns>/<name>:<port>/<path>` goes through the cluster API proxy |
| GitOps mode | on | Edits produce proposals, not live writes |
| Proposal endpoint | empty | URL accepting a proposal (below); also accepts `service/...` |
| Repository path | `alerting` | Directory the manifests are written under |
| Direct apply | off | Also allow writing live resources, for clusters not under GitOps |

## Proposals (GitOps)

Saving an edit opens a review dialog showing the generated YAML. With a proposal
endpoint configured, **Open pull request** sends

```json
POST <proposal endpoint>
{ "path": "alerting/notificationchannel-phone.yaml", "content": "<yaml>", "message": "alerting: update NotificationChannel phone" }
```

and expects `{ "prUrl": "https://git.example.com/my-org/my-repo/pull/1" }`, which
is shown as a link. The endpoint owns the repository, branch and credentials.
Without an endpoint, use **Copy YAML** or **Download YAML** and commit the file
yourself. Deletions are done in Git. A browser-reachable endpoint needs CORS;
the `service/...` form avoids that by going through the API server.

**Direct apply** (off by default) adds **Apply live** and **Delete live**. Under
GitOps the controller will revert such writes.

## Test sends

**Send test** on a channel sets the annotation
`alerting.example.com/test-requested` to the current RFC 3339 time (the group
follows the setting). The row shows pending until the backend sets
`alerting.example.com/test-handled` to the same value, then shows
`status.lastResult`. Test sends are ephemeral, not configuration, so they are
always applied live, even in GitOps mode. Tell Argo CD to ignore them:

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

`GET <state API URL>` is polled every 15 seconds and rendered as a table. The
expected shape (extra fields are ignored):

```json
{ "targets": [
  { "name": "web", "kind": "http", "state": "down", "since": "2026-01-01T00:00:00Z",
    "episodes": [ { "start": "2026-01-01T00:00:00Z", "end": "2026-01-01T00:05:00Z", "state": "down" } ] }
] }
```

## Development

```bash
npm ci && npm run tsc && npm run lint && npm test && npm run build
```
