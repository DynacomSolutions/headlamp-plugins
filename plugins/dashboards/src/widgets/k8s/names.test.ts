import { describe, expect, it } from 'vitest';
import { DEFAULT_SOURCE, normaliseConfig } from './config';
import { getPathValues, redactSecrets } from './fields';
import { suggestPaths } from './fieldSuggest';
import { isApiVersion, isDnsLabel, isDnsSubdomain, isSafeSource } from './names';

const source = (over: Record<string, unknown>) => ({
  group: '',
  version: 'v1',
  plural: 'pods',
  kind: 'Pod',
  namespaced: true,
  ...over,
});

describe('API names', () => {
  it('accepts valid names', () => {
    expect(isDnsLabel('pods')).toBe(true);
    expect(isDnsLabel('my-app-2')).toBe(true);
    expect(isDnsSubdomain('cert-manager.io')).toBe(true);
    expect(isDnsSubdomain('')).toBe(false);
    for (const v of ['v1', 'v2', 'v1beta1', 'v1alpha3']) expect(isApiVersion(v)).toBe(true);
  });
  it('rejects names that could change the path', () => {
    for (const s of ['..', '.', 'a/b', 'a b', 'Pods', '-a', 'a-', '', 'a%2Fb', 'a?b', 'a#b'])
      expect(isDnsLabel(s)).toBe(false);
    for (const s of ['../x', 'a..b', '.a', 'a.', 'a/b']) expect(isDnsSubdomain(s)).toBe(false);
    for (const v of ['../v1', 'v1/x', 'V1', 'beta1', 'v1beta', 'v'])
      expect(isApiVersion(v)).toBe(false);
    expect(isDnsLabel('a'.repeat(64))).toBe(false);
    expect(
      isDnsSubdomain(`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`)
    ).toBe(false);
  });
});

describe('the source in a saved report', () => {
  it('keeps a good source', () => {
    const s = source({ group: 'apps', plural: 'deployments', kind: 'Deployment' });
    expect(normaliseConfig({ source: s }).source).toEqual(s);
    expect(isSafeSource(s)).toBe(true);
  });
  it.each([
    [
      'a plural that climbs out of the path',
      { plural: '../../../api/v1/namespaces/x/services/app:80/proxy/admin/reset' },
    ],
    ['a plural with a slash', { plural: 'pods/log' }],
    ['a plural with a dot', { plural: '..' }],
    ['an upper case plural', { plural: 'Pods' }],
    ['a group with a slash', { group: 'apps/v1' }],
    ['a group that climbs', { group: '../..' }],
    ['a version that is not a version', { version: 'v1/../../x' }],
    ['a version without the v', { version: '1' }],
    ['a non string plural', { plural: 5 }],
  ])('falls back to the default source for %s', (_name, over) => {
    expect(normaliseConfig({ source: source(over) }).source).toEqual(DEFAULT_SOURCE);
  });
  it('blocks the core Secrets source', () => {
    const secrets = source({ plural: 'secrets', kind: 'Secret' });
    expect(normaliseConfig({ source: secrets }).source).toEqual(DEFAULT_SOURCE);
    expect(isSafeSource(secrets)).toBe(false);
    // Another group may use the same plural.
    expect(
      normaliseConfig({
        source: source({ group: 'example.com', plural: 'secrets', kind: 'Vault' }),
      }).source.plural
    ).toBe('secrets');
  });
});

describe('Secret values', () => {
  const secret = {
    kind: 'Secret',
    metadata: { name: 's' },
    data: { password: 'cGFzcw==' },
    stringData: { token: 'plain' },
  };
  it('removes data and stringData from a Secret, by its kind or by the source kind', () => {
    expect(redactSecrets(secret)).toEqual({ kind: 'Secret', metadata: { name: 's' } });
    const bare = { metadata: { name: 's' }, data: { a: 'b' } };
    expect(redactSecrets(bare, 'Secret')).toEqual({ metadata: { name: 's' } });
    expect(redactSecrets(bare, 'ConfigMap')).toBe(bare);
  });
  it('gives no value for a data path of a Secret', () => {
    expect(getPathValues(secret, '.data.password')).toEqual([]);
    expect(getPathValues(secret, '.stringData.token')).toEqual([]);
    expect(getPathValues(secret, '.data.*')).toEqual([]);
    expect(getPathValues(secret, '.metadata.name')).toEqual(['s']);
    expect(getPathValues({ kind: 'ConfigMap', data: { a: 'b' } }, '.data.a')).toEqual(['b']);
  });
  it('suggests no data or stringData path for a Secret', () => {
    const bare = { metadata: { name: 's' }, data: { a: 'b' }, stringData: { c: 'd' } };
    expect(suggestPaths([secret])).toEqual(['.kind', '.metadata.name']);
    expect(suggestPaths([bare], 400, 25, 6, 'Secret')).toEqual(['.metadata.name']);
    expect(suggestPaths([bare])).toContain('.data.a');
  });
});
