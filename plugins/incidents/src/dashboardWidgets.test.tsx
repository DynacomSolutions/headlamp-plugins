import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useHistory, useLocation } from 'react-router-dom';
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

import {
  INCIDENT_WIDGETS,
  incidentChatWidget,
  incidentListWidget,
  registerIncidentWidgets,
} from './dashboardWidgets';
import { fetchAllDiagnoses } from './data';
import { summariseDiagnoses } from './model';
import { resetFocus, setSelection } from './selection';

const diag = (id: string, alert: string, severity: string, status: string, resolved = false) => ({
  id,
  createdAt: `2026-11-19T10:0${id}:00Z`,
  status,
  source: 'alert',
  alert: { name: alert, severity },
  result: { likelyCause: `cause ${alert}`, confidence: 'high' },
  resolvedAt: resolved ? '2026-11-19T11:00:00Z' : undefined,
});
const DIAGNOSES = [
  diag('1', 'HighCPU', 'critical', 'done'),
  diag('2', 'DiskFull', 'warning', 'running'),
  diag('3', 'OldAlert', 'info', 'failed', true),
];

/** The widget with its resolved diagnoses shown: the default config, with the hide-resolved setting off. */
const SHOW_ALL = { ...incidentListWidget.defaultConfig, openOnly: false };

const filters = { namespaces: [], nodes: [], labelSelector: '', range: '1h' as const };
const props = (config: any, over: any = {}) => ({
  instanceId: 'w',
  config,
  filters,
  refreshSignal: 0,
  reportRefreshed: vi.fn(),
  editing: false,
  kiosk: false,
  ...over,
});
const view = (ui: React.ReactNode) =>
  render(
    <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>
  );

type Call = { url: string; method: string; body: any; headers?: Record<string, string> };
let calls: Call[];
let pageTotal: number | undefined;
let served: any[] = DIAGNOSES;

beforeEach(() => {
  calls = [];
  pageTotal = undefined;
  served = DIAGNOSES;
  request.mockReset();
  request.mockImplementation(async (url: string, params?: any) => {
    const method = params?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: params?.body ? JSON.parse(params.body) : undefined,
      headers: params?.headers,
    });
    if (url.includes('/api/diagnoses')) {
      const q = new URL(url, 'http://x').searchParams;
      const offset = Number(q.get('offset') ?? 0);
      const limit = Number(q.get('limit') ?? 50);
      return {
        total: pageTotal ?? served.length,
        diagnoses: served.slice(offset, offset + limit),
      };
    }
    if (url.endsWith('/api/models')) return { default: 'claude/opus', models: MODELS };
    if (method === 'POST' && url.endsWith('/api/chats')) return { id: 'c1' };
    if (method === 'POST') return { messageId: 'x' };
    if (url.endsWith('/api/chats/c1')) return CHAT;
    return {};
  });
});
afterEach(() => {
  cleanup();
  setSelection(null);
  resetFocus();
});

/** Opens the group of an alert and returns its header. Every group is closed at first. */
const openGroup = async (alert: string): Promise<HTMLElement> => {
  const header = (await screen.findByText(alert)).closest('[data-incident-group]') as HTMLElement;
  fireEvent.click(header);
  return header;
};

const diagnosisCalls = () => calls.filter(c => c.url.includes('/api/diagnoses'));

describe('registration', () => {
  it('registers both widget types through the dashboards contract', () => {
    delete (window as any).headlampDashboards;
    registerIncidentWidgets();
    const stub = (window as any).headlampDashboards;
    expect(stub.queue.map((d: any) => d.type)).toEqual(['incidents.list', 'incidents.chat']);
    expect(INCIDENT_WIDGETS).toHaveLength(2);
  });
  it('gives the list widget status, severity and hide-resolved settings', () => {
    const keys = incidentListWidget.configSchema!.map(f => f.key);
    expect(keys).toEqual(['status', 'severity', 'openOnly']);
    expect(incidentListWidget.defaultConfig).toEqual({
      status: 'all',
      severity: 'all',
      openOnly: true,
    });
    expect(incidentChatWidget.defaultConfig).toEqual({});
  });
});

