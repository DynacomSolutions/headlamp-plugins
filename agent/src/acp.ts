import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadConfig, modelConfigured } from './config.js';
import { fingerprint } from './alerts.js';
import { diagnose, type ToolHost } from './agent/engine.js';
import { ModelClient, type ToolSpec } from './agent/model.js';
import { A2UI_MIME } from './a2ui/index.js';
import { alertSchema, diagnosisMarkdown, type Alert, type Diagnosis } from './agent/report.js';

/**
 * The incident-diagnosis agent over the Agent Client Protocol (stdio,
 * newline-delimited JSON-RPC), for T3 Code, Zed or any other ACP client. It
 * gets its tools from the headlamp-agent MCP server (the session's MCP server
 * list, or HEADLAMP_AGENT_MCP_URL), its model from the AGENT_MODEL_* settings,
 * and publishes each finished diagnosis back to the server so Headlamp shows it.
 *
 * stdout carries the protocol; logs go to stderr.
 */

interface Session {
  mcpUrl: string;
  mcpHeaders: Record<string, string>;
  abort?: AbortController;
}

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

export function startAcp(): void {
  const config = loadConfig();
  const sessions = new Map<string, Session>();
  const defaultUrl = process.env.HEADLAMP_AGENT_MCP_URL ?? '';

  const app = agent()
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: true }, mcpCapabilities: { http: true } },
      agentInfo: { name: 'headlamp-agent', title: 'Incident diagnosis (Headlamp agent layer)', version: '0.1.0' },
      authMethods: [],
    }))
    .onRequest('session/new', ({ params }) => {
      const http = params.mcpServers.find((s: any) => 'url' in s && /headlamp|cluster|incident/i.test(s.name)) as any;
      const url = http?.url ?? defaultUrl;
      const headers = Object.fromEntries(((http?.headers ?? []) as Array<{ name: string; value: string }>).map(h => [h.name, h.value]));
      const sessionId = randomUUID();
      sessions.set(sessionId, { mcpUrl: url, mcpHeaders: headers });
      return { sessionId };
    })
    .onNotification('session/cancel', ({ params }) => {
      sessions.get(params.sessionId)?.abort?.abort();
    })
    .onRequest('session/prompt', async ({ params, client, signal }) => {
      const session = sessions.get(params.sessionId);
      if (!session) throw new Error('Unknown session');
      const update = (u: any) => client.notify('session/update', { sessionId: params.sessionId, update: u });
      const say = (text: string) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      const text = params.prompt
        .map((b: any) => (b.type === 'text' ? b.text : b.type === 'resource' && 'text' in b.resource ? b.resource.text : ''))
        .join('\n');
      if (!session.mcpUrl) {
        await say('No MCP server is configured. Add the headlamp-agent MCP server to the session, or set HEADLAMP_AGENT_MCP_URL.');
        return { stopReason: 'end_turn' };
      }
      if (!modelConfigured(config.model)) {
        await say('No model is configured. Set AGENT_MODEL, AGENT_MODEL_STYLE and AIS_GATEWAY_URL/AIS_GATEWAY_TOKEN (or AGENT_MODEL_BASE_URL/AGENT_MODEL_API_KEY).');
        return { stopReason: 'end_turn' };
      }
      const abort = new AbortController();
      session.abort = abort;
      signal.addEventListener('abort', () => abort.abort());
      const mcp = await mcpTools(session.mcpUrl, session.mcpHeaders);
      try {
        let alert = alertFromPrompt(text);
        if (!alert) {
          alert = await pickFiringAlert(mcp.host);
          if (!alert) {
            await say('No warning or critical alert is firing. Send an alert (JSON or `AlertName label=value ...`) or describe the symptom.');
            return { stopReason: 'end_turn' };
          }
          await say(`Diagnosing the firing alert **${alert.name}** (${alert.severity}).\n\n`);
        }
        const result = await diagnose({
          alert,
          tools: mcp.host,
          model: new ModelClient(config.model),
          budget: config.diagnosis.toolBudget,
          source: 'acp',
          host: process.env.HEADLAMP_AGENT_HOST_NAME ?? 'acp',
          signal: abort.signal,
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
        if (abort.signal.aborted) return { stopReason: 'cancelled' };
        await say(diagnosisMarkdown(result));
        await update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'resource', resource: { uri: `a2ui://headlamp-agent/diagnoses/${result.id}`, mimeType: A2UI_MIME, text: JSON.stringify(result.a2ui) } },
        });
        try {
          const id = await publish(session.mcpUrl, session.mcpHeaders, result);
          if (id) {
            const link = process.env.HEADLAMP_INCIDENTS_URL ? ` ${process.env.HEADLAMP_INCIDENTS_URL.replace(/\/$/, '')}/${id}` : '';
            await say(`\n\nPublished to Headlamp (Incidents) as ${id}.${link}`);
          }
        } catch (error) {
          await say(`\n\nCould not publish to Headlamp: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { stopReason: 'end_turn' };
      } finally {
        session.abort = undefined;
        await mcp.close().catch(() => undefined);
      }
    });

  const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  app.connect(stream);
  log(`ready (MCP ${defaultUrl || 'from session'}, model ${config.model.model || 'unset'})`);
}
