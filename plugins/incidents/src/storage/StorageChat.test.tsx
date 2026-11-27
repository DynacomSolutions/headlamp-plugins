import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatUrl, storageNotificationUrls } from '../routes';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request },
  Router: {
    createRouteURL: (name: string, params: Record<string, string> = {}) =>
      `/c/test/${name}${Object.values(params)
        .map(v => `/${v}`)
        .join('')}`,
  },
  ConfigStore: class {
    useConfig() {
      return () => ({ favourites: [] });
    }
    set() {}
  },
}));
vi.mock('@kinvolk/headlamp-plugin/lib/CommonComponents', () => ({
  SectionBox: ({ title, children }: any) => (
    <section>
      {title}
      {children}
    </section>
  ),
}));
vi.mock('../LaunchPages', () => ({ useNow: () => Date.now() }));

import { ChatPage } from '../ChatPage';
import {
  StorageChatRedirect,
  StorageFindingPage,
  StorageIncidentPage,
  StorageQuestionPage,
} from './StorageIncidentPage';

const CHAT = '11111111-1111-4111-8111-111111111111';
const DRIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const QUESTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FINDING = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const now = '2026-11-27T05:00:00.000Z';
const GiB = 1024 ** 3;

const drive = (id: string, mount: string) => ({
  id,
  node: 'worker-1',
  mount,
  filesystemId: `fs-${mount}`,
  totalBytes: 100 * GiB,
  availableBytes: 10 * GiB,
  reserveBytes: 20 * GiB,
  scannedAt: now,
  status: 'critical',
  complete: true,
  applyEnabled: true,
});

const incident = {
  enabled: true,
  applyEnabled: true,
  incident: { id: 'i1', chatId: CHAT, createdAt: now },
  drives: [drive(DRIVE, '/data'), drive(OTHER, '/var')],
  notices: [
    {
      id: 'n1',
      driveId: DRIVE,
      kind: 'question',
      questionId: QUESTION,
      action: { driveId: DRIVE, kind: 'question', id: QUESTION, chatId: CHAT },
      delivery: { status: 'accepted', targetedRecipients: 1, providerAccepted: 1, failed: 0, pending: 0, clientReceived: null },
    },
    {
      id: 'n2',
      driveId: DRIVE,
      kind: 'cleanup',
      eligibleCount: 1,
      action: { driveId: DRIVE, kind: 'cleanup', id: FINDING, chatId: CHAT },
    },
  ],
};

const item = {
  id: 'it1',
  category: 'cache',
  label: '/data/cache',
  bytes: 5 * GiB,
  eligible: true,
  reason: 'Old cache',
};
const detail = {
  drive: drive(DRIVE, '/data'),
  current: { id: 's1', scannedAt: now, totalBytes: 100 * GiB, availableBytes: 10 * GiB, reserveBytes: 20 * GiB, complete: true },
  history: [],
  items: [item],
  evidence: [],
  decisions: [],
  questions: [{ id: QUESTION, itemId: 'it1', text: 'Is the cache still needed?' }],
  children: [],
  receipts: [],
  plans: [
    {
      id: 'plan1',
      createdAt: now,
      expiresAt: '2099-01-01T00:00:00.000Z',
      items: [{ itemId: 'it1', category: 'cache', label: '/data/cache', bytes: 5 * GiB, eligible: true, reason: 'Old cache' }],
    },
  ],
};

type Call = { url: string; method: string; body?: any };
let calls: Call[];

