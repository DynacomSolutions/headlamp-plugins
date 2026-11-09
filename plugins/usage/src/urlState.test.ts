import { describe, expect, it } from 'vitest';
import { defaultState, parseState, serialiseState } from './urlState';

describe('urlState', () => {
  it('serialises the default view to nothing and parses it back', () => {
    expect(serialiseState(defaultState())).toBe('');
    expect(parseState('')).toEqual(defaultState());
  });

  it('round-trips a full view', () => {
    const s = {
      range: '7d' as const,
      groupBy: 'label:app.kubernetes.io/name',
      resources: ['cpu' as const, 'netIn' as const],
      namespaces: ['a', 'b'],
      nodes: ['worker-1'],
      include: ['x'],
      exclude: ['y', 'z'],
      drill: [{ groupBy: 'label:app.kubernetes.io/name', key: 'web' }],
    };
    expect(parseState(serialiseState(s))).toEqual(s);
  });

  it('never parses to an empty resource list', () => {
    expect(parseState('?res=').resources).toEqual(defaultState().resources);
    expect(parseState('?res=nope').resources).toEqual(defaultState().resources);
  });

  it('keeps commas inside values', () => {
    const s = { ...defaultState(), include: ['a,b', 'c'], drill: [{ groupBy: 'label:app', key: 'x,y|z' }] };
    expect(parseState(serialiseState(s))).toEqual(s);
  });

  it('ignores invalid values', () => {
    const s = parseState('?range=2y&group=bogus&res=cpu,nope&drill=junk');
    expect(s.range).toBe('24h');
    expect(s.groupBy).toBe('namespace');
    expect(s.resources).toEqual(['cpu']);
    expect(s.drill).toEqual([]);
  });
});
