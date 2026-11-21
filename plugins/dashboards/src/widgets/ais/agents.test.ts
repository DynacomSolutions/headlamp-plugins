import { describe, expect, it } from 'vitest';
import { parsePanel } from '../panels/model';
import { agentCount, agentTable, servingByPool } from './agents';

const COLUMNS = [
  { key: 'pool', label: 'Pool', align: 'left' },
  { key: 'identity', label: 'Identity', align: 'left' },
  { key: 'tool', label: 'Tool', align: 'left' },
  { key: 'identitySource', label: 'Source', align: 'left' },
  { key: 'age', label: 'Age', align: 'right' },
];
const rec = (pool: string, identity: string, tool: string, identitySource: string) => ({
  pool,
  identity,
  tool,
  identitySource,
  age: '1h 2m',
});
const newPanel = (rows: ReturnType<typeof rec>[], withRows = true) =>
  parsePanel({
    version: 1,
    id: 'agents',
    title: 'Agents',
    status: 'ok',
    summary: '',
    stats: [{ label: 'claude', value: String(rows.length * 2), status: 'ok' }],
    // The row fields are unknown to the parser. It drops them. The table keeps the data.
    rows: withRows
      ? rows.map(r => ({
          label: r.tool,
          detail: r.pool ? `${r.pool} / ${r.identity}` : r.identity,
          value: r.age,
          status: 'ok',
          tool: r.tool,
          pool: r.pool,
          identity: r.identity,
          identitySource: r.identitySource,
        }))
      : [],
    tables: [{ title: 'Agents', columns: COLUMNS, rows }],
  });
const oldPanel = parsePanel({
  version: 1,
  id: 'agents',
  title: 'Agents',
  status: 'ok',
  summary: '',
  stats: [{ label: 'claude', value: '4', status: 'ok' }],
  rows: [
    { label: 'claude', detail: 'pool-x', value: '1h', status: 'ok' },
    { label: 'claude', detail: 'unknown identity', value: '1h', status: 'ok' },
  ],
});

describe('agentTable', () => {
  it('reads the records of the Agents table', () => {
    const t = agentTable(newPanel([rec('pool-x', 'red', 'claude', 'gateway-ledger')]));
    expect(t).toEqual([
      { pool: 'pool-x', identity: 'red', tool: 'claude', source: 'gateway-ledger', age: '1h 2m' },
    ]);
  });
  it('turns an empty pool or identity into null', () => {
    const t = agentTable(newPanel([rec('', '', 'codex', 'unresolved')]));
    expect(t?.[0]).toMatchObject({ pool: null, identity: null, source: 'unresolved' });
  });
  it('is null for an older source with no table, and null for no panel', () => {
    expect(agentTable(oldPanel)).toBeNull();
    expect(agentTable(null)).toBeNull();
  });
  it('is an empty list for an empty table: the source said that no agent runs', () => {
    expect(agentTable(newPanel([], false))).toEqual([]);
  });
});

describe('agentCount', () => {
  it('counts the table records, not the stat sum', () => {
    const p = newPanel([rec('', 'red', 'claude', 'session-marker')]);
    expect(agentCount(p)).toBe(1);
  });
  it('counts the rows of an older source, and uses the stats for a panel with no rows', () => {
    expect(agentCount(oldPanel)).toBe(2);
    expect(
      agentCount(
        parsePanel({
          version: 1,
          id: 'agents',
          stats: [{ label: 'a', value: '40', status: 'ok' }],
          rows: [],
        })
      )
    ).toBe(40);
    expect(agentCount(null)).toBe(0);
  });
});

describe('servingByPool', () => {
  it('lists the members that the gateway served, once each, by pool', () => {
    const p = newPanel([
      rec('pool-x', 'red', 'claude', 'gateway-ledger'),
      rec('pool-x', 'red', 'claude', 'gateway-ledger'),
      rec('pool-x', 'blue', 'claude', 'gateway-ledger'),
      rec('pool-y', 'green', 'claude', 'pool-active'),
      rec('', 'solo', 'codex', 'session-marker'),
    ]);
    expect(Array.from(servingByPool(p))).toEqual([['pool-x', ['red', 'blue']]]);
  });
  it('is empty for an older source', () => {
    expect(servingByPool(oldPanel).size).toBe(0);
  });
});
