import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { request, push } = vi.hoisted(() => ({
  request: vi.fn(),
  push: {
    support: 'ok' as 'ok' | 'needs-install' | 'unsupported',
    device: null as null | { endpoint: string; getKey: (n: string) => ArrayBuffer | null },
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  },
}));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request },
  Router: {
    createRouteURL: (name: string, params?: { id?: string }) =>
      `/c/main/${name === 'incident' ? 'incidents' : 'incidents/chat'}${params?.id ? '/' + params.id : ''}`,
  },
  ConfigStore: class {
    useConfig() {
      return () => ({});
    }
    set() {}
  },
}));
vi.mock('@kinvolk/headlamp-plugin/lib/CommonComponents', () => ({
  SectionBox: ({ title, children }: any) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));
vi.mock('./push', () => ({
  currentSupport: () => push.support,
  existingSubscription: async () => push.device,
  subscribeDevice: (key: string) => push.subscribe(key),
  unsubscribeDevice: () => push.unsubscribe(),
}));

import { NotificationsPage } from './NotificationsPage';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/test-one';
const ID = 'a4d364375df9521b3855dae1e643eb8b';
const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i + 1)).buffer;
const fakeDevice = () => ({ endpoint: ENDPOINT, getKey: (n: string) => (n === 'p256dh' ? bytes(65) : bytes(16)) });

type Call = { url: string; method: string; body: any };
let calls: Call[];
let config: { enabled: boolean; publicKey: string | null };
let record: any;

beforeEach(() => {
  calls = [];
  push.support = 'ok';
  push.device = null;
  push.subscribe.mockReset();
  push.subscribe.mockImplementation(async () => (push.device = fakeDevice()));
  push.unsubscribe.mockReset();
  push.unsubscribe.mockImplementation(async () => (push.device = null));
  config = { enabled: true, publicKey: 'KEY' };
  record = null;
  request.mockReset();
  request.mockImplementation(async (url: string, params?: any) => {
    const method = params?.method ?? 'GET';
    const body = params?.body ? JSON.parse(params.body) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith('/api/push/config')) return config;
    if (url.includes('/api/push/subscriptions/')) {
      if (method === 'GET') {
        if (!record) throw Object.assign(new Error('not found'), { status: 404 });
        return record;
      }
      if (method === 'POST' && url.endsWith('/unsubscribe')) {
        record = null;
        return { ok: true };
      }
      if (method === 'POST' && url.endsWith('/settings')) {
        record = { ...record, settings: body.settings };
        return record;
      }
      if (method === 'POST') {
        record = { id: ID, label: body.label, settings: body.settings ?? { diagnosis: true, chat: true, severities: ['warning', 'critical'] }, lastSentAt: null, lastResult: null };
        return record;
      }
    }
    return {};
  });
});

const writes = () => calls.filter(c => c.method !== 'GET');

describe('NotificationsPage', () => {
  it('allows local storage opt-out while its authority is unavailable', async () => {
    push.device = fakeDevice();
    record = {
      id: ID,
      label: 'Phone',
      settings: { diagnosis: true, chat: true, severities: ['critical'] },
    };
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (url: string, params?: { method?: string }) => {
      if (url.endsWith(`/api/storage/incident/notifications/${ID}`)) {
        throw Object.assign(new Error('Storage notification authority is unavailable'), { status: 503 });
      }
      return original(url, params);
    });

    render(<NotificationsPage />);
    expect(await screen.findByText('Storage notification authority is unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disable storage notifications' }));
    await waitFor(() =>
      expect(writes()).toContainEqual({
        url: expect.stringContaining('/api/storage/incident/notifications'),
        method: 'POST',
        body: { subscriptionId: ID, enabled: false, auth: Buffer.from(bytes(16)).toString('base64url') },
      })
    );
    expect(push.unsubscribe).not.toHaveBeenCalled();
  });

  it('subscribes this device with its own key and the paths a notification opens', async () => {
    render(<NotificationsPage />);
    const enable = await screen.findByRole('button', { name: 'Enable on this device' });
    fireEvent.click(enable);
    expect(await screen.findByRole('button', { name: 'Disable on this device' })).toBeTruthy();
    expect(push.subscribe).toHaveBeenCalledWith('KEY');
    const put = writes()[0]!;
    expect(put.method).toBe('POST');
    expect(put.url).toContain(`/api/push/subscriptions/${ID}`);
    expect(put.body.subscription.endpoint).toBe(ENDPOINT);
    expect(put.body.subscription.keys.auth).toBeTruthy();
    expect(put.body.urls).toEqual({ incident: '/c/main/incidents/{id}', chat: '/c/main/incidents/chat/{id}' });
    expect(screen.getByRole('checkbox', { name: 'Critical' })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: 'Warning' })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: /^Other/ })).toHaveProperty('checked', false);
  });

  it('shows the saved state of a subscribed device and saves a switch at once', async () => {
    push.device = fakeDevice();
    record = { id: ID, label: 'Phone', settings: { diagnosis: true, chat: true, severities: ['critical'] }, lastSentAt: '2026-11-21T06:00:00Z', lastResult: 'ok' };
    render(<NotificationsPage />);
    const chat = await screen.findByRole('checkbox', { name: 'Chat answers' });
    expect(chat).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: 'Warning' })).toHaveProperty('checked', false);
    expect(screen.getByText(/Last notification/)).toBeTruthy();
    fireEvent.click(chat);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'POST', body: { settings: { diagnosis: true, chat: false, severities: ['critical'] } } });
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Chat answers' })).toHaveProperty('checked', false));
  });

  it('changes the severity filter and switches off diagnosis pushes', async () => {
    push.device = fakeDevice();
    record = { id: ID, label: 'Phone', settings: { diagnosis: true, chat: true, severities: ['critical'] }, lastSentAt: null, lastResult: null };
    render(<NotificationsPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Warning' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body.settings.severities).toEqual(['critical', 'warning']);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Warning' })).toHaveProperty('checked', true));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Diagnosis ready' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]!.body.settings.diagnosis).toBe(false);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Critical' })).toHaveProperty('disabled', true));
  });

  it('disables the device: deletes the record and the browser subscription', async () => {
    push.device = fakeDevice();
    record = { id: ID, label: 'Phone', settings: { diagnosis: true, chat: true, severities: ['critical'] }, lastSentAt: null, lastResult: null };
    render(<NotificationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable on this device' }));
    expect(await screen.findByRole('button', { name: 'Enable on this device' })).toBeTruthy();
    expect(writes()[0]!.url).toMatch(/\/unsubscribe$/);
    expect(push.unsubscribe).toHaveBeenCalled();
  });

  it('says when the agent has no push key, and when the browser cannot push', async () => {
    config = { enabled: false, publicKey: null };
    const { unmount } = render(<NotificationsPage />);
    expect(await screen.findByText(/not set up on the agent/)).toBeTruthy();
    unmount();
    config = { enabled: true, publicKey: 'KEY' };
    push.support = 'unsupported';
    render(<NotificationsPage />);
    expect(await screen.findByText(/cannot receive web push/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enable on this device' })).toHaveProperty('disabled', true);
  });

  it('shows an error from the agent', async () => {
    render(<NotificationsPage />);
    const enable = await screen.findByRole('button', { name: 'Enable on this device' });
    request.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    push.subscribe.mockImplementation(async () => {
      throw new Error('Notifications are blocked for this site.');
    });
    fireEvent.click(enable);
    expect(await screen.findByText(/blocked for this site/)).toBeTruthy();
  });
});
