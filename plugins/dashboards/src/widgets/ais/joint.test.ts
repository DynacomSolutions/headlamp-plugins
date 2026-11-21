import { describe, expect, it } from 'vitest';
import { parsePanel } from '../panels/model';
import { formatReset, lineDetails, poolSub } from './AisView';
import { type AisIdentity, type AisLimit, joinAis, jointLimits } from './join';

const limit = (name: string, fraction: number, extra: Partial<AisLimit> = {}): AisLimit => ({
  name,
  value: `${Math.round(fraction * 100)}%`,
  fraction,
  status: 'ok',
  ...extra,
});
const member = (name: string, limits: AisLimit[]): AisIdentity => ({
  key: `anthropic/${name}`,
  name,
  provider: 'Anthropic',
  limits,
  active: false,
  status: 'ok',
});
const byName = (j: ReturnType<typeof jointLimits>, name: string) =>
  j.limits.find(l => l.name === name);

describe('jointLimits', () => {
  it('gives every member one equal share: the mean of the shares', () => {
    const j = jointLimits([
      member('a', [limit('Weekly', 1)]),
      member('b', [limit('Weekly', 0.5)]),
      member('c', [limit('Weekly', 0)]),
      member('d', [limit('Weekly', 0.5)]),
    ]);
    expect(byName(j, 'Weekly')?.fraction).toBe(0.5);
    expect(byName(j, 'Weekly')?.value).toBe('50%');
    expect(byName(j, 'Weekly')?.basis).toBe('share');
    expect(byName(j, 'Weekly')?.reporting).toBe(4);
    expect(j.members).toBe(4);
    expect(j.reporting).toBe(4);
  });

  it('counts only the members that report a window', () => {
    const j = jointLimits([
      member('a', [limit('Weekly', 0.6), limit('Weekly (Fable)', 1)]),
      member('b', [limit('Weekly', 0.2)]),
      member('c', []),
    ]);
    expect(byName(j, 'Weekly')?.fraction).toBeCloseTo(0.4);
    expect(byName(j, 'Weekly')?.reporting).toBe(2);
    // One member reports this window, so it is the whole joint value, not a third of it.
    expect(byName(j, 'Weekly (Fable)')?.fraction).toBe(1);
    expect(byName(j, 'Weekly (Fable)')?.reporting).toBe(1);
    expect(j.members).toBe(3);
    expect(j.reporting).toBe(2);
  });

  it('keeps the display order of the windows and drops a window that nobody reports', () => {
    const j = jointLimits([
      member('a', [limit('Monthly', 0.1), limit('Weekly', 0.1), limit('5-hour', 0.1)]),
      member('b', [{ name: 'Daily', value: '', status: 'ok' }]),
    ]);
    expect(j.limits.map(l => l.name)).toEqual(['5-hour', 'Weekly', 'Monthly']);
  });

  it('uses sum(used) / sum(limit) when every reporting member gives absolute values', () => {
    const j = jointLimits([
      member('a', [limit('Weekly', 1, { used: 100, cap: 100 })]),
      member('b', [limit('Weekly', 0.1, { used: 10, cap: 400 })]),
      member('c', [limit('Weekly', 0)]),
    ]);
    // Member c has no value, so it does not count. 110 / 500 = 0.22, not the mean share of 0.55.
    expect(byName(j, 'Weekly')?.reporting).toBe(3);
    expect(byName(j, 'Weekly')?.basis).toBe('share');
    const k = jointLimits([
      member('a', [limit('Weekly', 1, { used: 100, cap: 100 })]),
      member('b', [limit('Weekly', 0.025, { used: 10, cap: 400 })]),
    ]);
    expect(byName(k, 'Weekly')?.basis).toBe('absolute');
    expect(byName(k, 'Weekly')?.fraction).toBeCloseTo(110 / 500);
    expect(byName(k, 'Weekly')?.value).toBe('22%');
  });

  it('takes the earliest reset: that window frees capacity first', () => {
    const j = jointLimits([
      member('a', [limit('Weekly', 0.5, { resetsAt: '2026-11-25T10:00:00Z' })]),
      member('b', [limit('Weekly', 0.5, { resetsAt: '2026-11-23T08:30:00Z' })]),
      member('c', [limit('Weekly', 0.5, { resetsAt: 'not a time' })]),
      member('d', [limit('Weekly', 0.5)]),
    ]);
    expect(byName(j, 'Weekly')?.resetsAt).toBe('2026-11-23T08:30:00Z');
    expect(jointLimits([member('a', [limit('Weekly', 0.5)])]).limits[0].resetsAt).toBeUndefined();
  });

  it('follows the member thresholds for the status: warning from 80 %, critical from 95 %', () => {
    const status = (f: number) => jointLimits([member('a', [limit('Weekly', f)])]).status;
    expect(status(0.79)).toBe('ok');
    expect(status(0.8)).toBe('warn');
    expect(status(0.95)).toBe('crit');
    // The joint status is the worst window.
    const j = jointLimits([member('a', [limit('Weekly', 0.1), limit('Monthly', 0.97)])]);
    expect(j.status).toBe('crit');
    expect(jointLimits([member('a', [])]).status).toBe('unknown');
  });

  it('is empty for no member', () => {
    expect(jointLimits([])).toEqual({ members: 0, reporting: 0, limits: [], status: 'unknown' });
  });
});

