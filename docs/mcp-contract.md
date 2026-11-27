# Headlamp agent MCP and ACP contract

Contract version: **1.0.0**. Status: draft until the first merge. After the merge this file is **immutable**: only additive changes are allowed (section 13).

This contract covers the network MCP server and the network ACP endpoint of `headlamp-agent`. Clients use it to read incidents, receive incident events without polling, start investigations and read storage state. Both endpoints are private and reachable only inside the cluster (section 2).

Words in this document: "MUST", "MUST NOT", "SHOULD" and "MAY" have the meaning in RFC 2119.

The schemas that `tools/list` returns are **normative**. This document describes them. If the two differ, the `tools/list` schema is correct and the difference is a defect in this document.

Notation in type blocks: a field written `X or null` can be null. A field written `(optional)` can be absent. Every other field is always present and is never null. A type written as an enumeration with the note "open" can get new values in a minor version (section 3.8). Clients MUST accept unknown values in open enumerations.

## 1. Protocol and transport

| Item | Value |
| --- | --- |
| Protocol | Model Context Protocol (MCP) |
| Versions served | `2025-06-18`, `2025-11-25`, `2026-07-28` |
| Transport | Streamable HTTP, single endpoint `/mcp` |
| Message format | JSON-RPC 2.0, UTF-8 |
| Stateful sessions | `2025-06-18` and `2025-11-25` clients (push needs them) |
| Stateless fallback | `2026-07-28` per-request envelope clients, and 2025-era clients that do not use a session |

Adding a served protocol version is not a breaking change. Removing one is a breaking change (section 13).

### 1.1 Stateful session

1. The client sends `POST /mcp` with `initialize` and one protocol version. The server answers with the same version when it serves it. Otherwise it answers with another version that it serves, and the client MAY then end the connection.
2. The server answers with the `Mcp-Session-Id` response header. The value is an opaque string of at most 128 visible ASCII characters.
3. The client MUST send `Mcp-Session-Id` and `MCP-Protocol-Version` on every later request.
4. The client opens the push stream with `GET /mcp`, header `Accept: text/event-stream` and `Mcp-Session-Id`. The server sends all notifications on this stream. At most one push stream is open per session. A new `GET` for the same session **replaces** the old stream: the server closes the old stream and serves the new one. A new `GET` never fails because an old stream still looks open. In a stateful session the server answers every `POST` with `application/json`. The only SSE stream of a session is the `GET` push stream. A client therefore never resumes a `POST` stream.
5. The client sends `DELETE /mcp` with `Mcp-Session-Id` to end the session.
6. A session ends when it is deleted, or 30 minutes after its last request while no push stream is open. An open push stream keeps the session alive. The server sends an SSE comment line (`: keep-alive`) every 25 seconds.
7. The server keeps at most 200 sessions, and at most 20 sessions for each client name. The client name is the `name` of the token entry (section 4.3). It is not the `clientInfo.name` that the client sends in `initialize`. When the total limit is reached, `initialize` fails with HTTP 503 and `Retry-After: 30`. When the limit for one client is reached, `initialize` fails with HTTP 429 and `Retry-After: 30`. Both answers carry the error code `rate_limited`. The server counts a session from the start of `initialize`, so parallel requests cannot go over a limit.
8. A request with an unknown or ended `Mcp-Session-Id` fails with HTTP 404. The client MUST then start a new session, subscribe again and catch up with the event log (section 8.3). Sessions live in the memory of one pod. A rollout or a restart ends all sessions.
9. A session ends when its token no longer exists in the token file, or when the token has fewer scopes than at the start of the session. The server closes the push stream. The next request fails with HTTP 401 when the token is gone, and with HTTP 404 when the token has fewer scopes. The server checks this before it delivers each event, and at least once a minute. A scope that an operator adds to a token does not apply to a session that is already open. The client opens a new session to use it.

### 1.2 Stateless fallback

A request without `Mcp-Session-Id` that is not an `initialize` for a 2025 version is handled in stateless mode. Stateless mode serves tools, resources (read), prompts and skills. It does **not** support `resources/subscribe`, `resources/unsubscribe` or the push stream. The subscribe and unsubscribe calls fail with JSON-RPC error `-32601` and `data.code = "session_required"`. A `GET /mcp` without `Mcp-Session-Id` gets HTTP 405. Anonymous callers (section 4.4) always use stateless mode.

### 1.3 Capabilities

The `initialize` result declares:

```json
{
  "capabilities": {
    "tools": { "listChanged": false },
    "resources": { "subscribe": true, "listChanged": true },
    "prompts": { "listChanged": false },
    "experimental": {
      "headlamp-agent": {
        "contract": "1.0.0",
        "eventLog": { "uri": "headlamp://events", "retentionHours": 168 },
        "scopes": ["registry:read", "incidents:read", "incidents:write", "incidents:resolve", "agent:investigate", "storage:read", "settings:read"]
      }
    }
  }
}
```

In stateless mode `subscribe` and `listChanged` are `false`. The `scopes` list names the scopes that this contract defines. It does not name the scopes of the caller.

A client that needs this contract MUST check `capabilities.experimental["headlamp-agent"].contract`. The first number is the major version. This document has major version 1. Minor and patch numbers grow with additive changes.

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

**Push and ACP are in-cluster only.** The existing HTTPRoute and Emissary Mapping forward `/mcp` to the agent, but they set a request timeout (2 minutes) and Emissary has no WebSocket upgrade. A push stream through the hostname ends after 2 minutes, and `/acp` cannot upgrade there. The ACP endpoint has no public route (docs/acp-endpoint.md). A client MUST use the Service name above from inside the cluster. This contract adds no public exposure, no new Service and no new reverse proxy. The contract does not describe any route through a tailnet hostname.

**Network policy.** The network policy of the agent MUST admit the namespace of a client. A client in a namespace that the policy does not admit cannot reach the agent.

Sessions live in one pod, and the agent runs as one replica. The contract needs no `sessionAffinity`. After a rollout the client opens a new session (section 1.1, rule 8).

### 2.1 ACP endpoint