beforeEach(() => {
  calls = [];
  request.mockReset();
  request.mockImplementation(async (url: string, params?: any) => {
    const method = params?.method ?? 'GET';
    calls.push({ url, method, body: params?.body ? JSON.parse(params.body) : undefined });
    const u = url.replace(/^.*\/proxy/, '');
    if (u === '/api/storage/incident') return incident;
    if (u === `/api/storage/incident/drives/${DRIVE}`) return detail;
    if (u === `/api/storage/incident/chat/${CHAT}`)
      return {
        id: CHAT,
        checkpoint: null,
        messages: [
          { id: 'm1', role: 'user', text: 'What is using /data?', createdAt: now, status: 'done', steps: [] },
          { id: 'm2', role: 'assistant', text: 'The cache uses 5 GiB.', createdAt: now, status: 'done', steps: [], questionIds: [QUESTION] },
        ],
      };
    if (u.startsWith(`/api/storage/incident/chat/${CHAT}/messages`)) return {};
    if (u.startsWith('/api/chats?')) return { chats: [] };
    if (u.startsWith('/api/models')) return { default: 'a/b', models: [] };
    if (u.startsWith('/api/diagnoses')) return { diagnoses: [], total: 0 };
    return {};
  });
});

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Route exact path="/c/test/incidents-chat-thread/:id" component={ChatPage} />
      <Route exact path="/c/test/incidents-storage" component={StorageIncidentPage} />
      <Route exact path="/c/test/incidents-storage-drive/:driveId" component={StorageIncidentPage} />
      <Route exact path="/c/test/incidents-storage-question/:driveId/:actionId" component={StorageQuestionPage} />
      <Route exact path="/c/test/incidents-storage-finding/:driveId/:actionId" component={StorageFindingPage} />
      <Route exact path="/c/test/incidents-storage-chat/:chatId" component={StorageChatRedirect} />
      <Route
        render={({ location }) => (
          <div data-testid="loc">
            {location.pathname}
            {location.search}
          </div>
        )}
      />
    </MemoryRouter>
  );

describe('the storage investigation in the Chat tab', () => {
  it('opens as a chat: the transcript, the pinned list entry, the drive context and no other chat UI', async () => {
    renderAt(chatUrl(CHAT, { drive: DRIVE }));
    expect(await screen.findByRole('heading', { name: 'Storage investigation' })).toBeTruthy();
    expect(await screen.findByText('What is using /data?')).toBeTruthy();
    expect(screen.getByText('The cache uses 5 GiB.')).toBeTruthy();
    // The storage chat is pinned in the chat list of the one chat.
    const nav = screen.getAllByRole('navigation', { name: 'Chats' })[0];
    expect(within(nav).getByRole('link', { name: /Storage investigation/ })).toBeTruthy();
    expect(within(nav).queryByLabelText(/Delete Storage investigation/)).toBeNull();
    // The context drive is chosen from the URL.
    expect(await screen.findByText('worker-1 · /data')).toBeTruthy();
  });

  it('renders the cleanup approval card and the open question in the chat', async () => {
    renderAt(chatUrl(CHAT, { drive: DRIVE, finding: FINDING }));
    expect(await screen.findByText('Cleanup plan')).toBeTruthy();
    expect(await screen.findByText('Is the cache still needed?')).toBeTruthy();
    expect(screen.getByText('Dry run results')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /\/data\/cache/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Dry run all eligible items/ })).toBeTruthy();
  });

  it('uses the one composer: the model picker, the context meter and the same message box', async () => {
    renderAt(chatUrl(CHAT, { drive: DRIVE }));
    await screen.findByText('What is using /data?');
    expect(screen.getAllByLabelText('Message')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Choose model|Grok|Model|a\/b/ })).toBeTruthy();
    expect(screen.queryByText('Storage evidence')).toBeNull();
    expect(screen.queryByLabelText('Drive context')).toBeNull();
  });

  it('shows the storage context as a row of chips with a drive menu', async () => {
    renderAt(chatUrl(CHAT, { drive: DRIVE }));
    const chip = await screen.findByRole('button', { name: 'Drive context: worker-1 \u00b7 /data' });
    expect(screen.getByRole('link', { name: 'Open drive' })).toBeTruthy();
    fireEvent.click(chip);
    const menu = await screen.findByRole('menu', { name: 'Drive context' });
    expect(within(menu).getByRole('menuitem', { name: 'All drives' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'worker-1 \u00b7 /var' })).toBeTruthy();
  });

  it('flows the plan as a card without upper-case buttons, side bars or the push delivery lines', async () => {
    renderAt(chatUrl(CHAT, { drive: DRIVE, finding: FINDING }));
    const card = (await screen.findByText('Cleanup plan')).closest('[data-chat-card]') as HTMLElement;
    expect(card.getAttribute('data-highlighted')).toBe('true');
    const dry = within(card).getByRole('button', { name: /Dry run all eligible items/ });
    expect(getComputedStyle(dry).textTransform).toBe('none');
    expect(card.textContent).not.toContain('Push provider');
    expect(card.textContent).not.toContain('Device receipt unverified');
    expect(document.querySelector('[data-storage-context]')).toBeTruthy();
  });

  it('shows the push status as one small line under the message that holds the question', async () => {
    renderAt(chatUrl(CHAT, { drive: DRIVE }));
    await screen.findByText('The cache uses 5 GiB.');
    const line = document.querySelector('[data-delivery-line]');
    expect(line?.textContent).toBe('Push provider accepted the send (1 of 1) \u00b7 device receipt unverified');
  });

  it('sends a message with the drive context to the storage agent', async () => {
    renderAt(chatUrl(CHAT, { drive: DRIVE }));
    await screen.findByText('What is using /data?');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Investigate capacity' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
    const post = calls.find(c => c.method === 'POST')!;
    expect(post.url).toContain('/headlamp-agent:session/proxy/api/storage/incident/chat/');
    expect(post.url).toContain('/messages');
    expect(post.body).toEqual({ text: 'Investigate capacity', driveId: DRIVE });
  });

  it('lists the open notices with links to the chat on their drive when no drive is chosen', async () => {
    renderAt(chatUrl(CHAT));
    const link = await screen.findByRole('link', { name: 'Review unanswered question' });
    expect(link.getAttribute('href')).toBe(`/c/test/incidents-chat-thread/${CHAT}?drive=${DRIVE}&question=${QUESTION}`);
    expect(screen.getByRole('link', { name: 'Review cleanup finding' }).getAttribute('href')).toBe(
      `/c/test/incidents-chat-thread/${CHAT}?drive=${DRIVE}&finding=${FINDING}`
    );
  });

  it('keeps a plain agent chat working: an unknown id is not the storage chat', async () => {
    renderAt('/c/test/incidents-chat-thread/other-chat');
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/api/chats/other-chat'))).toBe(true));
    expect(screen.queryByRole('heading', { name: 'Storage investigation' })).toBeNull();
  });
});

