import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { describe, expect, it, vi } from 'vitest';
import { queryMetrics } from './metrics';

describe('queryMetrics', () => {
  it('shares one request between concurrent callers of the same query', async () => {
    const request = vi.spyOn(ApiProxy, 'request').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success', data: { result: [] } }),
    } as any);
    await Promise.all([queryMetrics('up'), queryMetrics('up'), queryMetrics('down')]);
    expect(request).toHaveBeenCalledTimes(2);
    await queryMetrics('up');
    expect(request).toHaveBeenCalledTimes(3);
  });
});
