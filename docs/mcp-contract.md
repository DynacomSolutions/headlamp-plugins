# Headlamp agent MCP and ACP contract

Contract version: **1.0.0**. Status: draft until the first merge. After the merge this file is **immutable**: only additive changes are allowed (section 14).

This contract covers the network MCP server and the network ACP endpoint of `headlamp-agent`. Clients use it to read incidents, receive incident events without polling, start investigations and read storage state. Both endpoints are private and cluster-internal.

Words in this document: "MUST", "MUST NOT" and "MAY" have the meaning in RFC 2119.

## 1. Protocol and transport

| Item | Value |
| --- | --- |
| Protocol | Model Context Protocol (MCP) |
| Versions served | `2025-06-18`, `2025-11-25`, `2026-07-28` |
| Transport | Streamable HTTP, single endpoint `/mcp` |
| Message format | JSON-RPC 2.0, UTF-8 |
| Stateful sessions | `2025-06-18` and `2025-11-25` clients (push needs them) |
| Stateless fallback | `2026-07-28` per-request envelope clients, and 2025-era clients that do not use a session |

### 1.1 Stateful session

1. The client sends `POST /mcp` with `initialize`. The server picks the highest version that both sides know.
2. The server answers with the `Mcp-Session-Id` response header. The value is an opaque string of at most 128 visible ASCII characters.
3. The client MUST send `Mcp-Session-Id` and `MCP-Protocol-Version` on every later request.
4. The client opens the push stream with `GET /mcp`, header `Accept: text/event-stream` and `Mcp-Session-Id`. The server sends all notifications on this stream. At most one push stream is open per session. A second `GET` while a stream is open fails with HTTP 409. The client retries after the server notices the closed connection.
5. The client sends `DELETE /mcp` with `Mcp-Session-Id` to end the session.
6. A session ends when it is deleted, or 30 minutes after its last request while no push stream is open. An open push stream keeps the session alive. The server sends an SSE comment line (`: keep-alive`) every 25 seconds.
7. The server keeps at most 200 sessions. When the limit is reached, `initialize` fails with HTTP 503 and `Retry-After: 30`.
8. A request with an unknown or ended `Mcp-Session-Id` fails with HTTP 404. The client MUST then start a new session, subscribe again and catch up with the event log (section 8.3). Sessions live in the memory of one pod. A rollout or a restart ends all sessions.

### 1.2 Stateless fallback

A request without `Mcp-Session-Id` that is not an `initialize` for a 2025 version is handled in stateless mode, as before this contract. Stateless mode serves tools, resources (read), prompts and skills. It does **not** support `resources/subscribe` or the push stream. The calls fail with JSON-RPC error `-32601` and `data.code = "session_required"`.

### 1.3 Capabilities

The `initialize` result declares:

```json
{
  "capabilities": {
    "tools": { "listChanged": false },
    "resources": { "subscribe": true, "listChanged": true },
    "prompts": { "listChanged": false },
    "experimental": {
      "dev.dynacom.headlamp": {
        "contract": "1.0.0",
        "eventLog": { "uri": "headlamp://events", "retentionHours": 168 },
        "scopes": ["registry:read", "incidents:read", "incidents:write", "incidents:resolve", "agent:investigate", "storage:read", "settings:read"]
      }
    }
  }
}
```

In stateless mode `subscribe` and `listChanged` are `false`.

A client that needs this contract MUST check `capabilities.experimental["dev.dynacom.headlamp"].contract`. The first number is the major version. This document has major version 1. Minor and patch numbers grow with additive changes.

## 2. Service discovery

| Item | Value |
| --- | --- |
| Namespace | `headlamp-agent` |
| Service | `headlamp-agent` (ClusterIP) |
| Service port | `80` (name `http`), target port `8080` |
| MCP URL | `http://headlamp-agent.headlamp-agent.svc/mcp` |
| ACP URL | `ws://headlamp-agent.headlamp-agent.svc/acp` |
| Short form in the same namespace | `http://headlamp-agent/mcp` |

The agent also has a `session` port (`8081`, Service port `session`). Only the Kubernetes API service proxy reaches it. MCP and ACP clients MUST NOT use it (section 4.4).

The existing HTTPRoute and Emissary Mapping send the whole hostname (`/` prefix) to port 80. Both `/mcp` and `/acp` are therefore reachable on the tailnet hostname too, for the same hosts that reach `/mcp` today. Every request needs a bearer token (section 4). This contract adds no new public exposure, no new Service and no new reverse proxy. The NetworkPolicy of the agent already admits in-cluster clients through its namespace allow list. A client namespace that is not in the list needs a one-line addition to `networkPolicy` in the chart.

The Service MUST get `sessionAffinity: ClientIP` (timeout 1800 seconds). During a rollout two pods can run for a short time, and sessions live in one pod.

### 2.1 ACP endpoint

The ACP endpoint is `/acp` on the same Service and port (`ws://headlamp-agent.headlamp-agent.svc/acp`). It uses the same token file and the same scope check as MCP (section 4). Its scope is `agent:investigate`. The file [docs/acp-endpoint.md](acp-endpoint.md) is the authority for the framing, limits, close codes and error answers of ACP. This contract does not repeat them. ACP diagnoses publish through the same diagnosis store as webhook diagnoses, so they raise the same events (section 7).

