import { describe, expect, it } from 'vitest';
import { CONFIG, LAUNCH, SUMMARY } from './launch.fixture';
import {
  elapsed,
  fixCitesPlan,
  formatDuration,
  isFinalLaunch,
  isLiveLaunch,
  LAUNCH_STATUSES,
  launchElapsed,
  parseLaunch,
  parseLaunchConfig,
  parseLaunches,
  searchWithStatus,
  statusFilter,
  statusMeta,
} from './launch-model';
import { parseDetail } from './model';

describe('status pill mapping', () => {
  it('gives every status a label, a colour and an icon', () => {
    expect(LAUNCH_STATUSES.map(s => [s, statusMeta(s).label, statusMeta(s).colour])).toEqual([
      ['pending_approval', 'Pending approval', 'warning'],
      ['launching', 'Launching', 'info'],
      ['running', 'Running', 'info'],
      ['waiting', 'Waiting', 'warning'],
      ['completed', 'Completed', 'success'],
      ['failed', 'Failed', 'error'],
      ['rejected', 'Rejected', 'default'],
      ['cancelled', 'Cancelled', 'default'],
    ]);
    for (const s of LAUNCH_STATUSES) expect(statusMeta(s).icon).toMatch(/^mdi:/);
  });

  it('shows a spinner only while the agent works', () => {
    expect(LAUNCH_STATUSES.filter(s => statusMeta(s).busy)).toEqual(['launching', 'running']);
  });

  it('splits final and live states', () => {
    expect(LAUNCH_STATUSES.filter(isFinalLaunch)).toEqual([
      'completed',
      'failed',
      'rejected',
      'cancelled',
    ]);
    expect(LAUNCH_STATUSES.filter(isLiveLaunch)).toEqual(['launching', 'running', 'waiting']);
  });
});

describe('time', () => {
  it('formats durations', () => {
    expect([0, 5000, 65000, 3_725_000].map(formatDuration)).toEqual([
      '0 s',
      '5 s',
      '1 min 5 s',
      '1 h 2 min',
    ]);
  });

  it('counts up to now while a step runs and stops at the end', () => {
    const now = Date.parse('2026-11-20T07:01:00.000Z');
    expect(elapsed('2026-11-20T07:00:00.000Z', undefined, now)).toBe('1 min 0 s');
    expect(elapsed('2026-11-20T07:00:00.000Z', '2026-11-20T07:00:30.000Z', now)).toBe('30 s');
    expect(elapsed(undefined, undefined, now)).toBe('');
  });

  it('shows no launch time before the launch starts', () => {
    const now = Date.parse('2026-11-20T07:01:12.000Z');
    expect(launchElapsed(parseLaunch({ ...LAUNCH, status: 'pending_approval' }), now)).toBe('');
    expect(launchElapsed(parseLaunch(LAUNCH), now)).toBe('1 min 0 s');
    expect(
      launchElapsed(
        parseLaunch({ ...LAUNCH, status: 'completed', finishedAt: '2026-11-20T07:00:42.000Z' }),
        now
      )
    ).toBe('30 s');
  });
});

describe('parsers', () => {
  it('parses a launch with its timeline and reply', () => {
    const l = parseLaunch(LAUNCH);
    expect(l).toMatchObject({
      id: 'l1',
      status: 'running',
      diagnosisId: 'd1',
      fixTitle: 'Apply the DNS placement plan',
      threadId: 'thread-1',
    });
    expect(l.timeline.map(e => e.kind)).toEqual(['run', 'message', 'tool', 'file_change', 'tool']);
    expect(l.lastReply).toContain('checked');
  });

  it('falls back for unknown values and sorts the list newest first', () => {
    expect(parseLaunch({ id: 'x', status: 'strange' }).status).toBe('pending_approval');
    const list = parseLaunches({
      launches: [
        { ...SUMMARY, id: 'a', requestedAt: '2026-11-20T01:00:00Z' },
        { ...SUMMARY, id: 'b', requestedAt: '2026-11-20T02:00:00Z' },
        { requestedAt: 'x' },
      ],
    });
    expect(list.map(l => l.id)).toEqual(['b', 'a']);
    expect(list[0].steps).toBe(5);
  });

  it('parses the config', () => {
    expect(parseLaunchConfig(CONFIG).projects).toHaveLength(2);
    expect(parseLaunchConfig({ enabled: false, reason: 'T3_URL is not set' })).toMatchObject({
      enabled: false,
      reason: 'T3_URL is not set',
      projects: [],
    });
  });

  it('reads the fixes and the DNS plan fact ids from a diagnosis', () => {
    const d = parseDetail({
      id: 'd1',
      status: 'done',
      alert: { name: 'DnsDrift' },
      result: { fixes: [{ title: 'Move records', detail: 'x', recommended: true }, { title: '' }] },
      evidence: [
        { id: 'e1', tool: 'dns_placement_status', ok: true },
        { id: 'e2', tool: 'dns_placement_plan', ok: true },
        { id: 'e3', tool: 'dns_placement_plan', ok: false },
      ],
    });
    expect(d.alertName).toBe('DnsDrift');
    expect(d.fixes).toEqual([
      { title: 'Move records', detail: 'x', command: undefined, recommended: true },
    ]);
    expect(d.planFactIds).toEqual(['e2']);
  });
});

describe('fixes and filter', () => {
  it('knows when a fix is about the DNS plan', () => {
    expect(fixCitesPlan({ title: 'Move records' }, [])).toBe(false);
    expect(fixCitesPlan({ title: 'Restart the pod' }, ['e2'])).toBe(false);
    expect(fixCitesPlan({ title: 'Use dns_placement_plan' }, ['e2'])).toBe(true);
    expect(fixCitesPlan({ title: 'Move', detail: 'see e2' }, ['e2'])).toBe(true);
    expect(fixCitesPlan({ title: 'Fix the DNS records' }, ['e2'])).toBe(true);
  });

  it('reads and writes the status filter in the query string', () => {
    expect(statusFilter('?status=running')).toBe('running');
    expect(statusFilter('?status=nope')).toBeNull();
    expect(statusFilter('')).toBeNull();
    expect(searchWithStatus('', 'failed')).toBe('?status=failed');
    expect(searchWithStatus('?status=failed&x=1', null)).toBe('?x=1');
    expect(searchWithStatus('?status=failed', null)).toBe('');
  });
});
