import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
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
import { selectIncident } from './selection';

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

type Call = { url: string; method: string; body: any };
let calls: Call[];
let pageTotal: number | undefined;

beforeEach(() => {
  calls = [];
  pageTotal = undefined;
  request.mockReset();
  request.mockImplementation(async (url: string, params?: any) => {
    const method = params?.method ?? 'GET';
    calls.push({ url, method, body: params?.body ? JSON.parse(params.body) : undefined });
    if (url.includes('/api/diagnoses')) {
      const q = new URL(url, 'http://x').searchParams;
      const offset = Number(q.get('offset') ?? 0);
      const limit = Number(q.get('limit') ?? 50);
      return {
        total: pageTotal ?? DIAGNOSES.length,
        diagnoses: DIAGNOSES.slice(offset, offset + limit),
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
  selectIncident(null);
});

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
      openOnly: false,
    });
    expect(incidentChatWidget.defaultConfig).toEqual({});
  });
});

describe('incidents.list', () => {
  const List = incidentListWidget.Component;
  it('shows the summary and the rows, and reports the refresh', async () => {
    const p = props(incidentListWidget.defaultConfig);
    view(<List {...p} />);
    expect(await screen.findByText('HighCPU')).toBeTruthy();
    expect(screen.getByText(/^3 incidents\./)).toBeTruthy();
    expect(document.querySelector('[data-count="critical"]')?.textContent).toBe('1');
    expect(screen.getByText(/1 running/)).toBeTruthy();
    expect(p.reportRefreshed).toHaveBeenCalled();
  });
  it('keeps the summary outside the scrolling list', async () => {
    const { container } = view(<List {...props(incidentListWidget.defaultConfig)} />);
    await screen.findByText('HighCPU');
    const scroller = container.querySelector('[data-incident-list-scroll]') as HTMLElement;
    expect(scroller.contains(screen.getByText(/^3 incidents\./))).toBe(false);
    expect(scroller.contains(screen.getByText('HighCPU'))).toBe(true);
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
    view(<List {...props(incidentListWidget.defaultConfig)} />);
    const link = await screen.findByRole('link', { name: 'HighCPU' });
    expect(link.getAttribute('href')).toBe('/c/test/incident/1');
  });
  it('turns the links off while editing', async () => {
    view(<List {...props(incidentListWidget.defaultConfig, { editing: true })} />);
    await screen.findByText('HighCPU');
    expect(screen.queryByRole('link', { name: 'HighCPU' })).toBeNull();
  });
  it('fetches on the refresh signal only, not on a rerender', async () => {
    const p = props(incidentListWidget.defaultConfig);
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
    view(<List {...props(incidentListWidget.defaultConfig)} />);
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
    view(<List {...props(incidentListWidget.defaultConfig)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run again: OldAlert' }));
    expect((await screen.findByRole('alert')).textContent).toBe('No model is configured');
  });
  it('has no re-run button while editing', async () => {
    view(<List {...props(incidentListWidget.defaultConfig, { editing: true })} />);
    await screen.findByText('OldAlert');
    expect(screen.queryByRole('button', { name: /Run again/ })).toBeNull();
  });
  it('keeps the last data when a refresh fails', async () => {
    const p = props(incidentListWidget.defaultConfig);
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
          <List {...props(incidentListWidget.defaultConfig, { kiosk })} />
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
    const row = (await screen.findByText('HighCPU')).closest('[data-incident-row]') as HTMLElement;
    expect(within(row).queryByRole('link')).toBeTruthy();
    fireEvent.click(row);
    expect(await screen.findByText('About incident: HighCPU')).toBeTruthy();
    expect(row.getAttribute('aria-selected')).toBe('true');
    // The same row again clears the selection.
    fireEvent.click(row);
    expect(await screen.findByText(/No incident selected/)).toBeTruthy();
  });

  it('creates the chat with the selected incident and sends the message', async () => {
    both();
    fireEvent.click(
      (await screen.findByText('HighCPU')).closest('[data-incident-row]') as HTMLElement
    );
    await screen.findByText('About incident: HighCPU');
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'why?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/chats'))).toBe(true)
    );
    const create = calls.find(c => c.method === 'POST' && c.url.endsWith('/api/chats'))!;
    expect(create.body).toMatchObject({ diagnosisId: '1', model: 'claude/opus' });
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
