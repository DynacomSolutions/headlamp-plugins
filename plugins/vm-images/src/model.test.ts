/// <reference types="@kinvolk/headlamp-plugin" />
import { describe, expect, it } from 'vitest';
import {
  backendUrl,
  cronRow,
  dataVolumeRow,
  DEFAULT_SETTINGS,
  describeSource,
  digestOfImageId,
  filterRepos,
  formatRelative,
  formatSize,
  groupUsages,
  isVirtualKubeletNode,
  isVmRepo,
  lastCreated,
  matchImage,
  parseCatalogue,
  parseImageRef,
  parsePrefixes,
  podUsages,
  repoSize,
  resolveSettings,
  shortDigest,
  sortRepos,
  sortTags,
  usageCounts,
  virtualKubeletNodes,
  vmRows,
  vmUsages,
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

describe('VM repositories', () => {
  const mk = (name: string, over: object = {}) =>
    parseCatalogue({ repositories: [{ name, tags: [{ tag: 't', ...over }] }] }).repositories[0];
  it('parses prefixes', () => {
    expect(parsePrefixes(' a/, b/ ,,')).toEqual(['a/', 'b/']);
    expect(DEFAULT_SETTINGS.namePrefixes).toContain('macos-vz/');
  });
  it('matches by prefix or media type', () => {
    expect(isVmRepo(mk('vm/x'), ['vm/'])).toBe(true);
    expect(isVmRepo(mk('other/x'), ['vm/'])).toBe(false);
    expect(isVmRepo(mk('other/x', { artifactType: 'application/vnd.example.vm.disk.v1' }), [])).toBe(true);
    expect(isVmRepo(mk('other/x', { configMediaType: 'application/vnd.oci.image.config.v1+json' }), [])).toBe(false);
  });
});

describe('image refs', () => {
  it('strips host, tag and digest', () => {
    expect(parseImageRef('registry.example.com:5000/vm/disk:v1')).toEqual({ path: 'vm/disk', tag: 'v1', digest: null });
    expect(parseImageRef('registry.example.com/vm/disk@sha256:abc')).toEqual({ path: 'vm/disk', tag: null, digest: 'sha256:abc' });
    expect(parseImageRef('my-org/app')).toEqual({ path: 'my-org/app', tag: 'latest', digest: null });
    expect(parseImageRef('localhost/app:1').path).toBe('app');
    expect(parseImageRef('docker://example.com/a/b:2').path).toBe('a/b');
  });
  it('reads digests from imageID', () => {
    expect(digestOfImageId('example.com/a@sha256:ff00')).toBe('sha256:ff00');
    expect(digestOfImageId('')).toBeNull();
  });
  const repos = parseCatalogue({
    repositories: [{ name: 'vm/disk', tags: [{ tag: 'v1', digest: 'sha256:aa' }, { tag: 'v2', digest: 'sha256:bb' }] }],
  }).repositories;
  it('matches digest before tag', () => {
    expect(matchImage(parseImageRef('x.example.com/vm/disk:v1', 'sha256:bb'), repos).tag?.tag).toBe('v2');
    expect(matchImage(parseImageRef('x.example.com/vm/disk:v1'), repos).tag?.tag).toBe('v1');
    expect(matchImage(parseImageRef('x.example.com/vm/disk:v9'), repos)).toMatchObject({ tag: null });
    expect(matchImage(parseImageRef('x.example.com/nope:v1'), repos).repo).toBeNull();
  });
});

describe('in use', () => {
  const repos = parseCatalogue({
    repositories: [{ name: 'vm/disk', tags: [{ tag: 'v1', digest: 'sha256:aa' }] }],
  }).repositories;
  const nodes = [
    { metadata: { name: 'vk-1', labels: { type: 'virtual-kubelet' } } },
    { metadata: { name: 'vk-2' }, status: { nodeInfo: { kubeletVersion: 'v1.30.0-vk-1.0' } } },
    { metadata: { name: 'worker-1' }, status: { nodeInfo: { kubeletVersion: 'v1.30.0' } } },
  ];
  const pod = (name: string, node: string, image: string) => ({
    metadata: { name, namespace: 'ci' },
    spec: { nodeName: node, containers: [{ name: 'c', image }] },
    status: { containerStatuses: [{ name: 'c', imageID: 'x.example.com/vm/disk@sha256:aa' }] },
  });
  it('detects virtual-kubelet nodes', () => {
    expect(isVirtualKubeletNode(nodes[0])).toBe(true);
    expect([...virtualKubeletNodes(nodes)]).toEqual(['vk-1', 'vk-2']);
  });
  it('groups pods and VMs by image and counts users', () => {
    const pods = [
      pod('a', 'vk-1', 'x.example.com/vm/disk:v1'),
      pod('b', 'vk-2', 'y.example.com/vm/disk:v1'),
      pod('c', 'worker-1', 'x.example.com/vm/disk:v1'),
    ];
    const vms = [
      { metadata: { name: 'vm1', namespace: 'ci' }, spec: { template: { spec: { volumes: [{ name: 'd', containerDisk: { image: 'x.example.com/vm/disk:v1' } }] } } } },
    ];
    const vmis = [{ metadata: { name: 'vm1', namespace: 'ci' }, status: { nodeName: 'worker-2' } }];
    const usages = [...podUsages(pods, virtualKubeletNodes(nodes)), ...vmUsages(vms, vmis)];
    const groups = groupUsages(usages, repos);
    expect(groups).toHaveLength(2);
    const byDigest = groups.find(g => g.ref.digest)!;
    expect(byDigest).toMatchObject({ repo: 'vm/disk', tag: 'v1' });
    expect(byDigest.users.map(u => u.name)).toEqual(['a', 'b']);
    const plain = groups.find(g => !g.ref.digest)!;
    expect(plain.users[0]).toMatchObject({ kind: 'VirtualMachine', node: 'worker-2' });
    expect(usageCounts(groups).get('vm/disk')).toBe(3);
    expect(usageCounts(groups).get('vm/disk:v1')).toBe(3);
  });
});

describe('KubeVirt rows', () => {
  it('describes sources and data volumes', () => {
    expect(describeSource({ http: { url: 'https://example.com/a.img' } })).toBe('http: https://example.com/a.img');
    expect(describeSource({ pvc: { namespace: 'n', name: 'p' } })).toBe('pvc: n/p');
    expect(describeSource({ blank: {} })).toBe('blank');
    expect(describeSource(undefined)).toBe('-');
    expect(
      dataVolumeRow({ metadata: { name: 'dv', namespace: 'n' }, spec: { sourceRef: { kind: 'DataSource', name: 'ds' } }, status: { phase: 'Succeeded', progress: '100.0%' } })
    ).toMatchObject({ phase: 'Succeeded', progress: '100.0%', source: 'dataSource: ds' });
    expect(cronRow({ metadata: { name: 'c' }, spec: { schedule: '0 * * * *', managedDataSource: 'ds' } })).toMatchObject({ schedule: '0 * * * *', target: 'ds', ready: '-' });
  });
  it('joins VM volumes with PVCs', () => {
    const vm = {
      metadata: { name: 'vm1', namespace: 'n' },
      status: { printableStatus: 'Running' },
      spec: { template: { spec: { volumes: [
        { name: 'root', dataVolume: { name: 'root-dv' } },
        { name: 'ci', containerDisk: { image: 'example.com/vm/x:1' } },
        { name: 'cloud', cloudInitNoCloud: {} },
      ] } } },
    };
    const pvc = { metadata: { name: 'root-dv', namespace: 'n' }, spec: { storageClassName: 'fast' }, status: { capacity: { storage: '20Gi' } } };
    const [row] = vmRows([vm], [pvc]);
    expect(row.state).toBe('Running');
    expect(row.disks).toEqual([
      { volume: 'root', kind: 'DataVolume', ref: 'root-dv', capacity: '20Gi', storageClass: 'fast' },
      { volume: 'ci', kind: 'containerDisk', ref: 'example.com/vm/x:1', capacity: '-', storageClass: '-' },
      { volume: 'cloud', kind: 'other', ref: '-', capacity: '-', storageClass: '-' },
    ]);
  });
});
