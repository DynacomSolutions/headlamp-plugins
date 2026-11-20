# headlamp-agent: the read-only data and agent layer

One small service that lets any agent host see what Headlamp and its plugins
see, and diagnose incidents from it.

- **MCP server** (stateless, spec 2026-07-28): read-only tools over Kubernetes
  resources, events and pod logs, metrics and alerts, and data that the plugins
  add (SMART, disk performance and capacity, node temperatures, uptime probes,
  the alerting backend's state, component updates, sites, usage).
- **Plugin extension point**: each plugin can ship `agent/provider.ts` with
  typed tools. The server publishes their schemas and validates, masks and
  renders every result.
- **Incident diagnosis**: a skill plus an engine that starts from an alert,
  gathers evidence within a tool budget and returns the likely cause, the
  evidence and suggested fixes. It runs in the cluster (started by a vmalert
  webhook) or as an **ACP agent** in any Agent Client Protocol host.
- **A2UI v1.0 at every layer**: tool results, diagnoses and ACP messages carry
  A2UI next to structured JSON, and the [Incidents](../plugins/incidents) plugin
  renders them in Headlamp.

```
 vmalert ──POST /api/v2/alerts──▶┐
                                 │       ┌──────────── headlamp-agent (1 pod) ─────────────┐
 Claude Code / OpenBot ──MCP────▶├──────▶│ /mcp  stateless MCP: tools, A2UI views, prompt,  │
                                 │       │       incident-diagnosis skill                   │
 T3 Code ──ACP (stdio)──▶ headlamp-agent acp ──MCP + POST /api/diagnoses──▶│                │
                                 │       │ diagnosis engine ──▶ AI gateway (any model)      │
 Headlamp Incidents ──service proxy GET /api/diagnoses──▶│                                   │
                                         │ GET-only Kubernetes client · PromQL · vmalert API │
                                         └──────────────────────────────────────────────────┘
```

## MCP

`POST /mcp` speaks the 2026-07-28 stateless transport: every request carries
its protocol version and capabilities, there is no `initialize` handshake and
no session, so any replica can answer any request. Clients on 2025-era
versions (`initialize`, then requests) work too, without a session id.
Responses are plain JSON. `GET /mcp` returns 405, and browser requests from an
origin that is not in `ALLOWED_ORIGINS` get 403.

| Provider | Tools |
| --- | --- |
| kubernetes | `cluster_overview`, `list_resources`, `get_resource` (with events), `list_events`, `get_pod_logs`, `list_api_resources` |
| metrics | `query_metrics`, `query_metrics_range` (cut to 40 points, peaks kept), `find_metrics`, `list_alerts`, `list_alert_rules` |
| uptime | `uptime_status`: blackbox probe results per target and site, from `probe_*` series. `uptime_response_times`: current, average, p95 and maximum probe time, HTTP phases and size |
| dns_placement | `dns_placement_status`: DNS records against the placement rules and probe latency. `dns_placement_plan`: propose-only change plan |
| alerting | `alerting_watchdog_state`: the alerting backend's targets and down episodes |
| disk_health | `disk_health_smart`, `disk_health_performance`, `disk_health_capacity` |
| node_hardware | `node_hardware_thermals` |
| sites | `sites_lookup`: URL to Mapping to Service |
| updates | `updates_components` |
| usage | `usage_top` |
| diagnoses | `list_diagnoses`, `get_diagnosis` |

Every tool is annotated `readOnlyHint: true` and has an `inputSchema` and
`outputSchema`. A result holds:

1. `structuredContent`, checked against the output schema;
2. a text block: a one-line summary followed by the JSON, for text-only hosts;
3. an embedded resource with MIME type `application/a2ui+json`: an A2UI
   `updateDataModel` for the shared view template.

The template is the resource `a2ui://headlamp-agent/views/summary-list`
(`createSurface` plus `updateComponents` with data bindings). Each tool
descriptor points at it in `_meta.ui`. Diagnoses are also resources
(`a2ui://headlamp-agent/diagnoses/{id}`), each a self-contained surface.

The server also offers the prompt `diagnose_incident` and the skill
`incident-diagnosis` (MCP skills extension), so a host with its own model can
run the same method without the engine.

## Plugin data providers

A plugin adds data for agents in `plugins/<plugin>/agent/provider.ts`:

```ts
import { defineProvider, defineTool, setting, z } from '../../../agent/src/sdk.js';

const status = defineTool({
  name: 'my_plugin_status',          // snake_case, starts with the provider name
  title: 'My plugin status',
  description: 'What it returns and when an agent should call it.',
  input: z.object({ node: z.string().optional() }),
  output: z.object({ rows: z.array(z.object({ node: z.string(), ok: z.boolean() })) }),
  async run(args, ctx) {
    const samples = await ctx.prom.query('up');             // read-only clients only
    const rows = samples.map(s => ({ node: s.metric.node ?? '', ok: s.value === 1 }));
    return {
      data: { rows },                                       // validated against `output`
      summary: `${rows.length} nodes.`,                     // one line for the model
      view: { title: 'Status', rows: rows.map(r => ({ label: r.node, detail: '', status: r.ok ? 'ok' : 'down' })) },
    };
  },
});

export const provider = defineProvider({ name: 'my_plugin', title: 'My plugin', description: '…', tools: [status] });
```

Then list it in `src/providers/plugins.ts` (a test fails if a plugin ships a
provider that is not listed). The tool context offers only read-only clients:
`kube` (GET, never Secrets), `prom` (PromQL), `vmalert` (its `/api/v1/` read
API), `serviceGet` (GET JSON from a `*.svc` name) and `settings`, which holds
this provider's entry from the provider config file. Settings keep
cluster-specific names and URLs out of this repository.

### DNS placement settings

The `dns_placement` provider reads the metrics of an external placement check
and applies the placement rules. It runs in propose-only mode. It never
changes DNS. It has no write client and no DNS credential. The plan lists the
exact records to remove and add, and a person or agent with DNS access applies
it. Settings in the provider config file (a value of the wrong type is ignored):

```json
{
  "dns_placement": {
    "metricPrefix": "dns_placement",
    "zone": "example.com",
    "defaultNode": "node-a",
    "homeNodes": ["home-1", "home-2"],
    "remoteNodes": ["remote-1"],
    "pinned": { "app.example.com": ["home-1"] },
    "exclude": ["^failover-.*\\.example\\.com$"],
    "homeLocation": "home",
    "slowSeconds": 2,
    "uptimeJob": "uptime"
  }
}
```

The check exports `<metricPrefix>_match{host,expected,actual}`,
`_skipped{host,reason}`, `_check_success` and `_last_success_timestamp_seconds`.
The rules: a host that runs only on the default node needs no own record.
Home-first: an app with pods on a home node gets only those home nodes. A
pinned host wins over placement. An excluded host is reported and never
changed. Records are A, DNS-only and never proxied. A move away from the
rules needs an open board row and a planned return. The uptime provider
reads its own settings `job` and `slowSeconds` for `uptime_response_times`.

## Widget panels

`GET /api/widgets` lists panels and `GET /api/widgets/<id>` returns one. Both are
read-only, need no auth and answer from the same tools as MCP, with the same
masking. The Headlamps phone app reads them through the Headlamp service proxy.
Panels: `uptime`, `usage`, `usage-dashboard`, `alerts`, `disks`, `hardware`, `sites`, `updates`,
`incidents`, `github-runners`, `registry`, `vm-images` and `agent-memory` (the panel id keeps its old name for existing clients, the panel title is Agent resources). An unknown id gives 404 and a failing backend
gives 502 with a short reason. The `sites` panel takes `?q=<text>`.

The `usage-dashboard` panel adds a typed `rings` field (at most two rings, CPU
and memory). It uses the same numbers as the usage nodes dashboard. Each ring is
`{ id, label, unit, capacity, used, segments }`:

- `capacity` is the full circle. It is the sum of the node capacities.
- `used` is the part that is filled. It is the sum of the node totals.
- `unit` is `cores` (3 decimals) for CPU and `bytes` (whole numbers) for memory.
- `segments` are the categories (`k8s`, `t3`, `system`, and so on). Each is
  `{ key, label, value, children? }`, biggest first.
- `children` hold the biggest users of one category (for example the namespace
  `k8s/ns:shop`). There is one level only. Small children (below 0.2 % of
  `capacity`) are left out and the list stops at 60. Their use stays inside the
  value of the category. There is no "Other" entry.

## Incident diagnosis

The method lives in [`skills/incident-diagnosis/SKILL.md`](skills/incident-diagnosis/SKILL.md).
It is the engine's system prompt, the MCP prompt and the MCP skill. The engine
([`src/agent/engine.ts`](src/agent/engine.ts)) works like this:

1. **Evidence pack**: a fixed first look chosen from the alert's labels (the
   rule, then the pod, its logs and events, the workload, node, disks or probes,
   then recent warnings). It costs no budget, and its facts are numbered `e1`, `e2`, …