The ACP endpoint is `/acp` on the same Service and port (`ws://headlamp-agent.headlamp-agent.svc/acp`). It uses the same token file and the same scope check as MCP (section 4). Its scope is `agent:investigate`. The file [docs/acp-endpoint.md](acp-endpoint.md) is the authority for the framing, limits, close codes and error answers of ACP. This contract does not repeat them. ACP diagnoses publish through the same diagnosis store as webhook diagnoses, so they raise the same events (section 7). An ACP diagnosis opens a **new incident**. Its `incidentId` is the id of the diagnosis record that the run publishes. It does not join the incident of an existing alert, also when the alert has the same fingerprint. The agent MAY later resolve the older open incidents of the same fingerprint, as it does for webhook incidents.

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
  "severity": "string, open: critical | warning | info | none",
  "state": "closed: open | acknowledged | resolved",
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
  "status": "string, open: none | skipped | queued | running | done | failed",
  "attempt": "integer (0 when status is none or skipped)",
  "model": "string or null",
  "startedAt": "RFC 3339 or null",
  "finishedAt": "RFC 3339 or null",
  "error": "string or null",
  "automatic": "boolean (true when the agent started it on its own, false when a client or an operator started it)"
}
```

`status: "none"` means no investigation exists. `status: "skipped"` means the agent did not start an investigation because "Automatic investigations" was off when the incident opened (section 12). A server that does not record skipped incidents sends `none` for them. `skipped` behaves like `none` in every rule of this contract. The status is an open enumeration. A client MUST treat a value that it does not know like `none` for control flow, and MUST show it as text.

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
  "confidence": "closed: high | medium | low",
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
  "kind": "string, open: fired | refired | alert_resolved | investigation_queued | investigation_started | investigation_done | investigation_failed | acknowledged | note | escalated | resolved",
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
  "kind": "string, open: see section 7.1",
  "uri": "string (the primary resource URI of the event)",
  "incidentId": "uuid or null",
  "labels": "object of string to string (at most 32 entries, values cut to 256 characters)",
  "actor": "string or null"
}
```

When an incident has more than 32 labels, the event keeps the 32 smallest keys in byte order (UTF-8). The event of a storage volume (`storage.updated`) has the labels `node` and `volume` (section 7.1). An event never carries incident content such as notes, annotations or results. Clients read the resource for content. The kind `reset` is not stored in the log. It exists only as a push frame (section 8.5).

### 3.7 `Error`

```json
{
  "code": "string, open: see section 11",
  "message": "string (masked)",
  "requiredScope": "scope (optional, only for forbidden)",
  "retryAfterSeconds": "integer (optional)"
}
```

### 3.8 Open and closed enumerations

These enumerations are **open**. A later minor version can add values. A client MUST accept unknown values in them:

- `Incident.severity`
- `InvestigationSummary.status` (and so `Investigation.status`)
- `TimelineEntry.kind`
- `Event.kind` and the `kind` of an event notification
- `Error.code`

These enumerations are **closed**. A value is never added in 1.x:

- `Incident.state`
- `InvestigationResult.confidence`

The scope names are not an enumeration of an output. They grow only by a minor version (section 4.2).

The `tools/list` output schemas type open enumerations as `string` and list the known values in the description. Input enumerations (for example the `state` filter) are closed.

## 4. Authentication and scopes

### 4.1 Bearer tokens

A request to `/mcp` that is not anonymous (section 4.4) and every ACP upgrade request carries `Authorization: Bearer <token>`. The token is an opaque string. An operator SHOULD make it from at least 32 bytes of randomness (base64url). The server accepts a token of at least 16 characters. The server never logs it and never returns it.

### 4.2 Scopes

| Scope | Allows |
| --- | --- |
| `registry:read` | The registry tools that hold no incident, agent-launch or storage data (for example `cluster_overview`, `list_resources`, `list_alerts`, `query_metrics`, `list_alert_rules`, `list_nodes`, `list_workloads`). The A2UI view resource. |
| `incidents:read` | Read incident tools, incident resources, the timeline, the diagnosis tools `list_diagnoses` and `get_diagnosis`, the A2UI diagnosis resources `a2ui://headlamp-agent/diagnoses/{id}`, subscriptions to them. |
| `incidents:write` | `add_incident_note`, `acknowledge_incident`. |
| `incidents:resolve` | `resolve_incident`, `escalate_incident`. |
| `agent:investigate` | `start_investigation`, `get_investigation_status`, `get_investigation_result`, `list_agent_launches`. Investigation resources and subscriptions. The ACP endpoint. |
| `storage:read` | Storage tools, the registry tools `disk_health_smart`, `disk_health_performance`, `disk_health_capacity` and `disk_health`, and storage resources. |
| `settings:read` | `get_automatic_investigations` and the settings resource. |

No scope implies another scope. A client that writes notes needs `incidents:read` and `incidents:write`. The `agent:investigate` scope lets a client read the investigation of any incident it knows the id of. It does not allow reading incident bodies.

The event log (`headlamp://events`) needs a valid token with any scope. Each event shows only to a caller that has the scope of its primary URI (section 7.1, section 8.7).

**Planned narrowing (stated in 1.0.0).** Before this contract, the pre-contract server gave the A2UI diagnosis resources, `list_diagnoses`, `get_diagnosis`, `list_agent_launches` and `disk_health_*` to every caller of the registry. These items hold incident, agent-launch or storage data. From the first server release that serves this contract they need the scopes in the table above. An anonymous caller (section 4.4) does not get them. This is a deliberate one-time narrowing and it is part of 1.0.0. The `incident` field is not part of the output of `get_diagnosis`.

### 4.3 Tokens in a Kubernetes Secret

MCP and ACP share one token module (`agent/src/auth/scopes.ts`) and one token file.

| Item | Value |
| --- | --- |
| Secret | `headlamp-agent-api-tokens` in namespace `headlamp-agent` (sealed in the chart) |
| Key | `tokens.json` |
| Mount | Read-only file. The environment variable `AGENT_API_TOKENS_FILE` names the file. |
| Format | A JSON array: `[{ "name": "example-client", "token": "<at least 16 characters>", "scopes": ["incidents:read"] }]`. The server also accepts the object form `{ "tokens": [ ... ] }` with the same entries. An entry may have `"sha256"` (64 hex characters, the SHA-256 of the token) in place of `token`. |

- `name` is the client name. It is the actor in audit entries and timeline entries, and the `client` label of metrics. Use a DNS label of 1 to 40 characters of `a-z0-9-`. The name `anonymous` is reserved for callers without a token. The server refuses an entry with the name `anonymous`.
- `scopes` lists scope names. The server **ignores** a scope name that it does not know. The unknown name grants nothing. The server logs it and counts it (metric `bad_scopes`). The other scopes of the entry stay valid, so a client keeps its access when an operator adds a scope of a later minor version before the server update.
- The agent reads the file again when it changes. A Secret update needs no restart. Sessions follow section 1.1, rule 9.
- The agent compares SHA-256 digests in constant time. It never logs a token.
- Two clients MUST NOT share a token. A session belongs to the token that opened it, not only to its client name.

### 4.4 Other callers

| Caller | Scopes granted |
| --- | --- |
| Valid bearer token | The scopes of that entry. |
| No `Authorization` header, and `MCP_AUTH=optional` (default in 1.0.0) | **Anonymous.** `registry:read` only. No session and no subscription. Only the stateless mode (section 1.2). All incident, agent, storage and settings access needs a token. |
| No `Authorization` header, and `MCP_AUTH=required` | None. HTTP 401. |
| Request on the `session` port | Not served in 1.0.0. The listener treats the request like one on the main port. |

