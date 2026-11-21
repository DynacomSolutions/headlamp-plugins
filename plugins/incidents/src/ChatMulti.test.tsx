import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { createIncidentsChat } from './chat-data';
import { chatIncidentIds, parseChat, parseChats } from './chat-model';
import { CHAT_RAIL_WIDTH, ChatPage } from './ChatPage';
import { IncidentChats } from './IncidentChats';
import { DEFAULT_SETTINGS } from './model';

const diag = (id: string, name: string, at: string) => ({
  id,
  createdAt: at,
  status: 'done',
  source: 'webhook',
  alert: { name, severity: 'critical' },
  result: { likelyCause: `cause of ${name}`, confidence: 'high' },
});

let calls: Array<{ url: string; method: string; body?: any }>;
let chat: any;
let chatList: any[];

beforeEach(() => {
  calls = [];
  chat = {
    ...JSON.parse(JSON.stringify(CHAT)),
    diagnosisId: 'a1',
    diagnosisIds: ['a1', 'b2', 'c3'],
  };
  chatList = [{ ...chat, messages: undefined }];
  request.mockReset();
  request.mockImplementation(async (url: string, params?: any) => {
    const method = params?.method ?? 'GET';
    calls.push({ url, method, body: params?.body ? JSON.parse(params.body) : undefined });
    if (url.endsWith('/api/models')) return { default: 'claude/opus', models: MODELS };
    if (url.includes('/api/diagnoses?'))
      return {
        total: 3,
        diagnoses: [
          diag('a1', 'DiskFull', '2026-11-19T10:01:00Z'),
          diag('b2', 'NodeDown', '2026-11-19T10:02:00Z'),
          diag('c3', 'DiskFull', '2026-11-19T10:03:00Z'),
        ],
      };
    if (url.includes('/api/chats?')) return { chats: chatList };
    if (url.endsWith('/api/chats/c1')) return chat;
    return {};
  });
});
afterEach(() => cleanup());

const renderChat = () =>
  render(
    <MemoryRouter initialEntries={['/incidents/chat/c1']}>
      <Route path="/incidents/chat/:id?" component={ChatPage} />
    </MemoryRouter>
  );

