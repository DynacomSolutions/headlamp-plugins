import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

import { IncidentsPage } from './pages';

const row = (
  id: string,
  alert: string,
  status: string,
  severity = 'critical',
  resolved = false
) => ({
  id,
  createdAt: `2026-11-19T10:0${id}:00Z`,
  status,
  source: 'webhook',
  alert: { name: alert, severity },
  result: { likelyCause: `cause ${alert}`, confidence: 'high' },
  ...(resolved ? { resolvedAt: '2026-11-19T11:00:00Z' } : {}),
  a2ui: [],
});

let rows: Array<ReturnType<typeof row>>;
let calls: Array<{ url: string; method: string; body?: any }>;

beforeEach(() => {
  // Six incidents. Their ids are the digits 1 to 6, newest first in the list.
  rows = [
    row('1', 'AlertA', 'done'),
    row('2', 'AlertB', 'failed', 'warning'),
    row('3', 'AlertC', 'done', 'critical', true),
    row('4', 'AlertD', 'done', 'warning'),
    row('5', 'AlertE', 'running', 'info'),
    row('6', 'AlertF', 'done'),
  ];
  calls = [];
  request.mockReset();
  request.mockImplementation(async (url: string, params?: any) => {
    const method = params?.method ?? 'GET';
    calls.push({ url, method, body: params?.body ? JSON.parse(params.body) : undefined });
    if (method === 'POST' && url.endsWith('/api/chats')) return { id: 'thread9' };
    if (url.includes('/api/diagnoses?')) return { diagnoses: rows, total: rows.length };
    return {};
  });
});
afterEach(() => cleanup());

const Where = () => (
  <Route
    path="*"
    render={({ location }) => <div data-testid="loc">{location.pathname + location.search}</div>}
  />
);
const view = (path = '/incidents') =>
  render(
    <ThemeProvider theme={createTheme()}>
      <MemoryRouter initialEntries={[path]}>
        <Route path="/incidents" component={IncidentsPage} />
        <Route path="/c/test" component={() => null} />
        <Where />
      </MemoryRouter>
    </ThemeProvider>
  );
const box = (name: string) => screen.getByRole('checkbox', { name: `Select ${name}` });
const where = () => screen.getByTestId('loc').textContent;
const counter = () => screen.getByRole('toolbar', { name: 'Selection' }).textContent ?? '';
// The list is newest first: id 6 is the first row.
const order = ['AlertF', 'AlertE', 'AlertD', 'AlertC', 'AlertB', 'AlertA'];