## 3. Identifiers and shared types

All times are RFC 3339 UTC strings (`2026-11-28T00:15:00Z`). All ids are strings.

| Name | Meaning |
| --- | --- |
| `incidentId` | Equal to the id of the diagnosis record of the alert (a UUID). It stays stable for the life of the incident. |
| `eventId` | A decimal string of a positive 63-bit integer. It grows strictly (section 8.1). |
| `scope` | One of the scope names in section 4.2. |

### 3.1 `Incident`

```json
{
  "id": "uuid",
  "uri": "headlamp://incidents/{id}",
  "name": "string (the alertname)",
  "severity": "critical | warning | info | none",
  "state": "open | acknowledged | resolved",
  "escalated": "boolean",
  "labels": "object of string to string (the alert labels)",
  "annotations": "object of string to string",
  "fingerprint": "string",
  "test": "boolean (true when labels.test is \"true\")",
  "startsAt": "RFC 3339 (when the alert started)",
  "createdAt": "RFC 3339 (when the incident opened)",
  "updatedAt": "RFC 3339",
  "fires": "integer (how many times the alert fired, at least 1)",
  "acknowledgedAt": "RFC 3339 or null",
  "acknowledgedBy": "string or null",
  "resolvedAt": "RFC 3339 or null",
  "resolvedBy": "string or null (an operator, or \"alert\" when the alert resolved)",
  "resolution": "string or null",
  "escalatedAt": "RFC 3339 or null",
  "noteCount": "integer",
  "investigation": "InvestigationSummary"
}
```

`state` rules: `resolved` when `resolvedAt` is set. Otherwise `acknowledged` when `acknowledgedAt` is set. Otherwise `open`. `escalated` does not change `state`.

All strings are masked for secrets by the same function as the rest of the agent. All strings are at most 4096 characters, except `labels` and `annotations` values, which keep their original length up to 8192.

### 3.2 `InvestigationSummary`

```json
{
  "status": "none | queued | running | done | failed",
  "attempt": "integer (0 when status is none)",
  "model": "string or null",
  "startedAt": "RFC 3339 or null",
  "finishedAt": "RFC 3339 or null",
  "error": "string or null",
  "automatic": "boolean (true when the agent started it on its own, false when a client or an operator started it)"
}
```

`status: "none"` means no investigation exists. This is the normal state of an incident that opened while "Automatic investigations" is off.

### 3.3 `Investigation`

`InvestigationSummary` plus:

```json
{
  "incidentId": "uuid",
  "uri": "headlamp://investigations/{incidentId}",
  "toolCalls": "integer",
  "previousAttempts": [{ "at": "RFC 3339", "model": "string", "error": "string" }]
}
```

The investigation id equals the incident id. An incident has at most one current investigation. A new run replaces it and adds the old failed run to `previousAttempts`.

### 3.4 `InvestigationResult`

```json
{
  "summary": "string",
  "likelyCause": "string",
  "confidence": "high | medium | low",
  "signals": [{ "text": "string", "evidence": ["fact id"], "holds": "boolean" }],
  "fixes": [{ "title": "string", "detail": "string", "command": "string (optional, read-only)", "recommended": "boolean" }],
  "verify": "string",
  "evidence": [{ "id": "string", "tool": "string", "reason": "string", "summary": "string", "ok": "boolean" }]
}
```

This is the existing diagnosis result of the agent (`DiagnosisResult`) plus its evidence list without raw tool data.

### 3.5 `TimelineEntry`

```json
{
  "seq": "integer (1 for the first entry, no gaps within one incident)",
  "at": "RFC 3339",
  "kind": "fired | refired | alert_resolved | investigation_queued | investigation_started | investigation_done | investigation_failed | acknowledged | note | escalated | resolved",
  "actor": "string (an operator name, a token client name, \"alert\" or \"agent\")",
  "text": "string or null",
  "data": "object or null (small, kind specific)"
}
```

### 3.6 `Event`

```json
{
  "id": "eventId",
  "at": "RFC 3339",
  "kind": "see section 7.1",
  "uri": "string (the primary resource URI of the event)",
  "incidentId": "uuid or null",
  "labels": "object of string to string (at most 32 entries, values cut to 256 characters)",
  "actor": "string or null"
}
```

An event never carries incident content such as notes, annotations or results. Clients read the resource for content.

### 3.7 `Error`

```json
{ "code": "see section 12", "message": "string (masked)", "requiredScope": "scope (only for forbidden)", "retryAfterSeconds": "integer (optional)" }
```

## 4. Authentication and scopes

### 4.1 Bearer tokens

Every request to `/mcp` and every ACP upgrade request carries `Authorization: Bearer <token>`. The token is an opaque string of at least 32 bytes of randomness (base64url). The server never logs it and never returns it.

### 4.2 Scopes