A request that carries a bearer header with an unknown token, or when no token file exists, fails with HTTP 401 in both modes. ACP always needs a token (docs/acp-endpoint.md). A later release MAY change the default of `MCP_AUTH` to `required`. This change breaks anonymous clients. It is the **one pre-announced breaking exception** to the rules in section 13. The notice period is at least 90 days, announced in this repository before the change.

### 4.5 Auth failures

| Case | Response |
| --- | --- |
| Missing header, mode `required` | HTTP 401, header `WWW-Authenticate: Bearer realm="headlamp-agent"`, body `{ "error": { "code": "unauthenticated", "message": "..." } }`. |
| Invalid token | HTTP 401, header `WWW-Authenticate: Bearer realm="headlamp-agent", error="invalid_token"`, same body. |
| Origin not allowed | HTTP 403, JSON-RPC error `-32600`. |
| Session of another token | HTTP 403, body with code `forbidden`. |
| Scope missing | See section 11. |

`tools/list` returns only the tools the caller may call. `resources/list` and `resources/templates/list` return only the resources the caller may read. A resource template that the caller may not read does not list any resource.

## 5. Tools

Every tool returns a text content block and, on success, `structuredContent` that matches its output schema. The existing registry tools also return an A2UI data update. Write tools set `readOnlyHint: false`. `destructiveHint` is `false` for all tools of this contract, because nothing deletes data. Input objects set `additionalProperties: false`. A client MUST NOT send unknown fields.

**Tool errors.** A failed tool call returns `isError: true`, **no** `structuredContent`, a text block that holds the `Error` object as JSON, and the same object in `_meta["headlamp-agent/error"]`. Generic MCP clients validate `structuredContent` against the output schema. An error body would fail that check, so it is not sent. The server checks the tool input itself. A wrong input returns this error shape with `code: "invalid_argument"`. A client MUST also accept a result with `isError: true` that has no `_meta["headlamp-agent/error"]` (for example the plain text of a generic MCP library). The client MUST treat that result as `invalid_argument`.

All write tools accept an optional `requestId` (string, 1 to 64 characters of `A-Za-z0-9._-`). The server remembers the result of a write for 24 hours, keyed by incident, client name, tool name and `requestId`. A repeated call with the same key returns the first result with `replayed: true` and writes nothing again. A repeated key with different arguments fails with `request_conflict`. The server checks the `requestId` before it checks the state of the incident, so a retry of a completed write returns the first result also after the incident resolved.

### 5.1 Incident tools

#### `list_incidents`

| Item | Value |
| --- | --- |
| Scope | `incidents:read` |
| Idempotent | Yes (read only) |

