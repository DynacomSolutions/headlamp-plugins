import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { withMomento } from '../src/agent/mcpTools.js';

const local = { list: async () => [], call: async () => ({ ok: true, summary: 'local', data: null }) };

it('keeps the local tools when the client has no credential', () => {
  expect(withMomento(local, { MOMENTO_MCP_URL: 'https://example.com/mcp' })).toBe(local);
});

it('discovers and calls only the incident tools with the configured bearer', async () => {
  const token = randomBytes(32).toString('hex');
  const handler = toNodeHandler(createMcpHandler(() => {
    const server = new McpServer({ name: 'example', version: '1' });
    for (const name of ['whoami', 'report_alert', 'set_project_settings']) {
      server.registerTool(name, { inputSchema: z.object({}) }, async () => ({
        content: [{ type: 'text', text: 'agent' }], structuredContent: { kind: 'agent' },
      }));
    }
    return server;
  }, { responseMode: 'json' }));
  const http = createServer((req, res) => {
    if (req.url === '/mcp' && req.headers.authorization === `Bearer ${token}`) return handler(req, res);
    res.writeHead(401).end();
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    const addr = http.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected a TCP listener');
    const env = { MOMENTO_MCP_URL: `http://127.0.0.1:${addr.port}/mcp`, MOMENTO_TOKEN: token };
    const tools = withMomento(local, env);
    expect((await tools.list()).map(t => t.name).sort()).toEqual(['momento_report_alert', 'momento_whoami']);
    expect((await tools.call('momento_whoami', {})).data).toEqual({ kind: 'agent' });
    await expect(tools.call('momento_set_project_settings', {})).rejects.toThrow('Unknown');
    expect(await withMomento(local, { ...env, MOMENTO_TOKEN: 'invalid' }).list()).toEqual([]);
  } finally {
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});