| Scope | Allows |
| --- | --- |
| `registry:read` | The existing read-only registry tools (`list_alerts`, `list_resources`, `disk_health_*`, `query_metrics` and the rest) and `list_nodes`, `list_workloads`. The A2UI view resource. |
| `incidents:read` | Read incident tools, incident resources, the timeline, the event log, subscriptions to them. |
| `incidents:write` | `add_incident_note`, `acknowledge_incident`. |
| `incidents:resolve` | `resolve_incident`, `escalate_incident`. |
| `agent:investigate` | `start_investigation`, `get_investigation_status`, `get_investigation_result`. Investigation resources and subscriptions. The ACP endpoint. |
| `storage:read` | Storage tools and storage resources. |
| `settings:read` | `get_automatic_investigations` and the settings resource. |

No scope implies another scope. A client that writes notes needs `incidents:read` and `incidents:write`. The `agent:investigate` scope lets a client read the investigation of any incident it knows the id of. It does not allow reading incident bodies.

### 4.3 Tokens in a Kubernetes Secret

MCP and ACP share one token module (`agent/src/auth/scopes.ts`) and one token file.

| Item | Value |
| --- | --- |
| Secret | `headlamp-agent-api-tokens` in namespace `headlamp-agent` (sealed in the chart) |
| Key | `tokens.json` |
| Mount | Read-only file. The environment variable `AGENT_API_TOKENS_FILE` names the file. |
| Format | A JSON array: `[{ "name": "example-client", "token": "<at least 16 characters>", "scopes": ["incidents:read"] }]`. An entry may have `"sha256"` (64 hex characters, the SHA-256 of the token) in place of `token`. |

- `name` is the client name. It is the actor in audit entries and timeline entries, and the `client` label of metrics. Use a DNS label of 1 to 40 characters of `a-z0-9-`.
- `scopes` lists scope names from section 4.2. An entry with a scope name that this contract does not define is refused, and the failure counts as `bad_scopes`.
- The agent reads the file again when it changes. A Secret update needs no restart.
- The agent compares SHA-256 digests in constant time. It never logs a token.
- Two clients MUST NOT share a token.

### 4.4 Other callers

| Caller | Scopes granted |
| --- | --- |
| Valid bearer token | The scopes of that entry. |
| No `Authorization` header, and `MCP_AUTH=optional` (default in 1.0.0) | `registry:read` only. This keeps the existing anonymous read-only clients working. These callers get no session and cannot subscribe. |
| No `Authorization` header, and `MCP_AUTH=required` | None. HTTP 401. |
| Request on the `session` port | Not served in 1.0.0. The listener treats the request like one on the main port. |

A request that carries a bearer header with an unknown token, a token with unknown scopes, or no token file at all, fails with HTTP 401 in both modes. A later release changes the default of `MCP_AUTH` to `required`. That change is announced as a minor contract version. ACP always needs a token (docs/acp-endpoint.md).

### 4.5 Auth failures

| Case | Response |
| --- | --- |
| Missing header, mode `required` | HTTP 401, header `WWW-Authenticate: Bearer realm="headlamp-agent"`, body `{ "error": { "code": "unauthenticated", "message": "..." } }`. |
| Invalid token | HTTP 401, header `WWW-Authenticate: Bearer realm="headlamp-agent", error="invalid_token"`, same body. |
| Origin not allowed | HTTP 403, JSON-RPC error `-32600`, as before. |
| Session of another client | HTTP 403, body with code `forbidden`. |
| Scope missing | See section 12. |

`tools/list` returns only the tools the caller may call. `resources/list` and `resources/templates/list` return only the resources the caller may read.

## 5. Tools

Every tool returns `structuredContent` that matches its output schema, a text content block with a one-line summary, and (as the existing tools do) an A2UI data update. Write tools set `readOnlyHint: false`. `destructiveHint` is `false` for all tools of this contract, because nothing deletes data. Input objects set `additionalProperties: false`. A client MUST NOT send unknown fields.

All write tools accept an optional `requestId` (string, 1 to 64 characters of `A-Za-z0-9._-`). The server remembers the result of a write for 24 hours, keyed by incident, client name, tool name and `requestId`. A repeated call with the same key returns the first result with `replayed: true` and writes nothing again. A repeated key with different arguments fails with `conflict`.

### 5.1 Incident tools

#### `list_incidents`

| Item | Value |
| --- | --- |
| Scope | `incidents:read` |
| Idempotent | Yes (read only) |

Input:

```json
{
  "state": { "enum": ["open", "acknowledged", "resolved", "active"], "description": "active = open or acknowledged. Default: active." },
  "severity": { "type": "array", "items": { "enum": ["critical", "warning", "info", "none"] } },
  "labels": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Every pair must match exactly." },
  "test": { "type": "boolean", "description": "true: only test incidents. false: no test incidents. Absent: both." },
  "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 },
  "cursor": { "type": "string", "description": "From nextCursor of the previous page." }
}
```

Output: `{ "incidents": [Incident], "nextCursor": "string or null", "total": "integer" }`. Order: newest `createdAt` first. A cursor expires after 1 hour (`cursor_expired`).

#### `get_incident`

Scope `incidents:read`. Input `{ "incidentId": "uuid" }`. Output `{ "incident": Incident }`. Errors: `not_found`.

#### `get_incident_timeline`

Scope `incidents:read`. Input `{ "incidentId": "uuid", "afterSeq": "integer, default 0", "limit": "integer 1 to 500, default 200" }`. Output `{ "incidentId": "uuid", "entries": [TimelineEntry], "nextAfterSeq": "integer or null" }`. Errors: `not_found`.

