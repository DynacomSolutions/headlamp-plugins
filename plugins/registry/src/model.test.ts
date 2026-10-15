/// <reference types="@kinvolk/headlamp-plugin" />
import { describe, expect, it } from 'vitest';
import {
  aggregate,
  backendUrl,
  buildProjectTree,
  DEFAULT_SETTINGS,
  filterRepos,
  folderIds,
  formatRelative,
  formatSize,
  lastCreated,
  parseCatalogue,
  parseKindPrefixes,
  pruneTree,
  Repo,
  repoSize,
  resolveSettings,
  shortDigest,
  sortRepos,
  sortTags,
  sortTree,
  TreeNode,
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
    expect(formatRelative('nope', now)).toBe('unknown');
    expect(formatRelative(null, now)).toBe('unknown');
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

describe('buildProjectTree', () => {
  const mk = (name: string, size: number | null = null, created: string | null = null): Repo => ({
    name,
    tags: [{ tag: 'v1', digest: null, mediaType: null, artifactType: null, configMediaType: null, sizeBytes: size, created, platforms: [] }],
  });
  const kinds = parseKindPrefixes(undefined);
  const repos = [
    mk('shop-api', 100, '2026-10-01T00:00:00Z'),
    mk('shop-ui', 50, '2026-10-05T00:00:00Z'),
    mk('shop'),
    mk('pr/12/shop-api', 10, '2026-09-01T00:00:00Z'),
    mk('buildcache/my-org/shop/api'),
    mk('charts/shop'),
    mk('ci/shop-runtime'),
    mk('vendor/tool', 5),
    mk('lonely-thing'),
  ];
  const tree = buildProjectTree(repos, kinds);
  const shop = tree.find(n => n.id === 'p:shop')!;
  const ids = (n: TreeNode): string[] => (n.repo ? [n.repo.name] : n.children.flatMap(ids));

  it('maps the four examples to one project', () => {
    expect(ids(shop).sort()).toEqual(
      ['buildcache/my-org/shop/api', 'charts/shop', 'ci/shop-runtime', 'pr/12/shop-api', 'shop', 'shop-api', 'shop-ui'].sort()
    );
    expect(tree.find(n => n.id === 'p:my-org')).toBeUndefined();
  });
  it('places images directly under the project with the prefix stripped', () => {
    const leaves = shop.children.filter(c => c.repo).map(c => c.label);
    expect(leaves.sort()).toEqual(['api', 'shop', 'ui']);
    const folders = shop.children.filter(c => !c.repo).map(c => c.label);
    expect(folders.sort()).toEqual(['buildcache', 'charts', 'ci', 'pr']);
    expect(shop.children.find(c => c.label === 'pr')!.children[0].label).toBe('12/shop-api');
  });
  it('renders a single-repo project as one row with the full name', () => {
    const one = tree.find(n => n.id === 'r:lonely-thing')!;
    expect(one.repo?.name).toBe('lonely-thing');
    expect(one.children).toEqual([]);
    expect(tree.find(n => n.id === 'r:vendor/tool')).toBeDefined();
  });
  it('aggregates count, size and newest created; missing stays null', () => {
    expect(aggregate(shop)).toEqual({ count: 7, sizeBytes: 160, created: Date.parse('2026-10-05T00:00:00Z') });
    const empty = aggregate(tree.find(n => n.id === 'r:lonely-thing')!);
    expect(empty.created).toBeNull();
  });
  it('prunes to matches and lists folders to open', () => {
    const pruned = pruneTree(tree, ' PR/12 ');
    expect(pruned).toHaveLength(1);
    expect(ids(pruned[0])).toEqual(['pr/12/shop-api']);
    expect(folderIds(pruned)).toEqual(['p:shop', 'p:shop/k:pr']);
    expect(pruneTree(tree, 'zzz')).toEqual([]);
    expect(pruneTree(tree, '')).toBe(tree);
  });
  it('sorts each level with images before kind folders', () => {
    const sorted = sortTree(tree, 'name', false);
    const s = sorted.find(n => n.id === 'p:shop')!;
    expect(s.children.map(c => c.label)).toEqual(['api', 'shop', 'ui', 'buildcache', 'charts', 'ci', 'pr']);
    const bySize = sortTree(tree, 'size', true);
    expect(bySize[0].id).toBe('p:shop');
  });
});
