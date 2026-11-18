import { describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: (u: string) => request(u) },
}));

import {
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
    });
  });
  it('falls back to defaults', () => {
    expect(resolveNodesSettings(undefined)).toEqual(DEFAULT_NODES_SETTINGS);
    expect(resolveNodesSettings({ agentBackends: [' x '] }).agentBackends).toEqual(['x']);
  });
});