#### `acknowledge_incident`

| Item | Value |
| --- | --- |
| Scope | `incidents:write` |
| Idempotent | Yes. Acknowledging an acknowledged or resolved incident changes nothing and returns `changed: false`. |

Input `{ "incidentId": "uuid", "note": "string, optional, at most 2000", "requestId": "optional" }`. Output `{ "incident": Incident, "changed": "boolean", "replayed": "boolean" }`. Effects: sets `acknowledgedAt` and `acknowledgedBy` (the client name), adds a timeline entry `acknowledged`, raises event `incident.acknowledged`. An acknowledgement does not stop push notifications for new fires. Errors: `not_found`.

#### `add_incident_note`

| Item | Value |
| --- | --- |
| Scope | `incidents:write` |
| Idempotent | No. Use `requestId` to make a retry safe. |

Input `{ "incidentId": "uuid", "text": "string, 1 to 4000", "requestId": "optional" }`. Output `{ "entry": TimelineEntry, "incident": Incident, "replayed": "boolean" }`. Effects: adds a timeline entry `note`, increases `noteCount`, raises `incident.note_added`. Allowed on resolved incidents. Errors: `not_found`, `invalid_argument`.

#### `resolve_incident`

| Item | Value |
| --- | --- |
| Scope | `incidents:resolve` |
| Idempotent | Yes. Resolving a resolved incident returns `changed: false`. |

Input `{ "incidentId": "uuid", "resolution": "string, optional, at most 2000", "requestId": "optional" }`. Output `{ "incident": Incident, "changed": "boolean", "replayed": "boolean" }`. Effects: sets `resolvedAt`, `resolvedBy`, `resolution`, adds timeline entry `resolved`, raises `incident.resolved`. A manual resolve does not silence vmalert. If the alert fires again with a new `startsAt`, a new incident opens. Errors: `not_found`.

#### `escalate_incident`

| Item | Value |
| --- | --- |
| Scope | `incidents:resolve` |
| Idempotent | No. A second escalation adds a second timeline entry and a second push. Use `requestId` for safe retries. |

Input `{ "incidentId": "uuid", "reason": "string, 1 to 2000", "requestId": "optional" }`. Output `{ "incident": Incident, "replayed": "boolean" }`. Effects: sets `escalated: true` and `escalatedAt`, adds timeline entry `escalated`, raises `incident.escalated`, and sends an urgent Web Push notification through the existing push service. Errors: `not_found`, `conflict` (the incident is resolved).

### 5.2 Investigation tools

The "Automatic investigations" setting controls only investigations that the agent starts on its own. A client call to `start_investigation` always works, also when the setting is off.

#### `start_investigation`

| Item | Value |
| --- | --- |
| Scope | `agent:investigate` |
| Idempotent | Yes while a run is queued or running. |

Input `{ "incidentId": "uuid", "model": "string, optional (a model id from the agent model list)", "force": "boolean, default false", "requestId": "optional" }`. Output `{ "investigation": Investigation, "started": "boolean", "replayed": "boolean" }`.

Rules: when a run is queued or running, `started` is `false` and the current run returns. When a finished run exists and `force` is `false`, `started` is `false` and the finished run returns. Otherwise a new run starts (`started: true`, `attempt` plus 1, `automatic: false`). A client run does not count against the hourly automatic limit. The number of concurrent client runs is limited by the existing re-run limit. Errors: `not_found`, `unavailable` (no model is configured), `rate_limited` (re-run limit, with `retryAfterSeconds`), `invalid_argument` (unknown model).

#### `get_investigation_status`

Scope `agent:investigate`. Input `{ "incidentId": "uuid" }`. Output `{ "investigation": Investigation }`. For an incident without a run the status is `none`. Errors: `not_found`.

#### `get_investigation_result`

Scope `agent:investigate`. Input `{ "incidentId": "uuid" }`. Output `{ "investigation": Investigation, "result": "InvestigationResult or null" }`. `result` is `null` unless `status` is `done`. When the status is `queued` or `running` the call fails with `not_ready`. When the status is `none` it fails with `not_found`. When the status is `failed` it returns the failed investigation with `result: null`.

### 5.3 Storage tools

All storage tools need scope `storage:read`. They are read only and idempotent. They reuse the registry and storage code of the agent. Output objects below name the **required** fields. A response MAY add fields (section 14).

| Tool | Input | Output |
| --- | --- | --- |
| `list_storage_volumes` | `{ "namespace": "string, optional", "node": "string, optional" }` | `{ "volumes": [{ "name": "PV name", "claim": "namespace/name or null", "storageClass": "string or null", "capacityBytes": "integer", "phase": "string", "node": "string or null" }] }` |
| `list_storage_disks` | `{ "node": "string, optional" }` | `{ "disks": [{ "node": "string", "device": "string", "model": "string", "smartPassed": "boolean or null", "temperatureC": "number or null", "problems": ["string"] }] }` |
| `get_storage_smart` | `{ "node": "string, optional", "device": "string, optional" }` | `{ "disks": [same objects as the existing tool disk_health_smart: node, device, model, smartPassed, temperatureC, mediaErrors, percentageUsed, attributes, problems] }` |
| `get_storage_capacity` | `{ "node": "string, optional", "minUsedPercent": "number 0 to 100, optional" }` | `{ "filesystems": [same objects as the existing tool disk_health_capacity: node, mountpoint, device, usedPercent, availGiB, growthGiB6h, inodesUsedPercent] }` |

