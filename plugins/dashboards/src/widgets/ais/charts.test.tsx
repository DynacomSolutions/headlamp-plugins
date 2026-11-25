import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePanel } from '../panels/model';
import { legendHeight } from '../sunburst/NodeSunburstChart';
import { legendColumns, PieChart } from '../sunburst/PieChart';
import { SunburstChart } from '../sunburst/SunburstChart';
import { agentPaint, brightness, identityShade, inkOn, mixColour } from './agentRings';
import {
  accountsNote,
  agentPlacement,
  agentsToSunburst,
  compactTokens,
  DIRECT,
  gatewaySlices,
  IDENTITY_NOT_REPORTED,
  parseTokens,
  POOL_NOT_REPORTED,
  poolMembers,
  PROVIDER_NOT_REPORTED,
  providerIndex,
  providerOfTool,
} from './charts';

afterEach(cleanup);

const row = (label: string, detail: string, value = '1h', fraction?: number) => ({
  label,
  detail,
  value,
  status: 'ok',
  ...(fraction === undefined ? {} : { fraction }),
});
const panel = (id: string, rows: ReturnType<typeof row>[]) =>
  parsePanel({ version: 1, id, title: id, status: 'ok', summary: '', stats: [], rows });

const tableRow = (pool: string, identity: string, tool: string, identitySource: string) => ({
  pool,
  identity,
  tool,
  identitySource,
  age: '1h',
});
const newAgents = (rows: ReturnType<typeof tableRow>[]) =>
  parsePanel({
    version: 1,
    id: 'agents',
    title: 'Agents',
    status: 'ok',
    summary: '',
    stats: [],
    rows: [],
    tables: [
      {
        title: 'Agents',
        columns: ['pool', 'identity', 'tool', 'identitySource', 'age'].map(key => ({
          key,
          label: key,
          align: 'left',
        })),
        rows,
      },
    ],
  });