Input (JSON Schema, all fields optional):

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "state": { "enum": ["open", "acknowledged", "resolved", "active"], "description": "active = open or acknowledged. Default: active." },
    "severity": { "type": "array", "items": { "enum": ["critical", "warning", "info", "none"] } },
    "labels": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Every pair must match exactly." },
    "test": { "type": "boolean", "description": "true: only test incidents. false: no test incidents. Absent: both." },
    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 },
    "cursor": { "type": "string", "description": "From nextCursor of the previous page." }
  }
}
```

Output: `{ "incidents": [Incident], "nextCursor": "string or null", "total": "integer" }`. Order: newest `createdAt` first. A cursor expires after 1 hour (`cursor_expired`).

#### `get_incident`

Scope `incidents:read`. Input `{ "incidentId": "uuid" }` (required). Output `{ "incident": Incident }`. Errors: `not_found`.

#### `get_incident_timeline`

Scope `incidents:read`. Input: `incidentId` (string, required), `afterSeq` (integer, 0 or more, default 0), `limit` (integer 1 to 500, default 200). Output `{ "incidentId": "uuid", "entries": [TimelineEntry], "nextAfterSeq": "integer or null" }`. `nextAfterSeq` is null when no entry follows. Errors: `not_found`.

#### `acknowledge_incident`

| Item | Value |
| --- | --- |
| Scope | `incidents:write` |
| Idempotent | Yes. Acknowledging an acknowledged or resolved incident changes nothing and returns `changed: false`. |

Input: `incidentId` (string, required), `note` (string, at most 2000, optional), `requestId` (optional). Output `{ "incident": Incident, "changed": "boolean", "replayed": "boolean" }`. Effects: sets `acknowledgedAt` and `acknowledgedBy` (the client name), adds a timeline entry `acknowledged`, raises event `incident.acknowledged`. An acknowledgement does not stop push notifications for new fires. Errors: `not_found`.

#### `add_incident_note`

| Item | Value |
| --- | --- |
| Scope | `incidents:write` |
| Idempotent | No. Use `requestId` to make a retry safe. |

Input: `incidentId` (string, required), `text` (string, 1 to 4000, required), `requestId` (optional). Output `{ "entry": TimelineEntry, "incident": Incident, "replayed": "boolean" }`. Effects: adds a timeline entry `note`, increases `noteCount`, raises `incident.note_added`. Allowed on resolved incidents. Errors: `not_found`, `invalid_argument`.

#### `resolve_incident`

| Item | Value |
| --- | --- |
| Scope | `incidents:resolve` |
| Idempotent | Yes. Resolving a resolved incident returns `changed: false`. |

Input: `incidentId` (string, required), `resolution` (string, at most 2000, optional), `requestId` (optional). Output `{ "incident": Incident, "changed": "boolean", "replayed": "boolean" }`. Effects: sets `resolvedAt`, `resolvedBy`, `resolution`, adds timeline entry `resolved`, raises `incident.resolved`. A manual resolve does not silence vmalert. If the alert fires again with a new `startsAt`, a new incident opens. Errors: `not_found`.

#### `escalate_incident`

| Item | Value |
| --- | --- |
| Scope | `incidents:resolve` |
| Idempotent | No. A second escalation adds a second timeline entry and a second push. Use `requestId` for safe retries. |

Input: `incidentId` (string, required), `reason` (string, 1 to 2000, required), `requestId` (optional). Output `{ "incident": Incident, "replayed": "boolean" }`. Effects: sets `escalated: true` and `escalatedAt`, adds timeline entry `escalated`, raises `incident.escalated`, and sends an urgent Web Push notification through the existing push service. The push text holds the masked reason. A test incident (section 7.5) gets **no** urgent push unless its alert also has the label `push=true`. Errors: `not_found`, `conflict` (the incident is resolved).

### 5.2 Investigation tools

The "Automatic investigations" setting controls only investigations that the agent starts on its own. A client call to `start_investigation` always works, also when the setting is off.

#### `start_investigation`

| Item | Value |
| --- | --- |
| Scope | `agent:investigate` |
| Idempotent | Yes while a run is queued or running. |

Input: `incidentId` (string, required), `model` (string, optional, a model id from the agent model list), `force` (boolean, default false), `requestId` (optional). Output `{ "investigation": Investigation, "started": "boolean", "replayed": "boolean" }`.

Rules: when a run is queued or running, `started` is `false` and the current run returns. When a finished run (`done` or `failed`) exists and `force` is `false`, `started` is `false` and the finished run returns. A status of `none` or `skipped` is not a finished run: a new run starts without `force`. Otherwise a new run starts (`started: true`, `attempt` plus 1, `automatic: false`). A client run does not count against the hourly automatic limit. The number of concurrent client runs is limited by the existing re-run limit. Errors: `not_found`, `unavailable` (no model is configured), `rate_limited` (re-run limit, with `retryAfterSeconds`), `invalid_argument` (unknown model).

#### `get_investigation_status`

Scope `agent:investigate`. Input `{ "incidentId": "string (required)" }`. Output `{ "investigation": Investigation }`. For an incident without a run the status is `none` or `skipped`. Errors: `not_found`.

#### `get_investigation_result`

Scope `agent:investigate`. Input `{ "incidentId": "string (required)" }`. Output `{ "investigation": Investigation, "result": "InvestigationResult or null" }`. `result` is `null` unless `status` is `done`. When the status is `queued` or `running` the call fails with `not_ready`. When the status is `none` or `skipped` it fails with `not_found`. When the status is `failed` it returns the failed investigation with `result: null`.

### 5.3 Storage tools

All storage tools need scope `storage:read`. They are read only and idempotent. They reuse the registry and storage code of the agent. Each output object below lists **every** field. A response MAY add fields (section 13).

Types (a field `X or null` can be null):

```json
{
  "StorageVolume": { "name": "string (PV name)", "claim": "string or null (namespace/name)", "storageClass": "string or null", "capacityBytes": "integer", "phase": "string", "node": "string or null" },
  "StorageDisk": { "node": "string", "device": "string", "model": "string", "smartPassed": "boolean or null", "temperatureC": "number or null", "problems": ["string"] },
  "SmartDisk": {
    "node": "string", "device": "string", "model": "string",
    "smartPassed": "boolean or null", "temperatureC": "number or null", "mediaErrors": "number or null", "percentageUsed": "number or null",
    "attributes": "object of string (attribute name) to number",
    "problems": ["string"]
  },
  "Filesystem": {
    "node": "string", "mountpoint": "string", "device": "string",
    "usedPercent": "number", "availGiB": "number", "growthGiB6h": "number or null", "inodesUsedPercent": "number or null"
  }
}
```

| Tool | Input (all optional) | Output |
| --- | --- | --- |
| `list_storage_volumes` | `namespace` (string), `node` (string) | `{ "volumes": [StorageVolume] }` |
| `list_storage_disks` | `node` (string) | `{ "disks": [StorageDisk] }` |
| `get_storage_smart` | `node` (string), `device` (string) | `{ "disks": [SmartDisk] }` |
| `get_storage_capacity` | `node` (string), `minUsedPercent` (number 0 to 100) | `{ "filesystems": [Filesystem] }` |

Errors: `unavailable` when the metrics backend does not answer.

### 5.4 Extra tools

Types:

```json
{
  "Node": { "name": "string", "ready": "boolean", "roles": ["string"], "kubeletVersion": "string", "cpuAllocatable": "string", "memoryAllocatable": "string", "conditions": [{ "type": "string", "status": "string" }] },
  "Workload": { "kind": "string", "namespace": "string", "name": "string", "desired": "integer", "ready": "integer", "available": "integer" },
  "Alert": { "name": "string", "state": "string", "severity": "string", "labels": "object of string to string", "annotations": "object of string to string", "activeAt": "string (RFC 3339 or empty)", "value": "string", "expression": "string" }
}
```

| Tool | Scope | Input | Output |
| --- | --- | --- | --- |
| `list_nodes` | `registry:read` | `{}` | `{ "nodes": [Node] }` |
| `list_workloads` | `registry:read` | `namespace` (string, optional), `kind` (`Deployment`, `StatefulSet` or `DaemonSet`, optional), `unhealthyOnly` (boolean, default false) | `{ "workloads": [Workload] }` |
| `list_alerts` | `registry:read` | `state` (`firing`, `pending` or `any`, default `any`) | `{ "alerts": [Alert] }` (the alerts that vmalert holds now) |

### 5.5 Settings tool

`get_automatic_investigations`: scope `settings:read`. Input `{}`. Output `{ "enabled": "boolean", "changedAt": "RFC 3339 or null", "changedBy": "string or null" }`. `changedBy` is the name that came with the last change. It is a claim of the caller and not proof of identity. It is `null` when no name came with the change, or when the name is empty. A change of the setting raises event `settings.changed`.

### 5.6 Existing tools

The registry tools keep their names, schemas and read-only annotations, with these changes:

- `get_diagnosis` no longer returns the `incident` field. It returns the diagnosis without incident notes and timeline.
- `list_diagnoses` and `get_diagnosis` need `incidents:read`. `list_agent_launches` needs `agent:investigate`. The tools `disk_health_smart`, `disk_health_performance`, `disk_health_capacity` and `disk_health` need `storage:read`. All other registry tools need `registry:read`.
- The resource template `a2ui://headlamp-agent/diagnoses/{id}` keeps working and needs `incidents:read` (the planned narrowing of section 4.2).

Every tool of the server has `_meta["headlamp-agent/scope"]`, which names the scope that the tool needs.

## 6. Resources and templates

URI scheme: `headlamp://`. All resource contents have `mimeType: application/json` and one `text` item. The text is the JSON of the output type named below.

### 6.1 Resources

| URI | Content | Scope | Subscribe |
| --- | --- | --- | --- |
| `headlamp://incidents` | `{ "incidents": [Incident], "total": integer }` (active incidents, newest first, at most 200) | `incidents:read` | Yes |
| `headlamp://events` | Event log head: the object of section 8.3 with `events` empty, `nextAfter` equal to `latest` (or `"0"`), `hasMore` and `reset` false, plus `retentionHours` (168) | any valid token | Yes (all events that the caller may see) |
| `headlamp://settings/automatic-investigations` | Output of `get_automatic_investigations` | `settings:read` | Yes |
| `headlamp://storage/volumes` | Output of `list_storage_volumes` | `storage:read` | Yes |
| `headlamp://storage/disks` | Output of `list_storage_disks` | `storage:read` | No |
| `headlamp://storage/smart` | Output of `get_storage_smart` | `storage:read` | No |
| `headlamp://storage/capacity` | Output of `get_storage_capacity` | `storage:read` | No |
| `headlamp://contract` | `{ "contract": "1.0.0", "scopes": [...], "eventKinds": [...], "retentionHours": 168 }` | `registry:read` (anonymous callers included) | No |