`get_storage_smart` and `get_storage_capacity` return what `disk_health_smart` and `disk_health_capacity` return today. Errors: `unavailable` when the metrics backend does not answer.

### 5.4 Extra tools

| Tool | Scope | Input | Output |
| --- | --- | --- | --- |
| `list_nodes` | `registry:read` | `{}` | `{ "nodes": [{ "name": "string", "ready": "boolean", "roles": ["string"], "kubeletVersion": "string", "cpuAllocatable": "string", "memoryAllocatable": "string", "conditions": [{ "type": "string", "status": "string" }] }] }` |
| `list_workloads` | `registry:read` | `{ "namespace": "string, optional", "kind": "enum Deployment, StatefulSet, DaemonSet, optional", "unhealthyOnly": "boolean, default false" }` | `{ "workloads": [{ "kind": "string", "namespace": "string", "name": "string", "desired": "integer", "ready": "integer", "available": "integer" }] }` |
| `list_alerts` | `registry:read` | unchanged from the existing tool | unchanged from the existing tool (the alerts that vmalert holds now) |

### 5.5 Settings tool

`get_automatic_investigations`: scope `settings:read`. Input `{}`. Output `{ "enabled": "boolean", "changedAt": "RFC 3339 or null", "changedBy": "string or null" }`. A change of the setting raises event `settings.changed`.

### 5.6 Existing tools

All existing registry tools keep their names, schemas and read-only annotations. They need scope `registry:read`. The resource template `a2ui://headlamp-agent/diagnoses/{id}` keeps working and needs `incidents:read`.

## 6. Resources and templates

URI scheme: `headlamp://`. All resource contents have `mimeType: application/json` and one `text` item. The text is the JSON of the output type named below.

### 6.1 Resources

| URI | Content | Scope | Subscribe |
| --- | --- | --- | --- |
| `headlamp://incidents` | `{ "incidents": [Incident], "total": integer }` (active incidents, newest first, at most 200) | `incidents:read` | Yes |
| `headlamp://events` | Event log head: `{ "latest": eventId or null, "oldestRetained": eventId or null, "retentionHours": 168 }` | `incidents:read` | Yes (all events) |
| `headlamp://settings/automatic-investigations` | Output of `get_automatic_investigations` | `settings:read` | Yes |
| `headlamp://storage/volumes` | Output of `list_storage_volumes` | `storage:read` | Yes |
| `headlamp://storage/disks` | Output of `list_storage_disks` | `storage:read` | Yes |
| `headlamp://storage/smart` | Output of `get_storage_smart` | `storage:read` | Yes |
| `headlamp://storage/capacity` | Output of `get_storage_capacity` | `storage:read` | Yes |
| `headlamp://contract` | `{ "contract": "1.0.0", "scopes": [...], "eventKinds": [...], "retentionHours": 168 }` | any valid caller | No |

### 6.2 Resource templates (RFC 6570)

| Template | Content | Scope | Subscribe |
| --- | --- | --- | --- |
| `headlamp://incidents/{id}` | `{ "incident": Incident }` | `incidents:read` | Yes |
| `headlamp://incidents/{id}/timeline` | Output of `get_incident_timeline` (all entries, at most 500) | `incidents:read` | Yes |
| `headlamp://investigations/{id}` | `{ "investigation": Investigation, "result": InvestigationResult or null }` | `agent:investigate` | Yes |
| `headlamp://incidents{?state,severity,label,test}` | A filtered `headlamp://incidents` | `incidents:read` | Yes |
| `headlamp://events{?after,limit,kind,label}` | Event log catch-up (section 8.3) | `incidents:read` | Yes (use the form without `after` and `limit`) |
| `headlamp://storage/{kind}/{node}` | The storage collection `{kind}` (`volumes`, `disks`, `smart`, `capacity`) for one node | `storage:read` | Yes |

Query parameters: `state` is one of `open`, `acknowledged`, `resolved`, `active`. `severity` and `label` can repeat. A `label` value is `key=value` (percent-encoded). Several `label` parameters must all match. `test` is `true` or `false`. `kind` is an event kind or a prefix that ends in `.` (`incident.` matches all incident events). `kind` can repeat.

`resources/list` returns the fixed resources and the first 200 active incidents (`headlamp://incidents/{id}`). Resource names are `{name} {createdAt}`.

## 7. Events and notifications

### 7.1 Event kinds

