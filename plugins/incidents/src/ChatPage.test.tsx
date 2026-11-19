import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT, MODELS } from './chat.fixture';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
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

import { ChatPage } from './ChatPage';

type Calls = { url: string; method: string; body: any }[];
let calls: Calls;
let chat: any;

beforeEach(() => {
  calls = [];
  chat = JSON.parse(JSON.stringify(CHAT));
  request.mockReset();
  request.mockImplementation(async (url: string, params?: any) => {
    const method = params?.method ?? 'GET';
    calls.push({ url, method, body: params?.body ? JSON.parse(params.body) : undefined });
    if (url.endsWith('/api/models')) return { default: 'claude/opus', models: MODELS };
    if (url.includes('/api/chats?')) return { chats: [{ ...chat, messages: undefined }] };
    if (method === 'POST' && url.endsWith('/api/chats')) return { id: 'new1' };
    if (method === 'POST') return { messageId: 'x' };
    if (url.endsWith('/api/chats/c1')) return chat;
    return {};
  });
});

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Route path="/incidents/chat/:id?" component={ChatPage} />
      <Route
        path="/c/test"
        render={({ location }) => <div data-testid="loc">{location.pathname}</div>}
      />
    </MemoryRouter>
  );
const posts = () => calls.filter(c => c.method === 'POST');

describe('ChatPage', () => {
  it('renders the thread, markdown and the chat list from a fixture', async () => {
    renderAt('/incidents/chat/c1');
    expect(await screen.findByText('Why is api failing?', { selector: 'div' })).toBeTruthy();
    expect(screen.getByText('api', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('kubectl top pod api')).toBeTruthy();
    expect(screen.getAllByText('Why is api failing').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'd9' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Claude Sonnet/ })).toBeTruthy();
  });
  it('collapses the tool steps and expands them on click', async () => {
    renderAt('/incidents/chat/c1');
    const toggle = await screen.findByRole('button', { name: /Investigated 2 things/ });
    expect(screen.queryByText('get_pods')).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByText('get_pods')).toBeTruthy();
    expect(screen.getByText('Read the logs')).toBeTruthy();
    expect(screen.getByLabelText('Failed')).toBeTruthy();
  });
  it('sends on Enter and keeps Shift+Enter as a newline', async () => {
    renderAt('/incidents/chat/c1');
    await screen.findByText('Why is api failing?', { selector: 'div' });
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(posts()).toHaveLength(0);
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toContain('/api/chats/c1/messages');
    expect(posts()[0].body).toEqual({ text: 'hello' });
    await waitFor(() => expect(box.value).toBe(''));
  });
  it('shows Stop while a turn runs and cancels it', async () => {
    chat.running = true;
    chat.messages[1].status = 'running';
    renderAt('/incidents/chat/c1');
    const stop = await screen.findByRole('button', { name: 'Stop' });
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.click(stop);
    await waitFor(() => expect(posts().some(p => p.url.endsWith('/cancel'))).toBe(true));
  });
  it('creates a chat with the default model, sends, then opens it', async () => {
    renderAt('/incidents/chat');
    expect(await screen.findByText(/What do you want to know/)).toBeTruthy();
    await screen.findByRole('button', { name: /Claude Opus/ });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'status?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0].url).toMatch(/\/api\/chats$/);
    expect(posts()[0].body).toEqual({ model: 'claude/opus' });
    expect(posts()[1].url).toContain('/api/chats/new1/messages');
    expect(posts()[1].body).toEqual({ text: 'status?' });
    expect((await screen.findByTestId('loc')).textContent).toBe(
      '/c/test/incidents-chat-thread/new1'
    );
  });
  it('links to the diagnosis and the chat list with cluster-scoped URLs', async () => {
    renderAt('/incidents/chat/c1');
    const link = await screen.findByRole('link', { name: 'd9' });
    expect(link.getAttribute('href')).toBe('/c/test/incident/d9');
    const newChat = screen.getByRole('link', { name: /New chat/ });
    expect(newChat.getAttribute('href')).toBe('/c/test/incidents-chat');
  });
  it('sends a changed model with the next message', async () => {
    renderAt('/incidents/chat/c1');
    fireEvent.click(await screen.findByRole('button', { name: /Claude Sonnet/ }));
    fireEvent.click(screen.getByRole('option', { name: /Claude Opus/ }));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ text: 'again', model: 'claude/opus' });
  });
  it('shows a failed turn error', async () => {
    chat.messages[1].status = 'failed';
    chat.messages[1].error = 'model unavailable';
    renderAt('/incidents/chat/c1');
    expect(await screen.findByText('model unavailable')).toBeTruthy();
  });
});
