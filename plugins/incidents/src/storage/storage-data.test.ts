import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSettings } from '../model';

const request = vi.hoisted(() => vi.fn());
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request },
  Router: { createRouteURL: () => '/' },
  ConfigStore: class {
    useConfig() {
      return () => ({});
    }
    set() {}
  },
}));

import { postStorage } from './storage-data';

beforeEach(() => request.mockReset());

describe('storage calls', () => {
  it('use the session Service port, whatever the configured agent port is', async () => {
    request.mockResolvedValue({});
    await postStorage(resolveSettings({ servicePort: '8080' }, {}), '/incident/notifications', {});
    expect(request.mock.calls[0][0]).toBe(
      '/api/v1/namespaces/headlamp-agent/services/headlamp-agent:session/proxy/api/storage/incident/notifications'
    );
  });

  it('explain a 401 and a 403 accurately', async () => {
    const settings = resolveSettings({}, {});
    request.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 401 }));
    await expect(postStorage(settings, '/incident', {})).rejects.toThrow(
      /did not accept this Headlamp session.*STORAGE_SESSION_PROXY_CIDRS/
    );
    request.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 403 }));
    await expect(postStorage(settings, '/incident', {})).rejects.toThrow(
      'Storage operator permission required.'
    );
  });
});