2. **Investigation**: the model may make `AGENT_TOOL_BUDGET` more tool calls
   (default 10). Each call must state the question it answers, and results are
   numbered `t1`, `t2`, …
3. **Answer**: once the budget is spent, the only tool left is
   `submit_diagnosis`, and the model must call it. The answer holds the likely
   cause, a summary, a confidence level, signals that cite fact ids, up to five
   fixes and how to confirm the fix.
4. **Checks the model cannot skip**: signals that cite unknown ids are dropped,
   at most one fix is marked recommended, and a fix command must be read-only
   (`kubectl get/describe/logs`, `smartctl -a`, and so on) or it is removed.
   Everything is masked.

The diagnosis is kept as JSON with an A2UI surface (the cause, the evidence,
the fixes, an evidence-trail tab bound to the data model, and the alert).

### Where diagnoses start

- **vmalert**: `-notifier.url=http://headlamp-agent.<namespace>.svc`. vmalert
  posts Alertmanager v2 alerts to `/api/v2/alerts`. A firing alert with a
  severity in `AGENT_DIAGNOSE_SEVERITIES` (default warning and critical) starts
  one diagnosis per activation, limited to `AGENT_MAX_DIAGNOSES_PER_HOUR`
  (default 6). Diagnoses run one at a time. A resolved alert marks its
  diagnoses resolved.
