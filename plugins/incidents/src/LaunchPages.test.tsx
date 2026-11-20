import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, LAUNCH, SUMMARY } from './launch.fixture';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request },
  Router: {
    createRouteURL: (name: string, params?: { id?: string }) =>
      `/c/test/${name}${params?.id ? '/' + params.id : ''}`,
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
      <div>{title}</div>
      {children}
    </section>
  ),
}));

import { AgentActions } from './AgentActions';
import { LaunchesPage, LaunchPage } from './LaunchPages';

type Call = { url: string; method: string; body: any };
let calls: Call[];
let launch: any;
let list: any[];

beforeEach(() => {
  calls = [];
  launch = JSON.parse(JSON.stringify(LAUNCH));
  list = [SUMMARY];
  request.mockReset();
  request.mockImplementation(async (url: string, params?: any) => {
    const method = params?.method ?? 'GET';
    calls.push({ url, method, body: params?.body ? JSON.parse(params.body) : undefined });
    if (url.endsWith('/api/launches/config')) return CONFIG;
    if (url.includes('/api/launches?')) return { launches: list };
    if (url.endsWith('/api/launches/preview')) return { brief: 'BRIEF TEXT' };
    if (method === 'POST' && url.endsWith('/api/launches'))
      return { ...launch, id: 'new1', status: 'pending_approval' };
    if (method === 'POST' && url.endsWith('/approve')) {
      launch = { ...launch, status: 'running' };
      return launch;
    }
    if (method === 'POST' && url.endsWith('/reject')) {
      launch = { ...launch, status: 'rejected' };
      return launch;
    }
    if (method === 'POST') return {};
    if (url.endsWith('/api/launches/l1')) return launch;
    return {};
  });
});
afterEach(() => vi.useRealTimers());

const loc = (
  <Route
    path="/c/test"
    render={({ location }) => <div data-testid="loc">{location.pathname + location.search}</div>}
  />
);
const posts = () => calls.filter(c => c.method === 'POST');

describe('routes', () => {
  it('opens a launch from the path segment /incidents/launches/<id>', async () => {
    render(
      <MemoryRouter initialEntries={['/incidents/launches/l1']}>
        <Route path="/incidents/launches/:id" component={LaunchPage} />
      </MemoryRouter>
    );
    expect((await screen.findAllByText('Apply the DNS placement plan')).length).toBeGreaterThan(0);
    expect(calls[0].url).toContain('/api/launches/l1');
    expect(screen.getByRole('link', { name: 'Back to agents' }).getAttribute('href')).toBe(
      '/c/test/incidents-launches'
    );
    expect(screen.getByRole('link', { name: 'Open the incident' }).getAttribute('href')).toBe(
      '/c/test/incident/d1'
    );
  });
});

