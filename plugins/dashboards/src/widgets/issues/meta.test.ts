import { describe, expect, it } from 'vitest';
import { parseMeta, parsePanel } from '../panels/model';

describe('row meta', () => {
  it('keeps string values under safe keys and drops the rest', () => {
    expect(
      parseMeta({
        group: 'a|b',
        n: 5,
        bad_key_: 'x',
        'Bad-Key': 'y',
        __proto__: 'z',
        agent: 'working',
      })
    ).toEqual({ group: 'a|b', bad_key_: 'x', agent: 'working' });
  });

  it('limits the number of keys and the length of a value', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'v']));
    expect(Object.keys(parseMeta(many)!)).toHaveLength(16);
    expect(parseMeta({ cause: 'x'.repeat(1000) })!.cause).toHaveLength(240);
  });

  it('gives undefined for no meta, a list or an empty object', () => {
    expect(parseMeta(undefined)).toBeUndefined();
    expect(parseMeta(['a'])).toBeUndefined();
    expect(parseMeta({})).toBeUndefined();
  });

  it('parses the meta of a panel row and never fails the row', () => {
    const p = parsePanel({
      version: 1,
      id: 'x',
      rows: [
        { label: 'a', meta: { group: 'g' } },
        { label: 'b', meta: 'nope' },
      ],
    });
    expect(p.rows[0].meta).toEqual({ group: 'g' });
    expect(p.rows[1].meta).toBeUndefined();
  });
});
