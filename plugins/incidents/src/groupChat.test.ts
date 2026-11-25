import { describe, expect, it } from 'vitest';
import {
  chatContextKey,
  GROUP_FULL_DETAIL,
  GROUP_SUMMARY_LIMIT,
  groupChatRequest,
  groupFocus,
  incidentFocus,
  newestFirst,
  parseSelectionFocus,
  resolveSelection,
  sameSelection,
  SelectedGroup,
} from './groupChat';
import { DiagnosisSummary } from './model';

const d = (
  id: string,
  alertName: string,
  over: Partial<DiagnosisSummary> = {}
): DiagnosisSummary => ({
  id,
  createdAt: `2026-11-25T10:${id.padStart(2, '0').slice(-2)}:00Z`,
  status: 'done',
  source: 'alertmanager',
  alertName,
  severity: 'warning',
  likelyCause: 'cause',
  confidence: 'high',
  resolved: false,
  ...over,
});

describe('the focus segments of a selection', () => {
  it('names one incident or one group, and nothing else', () => {
    expect(parseSelectionFocus(incidentFocus('d1'))).toEqual({ kind: 'incident', key: 'd1' });
    expect(parseSelectionFocus(groupFocus('High CPU'))).toEqual({
      kind: 'group',
      key: 'High CPU',
    });
    expect(parseSelectionFocus([])).toBeNull();
    expect(parseSelectionFocus(undefined)).toBeNull();
    expect(parseSelectionFocus(['incident'])).toBeNull();
    expect(parseSelectionFocus(['group', ''])).toBeNull();
    expect(parseSelectionFocus(['other', 'x'])).toBeNull();
    expect(parseSelectionFocus(['group', 'a', 'b'])).toBeNull();
  });
});

describe('resolving a selection against the rows', () => {
  const rows = [
    d('1', 'HighCPU', { severity: 'critical' }),
    d('2', 'HighCPU', { resolved: true }),
    d('3', 'HighCPU'),
    d('4', 'DiskFull'),
  ];
  const open = rows.filter(r => !r.resolved);

  it('holds every incident of the group that the view shows, newest first', () => {
    const sel = resolveSelection(groupFocus('HighCPU'), rows, open, true);
    expect(sel).toEqual({
      kind: 'group',
      name: 'HighCPU',
      ids: ['3', '1'],
      worst: 'critical',
      view: 'open',
    });
  });
  it('follows the Hide resolved setting: the resolved incident joins the group when the view shows it', () => {
    const sel = resolveSelection(groupFocus('HighCPU'), rows, rows, false) as SelectedGroup;
    expect(sel.ids).toEqual(['3', '2', '1']);
    expect(sel.view).toBe('all');
  });
  it('finds a single incident among all rows, so a link to a resolved one still works', () => {
    expect(resolveSelection(incidentFocus('2'), rows, open, true)).toEqual({
      kind: 'incident',
      id: '2',
      alertName: 'HighCPU',
    });
  });
  it('gives null for an incident or a group that is not there', () => {
    expect(resolveSelection(incidentFocus('zz'), rows, open, true)).toBeNull();
    expect(resolveSelection(groupFocus('Gone'), rows, open, true)).toBeNull();
    // A group whose incidents are all resolved is not in the open view.
    expect(
      resolveSelection(groupFocus('Old'), [d('9', 'Old', { resolved: true })], [], true)
    ).toBeNull();
    expect(resolveSelection([], rows, open, true)).toBeNull();
  });
  it('orders by time, newest first, and keeps the row order for equal times', () => {
    const a = d('5', 'A', { createdAt: '2026-11-25T10:00:00Z' });
    const b = d('6', 'A', { createdAt: '2026-11-25T10:00:00Z' });
    const c = d('7', 'A', { createdAt: '2026-11-25T11:00:00Z' });
    expect(newestFirst([a, b, c]).map(x => x.id)).toEqual(['7', '5', '6']);
  });
});

describe('selection equality and chat context', () => {
  const group = (ids: string[], view: 'open' | 'all' = 'open'): SelectedGroup => ({
    kind: 'group',
    name: 'A',
    ids,
    worst: 'warning',
    view,
  });
  it('treats equal selections as one, so nothing rerenders', () => {
    expect(sameSelection(group(['1', '2']), group(['1', '2']))).toBe(true);
    expect(sameSelection(group(['1', '2']), group(['2', '1']))).toBe(false);
    expect(sameSelection(group(['1']), group(['1'], 'all'))).toBe(false);
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection(null, group([]))).toBe(false);
    expect(
      sameSelection(
        { kind: 'incident', id: '1', alertName: 'A' },
        { kind: 'incident', id: '1', alertName: 'A' }
      )
    ).toBe(true);
    expect(sameSelection({ kind: 'incident', id: '1', alertName: 'A' }, group(['1']))).toBe(false);
  });
  it('keeps one chat for each context, so a new incident in a group does not empty the chat', () => {
    expect(chatContextKey(null)).toBe('');
    expect(chatContextKey({ kind: 'incident', id: 'd1', alertName: 'A' })).toBe('d1');
    expect(chatContextKey(group(['1']))).toBe(chatContextKey(group(['1', '2'])));
    expect(chatContextKey(group(['1']))).not.toBe(chatContextKey(group(['1'], 'all')));
  });
});

describe('the payload for a group', () => {
  const group = (n: number): SelectedGroup => ({
    kind: 'group',
    name: 'KubePodCrashLooping',
    ids: Array.from({ length: n }, (_, i) => `d${i}`),
    worst: 'critical',
    view: 'open',
  });

  it('sends a small group as full incidents with the group name, and no short list', () => {
    expect(groupChatRequest(group(3))).toEqual({
      diagnosisIds: ['d0', 'd1', 'd2'],
      groupName: 'KubePodCrashLooping',
    });
    expect(groupChatRequest(group(GROUP_FULL_DETAIL)).summaryIds).toBeUndefined();
  });
  it('sends the newest incidents in full and the next ones as short lines', () => {
    const req = groupChatRequest(group(GROUP_FULL_DETAIL + 25));
    expect(req.diagnosisIds).toEqual(Array.from({ length: GROUP_FULL_DETAIL }, (_, i) => `d${i}`));
    expect(req.summaryIds).toHaveLength(25);
    expect(req.summaryIds![0]).toBe(`d${GROUP_FULL_DETAIL}`);
    expect(req.groupOmitted).toBeUndefined();
  });
  it('counts what a very large group leaves out', () => {
    const req = groupChatRequest(group(GROUP_FULL_DETAIL + GROUP_SUMMARY_LIMIT + 40));
    expect(req.diagnosisIds).toHaveLength(GROUP_FULL_DETAIL);
    expect(req.summaryIds).toHaveLength(GROUP_SUMMARY_LIMIT);
    expect(req.groupOmitted).toBe(40);
    // Every incident is in exactly one place: full, short line, or counted.
    const all = new Set([...req.diagnosisIds, ...req.summaryIds!]);
    expect(all.size).toBe(GROUP_FULL_DETAIL + GROUP_SUMMARY_LIMIT);
  });
});
