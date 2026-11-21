import { describe, expect, it } from 'vitest';
import { DiagnosisSummary } from './model';
import {
  clearShown,
  DEFAULT_LIST_QUERY,
  listQueryString,
  matchesText,
  MAX_CHAT_INCIDENTS,
  parseListQuery,
  pruneIds,
  rangeIds,
  selectAllIds,
  toggleId,
} from './multiselect';

const order = ['a', 'b', 'c', 'd', 'e'];

describe('toggleId', () => {
  it('adds an incident and removes it on the second call', () => {
    const one = toggleId([], 'b');
    expect(one).toEqual({ ids: ['b'], capped: false });
    expect(toggleId(one.ids, 'b').ids).toEqual([]);
  });
  it('keeps the order in which the user chose', () => {
    expect(toggleId(toggleId([], 'c').ids, 'a').ids).toEqual(['c', 'a']);
  });
  it('stops at the cap and says so, but still lets the user remove one', () => {
    const full = Array.from({ length: MAX_CHAT_INCIDENTS }, (_, i) => `i${i}`);
    expect(toggleId(full, 'extra')).toEqual({ ids: full, capped: true });
    expect(toggleId(full, 'i3').ids).toHaveLength(MAX_CHAT_INCIDENTS - 1);
  });
});

describe('rangeIds', () => {
  it('selects the rows between the anchor and the target, both ways', () => {
    expect(rangeIds([], order, 'b', 'd').ids).toEqual(['b', 'c', 'd']);
    expect(rangeIds([], order, 'd', 'b').ids).toEqual(['b', 'c', 'd']);
  });
  it('keeps what is selected and adds no repeat', () => {
    expect(rangeIds(['e', 'c'], order, 'b', 'd').ids).toEqual(['e', 'c', 'b', 'd']);
  });
  it('selects the target alone without an anchor, or when the anchor left the list', () => {
    expect(rangeIds([], order, null, 'c').ids).toEqual(['c']);
    expect(rangeIds([], order, 'gone', 'c').ids).toEqual(['c']);
  });
  it('ignores a target that the list does not show', () => {
    expect(rangeIds(['a'], order, 'a', 'zz')).toEqual({ ids: ['a'], capped: false });
  });
  it('respects the cap', () => {
    const long = Array.from({ length: 30 }, (_, i) => `i${i}`);
    const r = rangeIds([], long, 'i0', 'i29');
    expect(r.ids).toHaveLength(MAX_CHAT_INCIDENTS);
    expect(r.capped).toBe(true);
    expect(r.ids[0]).toBe('i0');
  });
});

describe('selectAllIds and clearShown', () => {
  it('selects every row of the filter in list order', () => {
    expect(selectAllIds([], order)).toEqual({ ids: order, capped: false });
  });
  it('keeps earlier picks first, adds the rest and stops at the cap', () => {
    const long = Array.from({ length: 25 }, (_, i) => `i${i}`);
    const r = selectAllIds(['i24'], long);
    expect(r.ids).toHaveLength(MAX_CHAT_INCIDENTS);
    expect(r.ids[0]).toBe('i24');
    expect(r.capped).toBe(true);
  });
  it('clears only the shown rows, so a pick that a filter hides stays', () => {
    expect(clearShown(['a', 'x', 'c'], ['a', 'b', 'c'])).toEqual(['x']);
  });
  it('prunes ids that no diagnosis has', () => {
    expect(pruneIds(['a', 'x', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('list query string', () => {
  it('is empty for the default view', () => {
    expect(listQueryString(DEFAULT_LIST_QUERY)).toBe('');
    expect(parseListQuery('')).toEqual(DEFAULT_LIST_QUERY);
  });
  it('round-trips the filters and the selection in one string', () => {
    const q = {
      status: 'failed' as const,
      severity: 'critical' as const,
      openOnly: true,
      q: 'disk full',
      sel: ['id-1', 'id-2'],
    };
    const text = listQueryString(q);
    expect(text).toBe('?status=failed&severity=critical&open=1&q=disk+full&sel=id-1,id-2');
    expect(parseListQuery(text)).toEqual(q);
  });
  it('ignores unknown values, repeats and blanks, and caps the selection', () => {
    const many = Array.from({ length: 30 }, (_, i) => `i${i}`).join(',');
    const q = parseListQuery(`?status=bogus&severity=x&sel=a,,a, b ,${many}`);
    expect(q.status).toBe('all');
    expect(q.severity).toBe('all');
    expect(q.sel.slice(0, 2)).toEqual(['a', 'b']);
    expect(q.sel).toHaveLength(MAX_CHAT_INCIDENTS);
  });
});

describe('matchesText', () => {
  const d = {
    id: 'x1',
    alertName: 'DiskFull',
    likelyCause: 'A log burst filled the volume',
    source: 'webhook',
  } as DiagnosisSummary;
  it('matches every word, in any case, in the name, cause, source or id', () => {
    expect(matchesText(d, '')).toBe(true);
    expect(matchesText(d, 'diskfull burst')).toBe(true);
    expect(matchesText(d, 'WEBHOOK')).toBe(true);
    expect(matchesText(d, 'x1')).toBe(true);
    expect(matchesText(d, 'disk memory')).toBe(false);
  });
});
