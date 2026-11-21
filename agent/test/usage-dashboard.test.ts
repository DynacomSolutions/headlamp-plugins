import { describe, expect, it } from 'vitest';
import { provider } from '../../plugins/usage/agent/provider.js';
import { usageFixture, AGENT_STATE_URL, CORES_PER_NODE, MEMORY_PER_NODE } from './usage-dashboard-fixture.js';

const tool = provider.tools.find(t => t.name === 'usage_dashboard')!;
type Seg = { key: string; label: string; value: number; children?: Array<{ key: string; label: string; value: number }> };
type Out = {
  nodes: number;
  hostMetrics: boolean;
  rings: Array<{
    id: string;
    label: string;
    unit: string;
    capacity: number;
    used: number;
    segments: Seg[];
    nodes?: Array<{ key: string; label: string; capacity: number; used: number; segments: Seg[] }>;
  }>;
};

async function run(ctx = usageFixture().context()): Promise<{ data: Out; summary: string; view?: { rows: unknown[] } }> {
  const result = await tool.run({}, ctx);
  return { data: tool.output.parse(result.data) as Out, summary: result.summary, view: result.view as { rows: unknown[] } };
}

describe('usage_dashboard tool', () => {
  it('is listed beside usage_top', () => {
    expect(provider.tools.map(t => t.name)).toEqual(['usage_top', 'usage_dashboard']);
  });

  it('sums capacity and used over the nodes', async () => {
    const { data } = await run();
    expect(data.nodes).toBe(3);
    expect(data.hostMetrics).toBe(true);
    const [cpu, memory] = data.rings;
    expect(cpu).toMatchObject({ id: 'cpu', label: 'CPU', unit: 'cores', capacity: 3 * CORES_PER_NODE });
    expect(memory).toMatchObject({ id: 'memory', label: 'Memory', unit: 'bytes', capacity: 3 * MEMORY_PER_NODE });
    expect(cpu.used).toBeCloseTo(3 * CORES_PER_NODE * 0.53, 3);
    expect(memory.used).toBe(Math.round(3 * MEMORY_PER_NODE * 0.65));
    expect(Number.isInteger(memory.used)).toBe(true);
  });

  it('makes segment values add up to used, biggest first, with the three category keys', async () => {
    const { data } = await run();
    for (const ring of data.rings) {
      expect(ring.segments.map(s => s.key).sort()).toEqual(['k8s', 'system', 't3']);
      const total = ring.segments.reduce((s, x) => s + x.value, 0);
      expect(Math.abs(total - ring.used)).toBeLessThan(ring.unit === 'cores' ? 0.01 : 16);
      const values = ring.segments.map(s => s.value);
      expect(values).toEqual([...values].sort((a, b) => b - a));
    }
  });

  it('uses friendly labels and child keys', async () => {
    const { data } = await run();
    const cpu = data.rings[0];
    const k8s = cpu.segments.find(s => s.key === 'k8s')!;
    expect(k8s.label).toBe('Kubernetes');
    expect(k8s.children!.map(c => c.key)).toContain('k8s/ns:shop');
    expect(k8s.children!.find(c => c.key === 'k8s/ns:shop')!.label).toBe('Shop');
    expect(k8s.children!.find(c => c.key === 'k8s/ns:kube-system')!.label).toBe('Kube system');
    // The namespace display-name annotation wins over the humaniser.
    expect(k8s.children!.find(c => c.key === 'k8s/ns:monitoring')!.label).toBe('Monitoring stack');
    const t3 = cpu.segments.find(s => s.key === 't3')!;
    expect(t3.label).toBe('T3 Code');
    expect(t3.children!.map(c => c.label)).toEqual(expect.arrayContaining(['web-shop', 'mobile-app']));
    const system = cpu.segments.find(s => s.key === 'system')!;
    expect(system.label).toBe('System');
  });

  it('sorts children biggest first and keeps one level only', async () => {
    const { data } = await run();
    for (const ring of data.rings) {
      for (const seg of ring.segments) {
        const values = (seg.children ?? []).map(c => c.value);
        expect(values).toEqual([...values].sort((a, b) => b - a));
        for (const child of seg.children ?? []) expect(child).not.toHaveProperty('children');
        expect(seg.children?.length ?? 1).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every child, small or not, and never makes an Other entry', async () => {
    const { data } = await run();
    for (const ring of data.rings) {
      for (const seg of ring.segments) for (const child of seg.children ?? []) expect(child.value).toBeGreaterThan(0);
    }
    const k8s = data.rings[0].segments.find(s => s.key === 'k8s')!;
    expect(k8s.children!.map(c => c.key)).toContain('k8s/ns:cert-manager');
    const labels = JSON.stringify(data.rings);
    expect(labels).not.toMatch(/other/i);
  });

  it('splits each ring by node, with the capacity and use of each node', async () => {
    const { data } = await run();
    for (const ring of data.rings) {
      const nodes = ring.nodes!;
      expect(nodes.map(n => n.label).sort()).toEqual(['worker-1', 'worker-2', 'worker-3']);
      expect(nodes.map(n => n.key).sort()).toEqual(['node:worker-1', 'node:worker-2', 'node:worker-3']);
      const per = ring.id === 'cpu' ? CORES_PER_NODE : MEMORY_PER_NODE;
      for (const n of nodes) expect(n.capacity).toBe(per);
      // The nodes add up to the ring, in capacity and in use.
      expect(nodes.reduce((s, n) => s + n.capacity, 0)).toBe(ring.capacity);
      expect(Math.abs(nodes.reduce((s, n) => s + n.used, 0) - ring.used)).toBeLessThan(ring.unit === 'cores' ? 0.01 : 16);
      // Each node keeps its own categories, which add up to the use of the node.
      for (const n of nodes) {
        const total = n.segments.reduce((s, x) => s + x.value, 0);
        expect(Math.abs(total - n.used)).toBeLessThan(ring.unit === 'cores' ? 0.01 : 16);
        expect(n.used).toBeLessThanOrEqual(n.capacity);
      }
    }
  });

  it('puts the agent host categories on the node that has the agent host only', async () => {
    const { data } = await run();
    const [cpu] = data.rings;
    const byNode = Object.fromEntries(cpu.nodes!.map(n => [n.label, n.segments.map(s => s.key).sort()]));
    expect(byNode['worker-1']).toEqual(['k8s', 'system', 't3']);
    expect(byNode['worker-2']).toEqual(['k8s', 'system']);
    expect(byNode['worker-3']).toEqual(['k8s', 'system']);
    // The node categories add up to the whole ring category, child by child.
    const sum = (key: string) => cpu.nodes!.reduce((s, n) => s + (n.segments.find(x => x.key === key)?.value ?? 0), 0);
    for (const seg of cpu.segments) expect(Math.abs(sum(seg.key) - seg.value)).toBeLessThan(0.01);
  });

  it('never makes an Other entry in the node split', async () => {
    const { data } = await run();
    expect(JSON.stringify(data.rings.map(r => r.nodes))).not.toMatch(/other/i);
  });

  it('reads the agent hosts from the setting and skips a backend that fails', async () => {
    const fx = usageFixture();
    const ctx = fx.context({ settings: { agentStateUrls: `${AGENT_STATE_URL}, http://broken.example.com/state` } });
    const { data } = await run(ctx);
    expect(fx.urls).toEqual([AGENT_STATE_URL, 'http://broken.example.com/state']);
    expect(data.rings[0].segments.map(s => s.key)).toContain('t3');
  });

  it('tries both default backends and one answer is enough', async () => {
    const fx = usageFixture();
    const { data } = await run(fx.context());
    expect(fx.urls).toEqual(['http://agent-resource.agent-resource.svc/api/state', AGENT_STATE_URL]);
    expect(data.rings[0].segments.map(s => s.key)).toContain('t3');
  });

  it('shows agent use under System when no agent host answers', async () => {
    const fx = usageFixture();
    const { data } = await run(fx.context({ serviceGet: async () => ({ units: 'not a list' }) }));
    expect(data.rings[0].segments.map(s => s.key).sort()).toEqual(['k8s', 'system']);
    const full = (await run()).data.rings[0];
    expect(data.rings[0].used).toBeCloseTo(full.used, 3);
  });

  it('falls back to the plain names when the namespace list fails', async () => {
    const fx = usageFixture();
    const ctx = fx.context({ kube: { list: async () => { throw new Error('forbidden'); } } as never });
    const { data } = await run(ctx);
    const k8s = data.rings[0].segments.find(s => s.key === 'k8s')!;
    expect(k8s.children!.find(c => c.key === 'k8s/ns:monitoring')!.label).toBe('Monitoring');
  });

  it('counts a failed query as empty and throws when all fail', async () => {
    const fx = usageFixture();
    const real = fx.context().prom;
    let first = true;
    const partial = { query: async (q: string) => { if (first) { first = false; throw new Error('boom'); } return real.query(q); } } as never;
    await expect(run(fx.context({ prom: partial }))).resolves.toBeTruthy();
    const none = { query: async () => { throw new Error('metrics down'); } } as never;
    await expect(tool.run({}, fx.context({ prom: none }))).rejects.toThrow('metrics down');
  });

  it('writes a summary and view rows', async () => {
    const { summary, view } = await run();
    expect(summary).toMatch(/^CPU 53\.\d% and memory 65\.\d% used on 3 nodes\. Biggest CPU user: /);
    expect(view!.rows.length).toBeGreaterThan(2);
  });

  it('answers with no data for an empty cluster', async () => {
    const empty = { query: async () => [] } as never;
    const { data, summary } = await run(usageFixture().context({ prom: empty }));
    expect(data.nodes).toBe(0);
    expect(data.hostMetrics).toBe(false);
    expect(summary).toBe('No usage data.');
  });
});

describe('usage_dashboard labels', () => {
  const CATCH_ALL = /^(other|others|misc|rest|remaining|scopes with no role)$/i;
  type Item = { key: string; label: string; value: number; children?: Item[] };
  const all = (items: Item[]): Item[] => items.flatMap(i => [i, ...all(i.children ?? [])]);

  it('gives namespaces with one display name unique, real labels', async () => {
    const fx = usageFixture();
    const names = ['team-a-billing', 'team-a-search', 'team-a-web'];
    const items = names.map(name => ({ metadata: { name, annotations: { 'app.kubernetes.io/display-name': 'Team A Apps' } } }));
    const kube = { list: async () => ({ info: {}, items, truncated: false }) } as never;
    // Rename three fixture namespaces to the colliding ones through the pod series.
    const prom = fx.context().prom;
    const renamed = {
      query: async (q: string) =>
        (await prom.query(q)).map(s =>
          s.metric.namespace === 'shop' ? { ...s, metric: { ...s.metric, namespace: 'team-a-billing' } }
          : s.metric.namespace === 'web' ? { ...s, metric: { ...s.metric, namespace: 'team-a-web' } }
          : s.metric.namespace === 'search' ? { ...s, metric: { ...s.metric, namespace: 'team-a-search' } }
          : s),
    } as never;
    const { data } = await run(fx.context({ kube, prom: renamed }));
    for (const ring of data.rings) {
      const k8s = ring.segments.find(s => s.key === 'k8s')!;
      const labels = k8s.children!.map(c => c.label);
      expect(new Set(labels).size).toBe(labels.length);
      expect(labels).toEqual(expect.arrayContaining(['Team A Apps (team-a-billing)', 'Team A Apps (team-a-search)', 'Team A Apps (team-a-web)']));
      for (const n of ring.nodes!) {
        const kids = n.segments.find(s => s.key === 'k8s')!.children!.map(c => c.label);
        expect(new Set(kids).size).toBe(kids.length);
      }
    }
  });

  it('has no catch-all key or label in any ring', async () => {
    const { data } = await run();
    const segs = data.rings.flatMap(r => [...r.segments, ...r.nodes!.flatMap(n => n.segments)]);
    for (const i of all(segs)) {
      expect(i.key.endsWith('/other')).toBe(false);
      expect(i.key).not.toBe('other');
      expect(i.label).not.toMatch(CATCH_ALL);
    }
  });
});