`eventKinds` lists the kinds that the log stores. It does not hold `reset`, which is a push frame only.

`logId` is a UUID that names this event log. It changes when the log is new (an empty database). A restore of the database to an older state does not change it. A client stores `logId` with its cursor.

### 6.2 Resource templates (RFC 6570)

| Template | Content | Scope | Subscribe |
| --- | --- | --- | --- |
| `headlamp://incidents/{id}` | `{ "incident": Incident }` | `incidents:read` | Yes |
| `headlamp://incidents/{id}/timeline` | Output of `get_incident_timeline` (all entries, at most 500) | `incidents:read` | Yes |
| `headlamp://investigations/{id}` | `{ "investigation": Investigation, "result": InvestigationResult or null }` | `agent:investigate` | Yes |
| `headlamp://incidents{?state,severity*,label*,test}` | A filtered `headlamp://incidents` | `incidents:read` | Yes |
| `headlamp://events{?after,logId,limit,kind*,label*}` | Event log catch-up (section 8.3) | any valid token | Yes (use the form without `after`, `logId` and `limit`) |
| `headlamp://storage/{kind}/{node}` | The storage collection `{kind}` (`volumes`, `disks`, `smart`, `capacity`) for one node | `storage:read` | Only for `kind` = `volumes` |

The `*` marks the RFC 6570 explode modifier. A list expands to repeated parameters (`label=a%3D1&label=b%3D2`), not to a comma list.

Query parameters: `state` is one of `open`, `acknowledged`, `resolved`, `active`. `severity` and `label` can repeat. A `label` value is `key=value` (percent-encoded). Several `label` parameters must all match. Two `label` parameters with the same key and different values match nothing. `test` is `true` or `false`. `kind` is an event kind or a prefix that ends in `.` (`incident.` matches all incident events). `kind` can repeat. `logId` is the `logId` that the client stored. A URI with a query key that its template does not name does not match the template. It fails like an unknown resource (`-32002`, `not_found`).

`resources/list` returns the fixed resources that the caller may read and, when the caller has `incidents:read`, the first 200 active incidents (`headlamp://incidents/{id}`). Resource names are `{name} {createdAt}`. A caller without `incidents:read` gets no incident URI and no incident name in any list.

## 7. Events and notifications

### 7.1 Event kinds

| Kind | Raised when | Primary `uri` | Scope of the primary `uri` |
| --- | --- | --- | --- |
| `incident.created` | The alert webhook opens a new incident, or an operator or ACP agent publishes one | `headlamp://incidents/{id}` | `incidents:read` |
| `incident.updated` | The alert fires again (`fires` grows), labels or annotations change | `headlamp://incidents/{id}` | `incidents:read` |
| `incident.acknowledged` | `acknowledge_incident` or the Headlamp UI acknowledges | `headlamp://incidents/{id}` | `incidents:read` |
| `incident.note_added` | `add_incident_note` or the Headlamp UI adds a note | `headlamp://incidents/{id}/timeline` | `incidents:read` |
| `incident.escalated` | `escalate_incident` or the Headlamp UI escalates | `headlamp://incidents/{id}` | `incidents:read` |
| `incident.resolved` | The alert resolves, the reconciler resolves it, or an operator resolves it | `headlamp://incidents/{id}` | `incidents:read` |
| `investigation.queued` | A run is queued | `headlamp://investigations/{id}` | `agent:investigate` |
| `investigation.started` | A run starts | `headlamp://investigations/{id}` | `agent:investigate` |
| `investigation.done` | A run finishes with a result | `headlamp://investigations/{id}` | `agent:investigate` |
| `investigation.failed` | A run fails | `headlamp://investigations/{id}` | `agent:investigate` |
| `settings.changed` | "Automatic investigations" changes (the event is written in the transaction of the change) | `headlamp://settings/automatic-investigations` | `settings:read` |
| `storage.updated` | A PersistentVolume appears, disappears or changes any field of `StorageVolume` (a Kubernetes watch, not a poll). The event `labels` hold `node` (the node of the volume, when it has one) and `volume` (the PV name). When the node of a volume changes, the server raises one event for the old node and one for the new node. | `headlamp://storage/volumes` | `storage:read` |
| `reset` | Push frame only, never stored (section 8.5). It goes to the session whose replay cannot be complete, whatever its scopes. | `headlamp://events` | any valid token |

The agent raises each event from the code path that changes the state: the alert ingest, the diagnosis store update, the write tools, the settings change and the PersistentVolume watch. No timer polls for changes. Capacity and SMART data come from metrics queries and have no event source, so they have no subscription. `incident.created` and `incident.resolved` also change the list of active incidents.

### 7.2 Which URIs an event updates

An event updates these URIs. A session gets one notification for each URI it subscribed to, from this list.

| Event kind | Updated URIs |
| --- | --- |
| `incident.created`, `incident.resolved` | the incident, its timeline, `headlamp://events`, every subscribed `headlamp://incidents{?...}` whose filter matches |
| `incident.updated`, `.acknowledged`, `.escalated`, `.note_added` | the incident, its timeline, `headlamp://events`, every subscribed `headlamp://incidents{?...}` whose filter matches |
| `investigation.*` | the investigation, the incident, its timeline, `headlamp://events`, matching `headlamp://incidents{?...}` |
| `settings.changed` | `headlamp://settings/automatic-investigations`, `headlamp://events` |
| `storage.updated` | `headlamp://storage/volumes`, `headlamp://storage/volumes/{node}` for the `node` of the event only, `headlamp://events` |

A filtered collection URI matches when the incident has the labels, state, severity and test flag of its query **before the event or after the event**. An incident that enters the collection, changes inside it or leaves it therefore updates the URI. For example, `incident.resolved` updates a subscription to `headlamp://incidents` (state `active`), because the incident matched before the event. The server stores the state before and after in the event. A replay uses the stored states, not the state now. Filters of subscriptions match the full labels that the server stores. They do not match the cut labels of the event (section 3.6). A subscription to `headlamp://events{?kind,label}` matches the events whose kind matches and whose full stored labels match.

The server sends the notification for a URI to a session only if the session has the scope to read that URI. A subscription fails at subscribe time if it lacks the scope (section 11). A notification that an `investigation.*` event causes on an incident URI or on a filtered collection goes to a session that has `incidents:read` but not `agent:investigate`. Its `kind` is `incident.updated`, because the investigation summary is part of `Incident`. The catch-up resource shows the `investigation.*` event itself only to a caller with `agent:investigate` (section 8.7).

### 7.3 `notifications/resources/updated`

