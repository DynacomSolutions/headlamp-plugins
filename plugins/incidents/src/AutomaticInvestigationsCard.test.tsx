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

let agent: { enabled: boolean; updatedAt?: string; updatedBy?: string; updatedVia?: string };
let user: string | null;
let stale: typeof agent | null;
let hold: Promise<void> | null;
let posts: unknown[];
let failLoad: string | null;
let failSave: string | null;

beforeEach(() => {
  agent = { enabled: true };
  posts = [];
  failLoad = null;
  failSave = null;
  user = 'alice';
  stale = null;
  hold = null;
  request.mockReset();
  request.mockImplementation(async (url: string, params?: any) => {
    if (url === '/apis/authentication.k8s.io/v1/selfsubjectreviews') {
      expect(params.method).toBe('POST');
      if (user === null) throw new Error('forbidden');
      return { status: { userInfo: { username: user } } };
    }
    expect(url).toMatch(/\/proxy\/api\/settings\/automatic-investigations$/);
    if (params?.method === 'POST') {
      expect(params.headers['Content-Type']).toBe('application/json');
      posts.push(JSON.parse(params.body));
      if (hold) await hold;
      if (failSave) throw new Error(failSave);
      const body = JSON.parse(params.body);
      agent = {
        enabled: body.enabled,
        updatedAt: '2026-11-28T00:40:00.000Z',
        updatedBy: body.by ?? '',
        updatedVia: 'proxy',
      };
      return { ...agent, changed: true, changes: [] };
    }
    if (failLoad) throw new Error(failLoad);
    return { ...(stale ?? agent), changes: [] };
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
    expect(posts).toEqual([{ enabled: false, by: 'alice' }]);
    expect(await screen.findByText(/does not start an investigation by itself/)).toBeTruthy();
    expect(screen.getByText(/Last changed by alice,/)).toBeTruthy();
  });

  it('sends no name when the cluster does not say who the user is, and shows via Headlamp', async () => {
    user = null;
    view();
    const input = (await toggle()) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.click(input);
    await waitFor(() => expect(input.checked).toBe(false));
    expect(posts).toEqual([{ enabled: false }]);
    expect(await screen.findByText(/Last changed via Headlamp,/)).toBeTruthy();
  });

  it('does not switch back when a poll of an older replica comes after the save', async () => {
    stale = { enabled: true, updatedAt: '2026-11-27T10:00:00.000Z', updatedBy: 'bob', updatedVia: 'proxy' };
    view();
    const input = (await toggle()) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.click(input);
    await waitFor(() => expect(input.checked).toBe(false));
    // The save asked the agent again (refresh) and got the older answer. The switch keeps the saved state.
    await new Promise(r => setTimeout(r, 50));
    expect(input.checked).toBe(false);
    expect(screen.getByText(/Last changed by alice,/)).toBeTruthy();
    // A poll that has the change takes over.
    stale = null;
    fireEvent.click(input);
    await waitFor(() => expect(input.checked).toBe(true));
  });

  it('keeps the switch enabled and focused while it saves, ignores input, and announces the result', async () => {
    let release!: () => void;
    hold = new Promise<void>(r => (release = r));
    view();
    const input = (await toggle()) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    input.focus();
    fireEvent.click(input);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('region', { name: 'Automatic investigations' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Saving the setting.');
    // A second click while it saves does nothing.
    fireEvent.click(input);
    expect(posts).toHaveLength(1);
    release();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Automatic investigations are now off.'));
    expect(screen.getByRole('region', { name: 'Automatic investigations' }).getAttribute('aria-busy')).toBe('false');
    expect(document.activeElement).toBe(input);
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
    expect(parseAutomaticInvestigations({ enabled: true, updatedVia: 'proxy' })?.updatedVia).toBe('proxy');
    expect(parseAutomaticInvestigations({ enabled: true, updatedVia: 'x' })?.updatedVia).toBeUndefined();
    expect(parseAutomaticInvestigations({})).toBeNull();
    expect(parseAutomaticInvestigations({ enabled: 'yes' })).toBeNull();
  });

  it('words the last change', () => {
    expect(lastChangeText({ enabled: true })).toBe('Not changed yet. The default is on.');
    const at = 'not a date';
    expect(lastChangeText({ enabled: true, updatedAt: at, updatedBy: 'bob', updatedVia: 'proxy' })).toBe(
      'Last changed by bob, not a date.'
    );
    // A name that did not come through Headlamp is a claim.
    expect(lastChangeText({ enabled: true, updatedAt: at, updatedBy: 'bob', updatedVia: 'direct' })).toBe(
      'Last changed by bob (claimed), not a date.'
    );
    expect(lastChangeText({ enabled: true, updatedAt: at, updatedBy: 'bob' })).toBe(
      'Last changed by bob (claimed), not a date.'
    );
    expect(lastChangeText({ enabled: true, updatedAt: at, updatedVia: 'proxy' })).toBe(
      'Last changed via Headlamp, not a date.'
    );
    expect(lastChangeText({ enabled: true, updatedAt: at, updatedVia: 'direct' })).toBe('Last changed not a date.');
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
