import { describe, expect, it } from 'vitest';
import { LEGACY_KEYS, migrateKeys } from './legacy-keys';
import { resolveSource } from './pool';

describe('migrateKeys', () => {
  it('moves each old key to its new key and drops the old key', () => {
    const old = Object.keys(LEGACY_KEYS);
    const input = Object.fromEntries(old.map(k => [k, `v-${k.length}`]));
    const out = migrateKeys(input) as Record<string, string>;
    for (const [oldKey, newKey] of Object.entries(LEGACY_KEYS)) {
      expect(out[newKey]).toBe(input[oldKey]);
      expect(oldKey in out).toBe(false);
    }
  });
  it('lets the new key win and keeps other keys', () => {
    const [oldKey, newKey] = Object.entries(LEGACY_KEYS)[0];
    const out = migrateKeys({ [oldKey]: 'old', [newKey]: 'new', other: 'x' }) as Record<string, string>;
    expect(out[newKey]).toBe('new');
    expect(out.other).toBe('x');
  });
  it('fills an empty new key from the old key', () => {
    const [oldKey, newKey] = Object.entries(LEGACY_KEYS)[0];
    expect((migrateKeys({ [oldKey]: 'old', [newKey]: '' }) as Record<string, string>)[newKey]).toBe('old');
  });
  it('makes an old settings object work as a pool source', () => {
    const entries = Object.fromEntries(
      Object.keys(LEGACY_KEYS).map(k => [k, k.endsWith('Mode') ? 'on' : k.endsWith('Port') ? '8080' : 'name'])
    );
    expect(resolveSource(migrateKeys(entries))).toMatchObject({
      mode: 'on',
      namespace: 'name',
      service: 'name',
      port: '8080',
      configured: true,
    });
  });
});