Server to client, on the push stream. The shape follows MCP and adds one `_meta` key:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": {
    "uri": "headlamp://incidents/6f1f0a52-0c1e-5a3e-8f0b-2f1c9a5d0e11",
    "_meta": {
      "headlamp-agent/event": {
        "eventId": "48213",
        "kind": "incident.created",
        "uri": "headlamp://incidents/6f1f0a52-0c1e-5a3e-8f0b-2f1c9a5d0e11",
        "incidentId": "6f1f0a52-0c1e-5a3e-8f0b-2f1c9a5d0e11",
        "at": "2026-11-28T00:15:00Z",
        "labels": { "alertname": "NodeNotReady", "severity": "critical", "test": "true" }
      }
    }
  }
}
```

- `params.uri` is exactly the string the client sent to `resources/subscribe`, byte for byte. The server does not rewrite or reorder it.
- `_meta["headlamp-agent/event"].uri` is the primary URI of the event (section 7.1). A client that subscribed to `headlamp://events` uses it to see which resource changed, for example which storage collection.
- `labels` holds the alert labels of the incident (at most 32 entries, section 3.6). It is empty for events without an incident, except for `storage.updated` (section 7.1).
- The notification never carries the incident body, notes, annotations or results.
- The SSE frame is `id: <eventId>.<n>`, `event: message`, `data: <the JSON above on one line>`. `<n>` is the position of the notification among the notifications that this event produces for this session (1 for the first). The server orders them by `params.uri` in byte order, and the `list_changed` notification (section 7.4) comes last. While the subscriptions of the session stay the same, an SSE id names at most one notification. A replay (section 8.4) can send an id again that the old stream sent but the client did not read.
- One event can produce several notifications on one session, one for each subscribed URI it updates. They share the same `eventId` and have different SSE ids. The client MUST de-duplicate by the pair (`eventId`, `uri`).

### 7.4 `notifications/resources/list_changed`

Server to client, on the push stream, to every stateful session whose token has `incidents:read`. A session without `incidents:read` gets no `list_changed` that holds incident `_meta`. The shape:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/list_changed",
  "params": {
    "_meta": {
      "headlamp-agent/event": {
        "eventId": "48213",
        "kind": "incident.created",
        "uri": "headlamp://incidents/6f1f0a52-0c1e-5a3e-8f0b-2f1c9a5d0e11",
        "incidentId": "6f1f0a52-0c1e-5a3e-8f0b-2f1c9a5d0e11",
        "at": "2026-11-28T00:15:00Z",
        "labels": { "alertname": "NodeNotReady", "test": "true" }
      }
    }
  }
}
```

The server sends it when the result of `resources/list` changes: after `incident.created` and after `incident.resolved` (an incident enters or leaves the active list). The server also sends it with `kind: "reset"` to the session whose replay cannot be complete (section 8.5). The reset frame holds no incident data. The SSE id rule of section 7.3 applies. A client re-reads `resources/list` or the collection resource.

### 7.5 Test incidents

A test incident is an incident whose alert has the label `test` with the value `true`. The `Incident.test` field is `true` for it. A test alert SHOULD also carry the label `source` with a short name of the sender (for example `source=example-client`). Test incidents behave like all others, except that the agent MUST NOT send Web Push notifications for them, also not for `escalate_incident`, unless the alert also carries the label `push=true`.

Appendix A describes how a client creates a test incident today. That description is informative. A later minor version is planned to add the tool `create_test_incident` (scope `incidents:write`, it always sets `test=true`). A later release MAY require a token on the alert webhook for callers other than the alert sender.

A subscriber filters in one of these ways:

1. Subscribe to `headlamp://incidents?label=test%3Dtrue` (only test incidents), or to `headlamp://incidents?test=false` (no test incidents).
2. Subscribe to `headlamp://events?label=test%3Dtrue&label=source%3Dexample-client`. The session gets only matching events.
3. Subscribe without a filter and filter on `_meta["headlamp-agent/event"].labels` in the client.

`list_incidents` takes `labels` and `test` with the same meaning.

## 8. Event log, ordering and replay

### 8.1 Event ids

- Every event gets one `eventId` from one sequence in the agent database (PostgreSQL) when it is stored. The sequence is shared by all pods.
- **Id order is commit order.** A plain sequence does not give this: values are taken before the commit, and transactions commit out of order. Therefore every transaction that inserts events takes one transaction-level advisory lock before its first event insert, and holds it until it commits. It takes no row lock after that. Two such transactions never overlap, so the event with the higher id always commits later. A reader never sees id N+1 before id N is visible. As a second guard, a reader MAY limit its read to ids below the lowest id still in flight. Gaps are allowed (a rolled-back transaction leaves one).
- Ids are decimal strings. Compare them as integers, never as strings.
- In memory mode (tests, no database) the ids come from a process counter and are not durable.
- The time `at` of an event is the database time at the insert.

### 8.2 Persistence and retention

- The agent writes each event to the table `mcp_events` in its PostgreSQL database in the same transaction as the state change, then sends it to sessions. A pod learns of events written by another pod through PostgreSQL `LISTEN`/`NOTIFY` (not by polling). A failed read after a notification is retried with a back-off.
- Retention window: **7 days (168 hours)**, and at most 100,000 events. Whichever limit is reached first removes the oldest events. The server removes expired events at most once an hour.
- The server keeps the **high-water mark** of removed ids (the highest id that it ever removed). The mark survives restarts.
- The window is part of the contract. A later minor version MAY lengthen it. It will not shorten it.

### 8.3 Durable catch-up resource

`headlamp://events?after=<eventId>&logId=<uuid>&limit=<n>&kind=<kind>&label=<k=v>` returns:

