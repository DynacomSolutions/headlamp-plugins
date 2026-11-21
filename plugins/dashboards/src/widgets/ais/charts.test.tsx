import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePanel } from '../panels/model';
import { PieChart } from '../sunburst/PieChart';
import { SunburstChart } from '../sunburst/SunburstChart';
import {
  agentPlacement,
  agentsToSunburst,
  DIRECT,
  gatewaySlices,
  IDENTITY_NOT_REPORTED,
  parseTokens,
  POOL_NOT_REPORTED,
  poolMembers,
  providerIndex,
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