describe('incidents.list', () => {
  const List = incidentListWidget.Component;
  it('shows the summary and the rows, and reports the refresh', async () => {
    const p = props(SHOW_ALL);
    view(<List {...p} />);
    expect(await screen.findByText('HighCPU')).toBeTruthy();
    expect(screen.getByText(/^3 incidents\./)).toBeTruthy();
    expect(document.querySelector('[data-count="critical"]')?.textContent).toBe('1');
    // The summary and the header of the DiskFull group both count the running analysis.
    expect(screen.getAllByText(/1 running/)).toHaveLength(2);
    expect(p.reportRefreshed).toHaveBeenCalled();
  });
  it('shows the open incidents only by default, and the resolved ones when the setting is off', async () => {
    view(<List {...props(incidentListWidget.defaultConfig)} />);
    await screen.findByText('HighCPU');
    expect(screen.queryByText('OldAlert')).toBeNull();
    expect(screen.getByText(/^2 incidents\./)).toBeTruthy();
    expect(document.querySelector('[data-count="critical"]')?.textContent).toBe('1');
    cleanup();
    view(<List {...props(SHOW_ALL)} />);
    expect(await screen.findByText('OldAlert')).toBeTruthy();
    expect(screen.getByText(/^3 incidents\./)).toBeTruthy();
  });
  it('keeps the summary outside the scrolling list', async () => {
    const { container } = view(<List {...props(SHOW_ALL)} />);
    await screen.findByText('HighCPU');
    const scroller = container.querySelector('[data-scroll-area]') as HTMLElement;
    expect(scroller.contains(screen.getByText(/^3 incidents\./))).toBe(false);
    expect(scroller.contains(screen.getByText('HighCPU'))).toBe(true);
    // Every group is inside it, and its rows too once the group is open, so the last card scrolls.
    expect(scroller.querySelectorAll('[data-incident-group]')).toHaveLength(3);
    expect(scroller.querySelectorAll('[data-incident-row]')).toHaveLength(0);
    for (const h of Array.from(scroller.querySelectorAll('[data-incident-group]'))) {
      fireEvent.click(h);
    }
    expect(scroller.querySelectorAll('[data-incident-row]')).toHaveLength(3);
    expect(document.body.textContent).not.toMatch(/\bmore\b|\bother\b/i);
  });
  it('applies the status, severity and resolved filters, and counts only the rows shown', async () => {
    view(<List {...props({ status: 'all', severity: 'all', openOnly: true })} />);
    await screen.findByText('HighCPU');
    expect(screen.queryByText('OldAlert')).toBeNull();
    expect(screen.getByText(/^2 incidents\./)).toBeTruthy();
    cleanup();
    view(<List {...props({ status: 'running', severity: 'warning', openOnly: false })} />);
    expect(await screen.findByText('DiskFull')).toBeTruthy();
    expect(screen.queryByText('HighCPU')).toBeNull();
    expect(screen.getByText(/^1 incident\./)).toBeTruthy();
  });
  it('says so when the filters hide every row', async () => {
    view(<List {...props({ status: 'queued', severity: 'all', openOnly: false })} />);
    expect(await screen.findByText(/No diagnoses match the filters/)).toBeTruthy();
  });
  it('opens the incident page when there is no chat widget', async () => {
    view(<List {...props(SHOW_ALL)} />);
    await openGroup('HighCPU');
    const link = await screen.findByRole('link', { name: 'cause HighCPU' });
    expect(link.getAttribute('href')).toBe('/c/test/incident/1');
  });
  it('turns the links off while editing', async () => {
    view(<List {...props(SHOW_ALL, { editing: true })} />);
    await openGroup('HighCPU');
    expect(screen.getByText('cause HighCPU')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'cause HighCPU' })).toBeNull();
  });
  it('fetches on the refresh signal only, not on a rerender', async () => {
    const p = props(SHOW_ALL);
    const { rerender } = view(<List {...p} />);
    await screen.findByText('HighCPU');
    expect(diagnosisCalls()).toHaveLength(1);
    const again = (over: any) => (
      <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
        <MemoryRouter>
          <List {...p} {...over} />
        </MemoryRouter>
      </ThemeProvider>
    );
    rerender(again({ editing: true }));
    rerender(again({ kiosk: true }));
    expect(diagnosisCalls()).toHaveLength(1);
    rerender(again({ refreshSignal: 1 }));
    await waitFor(() => expect(diagnosisCalls()).toHaveLength(2));
  });
  it('runs a failed diagnosis again from its row and fetches the rows again', async () => {
    view(<List {...props(SHOW_ALL)} />);
    await openGroup('OldAlert');
    const button = await screen.findByRole('button', { name: 'Run again: OldAlert' });
    expect(screen.getAllByRole('button', { name: /Run again/ })).toHaveLength(1);
    const before = diagnosisCalls().filter(c => c.method === 'GET').length;
    fireEvent.click(button);
    await waitFor(() => expect(calls.filter(c => c.url.endsWith('/rerun'))).toHaveLength(1));
    const post = calls.find(c => c.url.endsWith('/rerun'))!;
    expect(post).toMatchObject({ method: 'POST', body: {} });
    expect(post.url).toMatch(/\/api\/diagnoses\/3\/rerun$/);
    await waitFor(() =>
      expect(diagnosisCalls().filter(c => c.method === 'GET').length).toBeGreaterThan(before)
    );
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows a re-run error inline in the widget', async () => {
    request.mockImplementation(async (url: string, params?: any) => {
      if (params?.method === 'POST') throw new Error('{"error":"No model is configured"}');
      return { total: 3, diagnoses: DIAGNOSES };
    });
    view(<List {...props(SHOW_ALL)} />);
    await openGroup('OldAlert');
    fireEvent.click(await screen.findByRole('button', { name: 'Run again: OldAlert' }));
    expect((await screen.findByRole('alert')).textContent).toBe('No model is configured');
  });
  it('has no re-run button while editing', async () => {
    view(<List {...props(SHOW_ALL, { editing: true })} />);
    await openGroup('OldAlert');
    expect(screen.getByText('cause OldAlert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Run again/ })).toBeNull();
  });
  it('keeps the last data when a refresh fails', async () => {
    const p = props(SHOW_ALL);
    const { rerender } = view(<List {...p} />);
    await screen.findByText('HighCPU');
    request.mockRejectedValue(new Error('proxy down'));
    rerender(
      <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
        <MemoryRouter>
          <List {...p} refreshSignal={1} />
        </MemoryRouter>
      </ThemeProvider>
    );
    expect(await screen.findByText(/Refresh failed, showing the last data/)).toBeTruthy();
    expect(screen.getByText('HighCPU')).toBeTruthy();
  });
});