```json
{
  "logId": "uuid",
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
- Without `after` the result has no events. It returns the full object with `events` empty and `nextAfter` equal to `latest` (or `"0"`), so a new client can store a cursor before it subscribes.
- `latest` is the highest id that the log ever stored. It keeps the last id when retention removed every event. It is `null` only for a log that never stored an event.
- `kind` and `label` filter the events. A `label` matches the full labels that the server stores, as in a subscription. The server also hides events whose primary URI needs a scope that the caller does not have (section 8.7). `nextAfter` still moves over events that a filter or a scope hides, so a client never reads the same range twice.
- `reset` is `true` in each of these cases:
  1. `after` is greater than 0 and lower than the high-water mark of removed ids. Events are lost.
  2. `after` is greater than `latest`. The log is newer or older than the client expects, for example after a database restore or a restart in memory mode. A log that has no events now but did store events before still has its `latest`, so a stored cursor does not cause a reset by itself.
  3. `logId` is given and differs from the `logId` of the log.

  In every case the page starts at `oldestRetained`, not after `after`. The client MUST re-read the collections it uses (section 8.5).
- A cursor of `"0"` never gets `reset: true`, also when events were stored and removed before the next read. A client that stores `"0"` MUST read the collections it follows once.
- A client that reads catch-up pages until `hasMore` is `false` has seen every retained event after its cursor that it may see, exactly once, in order.

### 8.4 SSE resume with `Last-Event-ID`

- The SSE `id` of an event notification is `<eventId>.<n>` (section 7.3).
- A client that reconnects `GET /mcp` with the same `Mcp-Session-Id` and `Last-Event-ID: <eventId>.<n>` gets, in ascending order, every notification that comes **strictly after** that id: first the notifications of event `<eventId>` with a position greater than `<n>`, then the notifications of all events with a higher id, then live notifications. A replay sends the `notifications/resources/updated` of the subscriptions of the session and also the `list_changed` notifications (section 7.4). Both count in `<n>`. The server does not send the given id again, but it can send again an id that an older stream sent and the client did not read. The client de-duplicates by (`eventId`, `uri`).
- The positions `<n>` follow the subscriptions of the session at the time of the replay. A client that changes its subscriptions during a break MUST read the resources it cares about after the change. A replay can send an event that happened before a subscription, when the subscription exists at the time of the replay.
- A server MAY start the push stream with a **priming event**: an SSE event with an id and empty data. It sends one only to a session that negotiated `2025-11-25` or later. Priming events and reset frames get ids of the form `p<k>`, where `k` grows in the session. A `Last-Event-ID` of this form resumes after the position that the server remembers for it. The server remembers at least the last 1000 such ids of a session. An id that it does not know (never issued, or forgotten) gets a `reset` frame (section 8.5) and then live notifications, with no replay.
- Replay runs from the durable log, so it also works after a push stream was closed for a long time, if the session is still alive (section 1.1, rule 6) and the id is inside the window.
- A replay sends at most **5,000 notifications**. When more would follow, the server sends a `reset` frame and goes live. Replay stops when the client closes the stream. The server holds a replay in memory until the response starts, so the cap also bounds this memory.
- Live notifications that arrive while a replay runs are not lost. The server delivers them after the replayed ones, in id order, without a repeated id. This holds also when the replay ends early with a reset frame.
- Without `Last-Event-ID` the server sends only new events. It does not replay.
- A session that ended (HTTP 404) cannot resume. The client starts a new session, subscribes again and reads the catch-up resource with its last seen id.

### 8.5 Past the window and resets

A **reset** says that the client cannot rely on events to know what changed. It happens when:

- the `eventId` part of `Last-Event-ID` is greater than 0 and lower than the high-water mark of removed ids,
- the `eventId` part is greater than `latest`,
- the id is unknown (section 8.4),
- a replay is longer than 5,000 notifications.

The server then:

1. On the push stream: sends `notifications/resources/list_changed` with `_meta["headlamp-agent/event"].kind = "reset"`. The `_meta` object holds `eventId` (always `"0"`, so that it never matches a real event in the de-duplication key), `uri` (`headlamp://events`), `incidentId` (`null`), `at`, `labels` (empty), `latest` (the newest event id or `null`) and `logId`. The SSE id has the form `p<k>` (section 8.4). When the cause is a lost window, the server then replays from the oldest retained event. When the cause is an unknown id, an id above `latest` or an over-long replay, it goes live at once.
2. On the catch-up resource: sets `reset: true`.

After a reset the client MUST read `headlamp://incidents` (or `list_incidents`) and every incident resource it follows. The cursor comes only from `_meta.latest` of the reset frame (or `latest` of the catch-up resource), together with `logId`. After a reset frame the client reads the catch-up resource from `_meta.latest`, so that it misses no event that came while it read the collections.

### 8.6 Ordering and duplicates

- Events of one incident arrive in id order. The server never reorders events on one stream.
- Events with different ids arrive in id order on one stream. Between two streams there is no order promise.
- Duplicates are possible after a client retry. De-duplicate by (`eventId`, `uri`).
- A notification can be older than the state a read returns. The client always reads the resource and treats that as truth. A read returns state at least as new as the notification.

### 8.7 Who sees which event

Any valid token can read the event log. Each event shows only to a caller that has the scope of its primary URI (section 7.1). This holds for the catch-up resource, for a subscription to `headlamp://events` and for a replay. A token with only `registry:read` sees no event. A token with only `incidents:read` sees no investigation, settings or storage event. A token with only `storage:read` sees `storage.updated` events and nothing else. Reset frames go to the session whose replay cannot be complete, whatever its scopes.

## 9. Subscriptions

- `resources/subscribe` with `{ "uri": "<URI>" }` needs a stateful session and the scope of the URI. A URI that is neither a resource nor a match of a template fails with `-32002` (resource not found). A resource that has no event source (section 6) fails with `-32002` and `data.code = "not_subscribable"`. The result is `{}`.
- `resources/unsubscribe` removes the subscription. It is idempotent.
- The same URI string subscribed twice is one subscription. Two URI strings that mean the same query (a different order of parameters) count as two subscriptions.
- One session holds at most 100 subscriptions. The next one fails with `rate_limited`.
- Subscriptions end with the session. They are not persisted. After a new session the client subscribes again.
- A subscription to a URI whose resource does not exist yet (for example `headlamp://incidents/{id}` for an unknown id) fails with `not_found`. A subscription to a filtered collection never fails for lack of matches.
- The server sends no live notification about an event with an id lower than or equal to the latest id at the start of the session (the `initialize`). It sends a live notification only for a subscription that exists when the event happens. A replay (section 8.4) is the exception: it sends the events after the given id for the subscriptions that exist at replay time. A client that needs history reads the catch-up resource.

## 10. Audit

Every write tool call and every settings change writes an audit line to the agent log and a timeline entry (or a settings record). The actor is the client name of the token, or the Headlamp operator name for actions in the Headlamp UI. The audit line never holds a token.

## 11. Errors

A tool failure returns `isError: true`, a text block with the `Error` as JSON, and `_meta["headlamp-agent/error"]` (section 5). It has no `structuredContent`. Protocol failures (resources, subscriptions) return a JSON-RPC error with `data: { "code": "<code>" }`. The list of codes is **open** (section 3.8).

| `code` | JSON-RPC code | HTTP | Meaning |
| --- | --- | --- | --- |
| `unauthenticated` | n/a | 401 | No token, or an invalid token. |
| `forbidden` | `-32003` for `resources/subscribe`; see note | 403 for transport, 200 otherwise | The token lacks the scope. `requiredScope` names it (subscribe only). |
| `invalid_argument` | `-32602` | 200 | An input does not match its schema. For tools the server answers with a tool result `isError: true` and the `Error` with this code. A client also treats an `isError` result without the `Error` as this code (section 5). |
| `not_found` | `-32002` | 200 | The incident, investigation or resource does not exist. |
| `not_subscribable` | `-32002` | 200 | The resource exists but has no event source. |
| `conflict` | `-32000` | 200 | The state does not allow the action. |
| `request_conflict` | `-32000` | 200 | A `requestId` is reused with other arguments. |
| `not_ready` | `-32000` | 200 | The result does not exist yet. |
| `cursor_expired` | `-32602` | 200 | A list cursor is too old. Start again without a cursor. |
| `session_required` | `-32601` | 200 | The call needs a stateful session. |
| `rate_limited` | `-32000` | 200 (503 or 429 for the session limits) | A limit applies. `retryAfterSeconds` is set when known. |
| `unavailable` | `-32000` | 200 | A dependency is down or not configured (model, metrics backend). |
| `internal` | `-32603` | 200 | A server fault. The message is generic. |

