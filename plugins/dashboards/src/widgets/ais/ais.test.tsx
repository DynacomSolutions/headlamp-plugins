import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
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
import {
  AisView,
  COUNTDOWN_SLOT,
  countdownMode,
  isStacked,
  PERCENT_WIDTH,
  STACK_TILE_COLUMNS,
  STACK_WIDTH,
  WIDE_WIDTH,
  worstLimit,
} from './AisView';
import { isModelLimit, joinAis } from './join';

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
    // 7 identities and the pool line.
    expect(scroll[0].querySelectorAll('[data-ais-row]')).toHaveLength(8);
  });

  it('draws every row and group and no "+N more" line', () => {
    const c = view();
    // The pool is a line of its own, so four provider headers remain.
    expect(c.querySelectorAll('[data-ais-group]')).toHaveLength(4);
    expect(c.querySelectorAll('[data-ais-row]')).toHaveLength(8);
    expect(c.textContent).not.toMatch(/\+\s*\d+\s*more/i);
    expect(c.textContent).not.toMatch(/\bother\b/i);
  });

  it('marks the active member with a dot, and a login that needs attention with an icon', () => {
    const c = view();
    expect(c.querySelectorAll('[data-active-mark]')).toHaveLength(1);
    expect(c.querySelector('[data-active] [data-active-mark]')?.getAttribute('aria-label')).toBe(
      'Active'
    );
    // A mark, not a chip: no text on the line for the mark.
    expect(c.querySelector('[data-active-mark]')?.textContent).toBe('');
    expect(
      c.querySelector('[data-ais-row$="/red"] [data-login="crit"]')?.getAttribute('title')
    ).toBe('Login: Expired');
    expect(
      c.querySelector('[data-ais-row$="/solo"] [data-login="warn"]')?.getAttribute('title')
    ).toBe('Login: Expiring');
    // A member that is logged in has no login mark and no login text.
    expect(c.querySelector('[data-ais-row$="/blue"] [data-login]')).toBeNull();
    expect(c.querySelector('[data-ais-list]')?.textContent).not.toMatch(/Logged in/);
  });

  it('draws one thin line for each identity: the name, the bars and the worst percentage', () => {
    const c = view();
    const red = c.querySelector('[data-ais-row="anthropic/red"]') as HTMLElement;
    expect(red.textContent).toBe('red100%');
    expect(red.querySelectorAll('[data-lane]')).toHaveLength(2);
    expect(red.querySelector('[data-ais-note]')?.getAttribute('data-status')).toBe('crit');
    // The window names are in the legend only, never on a line.
    const list = c.querySelector('[data-ais-list]') as HTMLElement;
    expect(list.textContent).not.toMatch(/Weekly|5-hour|Monthly/);
    expect(c.querySelector('[data-legend]')?.textContent).toContain('Weekly (Fable)');
  });

  it('gives each window the colour of its legend swatch', () => {
    const c = view();
    const swatch = (name: string) =>
      c.querySelector(`[data-legend-item="${name}"] [data-swatch]`)?.getAttribute('data-swatch');
    const fill = (name: string) =>
      c.querySelector(`[data-ais-row="anthropic/red"] [data-segment="${name}"]`);
    expect(swatch('Weekly')).toBeTruthy();
    expect(swatch('Weekly')).not.toBe(swatch('Weekly (Fable)'));
    expect(fill('Weekly')).not.toBeNull();
    expect(fill('Weekly (Fable)')).not.toBeNull();
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
  it('gives the pool the joint bars of all members and says so', () => {
    const c = consoleView();
    const row = c.querySelector('[data-ais-row="pool:pool-one"]') as HTMLElement;
    expect(row.querySelectorAll('[data-lane]')).toHaveLength(2);
    expect(row.querySelector('[data-pool-sub]')?.textContent).toBe('Pool total, 3 members');
    // Weekly: (100 + 40 + 7) / 3 = 49 %. Weekly (Fable): only one member reports, at 100 %.
    expect(row.querySelector('[data-segment="Weekly"]')?.getAttribute('data-fill')).toBe(
      String((1 + 0.4 + 0.07) / 3)
    );
    // The full Fable window does not count: the line shows the Weekly total.
    expect(row.querySelector('[data-segment="Weekly (Fable)"]')?.getAttribute('data-fill')).toBe(
      '1'
    );
    expect(row.querySelector('[data-ais-note]')?.textContent).toBe('49%');
    expect(row.querySelector('[data-ais-note]')?.getAttribute('data-status')).toBe('ok');
    expect(row.getAttribute('data-row-status')).toBe('ok');
  });

  it('marks a member that reports no data for a window', () => {
    const c = consoleView();
    const blue = c.querySelector('[data-ais-row="anthropic/blue"]') as HTMLElement;
    expect(blue.querySelector('[data-lane="Weekly"]')?.hasAttribute('data-missing')).toBe(false);
    expect(blue.querySelector('[data-lane="Weekly (Fable)"]')?.hasAttribute('data-missing')).toBe(
      true
    );
    expect(blue.querySelector('[data-segment="Weekly (Fable)"]')).toBeNull();
    const red = c.querySelector('[data-ais-row="anthropic/red"]') as HTMLElement;
    expect(red.querySelector('[data-lane][data-missing]')).toBeNull();
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
    expect(c.querySelector('[data-ais-row="anthropic/red"] [data-active-mark]')).not.toBeNull();
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

describe('model windows', () => {
  const panel = (id: string, rows: ReturnType<typeof lim>[]) =>
    parsePanel({ version: 1, id, title: id, status: 'ok', summary: '', stats: [], rows });
  const only = (rows: ReturnType<typeof lim>[]) => joinAis({ limits: panel('limits', rows) });
  const draw = (m: ReturnType<typeof joinAis>) =>
    render(wrap(<AisView model={m} sourceId="ais-console" kiosk={false} editing={false} />))
      .container;

  it('knows a model window by the model in brackets at the end of its name', () => {
    expect(isModelLimit('Weekly (Fable)')).toBe(true);
    expect(isModelLimit('weekly (Opus 4)')).toBe(true);
    expect(isModelLimit('Weekly')).toBe(false);
    expect(isModelLimit('5-hour')).toBe(false);
    expect(isModelLimit('(Fable) Weekly')).toBe(false);
  });

  it('keeps a model window out of worstLimit', () => {
    const w = worstLimit([
      { name: 'Weekly', value: '40%', fraction: 0.4, status: 'ok' },
      { name: 'Weekly (Fable)', value: '100%', fraction: 1, status: 'crit' },
    ]);
    expect(w?.name).toBe('Weekly');
    expect(
      worstLimit([{ name: 'Weekly (Fable)', value: '100%', fraction: 1, status: 'crit' }])
    ).toBeUndefined();
  });

  it('sets the percentage and the status of a line by the other windows, and still draws the bar', () => {
    const m = only([
      lim('Anthropic / blue', 'Weekly', 0.4),
      lim('Anthropic / blue', 'Weekly (Fable)', 1, 'crit'),
    ]);
    expect(m.groups[0].members[0].status).toBe('ok');
    expect(m.status).toBe('ok');
    const c = draw(m);
    const row = c.querySelector('[data-ais-row="anthropic/blue"]') as HTMLElement;
    expect(row.querySelector('[data-ais-note]')?.textContent).toBe('40%');
    expect(row.querySelector('[data-ais-note]')?.getAttribute('data-status')).toBe('ok');
    expect(row.querySelectorAll('[data-lane]')).toHaveLength(2);
    expect(row.querySelector('[data-segment="Weekly (Fable)"]')?.getAttribute('data-fill')).toBe(
      '1'
    );
  });

  it('shows a warning by the weekly value when the weekly window warns', () => {
    const m = only([
      lim('Anthropic / blue', 'Weekly', 0.85, 'warn'),
      lim('Anthropic / blue', 'Weekly (Fable)', 1, 'crit'),
    ]);
    expect(m.groups[0].members[0].status).toBe('warn');
    expect(m.status).toBe('warn');
  });

  it('shows no percentage for an identity with only model windows, and keeps the bar', () => {
    const m = only([lim('Anthropic / blue', 'Weekly (Fable)', 1, 'crit')]);
    expect(m.groups[0].members[0].status).toBe('ok');
    expect(m.status).toBe('ok');
    const row = draw(m).querySelector('[data-ais-row="anthropic/blue"]') as HTMLElement;
    expect(row.querySelector('[data-ais-note]')?.textContent).toBe('');
    expect(row.querySelector('[data-segment="Weekly (Fable)"]')?.getAttribute('data-fill')).toBe(
      '1'
    );
  });

  it('chooses the pool member and the pool status by the other windows', () => {
    const limitsPanel = panel('limits', [
      lim('Anthropic / blue', 'Weekly', 0.4),
      lim('Anthropic / blue', 'Weekly (Fable)', 1, 'crit'),
      lim('Anthropic / red', 'Weekly', 0.5),
    ]);
    const swap = parsePanel({
      version: 1,
      id: 'claude-swap',
      title: 'Swap',
      status: 'ok',
      summary: '',
      stats: [],
      rows: [
        { label: 'pool-one / blue', detail: 'Active, weekly', value: '40%', status: 'ok' },
        { label: 'pool-one / red', detail: 'Idle, weekly', value: '50%', status: 'ok' },
      ],
    });
    const g = joinAis({ limits: limitsPanel, swap }).groups[0];
    expect(g.poolStatus).toBe('ok');
    expect(g.joint?.status).toBe('ok');
    expect(g.joint?.limits.map(l => l.name)).toContain('Weekly (Fable)');
  });
});

// The agents panel of a new source: the Agents table says which member the gateway really serves.
const COLUMNS = ['pool', 'identity', 'tool', 'identitySource', 'age'].map(key => ({
  key,
  label: key,
  align: 'left',
}));
const agentRow = (pool: string, identity: string, identitySource: string) => ({
  pool,
  identity,
  tool: 'claude',
  identitySource,
  age: '1h',
});
const servedPanels = (rows: ReturnType<typeof agentRow>[]) => ({
  limits,
  identities,
  swap,
  agents: parsePanel({
    version: 1,
    id: 'agents',
    title: 'Agents',
    status: 'ok',
    summary: '',
    // Old stat sum is 2 x the real count: the old scan counted the helper of each agent too.
    stats: [{ label: 'claude', value: String(rows.length * 2), status: 'ok' }],
    rows: rows.map(r => ({
      label: 'claude',
      detail: `${r.pool} / ${r.identity}`,
      value: '1h',
      status: 'ok',
    })),
    tables: [{ title: 'Agents', columns: COLUMNS, rows }],
  }),
});
const served = (rows: ReturnType<typeof agentRow>[]) => joinAis(servedPanels(rows));

describe('joinAis with the member that the gateway serves', () => {
  it('marks the served member, not the registry active one', () => {
    const g = served([agentRow('pool-one', 'blue', 'gateway-ledger')]).groups[0];
    expect(g.active).toBe('red');
    expect(g.serving).toEqual(['blue']);
    expect(g.members.map(m => [m.name, m.serving, m.active])).toEqual([
      ['blue', true, false],
      ['red', false, true],
      ['violet', false, false],
    ]);
  });
  it('takes the pool limits from the served member', () => {
    const g = served([agentRow('pool-one', 'blue', 'gateway-ledger')]).groups[0];
    expect(g.poolLimitsOf).toBe('blue');
    expect(g.poolLimits?.map(l => l.name)).toEqual(['Weekly']);
    expect(g.poolStatus).toBe('ok');
  });
  it('takes the worst served member when the gateway serves several', () => {
    const g = served([
      agentRow('pool-one', 'blue', 'gateway-ledger'),
      agentRow('pool-one', 'red', 'gateway-ledger'),
    ]).groups[0];
    expect(g.serving).toEqual(['blue', 'red']);
    expect(g.poolLimitsOf).toBe('red');
    expect(g.poolStatus).toBe('crit');
  });
  it('matches the pool and member names loosely', () => {
    const g = served([agentRow('Pool_One', 'BLUE', 'gateway-ledger')]).groups[0];
    expect(g.serving).toEqual(['blue']);
  });
  it('counts the served members in the tile', () => {
    const m = served([
      agentRow('pool-one', 'blue', 'gateway-ledger'),
      agentRow('pool-one', 'red', 'gateway-ledger'),
    ]);
    expect(m.stats.map(s => [s.label, s.value])).toContainEqual(['Serving', '2']);
  });
  it('keeps the active member name tile for a pool without a gateway record', () => {
    const m = served([agentRow('pool-one', 'red', 'pool-active')]);
    expect(m.stats.map(s => [s.label, s.value])).toContainEqual(['Active member', 'red']);
    expect(m.textTiles).toHaveLength(1);
  });
  it('leaves a pool without a gateway record as it was: the registry member is the one', () => {
    const g = served([agentRow('pool-one', 'red', 'pool-active')]).groups[0];
    expect(g.serving).toBeUndefined();
    expect(g.members.every(m => m.serving === undefined)).toBe(true);
    expect(g.poolLimitsOf).toBe('red');
  });
  it('shows the served member in the tile, and counts the sessions without the helpers', () => {
    const m = served([
      agentRow('pool-one', 'blue', 'gateway-ledger'),
      agentRow('', 'solo', 'session-marker'),
    ]);
    const tiles = m.stats.map(s => [s.label, s.value]);
    expect(tiles).toContainEqual(['Sessions', '2']);
    expect(tiles).toContainEqual(['Serving', '1']);
    // The tile is a number, so it is not a text tile and no name is cut.
    expect(m.textTiles).toEqual([]);
    expect(m.summary).toBe('2 sessions, 7 identities, 1 pool');
  });
});

describe('AisView with the member that the gateway serves', () => {
  const render2 = (rows: ReturnType<typeof agentRow>[], mode?: 'console') =>
    render(
      wrap(
        <AisView
          model={served(rows)}
          sourceId="ais-console"
          kiosk={false}
          editing={false}
          view={mode}
        />
      )
    ).container;

  it('marks Serving on the served member and Registry active on the other (overview)', () => {
    const c = render2([agentRow('pool-one', 'blue', 'gateway-ledger')]);
    expect(
      c
        .querySelector('[data-ais-row="anthropic/blue"] [data-serving-mark]')
        ?.getAttribute('aria-label')
    ).toBe('Serving');
    expect(
      c
        .querySelector('[data-ais-row="anthropic/red"] [data-active-mark]')
        ?.getAttribute('aria-label')
    ).toBe('Registry active');
    expect(c.querySelectorAll('[data-serving-mark]')).toHaveLength(1);
    expect(c.querySelector('[data-ais-row^="pool:"] [data-pool-sub]')?.textContent).toBe(
      'Pool total, 3 members'
    );
  });
  it('keeps the joint bars on the pool row whoever the gateway serves (console)', () => {
    const c = render2([agentRow('pool-one', 'blue', 'gateway-ledger')], 'console');
    const row = c.querySelector('[data-ais-row="pool:pool-one"]') as HTMLElement;
    expect(row.querySelector('[data-pool-sub]')?.textContent).toBe('Pool total, 3 members');
    expect(row.querySelectorAll('[data-lane]')).toHaveLength(2);
    expect(c.querySelector('[data-ais-row="anthropic/blue"] [data-serving-mark]')).not.toBeNull();
  });
  it('shows no Registry active mark when the registry member is the served one', () => {
    const c = render2([agentRow('pool-one', 'red', 'gateway-ledger')], 'console');
    expect(c.querySelector('[data-ais-row="anthropic/red"] [data-serving-mark]')).not.toBeNull();
    expect(c.querySelector('[data-active-mark]')).toBeNull();
  });
  it('keeps the old Active mark for a source that does not say who is served', () => {
    const c = view();
    expect(c.querySelector('[data-serving-mark]')).toBeNull();
    expect(c.querySelector('[data-active-mark]')?.getAttribute('aria-label')).toBe('Active');
  });
});

/** jsdom has no layout: the widget width is the clientWidth that the test sets on every element. */
function withWidth<T>(width: number, run: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => width,
  });
  try {
    return run();
  } finally {
    if (desc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', desc);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  }
}
const viewAt = (width: number) =>
  withWidth(
    width,
    () =>
      render(wrap(<AisView model={model()} sourceId="ais-console" kiosk={false} editing={false} />))
        .container
  );

describe('isStacked', () => {
  it('decides on the widget width: narrow stacks, wide does not', () => {
    expect(isStacked(470)).toBe(true);
    expect(isStacked(STACK_WIDTH - 1)).toBe(true);
    expect(isStacked(STACK_WIDTH)).toBe(false);
    expect(isStacked(1200)).toBe(false);
  });

  it('does not stack before the first measurement', () => {
    expect(isStacked(0)).toBe(false);
  });

  it('stacks below the width that draws the status key', () => {
    expect(STACK_WIDTH).toBeLessThanOrEqual(WIDE_WIDTH);
  });
});

describe('AisView stacked (narrow widget)', () => {
  it('draws one vertical list, a pool header with its members indented below it', () => {
    const c = viewAt(470);
    expect(c.querySelector('[data-ais]')?.getAttribute('data-ais-layout')).toBe('stacked');
    const list = c.querySelector('[data-ais-list]') as HTMLElement;
    expect(list.getAttribute('data-columns')).toBe('1');
    const keys = Array.from(list.children).map(
      e => e.getAttribute('data-ais-group') ?? e.getAttribute('data-ais-row')
    );
    const pool = keys.findIndex(k => k !== null && model().groups[0].key === k);
    expect(pool).toBe(0);
    const members = model().groups[0].members;
    expect(keys.slice(1, 1 + members.length)).toEqual(members.map(m => m.key));
  });

  it('draws every identity and every group, with no "+N more" line and no Other group', () => {
    const c = viewAt(470);
    expect(c.querySelectorAll('[data-ais-row]')).toHaveLength(8);
    expect(c.querySelectorAll('[data-ais-group]')).toHaveLength(4);
    expect(c.textContent).not.toMatch(/\+\s*\d+\s*more/i);
    expect(c.textContent).not.toMatch(/\bother\b/i);
    for (const g of model().groups)
      for (const m of g.members)
        expect(c.querySelector(`[data-ais-row="${m.key}"]`)).not.toBeNull();
  });

  it('puts the name, the bars and one percentage in each line, with no text for the login', () => {
    const c = viewAt(470);
    const row = c.querySelector('[data-ais-row="anthropic/red"]') as HTMLElement;
    expect(row.querySelector('[data-login="crit"]')).not.toBeNull();
    expect(row.querySelectorAll('[data-lane]').length).toBeGreaterThan(0);
    expect(row.textContent).toBe('red100%');
    const blue = c.querySelector('[data-ais-row="anthropic/blue"]') as HTMLElement;
    expect(blue.textContent).toBe('blue40%');
  });

  it('marks the active member and keeps the summary line outside the scroll area', () => {
    const c = viewAt(470);
    expect(c.querySelector('[data-active] [data-active-mark]')).not.toBeNull();
    const scroll = c.querySelectorAll('[data-scroll-area]');
    expect(scroll).toHaveLength(1);
    expect(scroll[0].contains(c.querySelector('[data-ais-summary]'))).toBe(false);
    expect(scroll[0].contains(c.querySelector('[data-stats]'))).toBe(false);
    expect(c.querySelector('[data-ais-summary]')?.textContent).toBe(
      '42 sessions, 7 identities, 1 pool'
    );
  });

  it('puts the summary numbers in a small grid and keeps one numeral size', () => {
    const c = viewAt(470);
    const stats = c.querySelector('[data-stats]') as HTMLElement;
    expect(stats.getAttribute('data-stat-columns')).toBe(String(STACK_TILE_COLUMNS));
    const sizes = Array.from(c.querySelectorAll('[data-stat] > div:first-child')).map(
      e => getComputedStyle(e).fontSize
    );
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBe('34px');
  });

  it('draws the fixed legend, as no line names its limit', () => {
    const c = viewAt(470);
    expect(c.querySelector('[data-legend]')).not.toBeNull();
    expect(c.querySelector('[data-scroll-area]')?.contains(c.querySelector('[data-legend]'))).toBe(
      false
    );
  });

  it('keeps the wide layout for a wide widget', () => {
    const c = viewAt(1200);
    const root = c.querySelector('[data-ais]');
    expect(root?.getAttribute('data-ais-layout')).toBe('wide');
    expect(c.querySelector('[data-legend]')).not.toBeNull();
    expect(c.querySelector('[data-stats]')?.getAttribute('data-stat-columns')).toBeNull();
    expect(c.querySelectorAll('[data-ais-row]')).toHaveLength(8);
  });
});

describe('reset countdown', () => {
  const NOW = Date.parse('2026-11-24T10:00:00Z');
  const iso = (ms: number): string => new Date(NOW + ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const withReset = (label: string, detail: string, f: number, resetsAt: string) => ({
    ...lim(label, detail, f),
    meta: { resetsAt },
  });
  const rows = () => [
    withReset('Anthropic / red', '5-hour', 0.3, iso(5 * HOUR + 12 * MIN + 5000)),
    withReset('Anthropic / red', 'Weekly', 0.5, iso(3 * 24 * HOUR + 4 * HOUR + 10 * MIN)),
    withReset('Anthropic / red', 'Weekly (Fable)', 0.9, iso(12 * MIN + 5000)),
    withReset('Anthropic / blue', 'Weekly', 0.4, iso(-HOUR)),
    lim('Anthropic / blue', '5-hour', 0.2),
  ];
  const draw = () =>
    render(
      wrap(
        <AisView
          model={joinAis({
            limits: parsePanel({
              version: 1,
              id: 'limits',
              title: 'Limits',
              status: 'ok',
              summary: '',
              stats: [],
              rows: rows(),
            }),
          })}
          sourceId="ais-console"
          kiosk={false}
          editing={false}
        />
      )
    ).container;
  const texts = (row: Element): Record<string, string> =>
    Object.fromEntries(
      Array.from(row.querySelectorAll('[data-countdown]')).map(e => [
        e.getAttribute('data-countdown') ?? '',
        e.querySelector('[data-countdown-text]')?.textContent ?? '',
      ])
    );

  const rowNamed = (c: Element, name: string): Element => {
    const row = Array.from(c.querySelectorAll('[data-ais-row]')).find(
      r => r.querySelector('[data-ais-label]')?.textContent === name
    );
    expect(row).toBeDefined();
    return row as Element;
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the time to the reset of every bar, model windows too', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    const red = rowNamed(draw(), 'red');
    expect(texts(red)).toEqual({
      '5-hour': '5h 12m',
      Weekly: '3d 4h',
      'Weekly (Fable)': '12m',
    });
  });

  it('shows a muted "now" for a past reset and nothing for a window with no reset', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    const blue = rowNamed(draw(), 'blue');
    expect(texts(blue)).toEqual({ Weekly: 'now' });
    expect(blue.querySelector('[data-countdown-past]')?.getAttribute('data-countdown')).toBe(
      'Weekly'
    );
    // The cells stay, so the columns of the lines line up.
    expect(blue.querySelectorAll('[data-countdowns] > div')).toHaveLength(3);
    expect(blue.textContent).not.toMatch(/-\d/);
  });

  it('gives every cell the same fixed width and a gap, so two countdowns never touch', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    const c = draw();
    const cells = Array.from(c.querySelectorAll('[data-countdowns] > div')) as HTMLElement[];
    expect(cells.length).toBeGreaterThan(0);
    const style = (e: HTMLElement) => getComputedStyle(e);
    for (const cell of cells) {
      expect(style(cell).width).toBe(`${COUNTDOWN_SLOT}px`);
      expect(style(cell).paddingRight).toBe('8px');
      expect(style(cell).overflow).toBe('hidden');
    }
  });

  it('reserves a fixed width for the percentage in every line', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    const c = draw();
    for (const row of Array.from(c.querySelectorAll('[data-ais-row]')) as HTMLElement[]) {
      expect(getComputedStyle(row).gridTemplateColumns).toMatch(new RegExp(`${PERCENT_WIDTH}px$`));
    }
  });

  it('decides how many countdown cells fit on the width of the row', () => {
    expect(countdownMode(0, 3, true)).toBe('all');
    expect(countdownMode(1400, 3, true)).toBe('all');
    expect(countdownMode(560, 3, true)).toBe('worst');
    expect(countdownMode(420, 3, false)).toBe('worst');
    expect(countdownMode(300, 3, false)).toBe('none');
    expect(countdownMode(1400, 0, true)).toBe('none');
    // The cells that the mode keeps never take the room of the percentage.
    expect(PERCENT_WIDTH).toBeGreaterThanOrEqual(40);
  });

  it('on a narrow widget draws only the countdown of the window that sets the line', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    const c = withWidth(560, draw);
    expect(c.querySelector('[data-ais]')?.getAttribute('data-countdown-mode')).toBe('worst');
    const red = rowNamed(c, 'red');
    // "Weekly (Fable)" is fuller, but a model window never sets the line.
    expect(texts(red)).toEqual({ Weekly: '3d 4h' });
    expect(red.querySelectorAll('[data-countdowns] > div')).toHaveLength(1);
    // The other countdowns stay in the tooltip text.
    expect(red.querySelector('[data-bar]')?.getAttribute('aria-label')).toMatch(
      /5-hour: .*resets .*Weekly \(Fable\): .*resets/
    );
    // A line with a past reset shows "now" in the same single cell.
    expect(texts(rowNamed(c, 'blue'))).toEqual({ Weekly: 'now' });
  });

  it('on a very narrow widget draws no countdown and keeps the percentage', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    const c = withWidth(400, draw);
    expect(c.querySelector('[data-ais]')?.getAttribute('data-countdown-mode')).toBe('none');
    expect(c.querySelector('[data-countdowns]')).toBeNull();
    const red = rowNamed(c, 'red');
    expect(red.querySelector('[data-ais-status]')?.textContent).toBe('50%');
    expect(getComputedStyle(red as HTMLElement).gridTemplateColumns).toMatch(
      new RegExp(`${PERCENT_WIDTH}px$`)
    );
  });

  it('on a wide widget draws every countdown', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    const c = withWidth(1400, draw);
    expect(c.querySelector('[data-ais]')?.getAttribute('data-countdown-mode')).toBe('all');
    expect(Object.keys(texts(rowNamed(c, 'red')))).toHaveLength(3);
  });

  it('keeps the full reset time in the tooltip text of the bars', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    const bar = draw().querySelector('[data-bar]') as Element;
    expect(bar.getAttribute('aria-label')).toMatch(/resets 2026-11-2\d \d\d:\d\d UTC/);
  });

  it('ticks every 30 s with one timer and stops it on unmount', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const c = draw();
    const red = rowNamed(c, 'red');
    expect(texts(red)['Weekly (Fable)']).toBe('12m');
    expect(setSpy.mock.calls.filter(call => call[1] === 30_000)).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(11 * MIN);
    });
    expect(texts(red)['Weekly (Fable)']).toBe('1m');
    act(() => {
      vi.advanceTimersByTime(MIN);
    });
    expect(texts(red)['Weekly (Fable)']).toBe('<1m');
    act(() => {
      vi.advanceTimersByTime(MIN);
    });
    expect(texts(red)['Weekly (Fable)']).toBe('now');
    cleanup();
    expect(clearSpy).toHaveBeenCalled();
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