describe('fetchAllDiagnoses', () => {
  const settings = { namespace: 'ns', serviceName: 'svc', servicePort: '80' };
  it('reads every page, so the count is the real total and not the first page', async () => {
    const many = Array.from({ length: 450 }, (_, i) =>
      diag(String(i), `A${i}`, i % 2 ? 'critical' : 'warning', 'done')
    );
    request.mockReset();
    request.mockImplementation(async (url: string) => {
      const q = new URL(url, 'http://x').searchParams;
      const offset = Number(q.get('offset') ?? 0);
      const limit = Number(q.get('limit'));
      return { total: many.length, diagnoses: many.slice(offset, offset + limit) };
    });
    const rows = await fetchAllDiagnoses(settings);
    expect(rows).toHaveLength(450);
    expect(summariseDiagnoses(rows).bySeverity).toEqual({ critical: 225, warning: 225, other: 0 });
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('stops after one short page for an agent that sends no total', async () => {
    request.mockReset();
    request.mockResolvedValue({ diagnoses: DIAGNOSES });
    expect(await fetchAllDiagnoses(settings)).toHaveLength(3);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('stops when an agent ignores offset and repeats a full page', async () => {
    const full = Array.from({ length: 200 }, (_, i) => diag(String(i), 'A', 'warning', 'done'));
    request.mockReset();
    request.mockResolvedValue({ diagnoses: full });
    expect(await fetchAllDiagnoses(settings)).toHaveLength(200);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('list and chat on one dashboard', () => {
  const List = incidentListWidget.Component;
  const Chat = incidentChatWidget.Component;
  const both = (kiosk = false) =>
    view(
      <>
        <div data-testid="list">
          <List {...props(SHOW_ALL, { kiosk })} />
        </div>
        <div data-testid="chat">
          <Chat {...props({}, { kiosk })} />
        </div>
      </>
    );

  it('shows a hint and the example prompts with no selection', async () => {
    both();
    expect(await screen.findByText(/No incident selected/)).toBeTruthy();
    expect(screen.getByText('Which pods are failing right now, and why?')).toBeTruthy();
  });

  it('selects the incident for the chat on a row click instead of navigating', async () => {
    both();
    await openGroup('HighCPU');
    const row = (await screen.findByText('cause HighCPU')).closest(
      '[data-incident-row]'
    ) as HTMLElement;
    expect(within(row).queryByRole('link')).toBeTruthy();
    fireEvent.click(row);
    expect(await screen.findByText('About incident: HighCPU')).toBeTruthy();
    expect(row.getAttribute('aria-selected')).toBe('true');
    // The same row again clears the selection.
    fireEvent.click(row);
    expect(await screen.findByText(/No incident selected/)).toBeTruthy();
  });

  it('sends the pick header, and the model, only when the user picked a model', async () => {
    both();
    await openGroup('HighCPU');
    fireEvent.click(
      (await screen.findByText('cause HighCPU')).closest('[data-incident-row]') as HTMLElement
    );
    await screen.findByText('About incident: HighCPU');
    fireEvent.click(await screen.findByRole('button', { name: /Claude Opus/ }));
    fireEvent.click(screen.getByRole('option', { name: /Claude Sonnet/ }));
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'why?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/chats'))).toBe(true)
    );
    const create = calls.find(c => c.method === 'POST' && c.url.endsWith('/api/chats'))!;
    expect(create.body).toEqual({ diagnosisId: '1', model: 'claude/sonnet' });
    expect(create.headers?.['x-incidents-model-pick']).toBe('1');
  });

  it('creates the chat with the selected incident and sends the message', async () => {
    both();
    await openGroup('HighCPU');
    fireEvent.click(
      (await screen.findByText('cause HighCPU')).closest('[data-incident-row]') as HTMLElement
    );
    await screen.findByText('About incident: HighCPU');
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'why?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/chats'))).toBe(true)
    );
    const create = calls.find(c => c.method === 'POST' && c.url.endsWith('/api/chats'))!;
    // The default is shown but not sent: the agent applies its default order.
    expect(create.body).toEqual({ diagnosisId: '1' });
    expect(create.headers?.['x-incidents-model-pick']).toBeUndefined();
    await waitFor(() =>
      expect(calls.find(c => c.url.endsWith('/api/chats/c1/messages'))?.body).toEqual({
        text: 'why?',
      })
    );
    // The chat opens and shows the stored thread.
    expect(await screen.findByText('Why is api failing?', { selector: 'div' })).toBeTruthy();
  });

  it('creates a chat with no incident when nothing is selected', async () => {
    both();
    fireEvent.click(await screen.findByText('Summarise the most recent incidents.'));
    await waitFor(() =>
      expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/chats'))).toBe(true)
    );
    const create = calls.find(c => c.method === 'POST' && c.url.endsWith('/api/chats'))!;
    expect(create.body.diagnosisId).toBeUndefined();
  });

  it('keeps the input and a scrolling message list in the chat widget', async () => {
    const { container } = both(true);
    await screen.findByText(/No incident selected/);
    const chat = container.querySelector('[data-incident-chat]') as HTMLElement;
    expect(within(chat).getByLabelText('Message')).toBeTruthy();
    const scroller = Array.from(chat.querySelectorAll('div')).find(
      el => getComputedStyle(el).overflowY === 'auto'
    );
    expect(scroller).toBeTruthy();
    expect(scroller!.contains(within(chat).getByLabelText('Message'))).toBe(false);
  });

  it('refetches models on the refresh signal and reports it', async () => {
    const p = props({});
    const Chat2 = incidentChatWidget.Component;
    const { rerender } = view(<Chat2 {...p} />);
    await waitFor(() => expect(p.reportRefreshed).toHaveBeenCalled());
    const modelCalls = () => calls.filter(c => c.url.endsWith('/api/models')).length;
    expect(modelCalls()).toBe(1);
    act(() => {
      rerender(
        <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
          <MemoryRouter>
            <Chat2 {...p} refreshSignal={1} />
          </MemoryRouter>
        </ThemeProvider>
      );
    });
    await waitFor(() => expect(modelCalls()).toBe(2));
  });
});