- **API**: `POST /api/diagnoses {"alert": {...}}`.
- **ACP**: `headlamp-agent acp` runs the engine in the host and takes its tools
  from the MCP server. It streams each tool call, the thinking and the report
  (Markdown plus an A2UI resource block), then publishes the result with
  `POST /api/diagnoses {"diagnosis": {...}}` so Headlamp shows it. Send it an
  alert as JSON or as `AlertName label=value …`, describe a symptom, or send
  `diagnose` to take the most severe firing alert.

`GET /api/diagnoses` and `GET /api/diagnoses/<id>` serve the Incidents plugin.

Diagnoses are stored one file per diagnosis. During a rollout the old pod
finishes its running diagnosis, and the new pod takes over queued and
interrupted ones.

## Hosts

**Claude Code** (MCP):

```sh
claude mcp add --transport http headlamp-agent https://agent.example.com/mcp
```

Then ask, for example, "use the diagnose_incident prompt for KubePodCrashLooping
namespace=shop pod=web-1", or call the tools directly.

**T3 Code** (ACP): add a local ACP agent with this command:

```sh
node /path/to/headlamp-plugins/agent/dist/main.mjs acp
```

and this environment:

```sh
HEADLAMP_AGENT_MCP_URL=https://agent.example.com/mcp
AGENT_MODEL=<model>  AGENT_MODEL_STYLE=openai|anthropic|responses
AIS_GATEWAY_URL=<gateway app URL>  AIS_GATEWAY_TOKEN=<app token>
# or several providers: AGENT_MODEL_ROUTES_FILE (see Model)
HEADLAMP_INCIDENTS_URL=https://headlamp.example.com/c/main/incidents   # optional link
```

**OpenBot or any always-on host**: point it at the MCP URL. Diagnoses that
vmalert starts run in the cluster with no host.

## Model

Any model that the AIS Gateway serves can run a diagnosis. Model calls go only
through gateway apps. There is no raw base URL and no raw API key setting. The
model is chosen per run.

A gateway app serves one provider, so each provider is one route. Three API
styles exist: `anthropic` (Messages), `openai` (Chat Completions) and
`responses` (OpenAI Responses, streamed). A model id is `<route>/<model>`, for
example `claude/claude-sonnet-5-5`. A bare id uses the first route that lists
it.

| Variable | Meaning |
| --- | --- |
| `AGENT_MODEL_ROUTES_FILE` | Path of a JSON array of routes (below) |
| `AGENT_MODEL_ROUTES` | The same array, inline |
| `AGENT_MODEL` | Default model id, used when a run names none |
| `AGENT_MODEL_MAX_TOKENS` / `AGENT_MODEL_TIMEOUT_MS` | Defaults for routes that set neither |

Each route names the environment variables that hold its gateway URL and app
token. Both names must match `^AIS_GATEWAY_[A-Z0-9_]*(URL|TOKEN)$`, so a route
cannot point at another endpoint. A route whose URL or token is empty is
skipped and logged. The other routes keep working.

