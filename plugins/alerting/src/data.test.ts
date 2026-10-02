import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { applyLive, createSubscription } from './data';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn() },
  ConfigStore: class {},
  K8s: {},
}));

const S: any = { group: 'example.com', version: 'v1', namespace: 'ns' };
const res = { metadata: { name: 'x' }, spec: {} };
const request = ApiProxy.request as any;

describe('body-carrying requests set a JSON content type', () => {
  beforeEach(() => request.mockReset().mockResolvedValue({}));

  const expectJson = () => {
    const bodied = request.mock.calls.filter(([, o]: any) => o && o.body !== undefined);
    expect(bodied.length).toBeGreaterThan(0);
    for (const [, o] of bodied) expect(o.headers).toEqual({ 'Content-Type': 'application/json' });
  };

  it('POST on create', async () => {
    await applyLive(S, 'NotificationChannel', res, null);
    expect(request.mock.calls[0][1].method).toBe('POST');
    expectJson();
  });

  it('PUT on update', async () => {
    await applyLive(S, 'NotificationChannel', res, { metadata: { resourceVersion: '1' } });
    expect(request.mock.calls[0][1].method).toBe('PUT');
    expectJson();
  });

  it('both POSTs when a subscription conflicts', async () => {
    request.mockRejectedValueOnce({ status: 409 });
    await createSubscription(S, res);
    expect(request.mock.calls.filter(([, o]: any) => o.method === 'POST')).toHaveLength(2);
    expectJson();
  });
});