/** A cache in memory with the shape of `WidgetCache`, for the last good data tests. */
function memoryCache() {
  let held: { value: unknown; at: number } | undefined;
  return {
    read: <T,>() => held as { value: T; at: number } | undefined,
    write: (value: unknown, at: number = Date.now()) => {
      held = { value: JSON.parse(JSON.stringify(value)), at };
    },
    peek: () => held,
  };
}

describe('incidents.list last good data', () => {
  const List = incidentListWidget.Component;

  it('writes the rows after a fetch, and the next mount shows them at once with no spinner', async () => {
    const cache = memoryCache();
    const first = view(<List {...props(SHOW_ALL, { cache })} />);
    await first.findByText('HighCPU');
    expect(cache.peek()).toBeDefined();
    cleanup();

    // The next load: the server never answers. The rows come from the cache in the first render.
    request.mockImplementation(() => new Promise(() => undefined));
    view(<List {...props(SHOW_ALL, { cache })} />);
    expect(screen.getByText('HighCPU')).toBeTruthy();
    expect(screen.queryByLabelText('Loading')).toBeNull();
    expect(screen.getByText(/^3 incidents\./)).toBeTruthy();
  });

  it('shows a spinner when nothing is cached, and ignores a cache of another address or shape', () => {
    request.mockImplementation(() => new Promise(() => undefined));
    const cache = memoryCache();
    cache.write({ key: 'another address', rows: [] });
    view(<List {...props(SHOW_ALL, { cache })} />);
    expect(screen.getByLabelText('Loading')).toBeTruthy();
    cleanup();
    const bad = memoryCache();
    bad.write('not an object');
    view(<List {...props(SHOW_ALL, { cache: bad })} />);
    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });
});

