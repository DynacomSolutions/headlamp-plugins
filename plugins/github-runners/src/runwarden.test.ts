import { describe, expect, it } from 'vitest';
import {
  buildRunWarden,
  countPairs,
  filterNodes,
  filterPools,
  filterQueue,
  listPath,
  mapFailures,
  mapJobTimes,
  mapNodes,
  mapPools,
  mapQueue,
  panelPath,
  parsePanel,
  ratio,
  resolveSource,
  safeLink,
} from './runwarden';

const panel = (id: string, rows: any[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  id,
  title: id,
  status: 'ok',
  summary: '',
  generatedAt: '2026-01-01T00:00:00Z',
  link: 'https://rw.example.com/x',
  stats: [],
  rows,
  ...extra,
});

const pools = parsePanel(
  panel(
    'pools',
    [
      { label: 'pool-a', detail: '24 running, 5 queued, 5 free', value: '24/200', fraction: 0.12, status: 'ok' },
      { label: 'pool-b', detail: '8 running, 41 queued, 31 free', value: '8/200', fraction: 0.04, status: 'warn' },
    ],
    {
      stats: [
        { label: 'Running', value: '32', status: 'ok' },
        { label: 'Queued', value: '46', status: 'ok' },
        { label: 'Free', value: '36', status: 'ok' },
      ],
    }
  )
)!;
const runners = parsePanel(
  panel('runners', [
    { label: 'pool-a', detail: 'busy 25, idle 0', value: '25/25', fraction: 1, status: 'ok' },
    { label: 'pool-b', detail: 'busy 8, idle 0, warm 1', value: '8/9', fraction: 0.8889, status: 'ok' },
    { label: 'pool-c', detail: 'busy 1, idle 2', value: '1/3', status: 'ok' },
  ])
)!;

describe('source and paths', () => {
  it('uses generic defaults and builds service proxy paths', () => {
    const s = resolveSource({});
    expect(s).toMatchObject({ mode: 'auto', namespace: 'runwarden', service: 'runwarden-widgets', port: '80', problem: null });
    expect(listPath(s)).toBe('/api/v1/namespaces/runwarden/services/runwarden-widgets:80/proxy/api/widgets');
    expect(panelPath(s, 'job-times')).toBe(
      '/api/v1/namespaces/runwarden/services/runwarden-widgets:80/proxy/api/widgets/job-times'
    );
  });
  it('takes settings over defaults and reads the mode', () => {
    const s = resolveSource({ runwardenMode: 'ON', runwardenNamespace: 'ci', runwardenService: 'rw', runwardenPort: 'http' });
    expect(s).toMatchObject({ mode: 'on', namespace: 'ci', service: 'rw', port: 'http' });
    expect(resolveSource({ runwardenMode: 'off' }).mode).toBe('off');
    expect(resolveSource({ runwardenMode: 'nonsense' }).mode).toBe('auto');
  });
  it('rejects names that could change the proxy path', () => {
    expect(resolveSource({ runwardenNamespace: '../x' }).problem).toMatch(/namespace/);
    expect(resolveSource({ runwardenService: 'a/b' }).problem).toMatch(/service/);
    expect(resolveSource({ runwardenPort: '80/x' }).problem).toMatch(/port/);
  });
});

describe('parsePanel', () => {
  it('accepts a panel and drops what is not a panel', () => {
    expect(pools.rows).toHaveLength(2);
    expect(parsePanel(null)).toBeNull();
    expect(parsePanel({ version: 2, id: 'x', rows: [] })).toBeNull();
    expect(parsePanel({ version: 1, id: 'x' })).toBeNull();
  });
  it('keeps only http and https links', () => {
    expect(safeLink('https://rw.example.com')).toBe('https://rw.example.com');
    expect(safeLink('javascript:alert(1)')).toBeUndefined();
    const p = parsePanel(panel('nodes', [{ label: 'n', detail: '', value: '', status: 'ok', link: 'javascript:x' }]))!;
    expect(p.rows[0].link).toBeUndefined();
  });
  it('maps an unknown status to unknown', () => {
    const p = parsePanel(panel('q', [{ label: 'a', detail: '', value: '', status: 'weird' }]))!;
    expect(p.rows[0].status).toBe('unknown');
  });
});

describe('text parsers', () => {
  it('reads count pairs in both orders', () => {
    expect(countPairs('24 running, 5 queued, 5 free')).toEqual([['running', 24], ['queued', 5], ['free', 5]]);
    expect(countPairs('busy 8, idle 0, warm 1')).toEqual([['busy', 8], ['idle', 0], ['warm', 1]]);
    expect(countPairs('no numbers here')).toEqual([]);
  });
  it('reads a ratio', () => {
    expect(ratio('24/200')).toEqual({ used: 24, total: 200 });
    expect(ratio('-')).toEqual({ used: null, total: null });
  });
});