const account = (identity: string, input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({
  identity,
  turns: 3,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
  firstSeen: '2026-11-22T01:00:00Z',
  lastSeen: '2026-11-22T02:00:00Z',
});
/** A row of the new source: the agent fields sit on the row itself. */
const agentRow = (fields: Record<string, unknown>, tool = 'claude') => ({
  label: tool,
  detail: 'x',
  value: '1h',
  status: 'ok',
  tool,
  ...fields,
});
const fieldPanel = (rows: ReturnType<typeof agentRow>[]) =>
  parsePanel({
    version: 1,
    id: 'agents',
    title: 'Agents',
    status: 'ok',
    summary: '',
    stats: [],
    rows,
  });

const swap = panel('claude-swap', [
  row('pool-one / red', 'Active, weekly'),
  row('pool-one / blue', 'Standby, weekly'),
]);

describe('agentPlacement', () => {
  const members = poolMembers(swap);
  it('puts an unknown identity in its own named segment, never Other', () => {
    const p = agentPlacement(panel('a', [row('claude', 'unknown identity')]).rows[0], members);
    expect(p).toEqual({ pool: POOL_NOT_REPORTED, identity: IDENTITY_NOT_REPORTED });
  });
  it('maps a pool identity word to its pool, without a member', () => {
    const r = panel('a', [row('claude', 'claude-pool')]).rows[0];
    expect(agentPlacement(r, members)).toEqual({
      pool: 'claude-pool',
      identity: IDENTITY_NOT_REPORTED,
    });
  });
  it('maps an identity to the swap pool that lists it, else to Direct', () => {
    const a = panel('a', [row('claude', 'red'), row('codex', 'solo')]).rows;
    expect(agentPlacement(a[0], members)).toEqual({ pool: 'pool-one', identity: 'red' });
    expect(agentPlacement(a[1], members)).toEqual({ pool: DIRECT, identity: 'solo' });
  });
});

describe('agentPlacement with the agent fields', () => {
  const members = poolMembers(swap);
  const place = (fields: Record<string, unknown>) =>
    agentPlacement(fieldPanel([agentRow(fields)]).rows[0], members);
  it('places a pool row by its pool and identity, not by the old word', () => {
    expect(
      place({
        pool: 'pool-x',
        identity: 'red',
        identitySource: 'gateway-ledger',
        sessionIdentity: 'claude-pool',
      })
    ).toEqual({ pool: 'pool-x', identity: 'red' });
  });
  it('places a row with a null pool in Direct', () => {
    expect(place({ pool: null, identity: 'solo', identitySource: 'config-dir' })).toEqual({
      pool: DIRECT,
      identity: 'solo',
    });
  });
  it('prefers activeIdentity over identity', () => {
    expect(
      place({
        pool: 'pool-x',
        identity: 'red',
        activeIdentity: 'blue',
        identitySource: 'gateway-session',
        identities: [account('blue', 10), account('red', 5)],
      })
    ).toEqual({ pool: 'pool-x', identity: 'blue' });
  });
  it('names an unresolved row with no pool and no identity, never Other', () => {
    expect(place({ pool: null, identity: null, identitySource: 'unresolved' })).toEqual({
      pool: POOL_NOT_REPORTED,
      identity: IDENTITY_NOT_REPORTED,
    });
  });
  it('keeps the old guess for a row with no agent fields', () => {
    const r = panel('a', [row('claude', 'red')]).rows[0];
    expect(r.agent).toBeUndefined();
    expect(agentPlacement(r, members)).toEqual({ pool: 'pool-one', identity: 'red' });
  });
});

describe('agentsToSunburst with the agent fields on the rows', () => {
  const agents = fieldPanel([
    agentRow({ pool: 'pool-x', identity: 'red', identitySource: 'gateway-ledger' }),
    agentRow({ pool: null, identity: 'solo', identitySource: 'config-dir' }, 'codex'),
    agentRow({
      pool: 'pool-x',
      identity: 'red',
      activeIdentity: 'blue',
      identitySource: 'gateway-session',
      identities: [account('blue', 700, 100, 200, 0), account('red', 200, 50, 50, 0)],
    }),
    agentRow({ pool: 'pool-y', identity: null, identitySource: 'unresolved' }),
  ]);
  const data = agentsToSunburst(agents, null);
  it('uses pool, Direct and the active identity, with no Other group', () => {
    expect(data.nodes?.map(n => [n.label, n.used])).toEqual([
      ['pool-x', 2],
      [DIRECT, 1],
      ['pool-y', 1],
    ]);
    const x = data.nodes?.find(n => n.label === 'pool-x');
    expect(x?.categories.map(c => [c.label, c.value])).toEqual([
      ['blue', 1],
      ['red', 1],
    ]);
    expect(data.nodes?.find(n => n.label === 'pool-y')?.categories[0].label).toBe(
      IDENTITY_NOT_REPORTED
    );
    expect(JSON.stringify(data)).not.toMatch(/other|\+\s*\d+\s*more/i);
  });
  it('shows the accounts and the token split, largest first, for a multi-account session', () => {
    const blue = data.nodes
      ?.find(n => n.label === 'pool-x')
      ?.categories.find(c => c.label === 'blue');
    expect(blue?.detail).toBe('identity source gateway-session, 2 accounts: blue 1K, red 300');
    expect(blue?.children?.[0].detail).toBe(blue?.detail);
  });
  it('shows no accounts note for a session with one account, and shows the unresolved source', () => {
    const red = data.nodes
      ?.find(n => n.label === 'pool-x')
      ?.categories.find(c => c.label === 'red');
    expect(red?.detail).toBe('identity source gateway-ledger');
    const none = data.nodes?.find(n => n.label === 'pool-y')?.categories[0];
    expect(none?.detail).toBe('identity source unresolved');
  });
  it('shows the accounts note in the tooltip of the arc', () => {
    const c = render(
      themed(<SunburstChart data={data} title="Agents" unit="agents" format={v => String(v)} />)
    ).container;
    const titles = Array.from(c.querySelectorAll('path title')).map(t => t.textContent ?? '');
    expect(titles.some(t => /2 accounts: blue 1K, red 300/.test(t))).toBe(true);
  });
});

describe('accountsNote and compactTokens', () => {
  it('gives nothing when no agent used more than one account', () => {
    expect(accountsNote([[], [account('a', 5)]])).toBeUndefined();
  });
  it('adds the accounts of several agents and sorts largest first, then by name', () => {
    const note = accountsNote([
      [account('b', 100), account('a', 100)],
      [account('c', 500), account('a', 50)],
    ]);
    expect(note).toBe('3 accounts: c 500, a 150, b 100');
  });
  it('writes a short token count', () => {
    expect(compactTokens(431)).toBe('431');
    expect(compactTokens(12_340)).toBe('12.3K');
    expect(compactTokens(80_800_000)).toBe('80.8M');
    expect(compactTokens(3_100_000_000)).toBe('3.1B');
  });
});

describe('agentsToSunburst', () => {
  const agents = panel('agents', [
    row('claude', 'claude-pool'),
    row('claude', 'claude-pool'),
    row('claude', 'unknown identity'),
    row('claude', 'red'),
    row('codex', 'solo'),
  ]);
  const data = agentsToSunburst(agents, swap);
  it('draws pool, identity and agent with counts and no Other group', () => {
    expect(data.capacity).toBe(5);
    expect(data.nodes?.map(n => [n.label, n.used])).toEqual([
      ['claude-pool', 2],
      [DIRECT, 1],
      [POOL_NOT_REPORTED, 1],
      ['pool-one', 1],
    ]);
    const unknown = data.nodes?.find(n => n.label === POOL_NOT_REPORTED);
    expect(unknown?.categories[0].label).toBe(IDENTITY_NOT_REPORTED);
    expect(JSON.stringify(data)).not.toMatch(/other/i);
    // Every node is full, so no free slice is drawn.
    expect(data.nodes?.every(n => n.capacity === n.used)).toBe(true);
  });
  it('is empty for no agents', () => {
    expect(agentsToSunburst(null, null).nodes).toEqual([]);
  });
});

describe('agentsToSunburst with the Agents table', () => {
  const agents = newAgents([
    tableRow('pool-one', 'blue', 'claude', 'gateway-ledger'),
    tableRow('pool-one', 'blue', 'claude', 'gateway-ledger'),
    tableRow('pool-one', 'blue', 'codex', 'gateway-ledger'),
    tableRow('pool-one', 'red', 'claude', 'gateway-ledger'),
    tableRow('', 'solo', 'claude', 'session-marker'),
    tableRow('', 'solo', 'codex', 'config-dir'),
    tableRow('pool-two', '', 'claude', 'unresolved'),
    tableRow('', '', 'kimi', 'unresolved'),
  ]);
  const data = agentsToSunburst(agents, swap);
  it('draws pool or Direct, then the real identity, then the tool', () => {
    expect(data.capacity).toBe(8);
    expect(data.nodes?.map(n => [n.label, n.used])).toEqual([
      ['pool-one', 4],
      [DIRECT, 2],
      [POOL_NOT_REPORTED, 1],
      ['pool-two', 1],
    ]);
    const one = data.nodes?.find(n => n.label === 'pool-one');
    expect(one?.categories.map(c => [c.label, c.value])).toEqual([
      ['blue', 3],
      ['red', 1],
    ]);
    expect(one?.categories[0].children?.map(k => [k.label, k.value])).toEqual([
      ['Anthropic', 2],
      ['OpenAI', 1],
    ]);
  });
  it('names an unresolved identity and a missing pool, and has no Other group', () => {
    const two = data.nodes?.find(n => n.label === 'pool-two');
    expect(two?.categories[0].label).toBe(IDENTITY_NOT_REPORTED);
    const none = data.nodes?.find(n => n.label === POOL_NOT_REPORTED);
    expect(none?.categories[0].label).toBe(IDENTITY_NOT_REPORTED);
    expect(JSON.stringify(data)).not.toMatch(/other/i);
  });
  it('puts the identity source in the note of the identity and the tool', () => {
    const direct = data.nodes?.find(n => n.label === DIRECT);
    const solo = direct?.categories[0];
    expect(solo?.detail).toMatch(/config-dir 1, session-marker 1/);
    expect(solo?.children?.map(k => [k.label, k.detail])).toEqual([
      ['Anthropic', 'identity source session-marker'],
      ['OpenAI', 'identity source config-dir'],
    ]);
  });
  it('shows the identity source in the tooltip of the arc', () => {
    const c = render(
      themed(<SunburstChart data={data} title="Agents" unit="agents" format={v => String(v)} />)
    ).container;
    const titles = Array.from(c.querySelectorAll('path title')).map(t => t.textContent ?? '');
    expect(titles).toContain(
      'pool-one / blue / Anthropic: 2 agents (25%), identity source gateway-ledger'
    );
  });
  it('ignores the old rows when the table exists, and counts one agent for each table row', () => {
    const both = parsePanel({
      version: 1,
      id: 'agents',
      stats: [],
      rows: [{ label: 'claude', detail: 'red', value: '1h' }],
      tables: [
        {
          title: 'Agents',
          columns: [
            { key: 'identity', label: 'Identity' },
            { key: 'pool', label: 'Pool' },
          ],
          rows: [
            { pool: '', identity: 'blue' },
            { pool: '', identity: 'blue' },
          ],
        },
      ],
    });
    const d = agentsToSunburst(both, swap);
    expect(d.capacity).toBe(2);
    expect(d.nodes?.[0].categories.map(c => c.label)).toEqual(['blue']);
  });
});

describe('agentsToSunburst with an older source (no table)', () => {
  it('keeps the old mapping and adds no source note', () => {
    const d = agentsToSunburst(
      panel('agents', [row('claude', 'red'), row('claude', 'solo')]),
      swap
    );
    expect(d.nodes?.map(n => n.label).sort()).toEqual([DIRECT, 'pool-one']);
    expect(JSON.stringify(d)).not.toMatch(/identity source/);
  });
  it('falls back to the named segments for a table with no data', () => {
    expect(agentsToSunburst(newAgents([]), swap).nodes).toEqual([]);
  });
});

describe('gateway slices', () => {
  it('parses the token text', () => {
    expect(parseTokens('3B')).toBe(3e9);
    expect(parseTokens('80.8M')).toBeCloseTo(80.8e6);
    expect(parseTokens('431K')).toBe(431e3);
    expect(parseTokens('0')).toBe(0);
    expect(parseTokens('n/a')).toBe(0);
  });
  it('keeps every row as its own slice, largest first, and the provider as group', () => {
    const s = gatewaySlices(
      panel('gateway-usage', [
        row('small', 'Codex, 7 days', '1M'),
        row('zero', 'Kimi, 7 days', '0'),
        row('big', 'Claude, 7 days', '3B'),
      ])
    );
    expect(s.map(x => [x.label, x.group])).toEqual([
      ['big', 'Claude'],
      ['small', 'Codex'],
      ['zero', 'Kimi'],
    ]);
  });
  it('gives known providers a fixed colour index and others a stable one after them', () => {
    expect(providerIndex('Claude', [])).toBe(0);
    expect(providerIndex('Kimi', [])).toBe(4);
    expect(providerIndex('Zeta', ['Zeta', 'Alpha'])).toBeGreaterThan(providerIndex('Ali', []));
    expect(providerIndex('Alpha', ['Zeta', 'Alpha'])).toBeLessThan(
      providerIndex('Zeta', ['Zeta', 'Alpha'])
    );
  });
});

const themed = (ui: React.ReactNode) => (
  <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>{ui}</ThemeProvider>
);

describe('PieChart', () => {
  const slices = [
    { key: 'a', label: 'app-a', group: 'Claude', value: 90, valueText: '90' },
    { key: 'b', label: 'app-b', group: 'Codex', value: 10, valueText: '10' },
    { key: 'z', label: 'app-z', group: 'Kimi', value: 0, valueText: '0' },
  ];
  const draw = () =>
    render(
      themed(
        <PieChart
          slices={slices}
          groupIndex={g => providerIndex(g, [])}
          title="Tokens"
          totalText="100 tokens"
        />
      )
    ).container;
  it('draws one slice for each value above 0 and lists every item, with no Other', () => {
    const c = draw();
    expect(c.querySelectorAll('[data-slice]')).toHaveLength(2);
    expect(c.querySelectorAll('[data-legend-row]')).toHaveLength(3);
    expect(c.textContent).not.toMatch(/\bother\b|\+\s*\d+\s*more/i);
    expect(
      c.querySelector('[data-scroll-area]')?.contains(c.querySelector('[data-pie-head]'))
    ).toBe(false);
  });
  it('shows the picked item above the pie', () => {
    const c = draw();
    fireEvent.click(c.querySelector('[data-legend-row="b"] button') as Element);
    expect(c.querySelector('[data-pie-head]')?.textContent).toContain('app-b: 10');
  });
});

describe('chart legends', () => {
  it('fits as many pie legend columns as the width allows, at least one', () => {
    expect(legendColumns(0)).toBe(1);
    expect(legendColumns(249)).toBe(1);
    expect(legendColumns(516)).toBe(2);
    expect(legendColumns(790)).toBe(3);
  });
  it('names the group in the tooltip of a pie legend row', () => {
    const c = render(
      themed(
        <PieChart
          slices={[{ key: 'a', label: 'app-a', group: 'Claude', value: 90, valueText: '90' }]}
          groupIndex={g => providerIndex(g, [])}
          title="Tokens"
          totalText="90 tokens"
        />
      )
    ).container;
    expect(c.querySelector('[data-legend-row="a"] button')?.getAttribute('title')).toContain(
      'app-a, Claude: 90'
    );
  });
  it('sizes the sunburst legend from its rows: nodes fill the columns row by row', () => {
    const node = (key: string, cats: number, capacity: number, used: number) => ({
      key,
      label: key,
      capacity,
      used,
      categories: Array.from({ length: cats }, (_, i) => ({
        key: `${key}${i}`,
        label: `${key}${i}`,
        value: 1,
      })),
    });
    // a: 1 + 2 lines, b: 1 + 1 lines + 1 free line, c: 1 line. 15 px a line, 7 px between rows.
    const nodes = [node('a', 2, 3, 3), node('b', 1, 5, 1), node('c', 0, 1, 1)];
    expect(legendHeight(nodes, 1)).toBe((3 + 3 + 1) * 15 + 2 * 7);
    expect(legendHeight(nodes, 2)).toBe(3 * 15 + 1 * 15 + 7);
    expect(legendHeight([], 2)).toBe(0);
  });
});

describe('agents sunburst chart', () => {
  it('shows the unit under the total and lists a named unknown segment in the legend', () => {
    const data = agentsToSunburst(
      panel('agents', [row('claude', 'unknown identity'), row('claude', 'unknown identity')]),
      null
    );
    const c = render(
      themed(<SunburstChart data={data} title="Agents" unit="agents" format={v => String(v)} />)
    ).container;
    expect(c.querySelector('[data-sunburst-centre]')?.textContent).toContain('2agents');
    expect(c.querySelector(`[data-legend-node="${POOL_NOT_REPORTED}"]`)?.textContent).toContain(
      IDENTITY_NOT_REPORTED
    );
  });
});

describe('agent rings: pool, identity, provider', () => {
  const agents = newAgents([
    tableRow('pool-alpha', 'red', 'claude', 'gateway-session'),
    tableRow('pool-alpha', 'red', 'claude', 'gateway-session'),
    tableRow('pool-alpha', 'blue', 'claude', 'gateway-session'),
    tableRow('', 'green', 'claude', 'config-dir'),
    tableRow('', 'solo', 'codex', 'config-dir'),
    tableRow('', 'team-oc', 'opencode', 'session-marker'),
    tableRow('', 'odd', 'frobnicator', 'config-dir'),
    tableRow('', '', '', 'unresolved'),
  ]);
  const data = agentsToSunburst(agents, null);
  const direct = data.nodes?.find(n => n.label === DIRECT);

  it('names the agents that are in no pool "Direct Identity"', () => {
    expect(DIRECT).toBe('Direct Identity');
    expect(data.nodes?.map(n => [n.label, n.used])).toEqual([
      [DIRECT, 4],
      ['pool-alpha', 3],
      [POOL_NOT_REPORTED, 1],
    ]);
  });
  it('puts the provider in the third ring, one slice for each identity and provider', () => {
    const pool = data.nodes?.find(n => n.label === 'pool-alpha');
    expect(pool?.categories.map(c => [c.label, c.value])).toEqual([
      ['red', 2],
      ['blue', 1],
    ]);
    expect(pool?.categories[0].children?.map(k => [k.key, k.label, k.value])).toEqual([
      ['red/Anthropic', 'Anthropic', 2],
    ]);
    const providers = (n: string) =>
      direct?.categories.find(c => c.label === n)?.children?.map(k => k.label);
    expect(providers('solo')).toEqual(['OpenAI']);
    expect(providers('green')).toEqual(['Anthropic']);
    expect(providers('team-oc')).toEqual(['OpenCode']);
  });
  it('keeps an unknown tool under its own name and gives a missing tool a named slice', () => {
    expect(providerOfTool('frobnicator')).toBe('frobnicator');
    expect(providerOfTool('')).toBe(PROVIDER_NOT_REPORTED);
    expect(providerOfTool(undefined)).toBe(PROVIDER_NOT_REPORTED);
    expect(providerOfTool('agent')).toBe(PROVIDER_NOT_REPORTED);
    const odd = direct?.categories.find(c => c.label === 'odd');
    expect(odd?.children?.map(k => k.label)).toEqual(['frobnicator']);
    const none = data.nodes?.find(n => n.label === POOL_NOT_REPORTED);
    expect(none?.categories[0].label).toBe(IDENTITY_NOT_REPORTED);
    expect(none?.categories[0].children?.map(k => k.label)).toEqual([PROVIDER_NOT_REPORTED]);
  });
  it('maps every tool of the feed to its provider', () => {
    const pairs: Array<[string, string]> = [
      ['claude', 'Anthropic'],
      ['codex', 'OpenAI'],
      ['grok', 'xAI'],
      ['kimi', 'Kimi'],
      ['zai', 'Z.ai'],
      ['ali', 'Alibaba'],
      ['opencode', 'OpenCode'],
      ['pi', 'Pi'],
    ];
    for (const [tool, provider] of pairs) expect(providerOfTool(tool)).toBe(provider);
  });
  it('gives several tools of one provider one slice, and names the tools in its note', () => {
    const d = agentsToSunburst(
      newAgents([
        tableRow('', 'x', 'claude', 'config-dir'),
        tableRow('', 'x', 'claude', 'config-dir'),
        tableRow('', 'x', 'anthropic', 'config-dir'),
      ]),
      null
    );
    const kids = d.nodes?.[0].categories[0].children;
    expect(kids?.map(k => [k.label, k.value])).toEqual([['Anthropic', 3]]);
    expect(kids?.[0].detail).toMatch(/^tools claude 2, anthropic 1/);
  });
  it('has no Other slice and the ring sizes add up to the agent count', () => {
    expect(JSON.stringify(data)).not.toMatch(/other|more/i);
    const sum = (xs: Array<{ value: number }> = []) => xs.reduce((s, x) => s + x.value, 0);
    for (const n of data.nodes ?? []) {
      expect(sum(n.categories)).toBe(n.used);
      for (const c of n.categories) expect(sum(c.children)).toBe(c.value);
    }
    expect(data.capacity).toBe(8);
  });
});

/** The arc of a kind and a key. The selector is built here, so no test line holds a quoted key. */
const arcOf = (c: HTMLElement, kind: string, key: string): Element | undefined =>
  Array.from(c.querySelectorAll(`[data-arc=${kind}]`)).find(
    e => e.getAttribute('data-key') === key
  );

describe('agent rings: tooltip path', () => {
  const data = agentsToSunburst(
    newAgents([
      tableRow('pool-alpha', 'red', 'claude', 'gateway-session'),
      tableRow('pool-alpha', 'red', 'claude', 'gateway-session'),
      tableRow('', 'solo', 'codex', 'config-dir'),
    ]),
    null
  );
  const draw = (extra: Record<string, unknown> = {}) =>
    render(
      themed(
        <SunburstChart
          data={data}
          title="Agents"
          unit="agents"
          format={v => String(v)}
          pathSeparator=" > "
          legendChildren
          tooltip
          {...extra}
        />
      )
    ).container;

  it('shows the full path and the count of a provider slice on hover', () => {
    const c = draw();
    const arc = arcOf(c, 'child', 'red/Anthropic');
    expect(arc).toBeDefined();
    expect(c.querySelector('[data-sunburst-tooltip]')).toBeNull();
    fireEvent.mouseEnter(arc!);
    const tip = c.querySelector('[data-sunburst-tooltip]');
    expect(tip?.textContent).toContain('pool-alpha > red > Anthropic');
    expect(tip?.textContent).toContain('2 agents (67%)');
    fireEvent.mouseLeave(arc!);
    expect(c.querySelector('[data-sunburst-tooltip]')).toBeNull();
  });
  it('shows the path of a direct identity slice and of a pool', () => {
    const c = draw();
    fireEvent.mouseEnter(arcOf(c, 'child', 'solo/OpenAI')!);
    expect(c.querySelector('[data-sunburst-tooltip]')?.textContent).toContain(
      'Direct Identity > solo > OpenAI'
    );
    fireEvent.mouseEnter(arcOf(c, 'node', 'pool-alpha')!);
    expect(c.querySelector('[data-sunburst-tooltip]')?.textContent).toContain('pool-alpha');
  });
  it('shows the path on a tap in kiosk mode', () => {
    const c = draw({ kiosk: true });
    fireEvent.click(arcOf(c, 'child', 'red/Anthropic')!);
    expect(c.querySelector('[data-sunburst-tooltip]')?.textContent).toContain(
      'pool-alpha > red > Anthropic'
    );
  });
  it('writes the path in the screen reader label of every arc, and has no native title', () => {
    const c = draw();
    const labels = Array.from(c.querySelectorAll('[data-arc]')).map(a =>
      a.getAttribute('aria-label')
    );
    expect(labels).toContain(
      'pool-alpha > red > Anthropic: 2 agents (67%), identity source gateway-session'
    );
    expect(labels).toContain(
      'Direct Identity > solo > OpenAI: 1 agent (33%), identity source config-dir'
    );
    expect(c.querySelectorAll('svg path title').length).toBe(0);
  });
  it('lists pool, identity and provider in the legend, and names the identities on the ring', () => {
    const c = draw({ ringLabels: true });
    const rows = Array.from(c.querySelectorAll('[data-legend-row]')).map(r =>
      r.getAttribute('data-legend-row')
    );
    expect(rows).toEqual([
      'pool-alpha',
      'pool-alpha/red',
      'pool-alpha/red/red/Anthropic',
      'Direct Identity',
      'Direct Identity/solo',
      'Direct Identity/solo/solo/OpenAI',
    ]);
    expect(c.querySelector('[data-ring-label="category"]')?.textContent).toBeTruthy();
  });
});

describe('agent ring colours', () => {
  const data = agentsToSunburst(
    newAgents([
      tableRow('pool-b', 'a', 'claude', 'x'),
      tableRow('pool-b', 'b', 'claude', 'x'),
      tableRow('pool-b', 'c', 'claude', 'x'),
      tableRow('pool-a', 'd', 'codex', 'x'),
      tableRow('', 'e', 'opencode', 'x'),
      tableRow('', '', '', 'unresolved'),
    ]),
    null
  );
  const nodes = data.nodes ?? [];
  const ref = (kind: 'node' | 'category' | 'child', nodeKey: string, key: string) => ({
    kind,
    nodeKey,
    categoryKey: kind === 'node' ? '' : key.split('/')[0],
    key,
  });
  for (const mode of ['dark', 'light'] as const) {
    it(`keeps the hue of a pool, shades its identities and uses the provider colour (${mode})`, () => {
      const paint = agentPaint(nodes, mode);
      const pool = paint(ref('node', 'pool-b', 'pool-b'))!;
      const shades = ['a', 'b', 'c'].map(k => paint(ref('category', 'pool-b', k))!.fill);
      expect(new Set(shades).size).toBe(3);
      expect(shades).not.toContain(pool.fill);
      // A provider has one colour, whatever the pool is.
      const anthropic = paint(ref('child', 'pool-b', 'a/Anthropic'))!.fill;
      expect(paint(ref('child', 'pool-b', 'b/Anthropic'))!.fill).toBe(anthropic);
      expect(paint(ref('child', 'pool-a', 'd/OpenAI'))!.fill).not.toBe(anthropic);
      // A pool keeps its colour when another pool appears (the names sort, not the sizes).
      expect(paint(ref('node', 'pool-a', 'pool-a'))!.fill).not.toBe(pool.fill);
    });
    it(`gives each arc an ink that reads on its fill (${mode})`, () => {
      const paint = agentPaint(nodes, mode);
      for (const n of nodes) {
        const all = [
          paint(ref('node', n.key, n.key))!,
          ...n.categories.flatMap(c => [
            paint(ref('category', n.key, c.key))!,
            ...(c.children ?? []).map(k => paint(ref('child', n.key, k.key))!),
          ]),
        ];
        for (const p of all) {
          const l = brightness(p.fill);
          const li = brightness(p.ink);
          const ratio = (Math.max(l, li) + 0.05) / (Math.min(l, li) + 0.05);
          expect(ratio).toBeGreaterThan(4.4);
        }
      }
    });
  }
  it('paints Direct Identity and the not reported names grey', () => {
    const paint = agentPaint(nodes, 'dark');
    const direct = paint(ref('node', DIRECT, DIRECT))!.fill;
    expect(direct).toBe('#A7ADB5');
    expect(paint(ref('node', POOL_NOT_REPORTED, POOL_NOT_REPORTED))!.fill).toBe('#6E747D');
  });
  it('mixes colours and picks the ink', () => {
    expect(mixColour('#000000', '#ffffff', 50)).toBe('#808080');
    expect(inkOn('#000000')).toBe('#ffffff');
    expect(inkOn('#ffffff')).toBe('#111111');
    expect(identityShade('#336699', 0, 'dark')).not.toBe(identityShade('#336699', 1, 'dark'));
  });
});