| Kind | Raised when | Primary `uri` |
| --- | --- | --- |
| `incident.created` | The alert webhook opens a new incident, or an operator or ACP agent publishes one | `headlamp://incidents/{id}` |
| `incident.updated` | The alert fires again (`fires` grows), labels or annotations change | `headlamp://incidents/{id}` |
| `incident.acknowledged` | `acknowledge_incident` or the Headlamp UI acknowledges | `headlamp://incidents/{id}` |
| `incident.note_added` | `add_incident_note` or the Headlamp UI adds a note | `headlamp://incidents/{id}/timeline` |
| `incident.escalated` | `escalate_incident` or the Headlamp UI escalates | `headlamp://incidents/{id}` |
| `incident.resolved` | The alert resolves, the reconciler resolves it, or an operator resolves it | `headlamp://incidents/{id}` |
| `investigation.queued` | A run is queued | `headlamp://investigations/{id}` |
| `investigation.started` | A run starts | `headlamp://investigations/{id}` |
| `investigation.done` | A run finishes with a result | `headlamp://investigations/{id}` |
| `investigation.failed` | A run fails | `headlamp://investigations/{id}` |
| `settings.changed` | "Automatic investigations" changes | `headlamp://settings/automatic-investigations` |
| `storage.updated` | A storage scan or reconcile changes volumes, disks or capacity | `headlamp://storage/{kind}` |

The agent raises each event from the code path that changes the state: the alert ingest, the diagnosis store update, the write tools and the settings change. No timer polls for changes. `incident.created` and `incident.resolved` also change the list of active incidents.

### 7.2 Which URIs an event updates

An event updates these URIs. A session gets one notification for each URI it subscribed to, from this list.

| Event kind | Updated URIs |
| --- | --- |
| `incident.created`, `incident.resolved` | the incident, its timeline, `headlamp://events`, every subscribed `headlamp://incidents{?...}` whose filter matches |
| `incident.updated`, `.acknowledged`, `.escalated`, `.note_added` | the incident, its timeline, `headlamp://events`, every subscribed `headlamp://incidents{?...}` whose filter matches |
| `investigation.*` | the investigation, the incident, its timeline, `headlamp://events`, matching `headlamp://incidents{?...}` |
| `settings.changed` | `headlamp://settings/automatic-investigations`, `headlamp://events` |
| `storage.updated` | the matching storage collection, `headlamp://storage/{kind}/{node}`, `headlamp://events` |

A filtered URI matches when the incident (at the time of the event) has the labels, state, severity and test flag in its query. A subscription to `headlamp://events{?kind,label}` matches the events whose kind and labels match.

The server also sends the notification for a URI to a session only if the session has the scope to read that URI. A subscription fails at subscribe time if it lacks the scope (section 12).

### 7.3 `notifications/resources/updated`

Server to client, on the push stream. The shape follows MCP and adds one `_meta` key:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": {
    "uri": "headlamp://incidents/6f1f0a52-0c1e-5a3e-8f0b-2f1c9a5d0e11",
    "_meta": {
      "dev.dynacom.headlamp/event": {
        "eventId": "48213",
        "kind": "incident.created",
        "incidentId": "6f1f0a52-0c1e-5a3e-8f0b-2f1c9a5d0e11",
        "at": "2026-11-28T00:15:00Z",
        "labels": { "alertname": "NodeNotReady", "severity": "critical", "test": "true" }
      }
    }
  }
}
```

- `params.uri` is exactly the string the client sent to `resources/subscribe`, byte for byte. The server does not rewrite or reorder it.
- `labels` holds the alert labels of the incident (at most 32 entries). It is empty for events without an incident.
- The notification never carries the incident body, notes, annotations or results.
- The SSE frame is `id: <eventId>`, `event: message`, `data: <the JSON above on one line>`.
- One event can produce several notifications on one session, one for each subscribed URI it updates. They share the same `eventId`. The client MUST de-duplicate by the pair (`eventId`, `uri`).

### 7.4 `notifications/resources/list_changed`

Server to client, on the push stream, to every session that is not stateless. The shape:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/list_changed",
  "params": {
    "_meta": {
      "dev.dynacom.headlamp/event": {
        "eventId": "48213",
        "kind": "incident.created",
        "incidentId": "6f1f0a52-0c1e-5a3e-8f0b-2f1c9a5d0e11",
        "at": "2026-11-28T00:15:00Z",
        "labels": { "alertname": "NodeNotReady", "test": "true" }
      }
    }
  }
}
```

The server sends it when the result of `resources/list` changes: after `incident.created` and after `incident.resolved` (an incident enters or leaves the active list). It also sends it once with `kind: "reset"` when a replay cannot be complete (section 8.5). The same SSE `id` rule as section 7.3 applies. A client re-reads `resources/list` or the collection resource.

### 7.5 Filtering by label (test incidents)

A test incident is an incident whose alert has the label `test` with the value `true`. The `Incident.test` field is `true` for it. A test alert SHOULD also carry the label `source` with a short name of the sender (for example `source=example-client`). Test incidents behave like all others, except that the agent MUST NOT send Web Push notifications for them unless the alert also carries the label `push=true`.

A subscriber filters in one of these ways:

1. Subscribe to `headlamp://incidents?label=test%3Dtrue` (only test incidents), or to `headlamp://incidents?test=false` (no test incidents).
2. Subscribe to `headlamp://events?label=test%3Dtrue&label=source%3Dexample-client`. The session gets only matching events.
3. Subscribe without a filter and filter on `_meta["dev.dynacom.headlamp/event"].labels` in the client.