describe('Incidents page selection', () => {
  it('has a checkbox for every row and starts with nothing selected', async () => {
    view();
    await screen.findByRole('checkbox', { name: 'Select AlertA' });
    expect(screen.getAllByRole('checkbox', { name: /^Select Alert/ })).toHaveLength(6);
    expect(counter()).toContain('6 shown');
    expect(
      (screen.getByRole('button', { name: 'Chat about 0 incidents' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('counts the selection, keeps it in the query string and clears it', async () => {
    view();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select AlertB' }));
    fireEvent.click(box('AlertD'));
    expect(counter()).toContain('2 selected');
    expect(where()).toBe('/incidents?sel=2,4');
    expect((box('AlertB') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(counter()).toContain('6 shown');
    expect(where()).toBe('/incidents');
  });

  it('opens with the selection of the URL', async () => {
    view('/incidents?sel=1,3');
    await screen.findByRole('checkbox', { name: 'Select AlertA' });
    expect(counter()).toContain('2 selected');
    expect((box('AlertC') as HTMLInputElement).checked).toBe(true);
    expect((box('AlertB') as HTMLInputElement).checked).toBe(false);
  });

  it('drops a selected id that no diagnosis has', async () => {
    view('/incidents?sel=1,gone');
    await screen.findByRole('checkbox', { name: 'Select AlertA' });
    expect(counter()).toContain('1 selected');
  });

  it('selects a range with Shift+click, from the last toggled row', async () => {
    view();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select AlertE' }));
    fireEvent.click(box('AlertB'), { shiftKey: true });
    expect(counter()).toContain('4 selected');
    for (const n of ['AlertE', 'AlertD', 'AlertC', 'AlertB'])
      expect((box(n) as HTMLInputElement).checked).toBe(true);
    expect((box('AlertF') as HTMLInputElement).checked).toBe(false);
  });

  it('toggles with Space and selects a range with Shift+Space on a focused row', async () => {
    view();
    await screen.findByRole('checkbox', { name: 'Select AlertA' });
    const rowOf = (name: string) => screen.getByRole('link', { name }).closest('tr') as HTMLElement;
    fireEvent.keyDown(rowOf('AlertF'), { key: ' ' });
    expect(where()).toBe('/incidents?sel=6');
    fireEvent.keyDown(rowOf('AlertD'), { key: ' ', shiftKey: true });
    expect(where()).toBe('/incidents?sel=6,5,4');
    fireEvent.keyDown(rowOf('AlertF'), { key: ' ' });
    expect(where()).toBe('/incidents?sel=5,4');
  });

  it('clears the selection with Escape', async () => {
    view('/incidents?sel=1,2');
    await screen.findByRole('checkbox', { name: 'Select AlertA' });
    fireEvent.keyDown(box('AlertA'), { key: 'Escape' });
    expect(where()).toBe('/incidents');
  });

  it('selects every shown row of the filter, and clears only the shown rows', async () => {
    view('/incidents?severity=warning');
    await screen.findByRole('checkbox', { name: 'Select AlertB' });
    expect(screen.queryByRole('checkbox', { name: 'Select AlertA' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Select all 2 shown' }));
    expect(counter()).toContain('2 selected');
    expect(where()).toBe('/incidents?severity=warning&sel=4,2');
    // A pick that a new filter hides stays selected and the bar says so.
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'AlertB' } });
    expect(counter()).toContain('1 hidden by the filters');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown incidents' }));
    expect(where()).toContain('sel=4');
    expect(where()).not.toContain('sel=2');
  });

  it('keeps the filters in the query string with replace, so Back does not step through them', async () => {
    view();
    await screen.findByRole('checkbox', { name: 'Select AlertA' });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'AlertD' } });
    expect(where()).toBe('/incidents?q=AlertD');
    expect(screen.getAllByRole('checkbox', { name: /^Select Alert/ })).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('Open only'));
    expect(where()).toContain('open=1');
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(where()).toBe('/incidents');
  });

  it('shows no folded or "Other" row, and keeps every row in one scrolling list', async () => {
    view();
    await screen.findByRole('checkbox', { name: 'Select AlertA' });
    expect(screen.queryByText(/\+\s?\d+ more/)).toBeNull();
    expect(screen.queryByText(/^Other$/)).toBeNull();
    const area = screen.getByRole('region', { name: 'Diagnoses' });
    expect(within(area).getAllByRole('checkbox', { name: /^Select Alert/ })).toHaveLength(6);
    expect(
      within(area)
        .getAllByRole('link')
        .map(l => l.textContent)
    ).toEqual(order);
  });

  it('keeps the row click, and the checkbox click does not open the incident', async () => {
    view();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select AlertB' }));
    expect(where()).toBe('/incidents?sel=2');
    fireEvent.click(screen.getByText('cause AlertD'));
    await waitFor(() => expect(where()).toBe('/c/test/incident/4'));
  });
});

describe('Chat about several incidents', () => {
  it('creates one chat with all the selected ids and opens it by its id', async () => {
    view();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select AlertA' }));
    fireEvent.click(box('AlertC'));
    fireEvent.click(box('AlertF'));
    fireEvent.click(screen.getByRole('button', { name: 'Chat about 3 incidents' }));
    await waitFor(() => expect(where()).toBe('/c/test/incidents-chat-thread/thread9'));
    const posts = calls.filter(c => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toMatch(/\/api\/chats$/);
    expect(posts[0].body).toEqual({ diagnosisIds: ['1', '3', '6'] });
  });

  it('sends one incident as diagnosisId, as before', async () => {
    view();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select AlertB' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chat about 1 incident' }));
    await waitFor(() => expect(where()).toBe('/c/test/incidents-chat-thread/thread9'));
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({ diagnosisId: '2' });
  });

  it('shows an error and stays on the page when the agent refuses', async () => {
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (url: string, params?: any) => {
      if (params?.method === 'POST') throw new Error('No diagnosis 2');
      return base(url, params);
    });
    view();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select AlertB' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chat about 1 incident' }));
    expect(await screen.findByText(/Could not start a chat: No diagnosis 2/)).toBeTruthy();
    expect(where()).toBe('/incidents?sel=2');
  });

  it('stops a select-all at the cap and says so', async () => {
    rows = Array.from({ length: 25 }, (_, i) => row(String(i + 1), `Alert${i + 1}`, 'done'));
    view();
    await screen.findByRole('checkbox', { name: 'Select Alert1' });
    fireEvent.click(screen.getByRole('button', { name: 'Select all first 20 of 25 shown' }));
    expect(counter()).toContain('20 selected');
    expect(await screen.findByText(/at most 20 incidents/)).toBeTruthy();
  });
});
