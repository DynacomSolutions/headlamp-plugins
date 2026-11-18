import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';

const FAKE_TOKEN = ['abc', '123'].join('');
let server: Awaited<ReturnType<typeof startServer>>;
let url: string;

beforeAll(async () => {
  const config = { ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent' };
  server = await startServer(config, 'test');
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => server.close());

describe('MCP endpoint', () => {
  it('serves 2026-07-28 clients: tools with schemas, A2UI meta and read-only annotations', async () => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(15);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.outputSchema).toBeTruthy();
      expect((t._meta as { ui?: { mimeType?: string } })?.ui?.mimeType).toBe('application/a2ui+json');
    }
    const res = (await client.callTool({ name: 'list_diagnoses', arguments: {} })) as any;
    expect(res.structuredContent).toEqual({ diagnoses: [] });
    const a2ui = res.content.find((c: any) => c.type === 'resource');
    expect(a2ui.resource.mimeType).toBe('application/a2ui+json');
    expect(JSON.parse(a2ui.resource.text)[0].version).toBe('1.0');
    const view = await client.readResource({ uri: 'a2ui://headlamp-agent/views/summary-list' });
    expect(JSON.parse((view.contents[0] as any).text)[0].createSurface.catalogId).toMatch(/basic/);
    const prompt = await client.getPrompt({ name: 'diagnose_incident', arguments: { alert: 'NodeNotReady node=worker-1' } });
    expect((prompt.messages[0].content as any).text).toContain('worker-1');
    await client.close();
  });

  it('serves 2025-era clients without sessions', async () => {
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'old', version: '1' } } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('rejects foreign browser origins and GET', async () => {
    expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example.com' } })).status).toBe(403);
    expect((await fetch(`${url}/mcp`)).status).toBe(405);
  });

  it('accepts vmalert notifications and published diagnoses', async () => {
    const res = await fetch(`${url}/api/v2/alerts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ labels: { alertname: 'X', severity: 'critical' }, startsAt: new Date().toISOString() }]),
    });
    expect(res.status).toBe(200);
    const pub = await fetch(`${url}/api/diagnoses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        diagnosis: {
          source: 'acp',
          alert: { name: 'X', labels: { pod: 'p' } },
          status: 'done',
          evidence: [{ id: 'e1', tool: 't', reason: 'r', summary: `token=${FAKE_TOKEN}`, ok: true }],
          result: {
            summary: 's',
            likelyCause: 'c',
            confidence: 'low',
            signals: [{ text: 'x', evidence: ['e1'] }],
            fixes: [{ title: 'f', detail: 'd', command: 'kubectl delete pod p' }],
            verify: 'v',
          },
        },
      }),
    });
    expect(pub.status).toBe(201);
    const { id } = (await pub.json()) as { id: string };
    const d = (await (await fetch(`${url}/api/diagnoses/${id}`)).json()) as any;
    expect(d.a2ui[0].createSurface).toBeTruthy();
    expect(d.result.fixes[0].command).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain(FAKE_TOKEN);
  });
});