`list_incidents` takes `labels` and `test` with the same meaning.

## 8. Event log, ordering and replay

### 8.1 Event ids

- Every event gets one `eventId` from one sequence in the agent database (PostgreSQL) when it is stored. The sequence is shared by all pods.
- Ids grow strictly with commit order of the event rows as seen by readers. A reader never sees id N+1 before id N is visible. Gaps are allowed (a rolled-back transaction can leave one).
- Ids are decimal strings. Compare them as integers, never as strings.
- In memory mode (tests, no database) the ids come from a process counter and are not durable.

### 8.2 Persistence and retention

- The agent writes each event to the table `mcp_events` in its PostgreSQL database in the same transaction as the state change, then sends it to sessions. A pod learns of events written by another pod through PostgreSQL `LISTEN`/`NOTIFY` (not by polling).
- Retention window: **7 days (168 hours)**, and at most 100,000 events. Whichever limit is reached first removes the oldest events. The server removes expired events at most once an hour.
- The window is part of the contract. A later minor version MAY lengthen it. It will not shorten it.

### 8.3 Durable catch-up resource

`headlamp://events?after=<eventId>&limit=<n>&kind=<kind>&label=<k=v>` returns:

```json
{
  "events": [Event],
  "nextAfter": "eventId (use as `after` in the next read)",
  "hasMore": "boolean",
  "latest": "eventId or null",
  "oldestRetained": "eventId or null",
  "reset": "boolean"
}
```

- `after` is exclusive: the result holds events with id greater than `after`. `after=0` starts at the oldest retained event.
- `limit` is 1 to 500, default 100. Events are in ascending id order.
- Without `after` the result has no events. It returns only `latest` and `oldestRetained`, so a new client can store a cursor before it subscribes.
- `kind` and `label` filter the events. `nextAfter` still moves over events that the filter hides, so a client never reads the same range twice.
- `reset` is `true` when `after` is non-zero and lower than the highest id that the server has ever removed (the server keeps this high-water mark). The result then starts at `oldestRetained`. The client MUST re-read the collections it uses (section 8.5).
- A client that reads catch-up pages until `hasMore` is `false` has seen every retained event after its cursor, exactly once, in order.

### 8.4 SSE resume with `Last-Event-ID`

- The SSE `id` of every event notification is its `eventId`.
- A client that reconnects `GET /mcp` with the same `Mcp-Session-Id` and `Last-Event-ID: <eventId>` gets, in ascending order, every notification for its subscriptions with an event id **greater than or equal to** the given id, then live notifications. The server includes the event with the given id again, because one event can produce several notifications and the connection can break between them. Delivery is therefore **at least once**. The client de-duplicates by (`eventId`, `uri`).
- Replay runs from the durable log, so it also works after a push stream was closed for a long time, if the session is still alive (section 1.1, rule 6) and the id is inside the window.
- Without `Last-Event-ID` the server sends only new events. It does not replay.
- A session that ended (HTTP 404) cannot resume. The client starts a new session, subscribes again and reads the catch-up resource with its last seen id.

### 8.5 Past the window

When `Last-Event-ID` or `after` is older than the oldest retained event, the server cannot give the missing events. It then:

1. On the push stream: sends `notifications/resources/list_changed` with `_meta["dev.dynacom.headlamp/event"].kind = "reset"`, `eventId` equal to the oldest retained id (so the stream ids still grow) and the extra key `latest` (the newest id), then replays from the oldest retained event, then goes live.
2. On the catch-up resource: sets `reset: true`.

After a reset the client MUST read `headlamp://incidents` (or `list_incidents`) and every incident resource it follows, and use the `latest` id as its new cursor.

### 8.6 Ordering and duplicates

- Events of one incident arrive in id order. The server never reorders events on one stream.
- Events with different ids arrive in id order on one stream. Between two streams there is no order promise.
- Duplicates are possible after resume (section 8.4) and after a client retry. De-duplicate by (`eventId`, `uri`).
- A notification can be older than the state a read returns. The client always reads the resource and treats that as truth. A read returns state at least as new as the notification.

## 9. Subscriptions

- `resources/subscribe` with `{ "uri": "<URI>" }` needs a stateful session and the scope of the URI. A URI that is neither a resource nor a match of a template fails with `-32002` (resource not found). The result is `{}`.
- `resources/unsubscribe` removes the subscription. It is idempotent.
- The same URI string subscribed twice is one subscription.
- One session holds at most 100 subscriptions. The next one fails with `rate_limited`.
- Subscriptions end with the session. They are not persisted. After a new session the client subscribes again.
- A subscription to a URI whose resource does not exist yet (for example `headlamp://incidents/{id}` for an unknown id) fails with `not_found`. A subscription to a filtered collection never fails for lack of matches.
- No notification is sent for the subscribing session about events with an id lower than the latest id at subscribe time. A client that needs history reads the catch-up resource.

## 10. Metrics

The agent exposes these on its existing `/metrics` endpoint (scraped by vmagent into VictoriaMetrics):