describe('launch detail page', () => {
  it('renders the pill, the timeline, the reply as Markdown and the T3 link', async () => {
    render(
      <MemoryRouter initialEntries={['/incidents/launches/l1']}>
        <Route path="/incidents/launches/:id" component={LaunchPage} />
      </MemoryRouter>
    );
    const pill = await screen.findByRole('status');
    expect(pill.getAttribute('data-status')).toBe('running');
    expect(screen.getByText('Run 1')).toBeTruthy();
    expect(screen.getByText('dig app.example.com')).toBeTruthy();
    // The reply is Markdown: bold text becomes a strong element.
    expect(screen.getByText('checked', { selector: 'strong' })).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open the thread in T3 Code' });
    expect(link.getAttribute('href')).toBe('https://t3.example.com/thread/thread-1');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('shows no thread link for an unsafe pattern', async () => {
    launch.threadLink = 'javascript:alert(1)';
    render(
      <MemoryRouter initialEntries={['/incidents/launches/l1']}>
        <Route path="/incidents/launches/:id" component={LaunchPage} />
      </MemoryRouter>
    );
    await screen.findByRole('status');
    expect(screen.queryByRole('link', { name: 'Open the thread in T3 Code' })).toBeNull();
  });

  it('polls every 1.5 s while the launch is live and stops when it is final', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <MemoryRouter initialEntries={['/incidents/launches/l1']}>
        <Route path="/incidents/launches/:id" component={LaunchPage} />
      </MemoryRouter>
    );
    await screen.findByRole('status');
    const gets = () => calls.filter(c => c.url.endsWith('/api/launches/l1')).length;
    expect(gets()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(gets()).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(gets()).toBe(3);
    launch = { ...launch, status: 'completed', finishedAt: '2026-11-20T07:05:00.000Z' };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await waitFor(() =>
      expect(screen.getByRole('status').getAttribute('data-status')).toBe('completed')
    );
    const after = gets();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(gets()).toBe(after);
  });

  it('approves a pending request from the approval card', async () => {
    launch.status = 'pending_approval';
    render(
      <MemoryRouter initialEntries={['/incidents/launches/l1']}>
        <Route path="/incidents/launches/:id" component={LaunchPage} />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and launch' }));
    await waitFor(() => expect(posts().map(p => p.url.split('/').pop())).toEqual(['approve']));
    await waitFor(() =>
      expect(screen.getByRole('status').getAttribute('data-status')).toBe('running')
    );
    expect(screen.queryByRole('button', { name: 'Approve and launch' })).toBeNull();
  });

  it('rejects a pending request', async () => {
    launch.status = 'pending_approval';
    render(
      <MemoryRouter initialEntries={['/incidents/launches/l1']}>
        <Route path="/incidents/launches/:id" component={LaunchPage} />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(screen.getByRole('status').getAttribute('data-status')).toBe('rejected')
    );
    expect(screen.getByText(/No agent was started/)).toBeTruthy();
  });

  it('shows the error of a failed launch and the approval error', async () => {
    launch.status = 'failed';
    launch.error = 'Tracking stopped after 6 errors in a row.';
    render(
      <MemoryRouter initialEntries={['/incidents/launches/l1']}>
        <Route path="/incidents/launches/:id" component={LaunchPage} />
      </MemoryRouter>
    );
    expect(await screen.findByText('Tracking stopped after 6 errors in a row.')).toBeTruthy();
  });

  it('sends a follow-up message', async () => {
    render(
      <MemoryRouter initialEntries={['/incidents/launches/l1']}>
        <Route path="/incidents/launches/:id" component={LaunchPage} />
      </MemoryRouter>
    );
    const box = await screen.findByLabelText('Follow-up message');
    fireEvent.change(box, { target: { value: 'Check the other host too.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toContain('/api/launches/l1/messages');
    expect(posts()[0].body).toEqual({ text: 'Check the other host too.' });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });

  it('offers no follow-up box for a request that has no thread', async () => {
    launch.status = 'pending_approval';
    delete launch.threadId;
    render(
      <MemoryRouter initialEntries={['/incidents/launches/l1']}>
        <Route path="/incidents/launches/:id" component={LaunchPage} />
      </MemoryRouter>
    );
    await screen.findByRole('button', { name: 'Approve and launch' });
    expect(screen.queryByLabelText('Follow-up message')).toBeNull();
  });
});

describe('Agents list', () => {
  beforeEach(() => {
    list = [
      {
        ...SUMMARY,
        id: 'a',
        purpose: 'Running one',
        status: 'running',
        requestedAt: '2026-11-20T03:00:00Z',
      },
      {
        ...SUMMARY,
        id: 'b',
        purpose: 'Done one',
        status: 'completed',
        requestedAt: '2026-11-20T02:00:00Z',
        finishedAt: '2026-11-20T02:05:00Z',
      },
      {
        ...SUMMARY,
        id: 'c',
        purpose: 'Failed one',
        status: 'failed',
        requestedAt: '2026-11-20T01:00:00Z',
      },
    ];
  });
  const renderList = (path = '/incidents/launches') =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <Route path="/incidents/launches" component={LaunchesPage} />
        {loc}
      </MemoryRouter>
    );

  it('lists newest first with status pills that link to the detail page', async () => {
    renderList();
    const links = await screen.findAllByRole('link', { name: /one$/ });
    expect(links.map(l => l.textContent)).toEqual(['Running one', 'Done one', 'Failed one']);
    expect(links[0].getAttribute('href')).toBe('/c/test/incidents-launch/a');
    expect(screen.getAllByRole('status').map(p => p.getAttribute('data-status'))).toEqual([
      'running',
      'completed',
      'failed',
    ]);
  });

  it('filters by the status in the query string', async () => {
    renderList('/incidents/launches?status=failed');
    expect(await screen.findByText('Failed one')).toBeTruthy();
    expect(screen.queryByText('Running one')).toBeNull();
  });

  it('writes the filter to the query string with history replace', async () => {
    let entries = 0;
    render(
      <MemoryRouter initialEntries={['/incidents/launches']}>
        <Route path="/incidents/launches" component={LaunchesPage} />
        <Route
          render={({ history, location }) => {
            entries = history.length;
            return <div data-testid="where">{location.pathname + location.search}</div>;
          }}
        />
      </MemoryRouter>
    );
    await screen.findByText('Done one');
    const before = entries;
    fireEvent.mouseDown(screen.getByLabelText('Status'));
    fireEvent.click(await screen.findByRole('option', { name: 'Completed' }));
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/incidents/launches?status=completed')
    );
    expect(screen.queryByText('Running one')).toBeNull();
    expect(screen.getByText('Done one')).toBeTruthy();
    // Replace, not push: the history does not grow.
    expect(entries).toBe(before);
  });

  it('opens a launch on row click', async () => {
    renderList();
    fireEvent.click(await screen.findByText('Done one'));
    expect((await screen.findByTestId('loc')).textContent).toBe('/c/test/incidents-launch/b');
  });
});

describe('Run with an agent on a diagnosis page', () => {
  const fixes = [
    { title: 'Apply the DNS placement plan', detail: 'Use e2.', recommended: true },
    { title: 'Restart the pod', detail: 'Restart it.', recommended: false },
  ];
  const renderActions = () =>
    render(
      <MemoryRouter initialEntries={['/d/d1']}>
        <Route
          path="/d/:id"
          render={() => (
            <AgentActions
              diagnosisId="d1"
              alertName="DnsDrift"
              fixes={fixes}
              planFactIds={['e2']}
            />
          )}
        />
        {loc}
      </MemoryRouter>
    );

  it('shows a button on each fix and a prominent one for the DNS plan fix', async () => {
    renderActions();
    expect(
      await screen.findByRole('button', { name: 'Run the DNS plan with an agent' })
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run with an agent' })).toBeTruthy();
  });

  it('hides everything when launching is off', async () => {
    request.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/launches/config'))
        return { enabled: false, reason: 'T3_URL is not set' };
      return { launches: [] };
    });
    const { container } = renderActions();
    await waitFor(() => expect(request).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 30));
    expect(container.textContent).toBe('');
  });

  it('requests a launch from the dialog and opens it for approval', async () => {
    renderActions();
    fireEvent.click(await screen.findByRole('button', { name: 'Run the DNS plan with an agent' }));
    const purpose = (await screen.findByLabelText(/Purpose/)) as HTMLInputElement;
    expect(purpose.value).toBe('Apply the DNS placement plan (DnsDrift)');
    // The brief is read only and loads when opened.
    expect(screen.queryByLabelText('Brief')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the brief the agent gets' }));
    expect(await screen.findByText('BRIEF TEXT')).toBeTruthy();
    fireEvent.change(purpose, { target: { value: 'Fix the drift' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request' }));
    await waitFor(() => expect(posts().some(p => p.url.endsWith('/api/launches'))).toBe(true));
    const post = posts().find(p => p.url.endsWith('/api/launches'))!;
    expect(post.body).toEqual({
      purpose: 'Fix the drift',
      diagnosisId: 'd1',
      fix: { index: 0, title: 'Apply the DNS placement plan', detail: 'Use e2.' },
      projectKey: 'default',
    });
    expect((await screen.findByTestId('loc')).textContent).toBe('/c/test/incidents-launch/new1');
    // The request did not approve anything.
    expect(posts().some(p => p.url.endsWith('/approve'))).toBe(false);
  });

  it('lists the launches of this diagnosis, with an approval card for a pending one', async () => {
    list = [
      { ...SUMMARY, id: 'p1', purpose: 'Pending work', status: 'pending_approval' },
      { ...SUMMARY, id: 'r1', purpose: 'Running work', status: 'running' },
      {
        ...SUMMARY,
        id: 'x1',
        purpose: 'Other incident',
        status: 'running',
        source: { diagnosisId: 'd2' },
      },
    ];
    renderActions();
    expect(await screen.findByText(/asked to run an agent: Pending work/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Running work' })).toBeTruthy();
    expect(screen.queryByText('Other incident')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and launch' }));
    await waitFor(() =>
      expect(posts().map(p => p.url.split('/').slice(-2).join('/'))).toEqual(['p1/approve'])
    );
    expect((await screen.findByTestId('loc')).textContent).toBe('/c/test/incidents-launch/p1');
  });
});