/* ---------- A group as the chat context ---------- */

/** A group of `n` open incidents of one alert, each a minute after the one before. */
const crowd = (n: number, resolvedEvery = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    createdAt: `2026-11-25T10:${String(i % 60).padStart(2, '0')}:00Z`,
    status: 'done',
    source: 'alert',
    alert: { name: 'KubePodCrashLooping', severity: i === 0 ? 'critical' : 'warning' },
    result: { likelyCause: `cause ${i}`, confidence: 'high' },
    resolvedAt: resolvedEvery && i % resolvedEvery === 0 ? '2026-11-25T11:00:00Z' : undefined,
  }));

/** A stand-in for the Dashboards page: the focus is the path after /d/t, and a change is a push. */
function Page(props: {
  children: (p: { focus: string[]; setFocus: (s: string[] | null) => void }) => React.ReactNode;
}) {
  const location = useLocation();
  const history = useHistory();
  const focus = location.pathname.split('/').slice(3).filter(Boolean).map(decodeURIComponent);
  const setFocus = React.useCallback(
    (s: string[] | null) =>
      history.push(
        `/d/t${(s ?? []).map(x => `/${encodeURIComponent(x)}`).join('')}${location.search}`
      ),
    [history, location.search]
  );
  return (
    <>
      <span data-testid="url">{location.pathname + location.search}</span>
      <button data-testid="back" onClick={() => history.goBack()} />
      <button data-testid="forward" onClick={() => history.goForward()} />
      {props.children({ focus, setFocus })}
    </>
  );
}

const paged = (url: string, config: any = SHOW_ALL, over: any = {}) => {
  const List = incidentListWidget.Component;
  const Chat = incidentChatWidget.Component;
  return render(
    <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
      <MemoryRouter initialEntries={[url]}>
        <Page>
          {f => (
            <>
              <List {...props(config, { ...f, ...over })} />
              <div data-testid="chat">
                <Chat {...props({}, { ...f, ...over })} />
              </div>
            </>
          )}
        </Page>
      </MemoryRouter>
    </ThemeProvider>
  );
};
const url = () => screen.getByTestId('url').textContent;
const groupButton = (name: string) =>
  document.querySelector(`[data-group-chat="${name}"]`) as HTMLElement;

