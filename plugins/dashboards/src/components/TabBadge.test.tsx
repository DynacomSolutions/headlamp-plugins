import { describe, expect, it } from 'vitest';
import { migrateSpec } from '../spec/model';
import { badgeCount } from './TabBadge';

const panel = (summary: string, stats: Array<{ label: string; value: string }> = []) =>
  ({ summary, stats: stats.map(s => ({ ...s, status: 'ok' })) } as never);

describe('tab badge', () => {
  it('counts the leading number of the summary', () => {
    expect(badgeCount(panel('64 open, 256 resolved'))).toBe(64);
    expect(badgeCount(panel('No open incidents'))).toBe(0);
    expect(badgeCount(panel('0 open'))).toBe(0);
    expect(badgeCount(null)).toBe(0);
  });
  it('counts a named stat when the badge names one', () => {
    expect(badgeCount(panel('x', [{ label: 'Open', value: '7' }]), 'open')).toBe(7);
    expect(badgeCount(panel('9 x', [{ label: 'Open', value: '7' }]), 'Failed')).toBe(0);
  });
  it('keeps a good badge in the spec and drops a bad one', () => {
    const spec = (badge: unknown) =>
      migrateSpec({
        version: 3,
        title: 'T',
        tabs: [{ id: 't', label: 'T', icon: 'mdi:alert-circle-outline', badge, sections: [] }],
      }).spec.tabs[0];
    expect(spec({ source: 'agent', panel: 'incidents' }).badge).toEqual({
      source: 'agent',
      panel: 'incidents',
    });
    expect(spec({ source: 'agent', panel: 'incidents', stat: 'Open' }).badge?.stat).toBe('Open');
    expect(spec({ source: '', panel: 'x' }).badge).toBeUndefined();
    expect(spec('x').badge).toBeUndefined();
  });
});