```json
[
  { "id": "zai", "style": "openai", "urlEnv": "AIS_GATEWAY_ZAI_URL", "tokenEnv": "AIS_GATEWAY_ZAI_TOKEN" },
  { "id": "claude", "style": "anthropic", "urlEnv": "AIS_GATEWAY_CLAUDE_URL", "tokenEnv": "AIS_GATEWAY_CLAUDE_TOKEN",
    "systemPrefix": "You are Claude Code, Anthropic's official CLI for Claude." },
  { "id": "codex", "style": "responses", "urlEnv": "AIS_GATEWAY_CODEX_URL", "tokenEnv": "AIS_GATEWAY_CODEX_TOKEN" },
  { "id": "kimi", "style": "anthropic", "urlEnv": "AIS_GATEWAY_KIMI_URL", "tokenEnv": "AIS_GATEWAY_KIMI_TOKEN" },
  { "id": "grok", "style": "openai", "urlEnv": "AIS_GATEWAY_GROK_URL", "tokenEnv": "AIS_GATEWAY_GROK_TOKEN",
    "headers": { "x-grok-client-version": "1.0.70" } },
  { "id": "opencode", "style": "openai", "urlEnv": "AIS_GATEWAY_OPENCODE_URL", "tokenEnv": "AIS_GATEWAY_OPENCODE_TOKEN",
    "headers": { "x-opencode-session": "{session}" } },
  { "id": "ali", "style": "anthropic", "urlEnv": "AIS_GATEWAY_ALI_URL", "tokenEnv": "AIS_GATEWAY_ALI_TOKEN" }
]
```

```sh
AGENT_MODEL_ROUTES_FILE=/etc/headlamp-agent/routes.json
AGENT_MODEL=claude/claude-sonnet-5-5
AIS_GATEWAY_CLAUDE_URL=https://gateway.example.com/gateway/headlamp-agent-claude
AIS_GATEWAY_CLAUDE_TOKEN=<app token>
```

Route fields: `id`, `style`, `urlEnv`, `tokenEnv`, and optional `headers`
(`{session}` becomes the diagnosis id), `systemPrefix` (text put before the
system prompt; the anthropic style sends it as its own first system block,
because the upstream rejects it inside one string with 429), `models` (allowlist, also the list used when the gateway cannot
list models), `maxTokens` and `timeoutMs`.

Provider notes:

- **claude**: the system prompt must start with the Claude Code identity line.
  Set `systemPrefix` as shown.
- **codex**: Responses API only (`POST {base}/responses`, streamed, `store:false`).
  The agent sends no token limit there. The model list needs a client version,
  which the agent adds.
- **grok**: send the `x-grok-client-version` header on every call.
- **opencode**: send the `x-opencode-session` header on every call.
- **kimi, zai, ali**: `anthropic` or `openai`, as the gateway app is set up.
- Every call carries a `headlamp-agent/<version>` user agent, because some
  providers refuse a default library one.

The agent lists models from `GET {base}/models` (then `{base}/v1/models`) and
caches the result for 10 minutes. It accepts the OpenAI, Anthropic and Codex
list shapes.

**Single route (older setting).** With no routes configured, one route named
`gateway` is built from `AIS_GATEWAY_URL`, `AIS_GATEWAY_TOKEN`,
`AGENT_MODEL_STYLE` (`openai`, `anthropic` or `responses`), `AGENT_MODEL_HEADERS`
(JSON) and `AGENT_MODEL_SYSTEM_PREFIX`. `AGENT_MODEL` is the model id.

**Choosing the model.**

- `GET /api/models` returns `{ default, models: [{ id, route, model, name }] }`.
- `POST /api/diagnoses` accepts `"model": "<route>/<model>"`. An unknown id gets
  a 400 that lists the valid ids.
- A webhook alert picks a model with the `agent_model` annotation or label. An
  unknown value logs a warning and uses the default.
- A run that a restart interrupted resumes with its recorded model. Each
  diagnosis stores the full id in `model`.
- The ACP agent returns a `model` select option from `session/new` (grouped by
  route) and accepts `session/set_config_option`, so a host such as T3 Code
  shows a model picker. The listing wait is capped at 5 seconds, then the
  configured lists are used.

Without a model, the MCP server still works, and alerts are recorded but not
diagnosed.

## Chat

The Incidents plugin has a chat page. An operator talks to the agent about the
cluster and about incidents. The agent uses the same read-only tools, masking and
model routes as a diagnosis. There is no submit tool: a turn ends when the model
answers without calling a tool. Each turn has the tool budget `AGENT_TOOL_BUDGET`.
The whole history goes to the model on every turn. When it gets long, the oldest
tool results are cut first. A chat can start from a diagnosis, and then the alert,
the result and the evidence summaries are part of the system prompt.

All routes answer JSON and have the same protection as `POST /api/diagnoses`.

