import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT, MODELS } from './chat.fixture';

const { request, push } = vi.hoisted(() => ({
  request: vi.fn(),
  push: { device: null as null | { endpoint: string } },
}));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request },
  Router: {
    createRouteURL: (name: string, params?: { id?: string }) =>
      `/c/test/${name}${params?.id ? '/' + params.id : ''}`,
  },
  ConfigStore: class {
    useConfig() {
      return () => ({ favourites: [] });
    }
    set() {}
  },
}));
vi.mock('./push', () => ({
  currentSupport: () => 'ok',
  existingSubscription: async () => push.device,
  subscribeDevice: async () => push.device,
  unsubscribeDevice: async () => undefined,
}));

import { ChatPage } from './ChatPage';

const ID = 'a4d364375df9521b3855dae1e643eb8b';
type Call = { url: string; method: string; body: any };
let calls: Call[];

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  calls = [];
  setVisibility('visible');
  push.device = null;
  request.mockReset();
  request.mockImplementation(async (url: string, params?: any) => {
    const method = params?.method ?? 'GET';
    calls.push({ url, method, body: params?.body ? JSON.parse(params.body) : undefined });
    if (url.endsWith('/api/models')) return { default: 'claude/opus', models: MODELS };
    if (url.includes('/api/chats?')) return { chats: [{ ...CHAT, messages: undefined }] };
    if (url.endsWith('/api/chats/c1')) return CHAT;
    if (method === 'POST') return { messageId: 'x' };
    return {};
  });
});

const renderChat = () =>
  render(
    <MemoryRouter initialEntries={['/incidents/chat/c1']}>
      <Route path="/incidents/chat/:id?" component={ChatPage} />
    </MemoryRouter>
  );
const presence = () => calls.filter(c => c.url.endsWith(`/api/push/subscriptions/${ID}/presence`));
const messages = () => calls.filter(c => c.url.endsWith('/messages'));
const send = async (text: string) => {
  const box = (await screen.findByLabelText('Message')) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
};
const DEVICE = { endpoint: 'https://fcm.googleapis.com/fcm/send/test-one' };

describe('chat and push', () => {
  it('names this device when it asks, so the agent can push the answer', async () => {
    push.device = DEVICE;
    renderChat();
    await screen.findByText('Why is api failing?', { selector: 'div' });
    await vi.waitFor(() => expect(presence().length).toBeGreaterThan(0));
    await send('hello');
    await vi.waitFor(() => expect(messages()).toHaveLength(1));
    expect(messages()[0]!.body).toEqual({ text: 'hello', push: ID });
  });

  it('sends no push id when this device has no subscription', async () => {
    renderChat();
    await screen.findByText('Why is api failing?', { selector: 'div' });
    await send('hello');
    await vi.waitFor(() => expect(messages()).toHaveLength(1));
    expect(messages()[0]!.body).toEqual({ text: 'hello' });
    expect(presence()).toHaveLength(0);
  });

  it('reports the chat while visible and none when the page is hidden or closed', async () => {
    push.device = DEVICE;
    const { unmount } = renderChat();
    await vi.waitFor(() => expect(presence()).toHaveLength(1));
    expect(presence()[0]!.method).toBe('POST');
    expect(presence()[0]!.body).toEqual({ chatId: 'c1' });
    act(() => setVisibility('hidden'));
    await vi.waitFor(() => expect(presence()).toHaveLength(2));
    expect(presence()[1]!.body).toEqual({ chatId: null });
    act(() => setVisibility('visible'));
    await vi.waitFor(() => expect(presence()).toHaveLength(3));
    expect(presence()[2]!.body).toEqual({ chatId: 'c1' });
    unmount();
    expect(presence()[3]!.body).toEqual({ chatId: null });
  });
});
