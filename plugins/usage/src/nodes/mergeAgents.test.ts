import { describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn() },
  ConfigStore: class {
    useConfig() {
      return () => ({});
    }
  },
}));

import type { AgentHost } from './agents';
// Imported after the mock above.
import { emptyAgentMemory, MAX_AGENT_FAILURES, mergeAgents } from './useNodesData';

const host = (node: string, backend: string): AgentHost => ({
  node,
  backend,
  units: [],
  orchestrators: [],
});

const B = 'service/a/b:80';
const fail = { hosts: [], errors: [{ backend: B, message: 'boom' }] };

describe('mergeAgents', () => {
  it("keys hosts by node and remembers each backend's node", () => {
    const r = mergeAgents(emptyAgentMemory(), { hosts: [host('worker-1', B)], errors: [] }, 1);
    expect([...r.agents.keys()]).toEqual(['worker-1']);
    expect(r.memory.backendNodes.get(B)).toBe('worker-1');
    expect(r.nodeErrors.size).toBe(0);
    expect(r.agentsAsOf.size).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it("puts a failing backend's error on the node it served last time", () => {
    const memory = { ...emptyAgentMemory(), backendNodes: new Map([[B, 'worker-1']]) };
    const r = mergeAgents(memory, fail, 1);
    expect(r.nodeErrors.get('worker-1')).toContain('boom');
    expect(r.errors).toEqual([]);
    expect(r.memory.backendNodes.get(B)).toBe('worker-1');
  });

  it('reports an error from a backend never seen as page-wide', () => {
    const r = mergeAgents(emptyAgentMemory(), fail, 1);
    expect(r.nodeErrors.size).toBe(0);
    expect(r.errors).toEqual(['service/a/b:80: boom']);
  });

  it('keeps the last good host, marked stale, until the third failure in a row', () => {
    const good = host('worker-1', B);
    let r = mergeAgents(emptyAgentMemory(), { hosts: [good], errors: [] }, 1000);
    for (let i = 1; i < MAX_AGENT_FAILURES; i++) {
      r = mergeAgents(r.memory, fail, 1000 + i * 10_000);
      expect(r.agents.get('worker-1')).toBe(good);
      expect(r.agentsAsOf.get('worker-1')).toBe(1000);
      expect(r.nodeErrors.get('worker-1')).toContain('boom');
    }
    r = mergeAgents(r.memory, fail, 99_000);
    expect(r.agents.has('worker-1')).toBe(false);
    expect(r.agentsAsOf.has('worker-1')).toBe(false);
    expect(r.nodeErrors.get('worker-1')).toContain('boom');
  });

  it('a success resets the failure count and the stale mark', () => {
    let r = mergeAgents(emptyAgentMemory(), { hosts: [host('worker-1', B)], errors: [] }, 1);
    r = mergeAgents(r.memory, fail, 2);
    r = mergeAgents(r.memory, fail, 3);
    const fresh = host('worker-1', B);
    r = mergeAgents(r.memory, { hosts: [fresh], errors: [] }, 4);
    expect(r.agentsAsOf.size).toBe(0);
    r = mergeAgents(r.memory, fail, 5);
    r = mergeAgents(r.memory, fail, 6);
    expect(r.agents.get('worker-1')).toBe(fresh);
    expect(r.agentsAsOf.get('worker-1')).toBe(4);
  });
});