| Route | Answer |
| --- | --- |
| `GET /api/chats?limit=50` | `{ chats: [{ id, title, model, diagnosisId?, updatedAt, running }] }`, newest first |
| `POST /api/chats` with `{ model?, diagnosisId? }` | 201 `{ id }`. An unknown model gets 400 with the valid ids. An unknown diagnosis gets 404 |
| `GET /api/chats/<id>` | `{ id, title, model, diagnosisId?, createdAt, updatedAt, running, messages }` |
| `POST /api/chats/<id>/messages` with `{ text, model? }` | 202 `{ messageId }`. `text` has 1 to 8000 characters. 409 when a turn runs in this chat. 429 above `AGENT_MAX_CHAT_TURNS`. A `model` switches the chat from this turn on |
| `POST /api/chats/<id>/cancel` | 200. Stops the running turn, which gets the status `cancelled` |
| `PATCH /api/chats/<id>` with `{ title?, model? }` | 200 with the chat summary |
| `DELETE /api/chats/<id>` | 204 |

A message is `{ id, role: "user"|"assistant", text, createdAt, status:
"done"|"running"|"failed"|"cancelled", error?, model?, steps }`. A step is
`{ id, tool, reason, ok?, summary?, status: "running"|"done" }` and belongs to an
assistant message, in call order. There is no event stream: the client reads
`GET /api/chats/<id>` every second while `running` is true. The store holds the
text and the steps during the turn.

Chats are one file each, `chats/<id>.json` under `DATA_DIR`, and live in memory
without it. The title is the first user message, cut to 60 characters. A turn
that a restart interrupted is marked `failed` with the error `interrupted by
restart`.

## Read-only and masking

- RBAC grants only `get`, `list` and `watch`, and no Secrets. The deployment
  binds the built-in `view` role plus read access to cluster-scoped types.
- The Kubernetes client sends `GET` only. It refuses any path whose resource
  type contains `secret`, and it never lists Secrets in discovery. This still
  holds if RBAC is too broad.
- Every result, log line, report and A2UI payload is masked: JWTs, PEM private
  keys, known token formats, bearer and basic credentials, `user:password@` in
  URLs, credential query parameters, `key=value` pairs and env vars whose names
  mean a secret.
- Evidence is data, not instructions: the skill tells the model so, and the
  model's output is checked before it is stored.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `KUBE_API` | in-cluster | API server URL, for example `http://127.0.0.1:8001` with `kubectl proxy` |
| `METRICS_URL` | – | Prometheus-compatible endpoint (VictoriaMetrics) |
| `VMALERT_URL` | – | vmalert, for rules and alerts |
| `PROVIDER_CONFIG_FILE` | – | JSON with each provider's settings, `{"<provider>": {...}}` |
| `AGENT_MEMORY_URL` | `http://agent-memory.agent-memory.svc/api/state` | State endpoint for the agent-memory panel |
| `REGISTRY_CATALOGUE_URL` | `http://registry-catalog.registry.svc/api/repositories` | Registry catalogue backend, for the registry and VM images panels. Set the namespace of your catalogue Service. |
| `DATA_DIR` | memory only | Where the diagnoses are kept, one file each in `diagnoses/` |
| `MAX_DIAGNOSES` | `200` | Diagnoses kept |
| `ALLOWED_ORIGINS` | none | Browser origins that may call `/mcp` |
| `AGENT_TOOL_BUDGET` | `10` | Tool calls per diagnosis after the evidence pack, and per chat turn |
| `AGENT_MAX_CHATS` | `200` | Chats kept in `chats/` under `DATA_DIR`. The oldest are dropped first |
| `AGENT_MAX_CHAT_TURNS` | `3` | Chat turns that may run at once across all chats. More get a 429 |
| `AGENT_DIAGNOSE_SEVERITIES` | `warning,critical` | Severities that start a diagnosis from the webhook |
| `AGENT_MAX_DIAGNOSES_PER_HOUR` | `6` | Webhook diagnoses per hour |
| `AGENT_IGNORE_ALERTS` | `Watchdog,InfoInhibitor` | Alert names that are never diagnosed |

## Development

```sh
npm ci
npm run tsc && npm test && npm run build      # dist/main.mjs plus skills/
kubectl proxy --port 8001 &
KUBE_API=http://127.0.0.1:8001 METRICS_URL=… node dist/main.mjs serve
```

The tests check masking, the Secret guard, A2UI payloads against the official
v1.0 JSON schemas (vendored in `test/a2ui-v1`), report sanitising, alert
parsing and gating, provider registration, the engine's budget, and the MCP
endpoint end to end.