describe('a group as the chat context', () => {
  it('selects the group from the button on its header, and the header itself still only opens it', async () => {
    served = crowd(3);
    paged('/d/t');
    await screen.findByText('KubePodCrashLooping');
    const header = document.querySelector('[data-incident-group]') as HTMLElement;
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(url()).toBe('/d/t');
    expect(screen.getByText(/No incident selected/)).toBeTruthy();
    fireEvent.click(groupButton('KubePodCrashLooping'));
    // The group is in the URL, the button is pressed, and the header did not close.
    expect(url()).toBe('/d/t/group/KubePodCrashLooping');
    await waitFor(() =>
      expect(groupButton('KubePodCrashLooping').getAttribute('aria-pressed')).toBe('true')
    );
    expect(header.getAttribute('aria-expanded')).toBe('true');
    const chip = await screen.findByText(/^About group: KubePodCrashLooping/);
    expect(chip.textContent).toBe(
      'About group: KubePodCrashLooping · 3 incidents · worst critical'
    );
    expect(document.querySelector('[data-chat-context="group"]')).toBeTruthy();
    // The same button again clears it.
    fireEvent.click(groupButton('KubePodCrashLooping'));
    expect(url()).toBe('/d/t');
    expect(await screen.findByText(/No incident selected/)).toBeTruthy();
  });

  it('shows the group from a link, and Back and Forward move between the views', async () => {
    served = crowd(2);
    paged('/d/t/group/KubePodCrashLooping');
    expect(await screen.findByText(/^About group: KubePodCrashLooping/)).toBeTruthy();
    expect(groupButton('KubePodCrashLooping').getAttribute('aria-pressed')).toBe('true');
    // A row in the group replaces the group selection.
    fireEvent.click(document.querySelector('[data-incident-group]')!);
    const row = (await screen.findByText('cause 1')).closest('[data-incident-row]') as HTMLElement;
    fireEvent.click(row);
    expect(url()).toBe('/d/t/incident/c1');
    expect(await screen.findByText('About incident: KubePodCrashLooping')).toBeTruthy();
    expect(groupButton('KubePodCrashLooping').getAttribute('aria-pressed')).toBe('false');
    expect(row.getAttribute('aria-selected')).toBe('true');
    // The group button replaces the row selection.
    fireEvent.click(groupButton('KubePodCrashLooping'));
    expect(url()).toBe('/d/t/group/KubePodCrashLooping');
    expect(await screen.findByText(/^About group: /)).toBeTruthy();
    expect(row.getAttribute('aria-selected')).toBe('false');
    // Back goes to the incident, then to the first group view.
    fireEvent.click(screen.getByTestId('back'));
    expect(url()).toBe('/d/t/incident/c1');
    expect(await screen.findByText('About incident: KubePodCrashLooping')).toBeTruthy();
    fireEvent.click(screen.getByTestId('back'));
    expect(url()).toBe('/d/t/group/KubePodCrashLooping');
    fireEvent.click(screen.getByTestId('forward'));
    expect(url()).toBe('/d/t/incident/c1');
  });

  it('clears the selection from the chip and keeps the query string', async () => {
    served = crowd(2);
    paged('/d/t/group/KubePodCrashLooping?kiosk=1');
    const chip = (await screen.findByText(/^About group: /)).closest(
      '.MuiChip-root'
    ) as HTMLElement;
    fireEvent.click(chip.querySelector('.MuiChip-deleteIcon')!);
    expect(url()).toBe('/d/t?kiosk=1');
    expect(await screen.findByText(/No incident selected/)).toBeTruthy();
  });

  it('shows no selection for a link to a group that is not in the view', async () => {
    served = crowd(2);
    paged('/d/t/group/Gone');
    await screen.findByText('KubePodCrashLooping');
    expect(screen.getByText(/No incident selected/)).toBeTruthy();
  });

  it('shows prompts that fit a group, and sends the group name with the incidents', async () => {
    served = crowd(3);
    paged('/d/t/group/KubePodCrashLooping');
    await screen.findByText(/^About group: /);
    expect(screen.getByText('What do these incidents have in common?')).toBeTruthy();
    expect(screen.getByText('Is this one root cause?')).toBeTruthy();
    expect(screen.queryByText('Why did this alert fire?')).toBeNull();
    expect(screen.getByText('Ask the agent about the KubePodCrashLooping group')).toBeTruthy();
    fireEvent.click(screen.getByText('Is this one root cause?'));
    await waitFor(() =>
      expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/chats'))).toBe(true)
    );
    const create = calls.find(c => c.method === 'POST' && c.url.endsWith('/api/chats'))!;
    // Newest first, and all three in full, with the group name. No short list for a small group.
    expect(create.body).toEqual({
      diagnosisIds: ['c2', 'c1', 'c0'],
      groupName: 'KubePodCrashLooping',
    });
    await waitFor(() =>
      expect(calls.find(c => c.url.endsWith('/api/chats/c1/messages'))?.body).toEqual({
        text: 'Is this one root cause?',
      })
    );
  });

  it('sends the newest incidents in full and the older ones as short lines for a large group', async () => {
    served = crowd(40);
    paged('/d/t/group/KubePodCrashLooping');
    await screen.findByText(/^About group: /);
    fireEvent.click(screen.getByText('What do these incidents have in common?'));
    await waitFor(() =>
      expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/chats'))).toBe(true)
    );
    const body = calls.find(c => c.method === 'POST' && c.url.endsWith('/api/chats'))!.body;
    expect(body.diagnosisIds).toEqual(Array.from({ length: 10 }, (_, i) => `c${39 - i}`));
    expect(body.summaryIds).toHaveLength(30);
    expect(body.summaryIds[0]).toBe('c29');
    expect(body.summaryIds[29]).toBe('c0');
    expect(body.groupOmitted).toBeUndefined();
    expect(body.groupName).toBe('KubePodCrashLooping');
  });

  it('leaves the resolved incidents out of the group while the list hides them, and adds them when it shows them', async () => {
    // c0, c3, c6 and c9 are resolved.
    served = crowd(10, 3);
    const open = paged('/d/t/group/KubePodCrashLooping', { ...SHOW_ALL, openOnly: true });
    const chip = await screen.findByText(/^About group: /);
    expect(chip.textContent).toBe(
      'About group: KubePodCrashLooping · 6 incidents · worst warning · open only'
    );
    fireEvent.click(screen.getByText('Is this one root cause?'));
    await waitFor(() =>
      expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/chats'))).toBe(true)
    );
    expect(
      calls.find(c => c.method === 'POST' && c.url.endsWith('/api/chats'))!.body.diagnosisIds
    ).toEqual(['c8', 'c7', 'c5', 'c4', 'c2', 'c1']);
    open.unmount();
    cleanup();
    calls.length = 0;
    paged('/d/t/group/KubePodCrashLooping', { ...SHOW_ALL, openOnly: false });
    const all = await screen.findByText(/^About group: /);
    expect(all.textContent).toBe(
      'About group: KubePodCrashLooping · 10 incidents · worst critical'
    );
    fireEvent.click(screen.getByText('Is this one root cause?'));
    await waitFor(() =>
      expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/chats'))).toBe(true)
    );
    expect(
      calls.find(c => c.method === 'POST' && c.url.endsWith('/api/chats'))!.body.diagnosisIds
    ).toEqual(['c9', 'c8', 'c7', 'c6', 'c5', 'c4', 'c3', 'c2', 'c1', 'c0']);
  });

  it('keeps the selection in memory with an older Dashboards plugin that gives no focus', async () => {
    served = crowd(2);
    const List = incidentListWidget.Component;
    const Chat = incidentChatWidget.Component;
    view(
      <>
        <List {...props(SHOW_ALL)} />
        <Chat {...props({})} />
      </>
    );
    await screen.findByText('KubePodCrashLooping');
    fireEvent.click(groupButton('KubePodCrashLooping'));
    expect(await screen.findByText(/^About group: KubePodCrashLooping/)).toBeTruthy();
    fireEvent.click(groupButton('KubePodCrashLooping'));
    expect(await screen.findByText(/No incident selected/)).toBeTruthy();
  });

  it('has no group button when the dashboard has no chat widget', async () => {
    served = crowd(2);
    const List = incidentListWidget.Component;
    view(<List {...props(SHOW_ALL)} />);
    await screen.findByText('KubePodCrashLooping');
    expect(groupButton('KubePodCrashLooping')).toBeNull();
  });
});
