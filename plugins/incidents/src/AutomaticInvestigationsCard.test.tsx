import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request },
  Router: { createRouteURL: (name: string) => `/c/test/${name}` },
  ConfigStore: class {
    useConfig() {
      return () => ({});
    }
  },
}));

import { AutomaticInvestigationsCard, lastChangeText } from './AutomaticInvestigationsCard';
import { parseAutomaticInvestigations, parseList, summariseDiagnoses } from './model';

let agent: { enabled: boolean; updatedAt?: string; updatedBy?: string };
let posts: unknown[];
let failLoad: string | null;
let failSave: string | null;

beforeEach(() => {
  agent = { enabled: true };
  posts = [];
  failLoad = null;
  failSave = null;
  request.mockReset();
  request.mockImplementation(async (url: string, params?: any) => {
    expect(url).toMatch(/\/proxy\/api\/settings\/automatic-investigations$/);
    if (params?.method === 'POST') {
      expect(params.headers['Content-Type']).toBe('application/json');
      posts.push(JSON.parse(params.body));
      if (failSave) throw new Error(failSave);
      agent = {
        enabled: JSON.parse(params.body).enabled,
        updatedAt: '2026-11-28T00:40:00.000Z',
        updatedBy: 'alice',
      };
      return { ...agent, changed: true, changes: [] };
    }
    if (failLoad) throw new Error(failLoad);
    return { ...agent, changes: [] };
  });
});
afterEach(cleanup);

const view = () =>
  render(
    <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
      <MemoryRouter>
        <AutomaticInvestigationsCard />
      </MemoryRouter>
    </ThemeProvider>
  );
const toggle = () => screen.findByRole('checkbox', { name: 'Automatic investigations' });

describe('Automatic investigations card', () => {
  it('shows the setting that the agent holds, with the default note before the first change', async () => {
    view();
    const input = (await toggle()) as HTMLInputElement;
    await waitFor(() => expect(input.checked).toBe(true));
    expect(screen.getByText(/investigates each new incident by itself/)).toBeTruthy();
    expect(screen.getByText('Not changed yet. The default is on.')).toBeTruthy();
  });

  it('turns the setting off, sends one write, and shows who changed it', async () => {
    view();
    const input = (await toggle()) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.click(input);
    await waitFor(() => expect(input.checked).toBe(false));
    expect(posts).toEqual([{ enabled: false }]);
    expect(await screen.findByText(/does not start an investigation by itself/)).toBeTruthy();
    expect(screen.getByText(/Last changed by alice,/)).toBeTruthy();
  });

  it('shows an error and keeps the state of the agent when the change fails', async () => {
    failSave = '{"error":"Origin not allowed"}';
    view();
    const input = (await toggle()) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.click(input);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not change the setting: Origin not allowed');
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(false);
  });

  it('shows an error with a retry when the setting cannot load, and keeps the switch disabled', async () => {
    failLoad = 'Service unavailable';
    view();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the setting: Service unavailable');
    expect(screen.queryByRole('checkbox')).toBeNull();
    failLoad = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(((screen.getByRole('checkbox') as HTMLInputElement).disabled)).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when an older agent does not report the setting', async () => {
    request.mockReset();
    request.mockResolvedValue({});
    view();
    expect((await screen.findByRole('alert')).textContent).toContain('Update the agent');
  });
});

describe('the model of the setting', () => {
  it('reads the agent reply and rejects a reply with no switch', () => {
    expect(parseAutomaticInvestigations({ enabled: false, updatedBy: 'bob', updatedAt: 'x' })).toEqual({
      enabled: false,
      updatedBy: 'bob',
      updatedAt: 'x',
    });
    expect(parseAutomaticInvestigations({})).toBeNull();
    expect(parseAutomaticInvestigations({ enabled: 'yes' })).toBeNull();
  });

  it('words the last change', () => {
    expect(lastChangeText({ enabled: true })).toBe('Not changed yet. The default is on.');
    expect(lastChangeText({ enabled: true, updatedAt: 'not a date', updatedBy: 'bob' })).toBe(
      'Last changed by bob, not a date.'
    );
  });

  it('reads a skipped incident with its marker as the cause, and counts it', () => {
    const list = parseList({
      diagnoses: [
        {
          id: 'a',
          createdAt: '2026-11-28T00:00:00Z',
          status: 'skipped',
          alert: { name: 'DiskFull', severity: 'critical' },
          skipped: { reason: 'Automatic investigation skipped: setting off', at: 'x' },
        },
      ],
    });
    expect(list[0]).toMatchObject({
      status: 'skipped',
      likelyCause: 'Automatic investigation skipped: setting off',
    });
    expect(summariseDiagnoses(list).byStatus.skipped).toBe(1);
  });
});
