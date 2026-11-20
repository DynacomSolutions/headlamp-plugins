import { describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: (u: string) => request(u) },
}));

import {
  backendCandidates,
  DEFAULT_NODES_SETTINGS,
  fetchAgentHosts,
  iconUrl,
  parseAgentState,
  resolveNodesSettings,
} from './agents';

const state = {
  node: 'worker-1',
  orchestrators: [{ name: 't3', title: 'T3 Code', kind: 't3' }],
  units: [
    {
      name: 'a.scope',
      kind: 'scope',
      orchestrator: 't3',
      role: 'agent',
      parent: 'env.slice',
      depth: 2,
      anon: 100,
      shmem: 20,
      kernel: 3,
      cpuCores: 0.5,
      agent: {
        threadUrl: 'https://example.com/t/1',
        names: {
          workspace: 'proj',
          title: 'Fix it',
          tab: 'tab',
          projectId: 'p1',
          icon: { kind: 'lucide', name: 'bug', color: '#fff' },
        },
      },
      processes: {
        roots: [
          {
            pid: 1,
            command: 'claude',
            rss: 50,
            cpuCores: 0.2,
            children: [{ pid: 2, command: 'node', rss: 10, children: [] }],
          },
        ],
      },
    },
    {
      name: 'b.scope',
      kind: 'scope',
      anon: 1,
      shmem: 0,
      kernel: 0,
      agent: { threadUrl: 'javascript:x', names: { tab: 'T' } },
    },
  ],
};

describe('parseAgentState', () => {
  it('maps units', () => {
    const h = parseAgentState(state, 'service/ns/svc:80');
    expect(h.node).toBe('worker-1');
    expect(h.backend).toBe('service/ns/svc:80');
    expect(h.orchestrators).toEqual([{ name: 't3', title: 'T3 Code' }]);
    const [a, b] = h.units;
    expect(a.memBytes).toBe(123);
    expect(a.cpuCores).toBe(0.5);
    expect(a.project).toBe('proj');
    expect(a.thread).toBe('Fix it');
    expect(a.projectId).toBe('p1');
    expect(a.icon).toEqual({ kind: 'lucide', name: 'bug', color: '#fff' });
    expect(a.threadUrl).toBe('https://example.com/t/1');
    expect(a.procs[0].cpuCores).toBe(0.2);
    expect(a.procs[0].children[0].pid).toBe(2);
    expect(a.procs[0].children[0].cpuCores).toBeUndefined();
    expect(b.cpuCores).toBeUndefined();
    expect(b.thread).toBe('T');
    expect(b.threadUrl).toBeUndefined();
    expect(b.procs).toEqual([]);
    expect(a.parent).toBe('env.slice');
    expect(a.depth).toBe(2);
    expect(b.parent).toBeUndefined();
  });
  it('throws on garbage', () => {
    expect(() => parseAgentState(null, 'x')).toThrow();
    expect(() => parseAgentState({ units: 5 }, 'x')).toThrow();
  });
});

describe('fetchAgentHosts', () => {
  it('keeps good backends and reports failures', async () => {
    request.mockImplementation(async (u: string) => {
      if (u.includes('/services/bad:80/')) throw new Error('boom');
      return state;
    });
    const r = await fetchAgentHosts(['service/ns/good:80', 'service/ns/bad:80']);
    expect(r.hosts).toHaveLength(1);
    expect(r.errors).toEqual([{ backend: 'service/ns/bad:80', message: 'boom' }]);
  });
});