| Metric | Type | Labels |
| --- | --- | --- |
| `headlamp_agent_mcp_sessions_active` | gauge | none |
| `headlamp_agent_mcp_subscriptions_active` | gauge | none |
| `headlamp_agent_mcp_push_streams_active` | gauge | none |
| `headlamp_agent_mcp_events_sent_total` | counter | `kind` |
| `headlamp_agent_mcp_events_recorded_total` | counter | `kind` |
| `headlamp_agent_mcp_tool_calls_total` | counter | `tool`, `client` |
| `headlamp_agent_mcp_tool_errors_total` | counter | `tool`, `code` |
| `headlamp_agent_mcp_auth_failures_total` | counter | `reason` (`missing`, `invalid`, `bad_scopes`, `scope`) |
| `headlamp_agent_acp_connections_active` | gauge | none |
| `headlamp_agent_mcp_event_log_events` | gauge | none (rows in the log) |

The label `client` is the client name of the token (`anonymous` without a token). The label `tool` has one value per tool name of this contract and the existing tools.

## 11. Audit

Every write tool call and every settings change writes an audit line to the agent log and a timeline entry (or a settings record). The actor is the client name of the token, or the `X-Remote-User` value for session trust. The audit line never holds a token.

## 12. Errors

A tool failure returns `isError: true`, a text block with the message and `structuredContent` `{ "error": Error }`. Protocol failures (resources, subscriptions) return a JSON-RPC error with `data: { "code": "<code>" }`.

| `code` | JSON-RPC code | HTTP | Meaning |
| --- | --- | --- | --- |
| `unauthenticated` | n/a | 401 | No token, or an invalid token. |
| `forbidden` | `-32003` for `resources/subscribe`; see note | 403 for transport, 200 otherwise | The token lacks the scope. `requiredScope` names it (subscribe only). |
| `invalid_argument` | `-32602` | 200 | An input does not match its schema. For tools the server answers with a tool result `isError: true` and a text message from the validator, without `structuredContent`. |
| `not_found` | `-32002` | 200 | The incident, investigation or resource does not exist. |
| `conflict` | `-32000` | 200 | The state does not allow the action, or a `requestId` is reused with other arguments. |
| `not_ready` | `-32000` | 200 | The result does not exist yet. |
| `cursor_expired` | `-32602` | 200 | A list cursor is too old. Start again without a cursor. |
| `session_required` | `-32601` | 200 | The call needs a stateful session. |
| `rate_limited` | `-32000` | 200 (503 for the session limit) | A limit applies. `retryAfterSeconds` is set when known. |
| `unavailable` | `-32000` | 200 | A dependency is down or not configured (model, metrics backend). |
| `internal` | `-32603` | 200 | A server fault. The message is generic. |

`resources/subscribe` without the scope fails with JSON-RPC error `-32003`, `data.code = "forbidden"` and `data.requiredScope`. A `tools/call` or `resources/read` without the scope fails as for a disabled item: JSON-RPC error `-32602` with the message `Tool <name> disabled` or `Resource <uri> disabled`. A caller learns the needed scope from `_meta["dev.dynacom.headlamp/scope"]` of the tool in a listing of a client that has the scope, or from this document.

## 13. Setting "Automatic investigations"

The contract fixes only what clients see. The setting is stored on the server, changed in the Headlamp UI and audited. Read access is `get_automatic_investigations` and the settings resource (section 5.5). When the setting is off:

- The agent never starts an investigation on its own: not for the alert webhook, not for re-runs, not on resume after a restart.
- Incidents still open, push notifications still go out, and events still stream.
- An incident opens with `investigation.status: "none"`.
- A client can still call `start_investigation`.

## 14. Versioning and change rules

- The contract version is `MAJOR.MINOR.PATCH`. This file holds version 1.0.0.
- After the first merge to the default branch of this file, nothing in it changes in meaning. Allowed changes are additive:
  - a new tool, resource, template, event kind, scope, error code or metric;
  - a new optional input field;
  - a new field in an output object;
  - a longer retention window;
  - a note that clarifies without changing behaviour (patch).
- Not allowed: renaming or removing a name, field or scope; making an optional input required; changing a type, an enum value, a URI shape or an event id rule; shortening a limit.
- A breaking change needs a new major version in a new file (`docs/mcp-contract-v2.md`) and a new endpoint path. The v1 endpoint stays for at least 90 days.
- Clients MUST ignore unknown output fields, unknown event kinds and unknown `_meta` keys. A client that gets an unknown event kind reads the resource in `uri`.
- Servers MUST accept an input only if it matches the schema of the contract version they declare.
- The `capabilities.experimental["dev.dynacom.headlamp"].contract` value tells the client the version of the server.
- Every change to this file is a pull request that states the new version.

## 15. Quick client flow (informative)

1. `POST /mcp` `initialize` with `Authorization: Bearer ...`. Store `Mcp-Session-Id`.
2. Read `headlamp://events` and keep `latest` as the cursor.
3. `GET /mcp` with `Accept: text/event-stream` and the session id.
4. `resources/subscribe` for `headlamp://incidents?label=test%3Dtrue` (or a wider URI).
5. On a notification, read `uri`, store `eventId`, and read the resource for content.
6. After a break: reconnect `GET /mcp` with `Last-Event-ID`. On HTTP 404 start again from step 1 and read `headlamp://events?after=<cursor>` until `hasMore` is `false`.
