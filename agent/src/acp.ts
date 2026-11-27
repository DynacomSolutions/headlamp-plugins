import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadConfig, modelConfigured, type Config } from './config.js';
import { fingerprint } from './alerts.js';
import { diagnose, type ToolHost } from './agent/engine.js';
import { ModelCatalogue } from './agent/catalogue.js';
import type { ChatModel, ToolSpec } from './agent/model.js';
import { A2UI_MIME } from './a2ui/index.js';
import { alertSchema, diagnosisMarkdown, type Alert, type Diagnosis } from './agent/report.js';

/**
 * The incident-diagnosis agent over the Agent Client Protocol (stdio,
 * newline-delimited JSON-RPC), for T3 Code, Zed or any other ACP client. It
 * gets its tools from the headlamp-agent MCP server (the session's MCP server
 * list, or HEADLAMP_AGENT_MCP_URL), its model from the AGENT_MODEL_* settings (picked per session),
 * and publishes each finished diagnosis back to the server so Headlamp shows it.
 *
 * stdout carries the protocol; logs go to stderr.
 */

interface Session {
  mcpUrl: string;
  mcpHeaders: Record<string, string>;
  abort?: AbortController;
  /** The model id chosen for this session. Empty means the default. */
  model: string;
  /** True once the user picked a model: it is used as it is, with no fallback. */
  modelPinned?: boolean;
  /** Frees the session's place under the session limit. */
  release?: () => void;
  /** True once the connection is gone. A run that is still ending frees the place when it ends. */
  disposed?: boolean;
}

/** How long session/new waits for the gateway model lists. */
const LIST_WAIT_MS = 5000;

const log = (message: string) => process.stderr.write(`[headlamp-agent acp] ${message}\n`);

async function mcpTools(url: string, headers: Record<string, string>): Promise<{ host: ToolHost; close(): Promise<void> }> {
  const client = new Client({ name: 'headlamp-agent-acp', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  let cache: ToolSpec[] | undefined;
  return {
    host: {
      async list() {
        if (!cache) {
          const out: ToolSpec[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.listTools(cursor ? { cursor } : undefined);
            for (const t of page.tools) {
              if (t.name === 'list_diagnoses' || t.name === 'get_diagnosis') continue;
              out.push({ name: t.name, description: t.description ?? '', parameters: t.inputSchema as Record<string, unknown> });
            }
            cursor = page.nextCursor;
          } while (cursor);
          cache = out;
        }
        return cache;
      },
      async call(name, args) {
        const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }> };
        const text = (res.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
        const summary = text.split('\n')[0] ?? '';
        return { ok: !res.isError, summary, data: res.structuredContent ?? { text } };
      },
    },
    close: () => client.close(),
  };
}

/**
 * The user's own message, without the text a host adds around it. T3 Code, for
 * example, sends <t3_code_instructions>…</t3_code_instructions> and
 * <user_request>…</user_request> in one block and <runtime_info>,
 * <pull_request_linking> and similar in another. When the host marks the
 * request, only that is used; otherwise every whole tagged block is removed.
 */
export function userText(text: string): string {
  const marked = [...text.matchAll(/<(user_request|user_message|user_query)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(m => m[2].trim());
  if (marked.length) return marked.join('\n').trim();
  return text
    .replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<([a-z][\w-]*(?:instructions?|context|reminder|info))\b[^>]*>[\s\S]*$/i, '')
    .trim();
}

/** Turns the prompt into an alert: a JSON alert, an Alertmanager payload, or free text. */
export function alertFromPrompt(text: string): Alert | undefined {
  const trimmed = userText(text);
  const json = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(trimmed)?.[0];
  if (json) {
    try {
      let value = JSON.parse(json) as any;
      if (Array.isArray(value)) value = value[0];
      if (value?.alerts && Array.isArray(value.alerts)) value = value.alerts[0];
      if (value?.labels?.alertname && !value.name) {
        value = { name: value.labels.alertname, severity: value.labels.severity ?? '', labels: value.labels, annotations: value.annotations ?? {}, startsAt: value.startsAt ?? '' };
      }
      const parsed = alertSchema.safeParse(value);
      if (parsed.success) return { ...parsed.data, fingerprint: parsed.data.fingerprint || fingerprint({ alertname: parsed.data.name, ...parsed.data.labels }) };
    } catch {
      /* not JSON, fall through */
    }
  }
  if (!trimmed || /^(diagnose|latest|go|run)\.?$/i.test(trimmed)) return undefined;
  // "AlertName key=value key=value ..." or plain words. Labels come from the first line only.
  const labels: Record<string, string> = {};
  for (const m of trimmed.split('\n')[0].matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)=("[^"]*"|\S+)/g)) labels[m[1]] = m[2].replace(/^"|"$/g, '');
  const first = trimmed.split(/\s+/)[0];
  const name = labels.alertname ?? (/^[A-Z][A-Za-z0-9]+$/.test(first) ? first : 'ReportedIncident');
  labels.alertname = name;
  return {
    name,
    severity: labels.severity ?? 'warning',
    labels,
    annotations: { description: trimmed.slice(0, 2000) },
    startsAt: new Date().toISOString(),
    fingerprint: fingerprint(labels),
  };
}

async function pickFiringAlert(tools: ToolHost): Promise<Alert | undefined> {
  const out = await tools.call('list_alerts', { state: 'firing' });
  const alerts = ((out.data as { alerts?: any[] })?.alerts ?? []).filter(a => a.severity === 'critical' || a.severity === 'warning');
  alerts.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));
  const a = alerts[0];
  if (!a) return undefined;
  return { name: a.name, severity: a.severity, labels: a.labels, annotations: a.annotations, startsAt: a.activeAt, fingerprint: fingerprint(a.labels) };
}

