import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn(), clusterRequest: vi.fn() },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));

import { LinkContext } from '../../links';
import { parsePanel } from '../panels/model';
import { AisView, worstLimit } from './AisView';
import { joinAis } from './join';

afterEach(cleanup);

const LINK = 'https://console.example.com/limits';
const lim = (label: string, detail: string, f: number, status = 'ok') => ({
  label,
  detail,
  value: `${Math.round(f * 100)}%`,
  fraction: f,
  status,
  link: LINK,
});

const limits = parsePanel({
  version: 1,
  id: 'limits',
  title: 'Limits',
  status: 'crit',
  summary: '',
  stats: [],
  rows: [
    lim('Anthropic / red', 'Weekly', 1, 'crit'),
    lim('Anthropic / red', 'Weekly (Fable)', 1, 'crit'),
    lim('Anthropic / blue', 'Weekly', 0.4),
    lim('Anthropic / green', '5-hour', 0.1),
    lim('OpenAI / red', 'Monthly', 0.5),
    lim('Kimi / red', 'Weekly', 0.2),
  ],
});
const identities = parsePanel({
  version: 1,
  id: 'identities',
  title: 'Identities',
  status: 'crit',
  summary: '',
  stats: [
    { label: 'Logged in', value: '5', status: 'ok' },
    { label: 'Expiring', value: '1', status: 'warn' },
    { label: 'Expired', value: '1', status: 'crit' },
    { label: 'Logged out', value: '0', status: 'ok' },
  ],
  rows: [
    { label: 'claude / red', detail: 'Expired', value: 'Expired', status: 'crit', link: LINK },
    { label: 'claude / blue', detail: 'Logged in', value: 'Logged in', status: 'ok', link: LINK },
    { label: 'claude / green', detail: 'Logged in', value: 'Logged in', status: 'ok', link: LINK },
    { label: 'codex / red', detail: 'Logged in', value: 'Logged in', status: 'ok', link: LINK },
    {
      label: 'pi / solo',
      detail: 'Expires soon',
      value: 'Expiring',
      status: 'warn',
      link: LINK,
    },
  ],
});
const swap = parsePanel({
  version: 1,
  id: 'claude-swap',
  title: 'Swap',
  status: 'crit',
  summary: '',
  stats: [{ label: 'Pools', value: '1', status: 'ok' }],
  rows: [
    {
      label: 'pool-one / blue',
      detail: 'Standby, weekly',
      value: '40%',
      fraction: 0.4,
      status: 'ok',
      link: LINK,
    },
    {
      label: 'pool-one / red',
      detail: 'Active, weekly',
      value: '100%',
      fraction: 1,
      status: 'crit',
      link: LINK,
    },
    {
      label: 'pool-one / violet',
      detail: 'Standby, weekly',
      value: '7%',
      fraction: 0.07,
      status: 'ok',
      link: LINK,
    },
  ],
});
const agents = parsePanel({
  version: 1,
  id: 'agents',
  title: 'Agents',
  status: 'ok',
  summary: '',
  stats: [
    { label: 'one', value: '40', status: 'ok' },
    { label: 'two', value: '2', status: 'ok' },
  ],
  rows: [],
});

const model = () => joinAis({ limits, identities, swap, agents });

