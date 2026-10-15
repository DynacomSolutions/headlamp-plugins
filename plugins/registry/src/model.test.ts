/// <reference types="@kinvolk/headlamp-plugin" />
import { describe, expect, it } from 'vitest';
import {
  backendUrl,
  DEFAULT_SETTINGS,
  filterRepos,
  formatRelative,
  formatSize,
  lastCreated,
  parseCatalogue,
  repoSize,
  resolveSettings,
  shortDigest,
  sortRepos,
  sortTags,
} from './model';

const cat = parseCatalogue({
  generatedAt: '2026-10-15T08:00:00Z',
  error: null,
  repositories: [
    {
      name: 'my-org/app',
      tags: [
        { tag: 'v1', digest: 'sha256:aaaaaaaaaaaaaaaaaaaa', sizeBytes: 1024, created: '2026-10-01T00:00:00Z', platforms: ['linux/amd64'] },
        { tag: 'v2', digest: null, sizeBytes: null, created: null },
      ],
    },
    { name: 'my-org/big', tags: [{ tag: 'latest', sizeBytes: 5 * 1024 ** 3, created: '2026-09-01T00:00:00Z' }] },
    { name: 'empty', tags: [] },
    { bogus: true },
  ],
});

describe('parseCatalogue', () => {
  it('keeps tags with null fields and drops junk', () => {
    expect(cat.repositories.map(r => r.name)).toEqual(['my-org/app', 'my-org/big', 'empty']);
    expect(cat.repositories[0].tags[1]).toMatchObject({ digest: null, sizeBytes: null, platforms: [] });
  });
  it('tolerates garbage', () => {
    expect(parseCatalogue(null).repositories).toEqual([]);
    expect(parseCatalogue({ error: 'boom' }).error).toBe('boom');
  });
});

describe('formatting', () => {
  it('formats sizes', () => {
    expect(formatSize(null)).toBe('-');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1536)).toBe('1.5 KiB');
    expect(formatSize(5 * 1024 ** 3)).toBe('5.0 GiB');
  });
  it('shortens digests', () => {
    expect(shortDigest('sha256:0123456789abcdef')).toBe('sha256:0123456789ab');
    expect(shortDigest(null)).toBe('-');
  });
  it('formats relative time', () => {
    const now = Date.parse('2026-10-15T08:00:00Z');
    expect(formatRelative('2026-10-15T07:57:00Z', now)).toBe('3 minutes ago');
    expect(formatRelative('2026-10-14T08:00:00Z', now)).toBe('1 day ago');
    expect(formatRelative('nope', now)).toBe('-');
    expect(formatRelative(null, now)).toBe('-');
  });
});

describe('repo helpers', () => {
  const [app, big, empty] = cat.repositories;
  it('totals and dates', () => {
    expect(repoSize(app)).toBe(1024);
    expect(lastCreated(app)).toBe(Date.parse('2026-10-01T00:00:00Z'));
    expect(lastCreated(empty)).toBeNull();
  });
  it('filters by name', () => {
    expect(filterRepos(cat.repositories, ' BIG ').map(r => r.name)).toEqual(['my-org/big']);
    expect(filterRepos(cat.repositories, '')).toHaveLength(3);
  });
  it('sorts with missing values last', () => {
    expect(sortRepos(cat.repositories, 'size', true).map(r => r.name)).toEqual(['my-org/big', 'my-org/app', 'empty']);
    expect(sortRepos(cat.repositories, 'created', false).map(r => r.name)).toEqual(['my-org/big', 'my-org/app', 'empty']);
    expect(sortRepos(cat.repositories, 'created', true).map(r => r.name)).toEqual(['my-org/app', 'my-org/big', 'empty']);
    expect(sortRepos(cat.repositories, 'name', false)[0].name).toBe('empty');
    expect(big.name).toBe('my-org/big');
  });
  it('sorts tags newest first', () => {
    expect(sortTags(app.tags).map(t => t.tag)).toEqual(['v1', 'v2']);
  });
});

describe('settings', () => {
  it('layers stored over defaults over built-ins', () => {
    const s = resolveSettings({ service: 'x', port: '' }, { service: 'y', namespace: 'ns' });
    expect(s).toMatchObject({ service: 'x', namespace: 'ns', port: DEFAULT_SETTINGS.port });
  });
  it('clamps refresh', () => {
    expect(resolveSettings({ refreshSeconds: 1 }, {}).refreshSeconds).toBe(5);
  });
  it('builds the proxy URL', () => {
    expect(backendUrl(DEFAULT_SETTINGS, '/api/repositories')).toBe(
      '/api/v1/namespaces/registry/services/registry-catalog:80/proxy/api/repositories'
    );
  });
});