describe('joint usage from the panels', () => {
  const row = (label: string, detail: string, f: number, meta?: Record<string, string>) => ({
    label,
    detail,
    value: `${Math.round(f * 100)}%`,
    fraction: f,
    status: 'ok',
    ...(meta ? { meta } : {}),
  });
  const panel = (id: string, rows: unknown[]) =>
    parsePanel({ version: 1, id, title: id, status: 'ok', summary: '', stats: [], rows });
  const swapRow = (name: string) => ({
    label: `pool / ${name}`,
    detail: 'Standby, weekly',
    value: '0%',
    status: 'ok',
  });

  it('reads used, limit and resetsAt from the row meta', () => {
    const m = joinAis({
      limits: panel('limits', [
        row('Anthropic / a', 'Weekly', 1, {
          used: '100',
          limit: '100',
          resetsAt: '2026-11-24T00:00:00Z',
        }),
        row('Anthropic / b', 'Weekly', 0.025, {
          used: '10',
          limit: '400',
          resetsAt: '2026-11-23T00:00:00Z',
        }),
      ]),
      swap: panel('claude-swap', [swapRow('a'), swapRow('b'), swapRow('c')]),
    });
    const j = m.groups[0].joint;
    expect(j?.members).toBe(3);
    const weekly = j?.limits.find(l => l.name === 'Weekly');
    expect(weekly?.basis).toBe('absolute');
    expect(weekly?.value).toBe('22%');
    expect(weekly?.resetsAt).toBe('2026-11-23T00:00:00Z');
    // Member c has no limit row and no swap value: it is in the pool but does not report.
    expect(weekly?.reporting).toBe(2);
    expect(j?.reporting).toBe(2);
  });

  it('ignores a bad used or limit value', () => {
    const m = joinAis({
      limits: panel('limits', [row('Anthropic / a', 'Weekly', 0.5, { used: 'x', limit: '0' })]),
      swap: panel('claude-swap', [swapRow('a')]),
    });
    const weekly = m.groups[0].joint?.limits[0];
    expect(weekly?.basis).toBe('share');
    expect(weekly?.value).toBe('50%');
  });
});

describe('the text of a pool line', () => {
  const joint = jointLimits([
    member('a', [limit('Weekly', 0.6, { resetsAt: '2026-11-23T08:30:00Z' })]),
    member('b', []),
  ]);
  it('says how many members report when not all do', () => {
    expect(poolSub(joint)).toBe('Pool total, 1 of 2 members report');
    expect(poolSub(jointLimits([member('a', [limit('Weekly', 0.1)])]))).toBe(
      'Pool total, 1 member'
    );
  });
  it('lists every window with its reporters and reset in the tooltip', () => {
    const pool = member('pool-x', joint.limits);
    expect(lineDetails(pool, ['Weekly'], joint)).toEqual([
      'pool-x: Pool total, 2 members',
      '1 of 2 members report',
      'Weekly: 60%, 1 of 2 members report, resets 2026-11-23 08:30 UTC',
    ]);
  });
  it('marks a window that a member does not report', () => {
    const a = member('a', [limit('Weekly', 0.4)]);
    a.login = { status: 'warn', word: 'Expiring', detail: 'Expires soon' };
    expect(lineDetails(a, ['Weekly', 'Monthly'])).toEqual([
      'Anthropic / a',
      'Login: Expiring',
      'Weekly: 40%',
      'Monthly: no data',
    ]);
  });
  it('writes a reset for people, and keeps text that is not a time', () => {
    expect(formatReset('2026-11-22T14:00:00+07:00')).toBe('2026-11-22 07:00 UTC');
    expect(formatReset('in 3 hours')).toBe('in 3 hours');
  });
});