describe('joinAis', () => {
  it('groups pool members under their pool, the active one first', () => {
    const pool = model().groups[0];
    expect(pool.kind).toBe('pool');
    expect(pool.title).toBe('pool-one');
    expect(pool.active).toBe('red');
    expect(pool.members.map(m => m.name)).toEqual(['red', 'blue', 'violet']);
    expect(pool.members.map(m => m.active)).toEqual([true, false, false]);
  });

  it('joins the login state and the limits of one identity across panels', () => {
    const red = model().groups[0].members[0];
    expect(red.provider).toBe('Anthropic');
    expect(red.login?.word).toBe('Expired');
    expect(red.limits.map(l => l.name)).toEqual(['Weekly', 'Weekly (Fable)']);
    expect(red.status).toBe('crit');
  });

  it('uses the pool value when an identity has no limit row of its own', () => {
    const violet = model().groups[0].members[2];
    expect(violet.limits).toEqual([{ name: 'Weekly', value: '7%', fraction: 0.07, status: 'ok' }]);
  });

  it('lists identities that are in no pool under their real provider name, in no Other group', () => {
    const m = model();
    expect(m.groups.map(g => g.title)).toEqual(['pool-one', 'Anthropic', 'OpenAI', 'Kimi', 'Pi']);
    expect(m.groups.slice(1).every(g => g.kind === 'provider')).toBe(true);
    expect(m.groups.some(g => /other|ungrouped/i.test(g.title))).toBe(false);
    expect(m.groups[1].members.map(x => x.name)).toEqual(['green']);
  });

  it('keeps every identity once and loses none', () => {
    const m = model();
    const keys = m.groups.flatMap(g => g.members.map(x => x.key));
    expect(new Set(keys).size).toBe(keys.length);
    // 3 pool members, one more Anthropic identity, and one each for OpenAI, Kimi and Pi.
    expect(m.identityCount).toBe(7);
    expect(keys).toHaveLength(7);
  });

  it('puts a login-only identity under its provider and marks the login state', () => {
    const delta = model().groups.find(g => g.title === 'Pi');
    expect(delta?.members[0].login?.status).toBe('warn');
    expect(delta?.members[0].limits).toEqual([]);
  });

  it('builds the summary tiles: sessions, logins, pools and the active member', () => {
    const m = model();
    expect(m.stats.map(s => [s.label, s.value])).toEqual([
      ['Sessions', '42'],
      ['Logged in', '5'],
      ['Expiring', '1'],
      ['Expired', '1'],
      ['Pools', '1'],
      ['Active member', 'red'],
    ]);
    expect(m.textTiles).toEqual([5]);
  });

  it('orders the limit names by window and keeps them all', () => {
    expect(model().limits).toEqual(['5-hour', 'Weekly', 'Weekly (Fable)', 'Monthly']);
  });

  it('survives missing panels', () => {
    const m = joinAis({ limits });
    expect(m.groups.length).toBeGreaterThan(0);
    expect(m.stats).toEqual([]);
    expect(joinAis({}).groups).toEqual([]);
  });
});

const wrap = (ui: React.ReactNode, tabs: string[] = ['overview', 'ais-console']) => (
  <MemoryRouter>
    <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
      <LinkContext.Provider value={{ base: '/c/main', dashboard: 'ops', tabs }}>
        {ui}
      </LinkContext.Provider>
    </ThemeProvider>
  </MemoryRouter>
);
const view = (editing = false, tabs?: string[]) =>
  render(
    wrap(<AisView model={model()} sourceId="ais-console" kiosk={false} editing={editing} />, tabs)
  ).container;

describe('AisView', () => {
  it('keeps the tiles and the legend fixed outside the one scroll area', () => {
    const c = view();
    const scroll = c.querySelectorAll('[data-scroll-area]');
    expect(scroll).toHaveLength(1);
    expect(scroll[0].contains(c.querySelector('[data-stats]'))).toBe(false);
    expect(scroll[0].contains(c.querySelector('[data-legend]'))).toBe(false);
    expect(scroll[0].querySelectorAll('[data-ais-row]')).toHaveLength(7);
  });

  it('draws every row and group and no "+N more" line', () => {
    const c = view();
    expect(c.querySelectorAll('[data-ais-group]')).toHaveLength(5);
    expect(c.querySelectorAll('[data-ais-row]')).toHaveLength(7);
    expect(c.textContent).not.toMatch(/\+\s*\d+\s*more/i);
    expect(c.textContent).not.toMatch(/\bother\b/i);
  });

  it('marks the active member, the pool and the login state on the row', () => {
    const c = view();
    expect(c.querySelectorAll('[data-active-chip]')).toHaveLength(1);
    expect(c.querySelector('[data-active] [data-active-chip]')?.textContent).toBe('Active');
    expect(c.querySelector('[data-group-kind="pool"] [data-pool-chip]')).not.toBeNull();
    expect(c.querySelector('[data-ais-row$="/red"] [data-login="crit"]')?.textContent).toContain(
      'Expired'
    );
    expect(c.querySelector('[data-ais-row$="/solo"] [data-login="warn"]')?.textContent).toContain(
      'Expiring'
    );
  });

  it('draws one lane for each limit of an identity', () => {
    const c = view();
    const red =
      c.querySelector('[data-ais-row="anthropic/red"]') ?? c.querySelector('[data-ais-row]');
    expect(red?.querySelectorAll('[data-lane]').length).toBeGreaterThan(0);
    const solo = c.querySelector('[data-ais-row$="/solo"]');
    expect(solo?.querySelectorAll('[data-lane]')).toHaveLength(0);
    expect(solo?.querySelector('[data-no-limits]')).not.toBeNull();
  });

  it('links only to the AIS tab of the dashboard', () => {
    const c = view();
    const hrefs = Array.from(c.querySelectorAll('a')).map(a => a.getAttribute('href'));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.every(h => h === '/c/main/dashboards/ops/ais-console')).toBe(true);
  });

  it('draws no link when the dashboard has no AIS tab, or in edit mode', () => {
    expect(view(false, ['overview']).querySelectorAll('a')).toHaveLength(0);
    cleanup();
    expect(view(true).querySelectorAll('a')).toHaveLength(0);
  });

  it('uses one numeral size for every number tile, whatever the name tile says', () => {
    const c = view();
    const sizes = Array.from(c.querySelectorAll('[data-stat] > div:first-child')).map(
      e => getComputedStyle(e).fontSize
    );
    expect(sizes).toHaveLength(6);
    expect(new Set(sizes).size).toBe(1);
  });

  it('shows the summary in the footer line', () => {
    expect(view().querySelector('[data-ais-summary]')?.textContent).toBe(
      '42 sessions, 7 identities, 1 pool'
    );
  });
});