describe('backend fallback', () => {
  it('lists the new Service first and the old one as fallback', () => {
    expect(backendCandidates('service/ns/agent-resource:80')).toEqual([
      'service/ns/agent-resource:80',
      'service/ns/agent-memory:80',
    ]);
    expect(backendCandidates('service/ns/agent-memory:80')).toEqual([
      'service/ns/agent-resource:80',
      'service/ns/agent-memory:80',
    ]);
    expect(backendCandidates('service/ns/other:80')).toEqual(['service/ns/other:80']);
  });
  it('defaults to the new Service', () => {
    expect(DEFAULT_NODES_SETTINGS.agentBackends).toEqual([
      'service/agent-resource/agent-resource:80',
    ]);
    expect(backendCandidates('service/agent-resource/agent-resource:80')).toEqual([
      'service/agent-resource/agent-resource:80',
      'service/agent-memory/agent-resource:80',
    ]);
    expect(backendCandidates('service/agent-memory/agent-memory:80')).toEqual([
      'service/agent-resource/agent-resource:80',
      'service/agent-memory/agent-resource:80',
    ]);
  });
  it('falls back to the old Service when the new one does not answer', async () => {
    request.mockReset();
    request.mockImplementation(async (u: string) => {
      if (u.includes('/services/agent-resource:80/'))
        throw Object.assign(new Error('nf'), { status: 404 });
      return state;
    });
    const r = await fetchAgentHosts(['service/ns/agent-resource:80']);
    expect(r.errors).toEqual([]);
    expect(r.hosts).toHaveLength(1);
    expect(request.mock.calls.map(c => c[0])).toEqual([
      '/api/v1/namespaces/ns/services/agent-resource:80/proxy/api/state',
      '/api/v1/namespaces/ns/services/agent-memory:80/proxy/api/state',
    ]);
    // The next poll goes straight to the Service that answered, and icons use it too.
    request.mockClear();
    await fetchAgentHosts(['service/ns/agent-resource:80']);
    expect(request.mock.calls.map(c => c[0])).toEqual([
      '/api/v1/namespaces/ns/services/agent-memory:80/proxy/api/state',
    ]);
    expect(iconUrl('service/ns/agent-resource:80', 'p')).toContain('/services/agent-memory:80/');
  });
  it('shows the error that is not a 404 when both fail', async () => {
    request.mockReset();
    request.mockImplementation(async (u: string) => {
      if (u.includes('/services/agent-resource:80/'))
        throw Object.assign(new Error('missing'), { status: 404 });
      throw Object.assign(new Error('backend broke'), { status: 500 });
    });
    const r = await fetchAgentHosts(['service/zz/agent-resource:80']);
    expect(r.errors).toEqual([
      { backend: 'service/zz/agent-resource:80', message: 'backend broke' },
    ]);
  });
});

describe('iconUrl', () => {
  it('targets the proxy route', () => {
    expect(iconUrl('service/ns/svc:80', 'p 1')).toBe(
      '/api/v1/namespaces/ns/services/svc:80/proxy/api/project-icon?project=p%201'
    );
  });
});

describe('resolveNodesSettings', () => {
  it('parses and clamps', () => {
    expect(resolveNodesSettings({ agentBackends: 'a, b', idleSeconds: '5' })).toEqual({
      agentBackends: ['a', 'b'],
      idleSeconds: 30,
      displayNames: {},
    });
    expect(resolveNodesSettings({ displayNames: 'a=A' }).displayNames).toEqual({ a: 'A' });
  });
  it('falls back to defaults', () => {
    expect(resolveNodesSettings(undefined)).toEqual(DEFAULT_NODES_SETTINGS);
    expect(resolveNodesSettings({ agentBackends: [' x '] }).agentBackends).toEqual(['x']);
  });
});

describe('CPU limits of agent units', () => {
  const unitWith = (extra: object) => ({
    ...state,
    units: [{ name: 'c.scope', kind: 'scope', anon: 1, shmem: 0, kernel: 0, ...extra }],
  });
  const first = (extra: object) => parseAgentState(unitWith(extra), 'b').units[0];
  it('reads the CPU limit and throttling', () => {
    const u = first({ cpuQuotaCores: 16, cpuThrottledRatio: 4.2, cpuWeight: 100 });
    expect(u.cpuLimitCores).toBe(16);
    expect(u.cpuThrottledRatio).toBe(4.2);
  });
  it('treats CPU stats without a quota as no limit', () => {
    expect(first({ cpuWeight: 100 }).cpuLimitCores).toBeNull();
    expect(first({ cpuQuotaCores: null, cpuNrPeriods: 4 }).cpuLimitCores).toBeNull();
    expect(first({ cpuQuotaCores: 0, cpuNrPeriods: 4 }).cpuLimitCores).toBeNull();
  });
  it('leaves the limit unset for an old backend', () => {
    const u = first({ cpuCores: 1 });
    expect(u.cpuLimitCores).toBeUndefined();
    expect(u.cpuThrottledRatio).toBeUndefined();
  });
});