describe('pools and runners', () => {
  it('joins runner states onto pools and keeps every pool', () => {
    const rows = mapPools(pools, runners);
    expect(rows.map(r => r.name)).toEqual(['pool-a', 'pool-b', 'pool-c']);
    expect(rows[0]).toMatchObject({ running: 24, queued: 5, free: 5, cap: 200, fraction: 0.12 });
    expect(rows[1].runners).toEqual([['busy', 8], ['idle', 0], ['warm', 1]]);
    // A pool only the runners panel reports is not dropped, and not invented as zero slots.
    expect(rows[2]).toMatchObject({ running: null, cap: null });
    expect(rows[2].runners).toEqual([['busy', 1], ['idle', 2]]);
  });
  it('works when a panel is missing', () => {
    expect(mapPools(null, null)).toEqual([]);
    expect(mapPools(pools, null)).toHaveLength(2);
  });
});

describe('queue', () => {
  it('splits owner, pool and count and keeps every group', () => {
    const q = parsePanel(
      panel('queue', [
        { label: 'org/repo-a', detail: 'pool pool-b, 39 queued', value: '11m 23s', status: 'warn' },
        { label: 'org/repo-b', detail: 'pool pool-a, 5 queued', value: '35s', status: 'ok' },
        { label: 'org/repo-b', detail: 'pool pool-b, 2 queued', value: '5s', status: 'ok' },
      ])
    )!;
    const rows = mapQueue(q);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ owner: 'org/repo-a', pool: 'pool-b', queued: 39, oldest: '11m 23s' });
    expect(filterQueue(rows, { pools: ['pool-a'], nodes: [], terms: [] })).toHaveLength(1);
  });
  it('keeps a row whose detail it cannot read', () => {
    const rows = mapQueue(parsePanel(panel('queue', [{ label: 'x', detail: 'odd', value: '1s', status: 'ok' }]))!);
    expect(rows).toEqual([expect.objectContaining({ owner: 'x', pool: '', queued: null })]);
  });
});

describe('job times and failures', () => {
  it('reads wait, start and run per pool, with dashes as no value', () => {
    const p = parsePanel(
      panel('job-times', [
        { label: 'pool-a', detail: 'wait p50 22s, p90 2m 10s, start p50 14s, 41 jobs', value: '30s', status: 'ok' },
        { label: 'other', detail: 'wait p50 -, p90 -, start p50 -, 1 job', value: '-', status: 'unknown' },
      ])
    )!;
    const [a, b] = mapJobTimes(p);
    expect(a).toMatchObject({ waitP50: '22s', waitP90: '2m 10s', startP50: '14s', jobs: 41, run: '30s' });
    expect(b).toMatchObject({ waitP50: null, waitP90: null, startP50: null, jobs: 1, run: null });
  });
  it('reads failure counts per repository', () => {
    const p = parsePanel(
      panel('failures', [
        { label: 'org/repo', detail: '1 failed, 0 cancelled of 37', value: '2.7%', fraction: 0.027, status: 'ok' },
      ])
    )!;
    expect(mapFailures(p)[0]).toMatchObject({ repository: 'org/repo', failed: 1, cancelled: 0, jobs: 37, rate: '2.7%', fraction: 0.027 });
  });
});

describe('nodes', () => {
  const n = parsePanel(
    panel('nodes', [
      { label: 'worker-1', detail: 'CPU 14.9/16.0 cores, Mem 61.5/251.4 GiB, 3 runners', value: '93.0%', fraction: 0.93, status: 'crit', link: 'https://rw.example.com/nodes/worker-1' },
      { label: 'worker-2', detail: 'CPU 0.0/16.0 cores, Mem 0.0/128.0 GiB, 1 runner', value: '0.0%', fraction: 0, status: 'ok' },
    ])
  )!;
  it('reads cpu, memory and runner counts', () => {
    const rows = mapNodes(n);
    expect(rows[0]).toMatchObject({ cpuUsed: 14.9, cpuTotal: 16, memUsed: 61.5, memTotal: 251.4, runners: 3, link: 'https://rw.example.com/nodes/worker-1' });
    expect(rows[1].runners).toBe(1);
  });
  it('filters by node and search text', () => {
    const rows = mapNodes(n);
    expect(filterNodes(rows, { pools: [], nodes: ['worker-2'], terms: [] })).toHaveLength(1);
    expect(filterNodes(rows, { pools: [], nodes: [], terms: ['worker'] })).toHaveLength(2);
  });
});

describe('buildRunWarden', () => {
  it('collects the headline stats and the oldest timestamp', () => {
    const b = buildRunWarden({ pools, runners });
    expect(b.headline.map(h => [h.label, h.value])).toEqual([
      ['Running jobs', '32'],
      ['Queued jobs', '46'],
      ['Free slots', '36'],
    ]);
    expect(b.generatedAt).toBe('2026-01-01T00:00:00Z');
    expect(filterPools(b.pools, { pools: [], nodes: [], terms: ['pool-b'] })).toHaveLength(1);
  });
  it('does not fail on no panels', () => {
    const b = buildRunWarden({});
    expect(b.pools).toEqual([]);
    expect(b.headline).toEqual([]);
    expect(b.generatedAt).toBe('');
  });
});
