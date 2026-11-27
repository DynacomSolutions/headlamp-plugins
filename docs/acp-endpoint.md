# ACP endpoint

The headlamp-agent serves its incident-diagnosis agent over the Agent Client
Protocol (ACP) on the network. An outside ACP client can open a session, send a
prompt and read the stream of updates and the final result.

This page describes the endpoint. The stdio command `headlamp-agent acp` runs
the same agent.

## Address

| Item | Value |
| --- | --- |
| Path | `/acp` on the agent HTTP port (Service `headlamp-agent`, port 80, which maps to container port 8080) |
| Transport | WebSocket (RFC 6455), reached by an HTTP upgrade on `GET /acp` |
| Framing | One ACP JSON-RPC message in each text frame. No batches. Binary frames close the socket |
| Frame size | At most 1 MiB. A larger frame closes the socket (code 1009) |
| Access | Cluster-internal only. The endpoint has no public route |

A plain `GET /acp` without an upgrade gets `426`.

Example URL from inside the cluster:
`ws://headlamp-agent.<namespace>.svc/acp`.

## Authentication

The client sends a bearer token in the `Authorization` header of the upgrade
request:

```
GET /acp HTTP/1.1
Upgrade: websocket
Authorization: Bearer <token>
```

The agent checks the token before it upgrades the socket.

| Answer | Cause |
| --- | --- |
| `401` | No bearer token, an unknown token, or no token configured on the agent. The answer has `WWW-Authenticate: Bearer` |
| `403` | The token is known but lacks the scope, or the `Origin` header names an origin that is not in `ALLOWED_ORIGINS` |
| `503` | The agent is draining, or the connection limit is reached (see Limits). The answer has `Retry-After` |
| `404` | The endpoint is off (`AGENT_ACP_MAX_SESSIONS=0`) |

Required scope: `agent:investigate`. It allows a prompt, so it is the one scope
of this endpoint.

### Token file

The tokens live in a Kubernetes Secret. The Secret is mounted as a file and
`AGENT_API_TOKENS_FILE` names the file. The file holds JSON:

```json
[{ "name": "my-client", "token": "<at least 16 characters>", "scopes": ["agent:investigate"] }]
```

- `name` is a label for logs. The agent never logs a token.
- An entry may have `"sha256": "<64 hex characters>"` in place of `token`.
- The agent reads the file again when it changes. A Secret update needs no restart.
- With no file, or an empty or broken file, every request fails with `401`.
- The agent logs a warning for each entry it drops, with the entry name (or its
  position) and the cause. It never logs a token. A dropped entry gives no access.

The token check is in `agent/src/auth/scopes.ts` (`checkBearer`, `tokensFromFile`,
`SCOPES`). The MCP endpoint can use the same module.

## Session flow

Each WebSocket is one ACP connection.

1. `initialize`. The agent answers with its capabilities (`loadSession` is false).
2. `session/new`. The agent answers with a `sessionId`. It may add a `model`
   option (`configOptions`), which `session/set_config_option` can change.
   The `mcpServers` field is ignored: the tools come from the agent itself.
3. `session/prompt` with the alert as JSON, as `AlertName label=value ...`, or as
   a description. The word `diagnose` takes the most severe firing alert.
4. The agent sends `session/update` notifications while the run goes on:
   `tool_call`, `tool_call_update`, `agent_thought_chunk` and
   `agent_message_chunk`. The final report is Markdown, followed by an A2UI
   resource block.
5. The `session/prompt` request ends with `stopReason`: `end_turn` or `cancelled`.

A session runs one prompt at a time. A `session/prompt` that comes while the
session still has a run fails with JSON-RPC error `-32000`. Send the next prompt
after the answer, or after `session/cancel`. Use another session for parallel work.

The tools of a session come from the registry in the agent process. There is no
network hop to the agent's own `/mcp` endpoint.

### Cancel

Send the notification `session/cancel` with the `sessionId`. The run stops and
the prompt ends with `stopReason: "cancelled"`. A cancelled run publishes
nothing.

### Close

When the socket closes for any reason, the agent aborts every run of that
connection. A session place is free again when its run has ended.

When the agent drains (a rollout):

- A connection with no prompt in flight closes at once with code `1001`.
- A prompt in flight finishes. The agent writes its answer (with `stopReason`)
  and then closes the socket with code `1001`.
- A `session/prompt` or `session/new` that comes during the drain fails with
  JSON-RPC error `-32000` (`Agent is draining`).
- The drain waits at most `AGENT_ACP_DRAIN_TIMEOUT_MS` (default 20 seconds).
  Then the agent aborts the runs that remain and closes their sockets. Keep this
  value under the pod grace period.

The agent pings each socket every 30 seconds. A client that does not answer is
closed.

### Result

When a run ends, the agent stores the diagnosis in its diagnosis store, as the
stdio agent does through `POST /api/diagnoses`. Headlamp (Incidents tab) shows
it with the `published` mark and the source `acp`. A push notification goes out
for a finished diagnosis. The agent tells the client the diagnosis id in the
last message chunk. The diagnosis records the name of the token (`client`), never
the token. A long run is cut to the limits of the publish schema (at most 60
evidence items, the evidence that the result cites first), so it is not lost.

## Limits

`AGENT_ACP_MAX_SESSIONS` (default `4`) is the number of ACP sessions that may be
open at once. It applies in two places:

- an upgrade past the limit of open connections gets `503`;
- a `session/new` past the limit of open sessions fails with JSON-RPC error `-32000`.

Closing a socket frees its places, when its runs have ended. A value of `0`
turns the endpoint off.

## Metrics

`GET /metrics` shows these series:

| Series | Type | Meaning |
| --- | --- | --- |
| `headlamp_agent_acp_sessions` | gauge | Open ACP sessions |
| `headlamp_agent_acp_connections` | gauge | Open WebSocket connections |
| `headlamp_agent_acp_prompts_total{result}` | counter | Prompts that ended: `ok`, `cancelled`, `failed` (a failed diagnosis) or `error` |
| `headlamp_agent_acp_errors_total{kind}` | counter | `limit`, `draining` (a prompt refused during a drain), `protocol` (a bad frame or a socket error) or `upgrade` (a bad upgrade request) |
| `headlamp_agent_acp_auth_failures_total{reason}` | counter | `unconfigured`, `missing`, `invalid`, `scope` or `origin` |

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_ACP_MAX_SESSIONS` | `4` | Open ACP sessions. `0` turns the endpoint off |
| `AGENT_ACP_DRAIN_TIMEOUT_MS` | `20000` | How long a drain waits for prompts in flight before it aborts them |
| `AGENT_API_TOKENS_FILE` | empty | JSON token file from the Secret. Empty means every request fails with `401` |
| `ALLOWED_ORIGINS` | empty | Browser origins that may open the socket. A client with no `Origin` header is always allowed |

## Client example

```ts
import { WebSocket } from 'ws';

const socket = new WebSocket('ws://headlamp-agent.<namespace>.svc/acp', {
  headers: { authorization: `Bearer ${process.env.ACP_TOKEN}` },
});
socket.on('message', data => console.log(data.toString()));
socket.on('open', () => {
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }));
});
```

The `@agentclientprotocol/sdk` package has a client for this transport:
`createWebSocketStream(url, { WebSocket, headers })` from
`@agentclientprotocol/sdk/experimental/ws-client`.