describe('the Storage tab', () => {
  it('keeps the drive overview and links to the investigation chat, with no chat of its own', async () => {
    renderAt('/c/test/incidents-storage');
    expect(await screen.findAllByText('worker-1 · /data')).toBeTruthy();
    const open = await screen.findByRole('link', { name: 'Open incident chat' });
    expect(open.getAttribute('href')).toBe(`/c/test/incidents-chat-thread/${CHAT}`);
    const perDrive = screen.getAllByRole('link', { name: 'Investigate in chat' });
    expect(perDrive[0].getAttribute('href')).toBe(`/c/test/incidents-chat-thread/${CHAT}?drive=${DRIVE}`);
    expect(screen.queryByLabelText('Message')).toBeNull();
  });

  it('links a drive page to the chat on that drive', async () => {
    renderAt(`/c/test/incidents-storage-drive/${DRIVE}`);
    const open = await screen.findByRole('link', { name: 'Open the investigation chat' });
    expect(open.getAttribute('href')).toBe(`/c/test/incidents-chat-thread/${CHAT}?drive=${DRIVE}`);
    expect(screen.queryByText('Cleanup plan')).toBeNull();
  });
});

describe('links of earlier releases', () => {
  it('redirects a question link to the chat, with the drive and the question', async () => {
    renderAt(`/c/test/incidents-storage-question/${DRIVE}/${QUESTION}`);
    expect(await screen.findByRole('heading', { name: 'Storage investigation' })).toBeTruthy();
    expect(await screen.findByText('Is the cache still needed?')).toBeTruthy();
  });

  it('redirects a finding link to the chat, with the cleanup card in view', async () => {
    renderAt(`/c/test/incidents-storage-finding/${DRIVE}/${FINDING}`);
    expect(await screen.findByText('Cleanup plan')).toBeTruthy();
  });

  it('redirects the old storage chat path to the chat tab', async () => {
    renderAt(`/c/test/incidents-storage-chat/${CHAT}`);
    expect(await screen.findByRole('heading', { name: 'Storage investigation' })).toBeTruthy();
  });
});

describe('storage notification URLs', () => {
  it('are templates of the chat, with the drive and the item as query strings', () => {
    const urls = storageNotificationUrls();
    expect(urls.question).toBe('/c/test/incidents-chat-thread/{chatId}?drive={driveId}&question={id}');
    expect(urls.cleanup).toBe('/c/test/incidents-chat-thread/{chatId}?drive={driveId}&finding={id}');
  });

  it('build a chat link whose content is a path segment and whose filters are query strings', () => {
    expect(chatUrl('c1')).toBe('/c/test/incidents-chat-thread/c1');
    expect(chatUrl('c1', { drive: 'd1' })).toBe('/c/test/incidents-chat-thread/c1?drive=d1');
    expect(chatUrl()).toBe('/c/test/incidents-chat');
  });
});