const consoleView = () =>
  render(
    wrap(
      <AisView
        model={model()}
        sourceId="ais-console"
        kiosk={false}
        editing={false}
        view="console"
      />
    )
  ).container;

describe('AisView console view', () => {
  it('gives the pool the limits of its active member and says so', () => {
    const g = model().groups[0];
    expect(g.poolLimits?.map(l => l.name)).toEqual(['Weekly', 'Weekly (Fable)']);
    expect(g.poolStatus).toBe('crit');
    const c = consoleView();
    const row = c.querySelector('[data-ais-row="pool:pool-one"]');
    expect(row?.querySelectorAll('[data-lane]')).toHaveLength(2);
    expect(row?.querySelector('[data-pool-sub]')?.textContent).toContain(
      'Limits of active member red'
    );
  });

  it('opens every pool by default with the members under it, the active one marked', () => {
    const c = consoleView();
    expect(c.querySelector('[data-pool-toggle]')?.getAttribute('aria-expanded')).toBe('true');
    const rows = Array.from(c.querySelectorAll('[data-ais-row]')).map(r =>
      r.getAttribute('data-ais-row')
    );
    expect(rows.slice(0, 4)).toEqual([
      'pool:pool-one',
      'anthropic/red',
      'anthropic/blue',
      'anthropic/violet',
    ]);
    expect(c.querySelector('[data-ais-row="anthropic/red"] [data-active-chip]')).not.toBeNull();
    expect(c.querySelector('[data-ais-row="anthropic/red"] [data-login="crit"]')).not.toBeNull();
  });

  it('keeps identities of no pool under their real provider and never names a group Other', () => {
    const c = consoleView();
    const titles = Array.from(c.querySelectorAll('[data-ais-group]')).map(g => g.textContent);
    expect(titles.join('|')).toMatch(/OpenAI/);
    expect(c.textContent).not.toMatch(/\bother\b/i);
    expect(c.textContent).not.toMatch(/\+\s*\d+\s*more/i);
  });

  it('draws no stat tiles and folds a pool on a click', () => {
    const c = consoleView();
    expect(c.querySelector('[data-stats]')).toBeNull();
    fireEvent.click(c.querySelector('[data-pool-toggle]') as Element);
    expect(c.querySelector('[data-ais-row="anthropic/red"]')).toBeNull();
    expect(c.querySelector('[data-ais-row="pool:pool-one"]')).not.toBeNull();
    fireEvent.click(c.querySelector('[data-pool-toggle]') as Element);
    expect(c.querySelector('[data-ais-row="anthropic/red"]')).not.toBeNull();
  });

  it('names the login states in the footer line', () => {
    expect(consoleView().querySelector('[data-ais-summary]')?.textContent).toContain(
      'Logins: 5 logged in, 1 expiring, 1 expired'
    );
  });
});

describe('worstLimit', () => {
  it('takes the worst status, then the largest fraction', () => {
    const w = worstLimit([
      { name: 'a', value: '50%', fraction: 0.5, status: 'ok' },
      { name: 'b', value: '20%', fraction: 0.2, status: 'warn' },
      { name: 'c', value: '30%', fraction: 0.3, status: 'warn' },
    ]);
    expect(w?.name).toBe('c');
    expect(worstLimit([])).toBeUndefined();
  });
});
