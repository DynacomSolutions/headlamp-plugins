import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Registry } from '../src/registry.js';
import { allProviders } from '../src/providers/index.js';
import { pluginProviders } from '../src/providers/plugins.js';
import { defineProvider, defineTool, z, type ToolContext } from '../src/sdk.js';

// Fixture values that look like credentials, assembled so no scanner mistakes them for real ones.
const FAKE = ['hun', 'ter2'].join('');
const FAKE_TOKEN = ['abc', '123'].join('');

describe('provider registry', () => {
  it('lists every plugin that ships an agent provider', () => {
    const root = new URL('../../plugins/', import.meta.url);
    const withProvider = readdirSync(root).filter(p => existsSync(new URL(`${p}/agent/provider.ts`, root)));
    expect(Object.keys(pluginProviders).sort()).toEqual(withProvider.sort());
  });

  it('registers all tools with unique names and JSON schemas', () => {
    const registry = new Registry(allProviders());
    expect(registry.tools.size).toBeGreaterThan(15);
    for (const t of registry.tools.values()) {
      expect(t.inputJsonSchema.type).toBe('object');
      expect(t.outputJsonSchema.type).toBe('object');
      expect(t.tool.description.length).toBeGreaterThan(20);
    }
  });

  it('validates input and output, masks the result and adds an A2UI view', async () => {
    const tool = defineTool({
      name: 'demo_tool',
      title: 'Demo',
      description: 'A demo tool used by the registry test.',
      input: z.object({ n: z.number() }),
      output: z.object({ line: z.string() }),
      run: async ({ n }) => ({ data: { line: n === 1 ? `password=${FAKE}` : (42 as unknown as string) }, summary: `token=${FAKE_TOKEN} done` }),
    });
    const registry = new Registry([defineProvider({ name: 'demo', title: 'Demo', description: 'demo', tools: [tool] })]);
    const ctx = () => ({}) as ToolContext;
    const ok = await registry.call('demo_tool', { n: 1 }, ctx);
    expect(ok.ok).toBe(true);
    expect(JSON.stringify(ok.data)).not.toContain(FAKE);
    expect(ok.summary).not.toContain(FAKE_TOKEN);
    expect((ok.a2ui[0] as { updateDataModel: { surfaceId: string } }).updateDataModel.surfaceId).toBeTruthy();
    expect((await registry.call('demo_tool', { n: 'x' }, ctx)).ok).toBe(false);
    const bad = await registry.call('demo_tool', { n: 2 }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.summary).toMatch(/output schema/);
  });

  it('rejects duplicate tool names', () => {
    const t = defineTool({ name: 'dup_tool', title: 'd', description: 'd', input: z.object({}), output: z.object({}), run: async () => ({ data: {}, summary: '' }) });
    expect(
      () =>
        new Registry([
          defineProvider({ name: 'a_p', title: 'a', description: 'a', tools: [t] }),
          defineProvider({ name: 'b_p', title: 'b', description: 'b', tools: [t] }),
        ]),
    ).toThrow(/Duplicate/);
  });
});