`resources/subscribe` without the scope fails with JSON-RPC error `-32003`, `data.code = "forbidden"` and `data.requiredScope`. A `tools/call` or `resources/read` without the scope fails as for a disabled item: JSON-RPC error `-32602` with the message `Tool <name> disabled` or `Resource <uri> disabled` (for a template: `Resource template <template> disabled`). A caller learns the needed scope from `_meta["headlamp-agent/scope"]` of the tool in a listing of a client that has the scope, or from this document.

## 12. Setting "Automatic investigations"

The contract fixes only what clients see. The setting is stored on the server, changed in the Headlamp UI and audited. Read access is `get_automatic_investigations` and the settings resource (section 5.5). When the setting is off:

- The agent never starts an investigation on its own: not for the alert webhook, not for re-runs, not on resume after a restart.
- Incidents still open, push notifications still go out, and events still stream.
- An incident opens with `investigation.status: "skipped"` (`"none"` from a server that does not record skipped incidents).
- A client can still call `start_investigation`.

## 13. Versioning and change rules

- The contract version is `MAJOR.MINOR.PATCH`. This file holds version 1.0.0.
- After the first merge to the default branch of this file, nothing in it changes in meaning. Allowed changes are additive:
  - a new tool, resource, template, event kind, scope, error code or served protocol version;
  - a new value in an open enumeration (section 3.8);
  - a new optional input field;
  - a new field in an output object;
  - a longer retention window;
  - a note that clarifies without changing behaviour (patch).
- Not allowed: renaming or removing a name, field, scope or served protocol version; making an optional input required; changing a type, a value of a closed enumeration, a URI shape or an event id rule; shortening a limit.
- A breaking change needs a new major version in a new file (`docs/mcp-contract-v2.md`) and a new endpoint path. The v1 endpoint stays for at least 90 days.
- **One pre-announced exception:** the default of `MCP_AUTH` can change from `optional` to `required` (section 4.4). This breaks anonymous clients. It needs a notice of at least 90 days and a minor version.
- Clients MUST ignore unknown output fields and unknown `_meta` keys. Clients MUST accept unknown values in open enumerations, including unknown event kinds. A client that gets an unknown event kind reads the resource in `uri`.
- Servers MUST accept an input only if it matches the schema of the contract version they declare.
- The `capabilities.experimental["headlamp-agent"].contract` value tells the client the version of the server.
- Every change to this file is a pull request that states the new version.
- Appendix A is **not** part of the contract. It can change in any release.

## 14. Quick client flow (informative)

1. `POST /mcp` `initialize` with `Authorization: Bearer ...`. Store `Mcp-Session-Id`.
2. Read `headlamp://events`. Keep `latest` as the cursor and `logId`.
3. `GET /mcp` with `Accept: text/event-stream` and the session id.
4. `resources/subscribe` for `headlamp://incidents?label=test%3Dtrue` (or a wider URI).
4b. Read `headlamp://events?after=<cursor>&logId=<logId>` until `hasMore` is `false`. This closes the gap between step 2 and step 4: events in that gap are not pushed.
5. On a notification, read `uri`, store `eventId`, and read the resource for content.
6. After a break: reconnect `GET /mcp` with `Last-Event-ID`. On a `reset` frame, re-read the collections and take `latest` as the new cursor. On HTTP 404 start again from step 1 and read `headlamp://events?after=<cursor>` until `hasMore` is `false`.

## Appendix A. Operational notes (not part of the contract)

This appendix can change in any release. Clients MUST NOT depend on it.

The agent exposes these metrics on its existing `/metrics` endpoint (scraped by vmagent into VictoriaMetrics). The ACP names follow the ACP endpoint page.

| Metric | Type | Labels |
| --- | --- | --- |
| `headlamp_agent_mcp_sessions_active` | gauge | none |
| `headlamp_agent_mcp_subscriptions_active` | gauge | none |
| `headlamp_agent_mcp_push_streams_active` | gauge | none |
| `headlamp_agent_mcp_events_sent_total` | counter | `kind` |
| `headlamp_agent_mcp_events_recorded_total` | counter | `kind` |
| `headlamp_agent_mcp_tool_calls_total` | counter | `tool`, `client` |
| `headlamp_agent_mcp_tool_errors_total` | counter | `tool`, `code` |
| `headlamp_agent_mcp_auth_failures_total` | counter | `reason` (`unconfigured`, `missing`, `invalid`, `scope`, `origin`, `bad_scopes`) |
| `headlamp_agent_acp_connections` | gauge | none |
| `headlamp_agent_mcp_event_log_events` | gauge | none (rows in the log) |

The label `client` is the client name of the token (`anonymous` without a token). The label `tool` has one value per tool name.

**Network policy.** The NetworkPolicy of the agent admits vmalert, vmagent, Emissary, Envoy Gateway and node address ranges to port 8080. The chart value `networkPolicy.clientNamespaces` is planned to hold a list of client namespaces that may also reach port 8080. The key can change in any release.

**How to create a test incident (informative).** Send an Alertmanager v2 alert to the webhook of the agent from a pod inside the cluster:

```
POST http://headlamp-agent.headlamp-agent.svc/api/v2/alerts
Content-Type: application/json

[{
  "labels": { "alertname": "ExampleTest", "severity": "warning", "test": "true", "source": "example-client" },
  "annotations": { "summary": "Test incident" },
  "startsAt": "2026-11-28T00:15:00Z"
}]
```

- The endpoint needs no bearer token. Its protection is the network: only pods in a namespace that the NetworkPolicy admits can reach it (section 2).
- `severity` MUST be one that the agent diagnoses (by default `warning` or `critical`), or no incident opens.
- A second `POST` of the same labels joins the open incident and raises `incident.updated` (`fires` grows). A client MAY repeat the `POST` to keep a test incident open: the reconciler resolves an open webhook incident when vmalert does not hold its alert, after a grace time of 2 minutes from the last fire.
- To end it, `POST` the same alert with `endsAt` in the past, or call `resolve_incident`.
- With "Automatic investigations" off, the incident opens with `investigation.status` `skipped` (`none` from a server that does not record skipped incidents, section 12).