async function publish(mcpUrl: string, headers: Record<string, string>, d: Diagnosis): Promise<string | undefined> {
  if (process.env.HEADLAMP_AGENT_PUBLISH === '0') return undefined;
  const base = process.env.HEADLAMP_AGENT_URL ?? mcpUrl.replace(/\/mcp\/?$/, '');
  const { a2ui: _a2ui, finishedAt: _f, resolvedAt: _r, ...rest } = d;
  const res = await fetch(`${base}/api/diagnoses`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ diagnosis: { ...rest, source: 'acp', status: d.status === 'done' ? 'done' : 'failed' } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`publishing failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { id: string }).id;
}

/** The model picker for a session: one select option, grouped by route. T3 Code shows it as its model list. */
export async function modelConfigOptions(catalogue: ModelCatalogue, current: string): Promise<any[]> {
  const entries = await catalogue.list({ waitMs: LIST_WAIT_MS });
  if (!entries.length) return [];
  const groups = new Map<string, Array<{ value: string; name: string }>>();
  for (const e of entries) {
    const g = groups.get(e.route) ?? [];
    g.push({ value: e.id, name: e.name });
    groups.set(e.route, g);
  }
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: current,
      options: [...groups].map(([route, options]) => ({ group: route, name: route, options })),
    },
  ];
}

/** The default model as a full id, taken from the listed entries so no extra call is made. */
export async function defaultModelId(catalogue: ModelCatalogue): Promise<string> {
  const def = catalogue.defaultModel;
  const entries = await catalogue.list({ waitMs: LIST_WAIT_MS });
  return entries.find(e => e.id === def)?.id ?? entries.find(e => !def.includes('/') && e.model === def)?.id ?? def;
}

/** Checks a picked model id against the listed ones. */
export async function pickModel(catalogue: ModelCatalogue, value: unknown): Promise<string> {
  if (typeof value !== 'string') throw new Error('The model value must be a string');
  const entries = await catalogue.list({ waitMs: LIST_WAIT_MS });
  if (!entries.some(e => e.id === value)) throw new Error(`Unknown model "${value}"`);
  return value;
}

/** How a prompt ended, for the metrics: `failed` is a run that ended with a failed diagnosis, `error` a request that threw. */
export type PromptOutcome = 'ok' | 'cancelled' | 'failed' | 'error';

export interface AcpHooks {
  /** Called at session/new. Throws a RequestError at the session limit. Returns the function that frees the place. */
  acquireSession?(): () => void;
  /** A prompt starts. Throws a RequestError to refuse it (the prompt then has no `prompt` call). */
  promptStarted?(sessionId: string): void;
  /** The prompt that started ends. Called once per `promptStarted` that did not throw. */
  prompt?(outcome: PromptOutcome, sessionId: string): void;
}

export interface AcpDeps {
  config: Config;
  catalogue: ModelCatalogue;
  log: (message: string) => void;
  /** The MCP URL a session uses when it names none (HEADLAMP_AGENT_MCP_URL). Unused with `tools`. */
  defaultMcpUrl?: string;
  /** In-process tools. The session's own mcpServers are then ignored and no network call is made for a tool. */
  tools?: ToolHost;
  /** Publishes a finished diagnosis. The default posts it to the agent's HTTP API, as the stdio agent does. */
  publish?: (diagnosis: Diagnosis, session: { mcpUrl: string; mcpHeaders: Record<string, string> }) => Promise<string | undefined>;
  hooks?: AcpHooks;
}

/**
 * The ACP agent: one implementation for stdio and for the WebSocket endpoint. Call it once per connection,
 * so the sessions belong to the connection. `dispose` aborts every run of the connection and frees its session places.
 */
export function createAcpApp(deps: AcpDeps) {
  const { config, catalogue, log } = deps;
  const sessions = new Map<string, Session>();
  let disposed = false;
  const defaultUrl = deps.defaultMcpUrl ?? '';
  const publishDiagnosis = deps.publish ?? ((d: Diagnosis, session: { mcpUrl: string; mcpHeaders: Record<string, string> }) => publish(session.mcpUrl, session.mcpHeaders, d));

  const app = agent()
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: true }, mcpCapabilities: { http: true } },
      agentInfo: { name: 'headlamp-agent', title: 'Incident diagnosis (Headlamp agent layer)', version: '0.1.0' },
      authMethods: [],
    }))
    .onRequest('session/new', async ({ params }) => {
      const http = params.mcpServers.find((s: any) => 'url' in s && /headlamp|cluster|incident/i.test(s.name)) as any;
      const url = http?.url ?? defaultUrl;
      const headers = Object.fromEntries(((http?.headers ?? []) as Array<{ name: string; value: string }>).map(h => [h.name, h.value]));
      const release = deps.hooks?.acquireSession?.();
      const sessionId = randomUUID();
      let current = '';
      let configOptions: any[] = [];
      try {
        if (catalogue.configured) {
          current = catalogue.defaultOrder.length > 1 ? catalogue.currentDefault() : await defaultModelId(catalogue);
          configOptions = await modelConfigOptions(catalogue, current);
        }
      } catch (error) {
        release?.();
        throw error;
      }
      // The connection can close while the model lists load: nobody owns the place then.
      if (disposed) {
        release?.();
        throw new RequestError(-32000, 'The connection is closed');
      }
      sessions.set(sessionId, { mcpUrl: url, mcpHeaders: headers, model: current, release });
      return configOptions.length ? { sessionId, configOptions } : { sessionId };
    })
    .onRequest('session/set_config_option', async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (!session) throw new Error('Unknown session');
      if (params.configId !== 'model') throw new Error(`Unknown config option "${params.configId}"`);
      session.model = await pickModel(catalogue, (params as { value: unknown }).value);
      session.modelPinned = true;
      return { configOptions: await modelConfigOptions(catalogue, session.model) };
    })
    .onNotification('session/cancel', ({ params }) => {
      sessions.get(params.sessionId)?.abort?.abort();
    })
    .onRequest('session/prompt', async ({ params, client, signal }) => {
      // A hook may refuse the prompt (the agent drains). Then no run starts and `prompt` is not called.
      deps.hooks?.promptStarted?.(params.sessionId);
      let outcome: PromptOutcome = 'error';
      let session: Session | undefined;
      let abort: AbortController | undefined;
      const onAbort = () => abort?.abort();
      try {
        session = sessions.get(params.sessionId);
        if (!session) throw new Error('Unknown session');
        // One prompt per session. The controller is set before any await, so two prompts cannot both pass.
        if (session.abort) throw new RequestError(-32000, 'A prompt is already running in this session');
        abort = new AbortController();
        session.abort = abort;
        // The request signal ends when the client cancels the request or the connection closes.
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) abort.abort();
        const owner = session;
        const out = await runPrompt(params, client, abort.signal, () => abort!.signal.aborted || sessions.get(params.sessionId) !== owner, owner);
        outcome = out.outcome;
        return { stopReason: out.stopReason };
      } finally {
        signal.removeEventListener('abort', onAbort);
        // The place of a closed connection is freed when its run ends, not before.
        if (session && abort && session.abort === abort) {
          session.abort = undefined;
          if (session.disposed) {
            session.release?.();
            session.release = undefined;
          }
        }
        deps.hooks?.prompt?.(outcome, params.sessionId);
      }
    });

  async function runPrompt(
    params: { sessionId: string; prompt: any[] },
    client: { notify(method: 'session/update', params: unknown): Promise<void> | void },
    signal: AbortSignal,
    stopped: () => boolean,
    session: Session,
  ): Promise<{ stopReason: 'end_turn' | 'cancelled'; outcome: PromptOutcome }> {
    const cancelled = { stopReason: 'cancelled', outcome: 'cancelled' } as const;
    // A notification after the connection closed fails. It is dropped: the run is aborted with the connection, and
    // the engine does not wait for a listener, so a rejection here would reach nobody and stop the process.
    const update = (u: any): Promise<void> =>
      new Promise<void>(resolve => resolve(client.notify('session/update', { sessionId: params.sessionId, update: u }))).catch(() => undefined);
    const say = (text: string) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    const text = params.prompt
      .map((b: any) => (b.type === 'text' ? b.text : b.type === 'resource' && 'text' in b.resource ? b.resource.text : ''))
      .join('\n');
    if (!deps.tools && !session.mcpUrl) {
      await say('No MCP server is configured. Add the headlamp-agent MCP server to the session, or set HEADLAMP_AGENT_MCP_URL.');
      return { stopReason: 'end_turn', outcome: 'failed' };
    }
    if (!modelConfigured(config.models)) {
      await say('No model is configured. Set AGENT_MODEL and AGENT_MODEL_ROUTES_FILE (or AGENT_MODEL_ROUTES) with AIS_GATEWAY_* variables. For one route, set AIS_GATEWAY_URL, AIS_GATEWAY_TOKEN and AGENT_MODEL_STYLE.');
      return { stopReason: 'end_turn', outcome: 'failed' };
    }
    let modelClient: ChatModel;
    try {
      // Without a pick the default order applies, with a fallback on a usage failure.
      modelClient = await catalogue.open(session.modelPinned ? session.model : undefined);
    } catch (error) {
      if (stopped()) return cancelled;
      await say(error instanceof Error ? error.message : String(error));
      return { stopReason: 'end_turn', outcome: 'failed' };
    }
    if (stopped()) return cancelled;
    const mcp = deps.tools ? { host: deps.tools, close: async () => {} } : await mcpTools(session.mcpUrl, session.mcpHeaders);
    try {
      if (stopped()) return cancelled;
      let alert = alertFromPrompt(text);
      if (!alert) {
        alert = await pickFiringAlert(mcp.host);
        if (!alert) {
          await say('No warning or critical alert is firing. Send an alert (JSON or `AlertName label=value ...`) or describe the symptom.');
          return { stopReason: 'end_turn', outcome: 'ok' };
        }
        await say(`Diagnosing the firing alert **${alert.name}** (${alert.severity}).\n\n`);
      }
      const result = await diagnose({
        alert,
        tools: mcp.host,
        model: modelClient,
        timeoutMs: config.diagnosis.runTimeoutMs,
        maxModelCalls: config.diagnosis.maxModelCalls,
        source: 'acp',
        host: process.env.HEADLAMP_AGENT_HOST_NAME ?? 'acp',
        signal,
        onEvent: async event => {
          if (event.type === 'tool_start') {
            await update({
              sessionUpdate: 'tool_call',
              toolCallId: event.id,
              title: `${event.id} ${event.tool}: ${event.reason}`,
              kind: 'other',
              status: 'in_progress',
              rawInput: event.args,
              content: [{ type: 'content', content: { type: 'text', text: `${event.tool} ${JSON.stringify(event.args)}` } }],
              // Names the MCP server and tool, so hosts that read it (T3 Code) label the
              // call headlamp-agent.<tool> instead of a generic "Tool".
              _meta: { serverId: 'headlamp-agent', toolName: event.tool },
            });
          } else if (event.type === 'tool_end') {
            await update({
              sessionUpdate: 'tool_call_update',
              toolCallId: event.id,
              status: event.ok ? 'completed' : 'failed',
              content: [{ type: 'content', content: { type: 'text', text: event.summary } }],
              _meta: { serverId: 'headlamp-agent', toolName: event.tool },
            });
          } else if (event.type === 'thought') {
            await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.text } });
          }
        },
      });
      if (stopped()) return cancelled;
      await say(diagnosisMarkdown(result));
      await update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'resource', resource: { uri: `a2ui://headlamp-agent/diagnoses/${result.id}`, mimeType: A2UI_MIME, text: JSON.stringify(result.a2ui) } },
      });
      try {
        const id = await publishDiagnosis(result, { mcpUrl: session.mcpUrl, mcpHeaders: session.mcpHeaders });
        if (id) {
          const link = process.env.HEADLAMP_INCIDENTS_URL ? ` ${process.env.HEADLAMP_INCIDENTS_URL.replace(/\/$/, '')}/${id}` : '';
          await say(`\n\nPublished to Headlamp (Incidents) as ${id}.${link}`);
        }
      } catch (error) {
        log(`publishing failed: ${error instanceof Error ? error.message : String(error)}`);
        await say(`\n\nCould not publish to Headlamp: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { stopReason: 'end_turn', outcome: result.status === 'done' ? 'ok' : 'failed' };
    } finally {
      await mcp.close().catch(() => undefined);
    }
  }

  /** Aborts every run of this connection and frees its session places. Safe to call more than once. */
  function dispose(): void {
    disposed = true;
    for (const session of sessions.values()) {
      session.disposed = true;
      if (session.abort) {
        // The run ends soon and frees the place then.
        session.abort.abort();
      } else {
        session.release?.();
        session.release = undefined;
      }
    }
    sessions.clear();
  }

  return { app, dispose };
}

/** `headlamp-agent acp`: the agent on stdio, with its tools from the MCP server over the network. */
export function startAcp(): void {
  const config = loadConfig();
  const catalogue = new ModelCatalogue(config.models);
  const defaultMcpUrl = process.env.HEADLAMP_AGENT_MCP_URL ?? '';
  const { app } = createAcpApp({ config, catalogue, log, defaultMcpUrl });
  const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  app.connect(stream);
  log(`ready (MCP ${defaultMcpUrl || 'from session'}, model ${config.models.defaultModel || 'unset'}, routes ${config.models.routes.map(r => r.id).join(',') || 'none'})`);
}
