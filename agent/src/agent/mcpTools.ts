import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ToolHost } from './engine.js';
import type { ToolSpec } from './model.js';

export async function mcpTools(url: string, headers: Record<string, string>,
  include = (name: string) => name !== 'list_diagnoses' && name !== 'get_diagnosis',
  request: RequestInit = {}): Promise<{ host: ToolHost; close(): Promise<void> }> {
  const client = new Client({ name: 'headlamp-agent-acp', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { ...request, headers } });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close();
    throw error;
  }
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
              if (!include(t.name)) continue;
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

const incidentTools = new Set(['whoami', 'get_issue', 'search_issues', 'report_alert']);
const prefix = 'momento_';

export function toolMetadata(name: string) {
  return name.startsWith(prefix)
    ? { serverId: 'momento', toolName: name.slice(prefix.length) }
    : { serverId: 'headlamp-agent', toolName: name };
}

/** The diagnosis engine can read issues and report an alert under its own agent identity. */
export function withMomento(local: ToolHost, env: NodeJS.ProcessEnv = process.env): ToolHost {
  if (!env.MOMENTO_MCP_URL || !env.MOMENTO_TOKEN) return local;
  const url = env.MOMENTO_MCP_URL;
  const token = env.MOMENTO_TOKEN;

  async function use<T>(run: (host: ToolHost) => Promise<T>): Promise<T> {
    const remote = await mcpTools(url, { Authorization: `Bearer ${token}` }, name => incidentTools.has(name),
      { redirect: 'error', signal: AbortSignal.timeout(5000) });
    try {
      return await run(remote.host);
    } finally {
      await remote.close();
    }
  }

  return {
    async list() {
      const tools = await local.list();
      try {
        const remote = await use(host => host.list());
        return [...tools, ...remote.map(tool => ({ ...tool, name: prefix + tool.name }))];
      } catch {
        console.warn('Momento tool discovery failed. The local diagnosis tools are available.');
        return tools;
      }
    },
    async call(name, args) {
      if (!name.startsWith(prefix)) return local.call(name, args);
      const tool = name.slice(prefix.length);
      if (!incidentTools.has(tool)) throw new Error('Unknown Momento incident tool.');
      try {
        return await use(host => host.call(tool, args));
      } catch {
        throw new Error('The Momento incident tool call failed.');
      }
    },
  };
}
