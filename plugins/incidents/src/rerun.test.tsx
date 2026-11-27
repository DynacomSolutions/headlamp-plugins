import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('./a2ui', () => ({ A2uiRenderer: () => null }));
vi.mock('./ChatPage', () => ({ ChatPage: () => null }));
vi.mock('./AgentActions', () => ({ AgentActions: () => null }));
vi.mock('./LaunchPages', () => ({ LaunchesPage: () => null }));

import { rerunErrorText } from './data';
import { IncidentPage, IncidentsPage } from './pages';

const row = (id: string, alert: string, status: string) => ({
  id,
  createdAt: `2026-11-19T10:0${id}:00Z`,
  status,
  source: 'webhook',
  alert: { name: alert, severity: 'critical' },
  result: { likelyCause: `cause ${alert}`, confidence: 'high' },
  a2ui: [],
});

let rows: Array<ReturnType<typeof row>>;
let calls: Array<{ url: string; method: string }>;
let rerunReply: () => Promise<unknown>;

beforeEach(() => {
  rows = [row('1', 'HighCPU', 'done'), row('2', 'DiskFull', 'failed')];
  calls = [];
  rerunReply = async () => {
    rows = rows.map(r => (r.id === '2' ? { ...r, status: 'queued' } : r));
    return { id: '2', status: 'queued', model: 'codex/gpt-6.2-sol' };
  };
  request.mockReset();
  request.mockImplementation(async (url: string, params?: any) => {
    const method = params?.method ?? 'GET';
    calls.push({ url, method });
    if (method === 'POST' && url.endsWith('/rerun')) {
      expect(JSON.parse(params.body)).toEqual({});
      expect(params.headers['Content-Type']).toBe('application/json');
      return rerunReply();
    }
    if (url.endsWith('/api/settings/automatic-investigations')) return { enabled: true };
    if (url.includes('/api/diagnoses?')) return { total: rows.length, diagnoses: rows };
    const id = decodeURIComponent(url.split('/api/diagnoses/')[1] ?? '');
    return rows.find(r => r.id === id) ?? {};
  });
});
afterEach(cleanup);

const view = (ui: React.ReactNode) =>
  render(
    <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
      <MemoryRouter initialEntries={['/list']}>{ui}</MemoryRouter>
    </ThemeProvider>
  );
const rerunCalls = () => calls.filter(c => c.method === 'POST');

describe('Run again on the Incidents page', () => {
  it('shows the button on failed rows only', async () => {
    view(<Route path="/list" component={IncidentsPage} />);
    expect(await screen.findByRole('button', { name: 'Run again: DiskFull' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run again: HighCPU' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Run again/ })).toHaveLength(1);
  });

  it('posts to the rerun route, disables the button while it runs, then shows the queued row', async () => {
    let release: () => void = () => {};
    const inner = rerunReply;
    rerunReply = () => new Promise(resolve => (release = () => resolve(inner())));
    view(<Route path="/list" component={IncidentsPage} />);
    const button = await screen.findByRole('button', { name: 'Run again: DiskFull' });
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(button.textContent).toBe('Starting...');
    fireEvent.click(button);
    expect(rerunCalls()).toHaveLength(1);
    expect(rerunCalls()[0].url).toMatch(/\/api\/diagnoses\/2\/rerun$/);
    release();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Run again/ })).toBeNull());
    expect(screen.getByText('queued')).toBeTruthy();
  });

  it('shows the error under the button and lets the user try again', async () => {
    rerunReply = async () => {
      throw new Error('{"error":"The hourly limit of 6 diagnoses is used. Try again later."}');
    };
    view(<Route path="/list" component={IncidentsPage} />);
    const button = await screen.findByRole('button', { name: 'Run again: DiskFull' });
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The hourly limit of 6 diagnoses is used. Try again later.'
    );
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.textContent).toBe('Run again');
    expect(screen.getByText('failed')).toBeTruthy();
  });

  it('does not open the incident when the button is clicked', async () => {
    view(
      <>
        <Route path="/list" component={IncidentsPage} />
        <Route
          path="*"
          render={({ location }) => <div data-testid="loc">{location.pathname}</div>}
        />
      </>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Run again: DiskFull' }));
    await waitFor(() => expect(rerunCalls()).toHaveLength(1));
    expect(screen.getByTestId('loc').textContent).toBe('/list');
  });

  it('shows the button again when the re-run fails once more', async () => {
    view(<Route path="/list" component={IncidentsPage} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run again: DiskFull' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Run again/ })).toBeNull());
    // The poll sees the new failure.
    rows = rows.map(r => (r.id === '2' ? { ...r, status: 'failed' } : r));
    cleanup();
    view(<Route path="/list" component={IncidentsPage} />);
    expect(await screen.findByRole('button', { name: 'Run again: DiskFull' })).toBeTruthy();
  });
});

describe('Run again on the incident page', () => {
  it('shows the button for a failed diagnosis and posts to its route', async () => {
    render(
      <ThemeProvider theme={createTheme()}>
        <MemoryRouter initialEntries={['/list/2']}>
          <Route path="/list/:id" component={IncidentPage} />
        </MemoryRouter>
      </ThemeProvider>
    );
    const button = await screen.findByRole('button', { name: 'Run again' });
    fireEvent.click(button);
    await waitFor(() => expect(rerunCalls()).toHaveLength(1));
    expect(rerunCalls()[0].url).toMatch(/\/api\/diagnoses\/2\/rerun$/);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull());
  });

  it('has no button for a diagnosis that is not failed', async () => {
    render(
      <ThemeProvider theme={createTheme()}>
        <MemoryRouter initialEntries={['/list/1']}>
          <Route path="/list/:id" component={IncidentPage} />
        </MemoryRouter>
      </ThemeProvider>
    );
    await screen.findByRole('button', { name: 'Ask about this incident' });
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull();
  });
});

describe('rerunErrorText', () => {
  it('takes the error field of a JSON body and keeps any other text', () => {
    expect(rerunErrorText(new Error('{"error":"Only a failed diagnosis can run again."}'))).toBe(
      'Only a failed diagnosis can run again.'
    );
    expect(rerunErrorText(new Error('Bad Gateway'))).toBe('Bad Gateway');
    expect(rerunErrorText('')).toBe('Something went wrong.');
  });
});

describe('Investigate a skipped incident', () => {
  it('shows an Investigate button on a skipped row and posts to the rerun route', async () => {
    rows = [
      {
        ...row('3', 'NodeNotReady', 'skipped'),
        result: undefined as never,
        skipped: { reason: 'Automatic investigation skipped: setting off', at: 'x' },
      } as never,
    ];
    rerunReply = async () => {
      rows = rows.map(r => ({ ...r, status: 'queued' }));
      return { id: '3', status: 'queued', model: 'codex/gpt-6.2-sol' };
    };
    view(<Route path="/list" component={IncidentsPage} />);
    const button = await screen.findByRole('button', { name: 'Investigate: NodeNotReady' });
    expect(screen.queryByRole('button', { name: /Run again/ })).toBeNull();
    expect(screen.getAllByText('Automatic investigation skipped: setting off').length).toBeGreaterThan(0);
    fireEvent.click(button);
    await waitFor(() => expect(rerunCalls()).toHaveLength(1));
    expect(rerunCalls()[0].url).toMatch(/\/api\/diagnoses\/3\/rerun$/);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Investigate/ })).toBeNull());
  });
});
