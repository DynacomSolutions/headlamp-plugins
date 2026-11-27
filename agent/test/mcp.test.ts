import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';

const FAKE_TOKEN = ['abc', '123'].join('');
let server: Awaited<ReturnType<typeof startServer>>;
let url: string;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-'));
  writeFileSync(join(dir, 'tokens.json'), JSON.stringify([{ name: 'reader', token: `r-${FAKE_TOKEN}-reader-token-0000`, scopes: ['registry:read', 'incidents:read'] }]));
  const config = { ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent' };
  config.mcp = { tokensFile: join(dir, 'tokens.json'), auth: 'optional' };
  server = await startServer(config, 'test', { watchVolumes: false });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP endpoint', () => {
  it('serves 2026-07-28 clients: tools with schemas, A2UI meta and read-only annotations', async () => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(15);
    // An anonymous caller sees the registry tools and the two read-only extras of the contract, nothing that writes.
    expect(tools.map(t => t.name)).not.toContain('acknowledge_incident');
    for (const t of tools.filter(t => (t._meta as Record<string, unknown>)?.['headlamp-agent/provider'])) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.outputSchema).toBeTruthy();
      expect((t._meta as { ui?: { mimeType?: string } })?.ui?.mimeType).toBe('application/a2ui+json');
    }
    // Anonymous callers get no tool that reads incident, agent-launch or storage data (contract section 4.2).
    const names = tools.map(t => t.name);
    for (const hidden of ['list_diagnoses', 'get_diagnosis', 'list_agent_launches', 'disk_health_smart', 'disk_health_performance', 'disk_health_capacity']) expect(names).not.toContain(hidden);
    await expect(client.callTool({ name: 'list_diagnoses', arguments: {} })).rejects.toThrow(/disabled/);
    await client.close();
    const reader = new Client({ name: 'reader', version: '1' });
    await reader.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer r-${FAKE_TOKEN}-reader-token-0000` } } }));
    expect((await reader.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(['list_diagnoses', 'get_diagnosis']));
    expect((await reader.listTools()).tools.map(t => t.name)).not.toContain('list_agent_launches');
    const res = (await reader.callTool({ name: 'list_diagnoses', arguments: {} })) as any;
    expect(res.structuredContent).toEqual({ diagnoses: [] });
    const a2ui = res.content.find((c: any) => c.type === 'resource');
    expect(a2ui.resource.mimeType).toBe('application/a2ui+json');
    expect(JSON.parse(a2ui.resource.text)[0].version).toBe('1.0');
    const view = await reader.readResource({ uri: 'a2ui://headlamp-agent/views/summary-list' });
    expect(JSON.parse((view.contents[0] as any).text)[0].createSurface.catalogId).toMatch(/basic/);
    const prompt = await reader.getPrompt({ name: 'diagnose_incident', arguments: { alert: 'NodeNotReady node=worker-1' } });
    expect((prompt.messages[0].content as any).text).toContain('worker-1');
    await reader.close();
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
