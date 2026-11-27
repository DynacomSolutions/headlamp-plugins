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

type Calls = { url: string; method: string; body: any; headers?: Record<string, string> }[];
let calls: Calls;
let chat: any;

beforeEach(() => {
  calls = [];
  chat = JSON.parse(JSON.stringify(CHAT));
  request.mockReset();
  request.mockImplementation(async (url: string, params?: any) => {
    const method = params?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: params?.body ? JSON.parse(params.body) : undefined,
      headers: params?.headers,
    });
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
    const toggle = await screen.findByRole('button', { name: /Used 2 tools, 1 failed/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('get_pods')).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByText('get_pods')).toBeTruthy();
    expect(screen.getByText('Read the logs')).toBeTruthy();
    expect(screen.getByLabelText('Failed')).toBeTruthy();
    // A tool card opens to its arguments and its result, and closes again.
    const card = screen.getByRole('button', { name: /get_logs/ });
    expect(card.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(card);
    expect(card.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText('Error')).toBeTruthy();
    expect(screen.getByText('denied')).toBeTruthy();
  });
  it('shows the model, identity, tokens, cost and time under an answer, and the context meter', async () => {
    chat.messages[1].usage = {
      inputTokens: 12345,
      outputTokens: 540,
      contextTokens: 24000,
      contextWindow: 200000,
      calls: 2,
      costUsd: 0.0123,
      identity: 'Pool',
      durationMs: 12000,
    };
    renderAt('/incidents/chat/c1');
    const line = await screen.findByText('sonnet');
    const usage = line.closest('[data-usage-line]') as HTMLElement;
    expect(usage.textContent).toContain('Pool');
    expect(usage.textContent).toContain('12k in');
    expect(usage.textContent).toContain('540 out');
    expect(usage.textContent).toContain('$0.012');
    expect(usage.textContent).toContain('12 s');
    expect(usage.textContent).toContain('2 tool calls');
    const meter = screen.getByRole('meter', { name: 'Context window' });
    expect(meter.getAttribute('aria-valuenow')).toBe('24000');
    expect(meter.getAttribute('aria-valuemax')).toBe('200000');
    expect(meter.textContent).toContain('24k / 200k');
  });
  it('shows the thinking section and a running tool with its live status while a turn runs', async () => {
    chat.running = true;
    chat.messages[1] = {
      ...chat.messages[1],
      status: 'running',
      text: '',
      thinking: 'Checking the pod first.',
      steps: [
        { id: 's1', tool: 'get_pods', reason: 'List the pods', ok: true, summary: '3 pods', status: 'done', durationMs: 420 },
        { id: 's2', tool: 'get_logs', reason: 'Read the logs', status: 'running', startedAt: new Date().toISOString() },
      ],
    };
    renderAt('/incidents/chat/c1');
    // Open while the turn runs: the reader sees the work as it happens.
    expect(await screen.findByText('Checking the pod first.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Thinking/ }).getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText('get_logs')).toBeTruthy();
    expect(screen.getByLabelText('Running', { selector: '[role="progressbar"]' })).toBeTruthy();
    expect(screen.getByText('420 ms')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
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
  it('creates a chat without a model when none is picked, sends, then opens it', async () => {
    renderAt('/incidents/chat');
    expect(await screen.findByText(/What do you want to know/)).toBeTruthy();
    await screen.findByRole('button', { name: /Claude Opus/ });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'status?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0].url).toMatch(/\/api\/chats$/);
    // The default is shown but not sent: the agent applies its default order, with a fallback by usage.
    expect(posts()[0].body).toEqual({});
    // No pick, so no pick header: an older agent and a newer one both read this as no model chosen.
    expect(posts()[0].headers?.['x-incidents-model-pick']).toBeUndefined();
    expect(posts()[1].url).toContain('/api/chats/new1/messages');
    expect(posts()[1].body).toEqual({ text: 'status?' });
    expect((await screen.findByTestId('loc')).textContent).toBe(
      '/c/test/incidents-chat-thread/new1'
    );
  });
  it('creates a chat with the model the user picked', async () => {
    renderAt('/incidents/chat');
    fireEvent.click(await screen.findByRole('button', { name: /Claude Opus/ }));
    fireEvent.click(screen.getByRole('option', { name: /Claude Sonnet/ }));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'status?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    // The identity of the pick goes with it, so the agent answers from the identity the person chose.
    expect(posts()[0].body).toEqual({ model: 'claude/sonnet', identity: 'claude' });
    expect(posts()[0].headers?.['x-incidents-model-pick']).toBe('1');
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
    expect(posts()[0].body).toEqual({ text: 'again', model: 'claude/opus', identity: 'claude' });
  });
  it('shows a failed turn error', async () => {
    chat.messages[1].status = 'failed';
    chat.messages[1].error = 'model unavailable';
    renderAt('/incidents/chat/c1');
    expect(await screen.findByText('model unavailable')).toBeTruthy();
  });
  it('refreshes the chat list when the open chat stops running', async () => {
    chat.running = true;
    chat.messages[1].status = 'running';
    renderAt('/incidents/chat/c1');
    await screen.findByRole('button', { name: 'Stop' });
    const listCalls = () => calls.filter(c => c.url.includes('/api/chats?')).length;
    const before = listCalls();
    chat.running = false;
    chat.messages[1].status = 'done';
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull(), {
      timeout: 3000,
    });
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
  });
  it('opens the picker on the default model of a new chat, checked and scrolled into view', async () => {
    const zai = [
      '4.5',
      '4.5-air',
      '4.6',
      '4.7',
      '5',
      '5-turbo',
      '5.1',
      '5.2',
      '5.3',
      '5.3-flash',
      '5.3-flashx',
      '5.3-flashx-legal',
    ].map(v => ({ id: `zai/glm-${v}`, route: 'zai', model: `glm-${v}`, name: `glm-${v}`, provider: 'zai', identity: 'Pool' }));
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (url: string, params?: any) =>
      url.endsWith('/api/models')
        ? { default: 'zai/glm-5.3', models: [...zai, ...MODELS] }
        : base(url, params)
    );
    const scrolled: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? '');
    };
    try {
      renderAt('/incidents/chat');
      fireEvent.click(await screen.findByRole('button', { name: /^glm-5\.3$/ }));
      const checked = await screen.findByRole('option', { selected: true });
      expect(checked.textContent).toContain('glm-5.3');
      expect(checked.textContent).not.toContain('flash');
      const lit = document.querySelectorAll('[data-highlighted="true"]');
      expect(lit).toHaveLength(1);
      expect(lit[0].textContent).toContain('glm-5.3');
      expect(scrolled.some(t => t.includes('glm-5.3') && !t.includes('flash'))).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
});
