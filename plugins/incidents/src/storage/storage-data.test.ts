import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendUrl, resolveSettings } from '../model';
import {
  loadStorageTranscriptBefore,
  postStorage,
  useStorageChat,
  useStorageDrive,
  useStorageIncident,
  useStorageNotificationDevice,
} from './storage-data';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn() } }));
vi.mock('../chat-data', () => ({ useLoaded: (url: string) => ({ url }) }));

const settings = resolveSettings({}, {});
const id = '123e4567-e89b-42d3-a456-426614174000';

afterEach(() => vi.mocked(ApiProxy.request).mockReset());

describe('storage route selection', () => {
  it('uses the same-origin relay for shared reads and the service proxy for notification data', () => {
    expect(useStorageIncident(settings).url).toBe('/api/storage-relay/incident');
    expect(useStorageDrive(settings, id).url).toBe(`/api/storage-relay/incident/drives/${id}`);
    expect(useStorageChat(settings, id).url).toBe(`/api/storage-relay/incident/chat/${id}`);
    expect(useStorageNotificationDevice(settings, id).url).toBe(
      backendUrl(settings, `/api/storage/incident/notifications/${id}`)
    );
  });

  it('keeps mutations on the direct service-proxy route', async () => {
    vi.mocked(ApiProxy.request).mockResolvedValue({ ok: true } as never);
    await postStorage(settings, `/incident/chat/${id}/messages`, { text: 'inventory' });
    expect(ApiProxy.request).toHaveBeenCalledWith(
      backendUrl(settings, `/api/storage/incident/chat/${id}/messages`),
      {
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        body: JSON.stringify({ text: 'inventory' }),
      },
      false,
      true
    );
  });

  it('loads transcript pages through the same-origin relay without cluster headers and rejects redirects', async () => {
    vi.mocked(ApiProxy.request).mockResolvedValue({
      id,
      messages: [],
      nextBefore: null,
    } as never);
    await loadStorageTranscriptBefore(settings, id, id);
    expect(ApiProxy.request).toHaveBeenCalledWith(
      `/api/storage-relay/incident/chat/${id}/transcript?before=${id}&limit=24`,
      {
        headers: {},
        credentials: 'same-origin',
        redirect: 'error',
      },
      false,
      false
    );
  });
});
