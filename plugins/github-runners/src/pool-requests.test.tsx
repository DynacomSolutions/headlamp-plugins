import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request },
  ConfigStore: class {
    useConfig() {
      return () => ({});
    }
  },
  K8s: { ResourceClasses: {}, crd: { makeCustomResourceClass: () => ({}) } },
}));

import { usePoolService } from './data';
import { PANEL_IDS } from './pool';
import type { PluginConfig } from './types';

const set = { poolNamespace: 'ci', poolService: 'widgets' };

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
});
afterEach(cleanup);

const requestsFor = async (cfg: PluginConfig) => {
  const { result } = renderHook(() => usePoolService(cfg));
  // Give any effect and its promises time to run.
  await new Promise(resolve => setTimeout(resolve, 50));
  return { calls: request.mock.calls.map(c => String(c[0])), state: result.current.state };
};

describe('runner pool service requests', () => {
  it('sends no request with the mode off', async () => {
    const { calls, state } = await requestsFor({ ...set, poolMode: 'off' });
    expect(calls).toEqual([]);
    expect(state).toBe('off');
  });

  it('sends no request with no namespace and service set', async () => {
    for (const cfg of [{}, { poolNamespace: 'ci' }, { poolService: 'widgets' }, { poolMode: 'auto' }]) {
      const { calls, state } = await requestsFor(cfg);
      expect(calls).toEqual([]);
      expect(state).toBe('off');
    }
  });

  it('sends no request when the mode is on but nothing is set', async () => {
    const { calls, state } = await requestsFor({ poolMode: 'on' });
    expect(calls).toEqual([]);
    expect(state).toBe('error');
  });

  it('asks every panel path when a service is set (control)', async () => {
    renderHook(() => usePoolService({ ...set, poolMode: 'auto' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(PANEL_IDS.length));
    const calls = request.mock.calls.map(c => String(c[0]));
    expect(calls.every(c => c.startsWith('/api/v1/namespaces/ci/services/widgets:80/proxy/api/widgets/'))).toBe(true);
  });
});
