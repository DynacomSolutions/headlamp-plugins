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
import { mergeAgents } from './useNodesData';

const host = (node: string, backend: string): AgentHost => ({
  node,
  backend,
  units: [],
  orchestrators: [],
});

describe('mergeAgents', () => {
  it("keys hosts by node and remembers each backend's node", () => {
    const r = mergeAgents(new Map(), { hosts: [host('worker-1', 'service/a/b:80')], errors: [] });
    expect([...r.agents.keys()]).toEqual(['worker-1']);
    expect(r.backendNodes.get('service/a/b:80')).toBe('worker-1');
    expect(r.nodeErrors.size).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it("puts a failing backend's error on the node it served last time", () => {
    const known = new Map([['service/a/b:80', 'worker-1']]);
    const r = mergeAgents(known, {
      hosts: [],
      errors: [{ backend: 'service/a/b:80', message: 'boom' }],
    });
    expect(r.nodeErrors.get('worker-1')).toContain('boom');
    expect(r.errors).toEqual([]);
    expect(r.backendNodes.get('service/a/b:80')).toBe('worker-1');
  });

  it('reports an error from a backend never seen as page-wide', () => {
    const r = mergeAgents(new Map(), {
      hosts: [],
      errors: [{ backend: 'service/a/b:80', message: 'boom' }],
    });
    expect(r.nodeErrors.size).toBe(0);
    expect(r.errors).toEqual(['service/a/b:80: boom']);
  });
});