describe('createIncidentsChat', () => {
  it('sends one id as diagnosisId and several as one diagnosisIds list', async () => {
    request.mockResolvedValue({ id: 'new1' });
    await expect(createIncidentsChat(DEFAULT_SETTINGS, ['a'])).resolves.toBe('new1');
    await createIncidentsChat(DEFAULT_SETTINGS, ['a', 'b', 'a', 'c'], 'claude/opus');
    const bodies = request.mock.calls.map(c => JSON.parse(c[1].body));
    expect(bodies[0]).toEqual({ diagnosisId: 'a' });
    expect(bodies[1]).toEqual({ model: 'claude/opus', diagnosisIds: ['a', 'b', 'c'] });
    expect(request.mock.calls[1][0]).toMatch(/\/api\/chats$/);
    expect(request.mock.calls[1][1].method).toBe('POST');
  });
  it('refuses an empty selection without a request', async () => {
    request.mockClear();
    await expect(createIncidentsChat(DEFAULT_SETTINGS, [])).rejects.toThrow(/at least one/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('chat model with several incidents', () => {
  it('reads the list, and the single id of an older agent', () => {
    const many = parseChat({ id: 'c', diagnosisIds: ['a', 'b', 'a', ''] });
    expect(many.diagnosisIds).toEqual(['a', 'b']);
    expect(many.diagnosisId).toBe('a');
    expect(chatIncidentIds(many)).toEqual(['a', 'b']);
    const old = parseChat({ id: 'c', diagnosisId: 'z' });
    expect(old.diagnosisIds).toBeUndefined();
    expect(chatIncidentIds(old)).toEqual(['z']);
    expect(chatIncidentIds(parseChat({ id: 'c' }))).toEqual([]);
    expect(parseChats({ chats: [{ id: 'c', diagnosisIds: ['a'] }] })[0].diagnosisIds).toEqual([
      'a',
    ]);
  });
});

describe('thread with several incidents', () => {
  it('lists every linked incident under the thread title, each a link inside Headlamp', async () => {
    renderChat();
    const list = await screen.findByRole('list', { name: 'Incidents in this chat' });
    expect(screen.getByText('About 3 incidents')).toBeTruthy();
    const links = await waitFor(() => {
      const found = within(list).getAllByRole('link');
      expect(found[0].textContent).toContain('DiskFull');
      return found;
    });
    expect(links).toHaveLength(3);
    expect(links.map(l => l.getAttribute('href'))).toEqual([
      '/c/test/incident/a1',
      '/c/test/incident/b2',
      '/c/test/incident/c3',
    ]);
    // Two incidents of one alert have different chips: the time of day tells them apart.
    expect(links[0].textContent).not.toBe(links[2].textContent);
    for (const l of links) expect(l.getAttribute('href')).toMatch(/^\/c\/test\//);
  });
  it('shows the count of incidents in the chat list, on the line of the time', async () => {
    renderChat();
    const nav = await screen.findByRole('navigation', { name: 'Chats' });
    expect(await within(nav).findByText(/3 incidents/)).toBeTruthy();
  });
  it('keeps the one-incident sentence for a chat about one incident', async () => {
    chat.diagnosisIds = ['a1'];
    chatList = [{ ...chat, messages: undefined }];
    renderChat();
    expect(await screen.findByText(/About incident/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Incidents in this chat' })).toBeNull();
  });
});

describe('chat navigation width', () => {
  it('is thin: 192 px, down from 260 px, on a wide screen', async () => {
    expect(CHAT_RAIL_WIDTH).toBe(192);
    expect(CHAT_RAIL_WIDTH).toBeLessThan(260);
    renderChat();
    const nav = await screen.findByRole('navigation', { name: 'Chats' });
    const rules = Array.from(document.styleSheets).flatMap(s =>
      Array.from(s.cssRules).map(r => r.cssText)
    );
    const cls = Array.from(nav.classList).find(c => c.startsWith('css-'))!;
    const own = rules.filter(r => r.includes(`.${cls}`)).join(' ');
    expect(own).toContain(`width: ${CHAT_RAIL_WIDTH}px`);
    expect(own).not.toContain('260px');
  });
  it('keeps the title on one line with its full text in a tooltip label, and the time visible', async () => {
    renderChat();
    const nav = await screen.findByRole('navigation', { name: 'Chats' });
    const title = within(nav).getAllByText('Why is api failing')[0];
    expect(title.className).toMatch(/noWrap/);
    expect(within(nav).getAllByText(/ago|just now/).length).toBeGreaterThan(0);
  });
  it('opens the chat list in a drawer on a narrow screen', async () => {
    renderChat();
    expect(document.querySelector('.MuiDrawer-root')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /^Chats$/ }));
    // An open drawer hides the page behind it, so its list is the one navigation left.
    const drawer = await waitFor(() => {
      const el = document.querySelector('.MuiDrawer-root nav') as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    expect(drawer.getAttribute('aria-label')).toBe('Chats');
    fireEvent.click(within(drawer).getByRole('link', { name: /Why is api failing/ }));
    await waitFor(() => expect(document.querySelector('.MuiDrawer-root')).toBeNull());
  });
});

describe('chats under an incident', () => {
  it('lists the threads linked to the incident, with their incident count', async () => {
    chatList = [
      {
        id: 'c1',
        title: 'Disk alarm',
        updatedAt: '2026-11-19T10:00:00Z',
        diagnosisId: 'a1',
        diagnosisIds: ['a1', 'b2'],
      },
      {
        id: 'c2',
        title: 'Other thing',
        updatedAt: '2026-11-19T10:00:00Z',
        diagnosisId: 'zz',
        diagnosisIds: ['zz'],
      },
    ];
    render(
      <MemoryRouter>
        <IncidentChats diagnosisId="a1" />
      </MemoryRouter>
    );
    const link = await screen.findByRole('link', { name: 'Disk alarm' });
    expect(link.getAttribute('href')).toBe('/c/test/incidents-chat-thread/c1');
    expect(screen.getByText(/2 incidents/)).toBeTruthy();
    // An older agent ignores the filter: the thread of another incident stays out.
    expect(screen.queryByText('Other thing')).toBeNull();
    expect(calls.some(c => c.url.includes('diagnosisId=a1'))).toBe(true);
  });
  it('renders nothing when the incident has no chat', async () => {
    chatList = [];
    const { container } = render(
      <MemoryRouter>
        <IncidentChats diagnosisId="a1" />
      </MemoryRouter>
    );
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(container.textContent).toBe('');
  });
});
