import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { provider } from '../../plugins/usage/agent/provider.js';
import { usageFixture } from './usage-dashboard-fixture.js';
import { PanelError, PANELS, buildPanel, listPanels, sortRows, type PanelDeps, type Row } from '../src/widgets.js';

const FAKE_PASSWORD = ['hun', 'ter2'].join('');

function deps(outputs: Record<string, unknown>, extra: Partial<PanelDeps> = {}): PanelDeps {
  return {
    call: async tool => {
      if (!(tool in outputs)) throw new PanelError(`no output for ${tool}`);
      const out = outputs[tool];
      if (out instanceof Error) throw out;
      return out;
    },
    serviceGet: async () => ({}),
    kubeList: async kind => {
      throw new Error(`no list for ${kind}`);
    },
    agentResourceUrl: 'http://agent-resource.example.svc/api/state',
    registryCatalogueUrl: 'http://registry-catalog.example.svc/api/repositories',
    query: new URLSearchParams(),
    now: new Date('2026-11-18T08:00:00Z'),
    ...extra,
  };
}

describe('panel list', () => {
  it('lists the v1 panels with the contract fields', () => {
    const { version, panels } = listPanels();
    expect(version).toBe(1);
    expect(panels.map(p => p.id)).toEqual(['uptime', 'usage', 'usage-dashboard', 'alerts', 'disks', 'hardware', 'sites', 'updates', 'incidents', 'github-runners', 'registry', 'vm-images', 'agent-resource']);
    for (const p of panels) {
      expect(p.title).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.link).toContain('{cluster}');
      expect(p.refreshSeconds).toBeGreaterThan(0);
      expect(p).not.toHaveProperty('build');
    }
  });
});

describe('usage panel links', () => {
  it('open the dashboard path, not the old nodes path', () => {
    for (const id of ['usage', 'usage-dashboard']) {
      expect(PANELS.find(p => p.id === id)?.link).toBe('/c/{cluster}/usage/dashboard');
    }
  });
});

describe('sorting', () => {
  it('puts crit, warn, unknown, ok first and keeps the panel order inside a group', () => {
    const r = (label: string, status: Row['status']): Row => ({ label, detail: '', value: '', status });
    expect(sortRows([r('a', 'ok'), r('b', 'warn'), r('c', 'crit'), r('d', 'unknown'), r('e', 'warn')]).map(x => x.label)).toEqual(['c', 'b', 'e', 'd', 'a']);
  });
  it('never drops a row', () => {
    const rows = Array.from({ length: 500 }, (_, i): Row => ({ label: String(i), detail: '', value: '', status: i % 7 === 0 ? 'crit' : 'ok' }));
    const sorted = sortRows(rows);
    expect(sorted).toHaveLength(500);
    expect(sorted[0].status).toBe('crit');
  });
});

describe('panel mappings', () => {
  it('uptime', async () => {
    const m = await buildPanel(
      'uptime',
      deps({
        uptime_status: {
          job: 'uptime',
          checks: [
            { target: 'a.example.com', status: 'up', uptime24h: 99.9, sites: [{ location: 'x', up: true, latencyMs: 120, httpStatus: 200, uptime24h: 99.9 }] },
            { target: 'b.example.com', status: 'down', uptime24h: 50, sites: [{ location: 'x', up: false, latencyMs: null, httpStatus: null, uptime24h: 50 }] },
            { target: 'c.example.com', status: 'degraded', uptime24h: null, sites: [] },
          ],
        },
      }),
    );
    expect(m).toMatchObject({ version: 1, id: 'uptime', status: 'crit', summary: '1 up, 1 degraded, 1 down', generatedAt: '2026-11-18T08:00:00.000Z', link: '/c/{cluster}/uptime' });
    expect(m!.stats.map(s => [s.label, s.value])).toEqual([['Up', '1'], ['Degraded', '1'], ['Down', '1']]);
    expect(m!.rows.map(r => r.label)).toEqual(['b.example.com', 'c.example.com', 'a.example.com']);
    expect(m!.rows[2]).toMatchObject({ detail: 'HTTP 200, 120 ms', value: '99.9%', fraction: 0.999, status: 'ok' });
    expect(m!.rows[0].detail).toBe('down at x');
  });

  it('usage uses node capacity for fractions', async () => {
    const m = await buildPanel(
      'usage',
      deps({
        usage_top: { unit: 'cores', rows: [{ group: 'worker-1', value: 3.6 }, { group: 'worker-2', value: 1 }] },
        query_metrics: { query: '', total: 2, samples: [{ metric: { node: 'worker-1' }, value: 4, time: '' }, { metric: { node: 'worker-2' }, value: 4, time: '' }] },
      }),
    );
    expect(m!.status).toBe('warn');
    expect(m!.rows[0]).toMatchObject({ label: 'worker-1', value: '90.0%', fraction: 0.9, status: 'warn' });
    expect(m!.stats[0]).toMatchObject({ label: 'CPU', value: '57.5%' });
  });

  it('usage without capacity shows absolute values and no bar', async () => {
    const m = await buildPanel('usage', deps({ usage_top: { unit: 'cores', rows: [{ group: 'worker-1', value: 1.5 }] }, query_metrics: new Error('no metrics') }));
    expect(m!.rows[0].fraction).toBeUndefined();
    expect(m!.rows[0].detail).toContain('1.5 cores');
    expect(m!.status).toBe('unknown');
  });

  it('alerts: crit when a critical alert fires', async () => {
    const m = await buildPanel(
      'alerts',
      deps({
        list_alerts: {
          alerts: [
            { name: 'DiskFull', state: 'firing', severity: 'critical', labels: {}, annotations: { summary: 'Disk is full' } },
            { name: 'Slow', state: 'pending', severity: 'warning', labels: {}, annotations: {} },
            { name: 'Busy', state: 'firing', severity: 'warning', labels: {}, annotations: {} },
          ],
        },
      }),
    );
    expect(m!.status).toBe('crit');
    expect(m!.stats.map(s => s.value)).toEqual(['1', '1', '1']);
    expect(m!.rows.map(r => r.label)).toEqual(['DiskFull', 'Busy', 'Slow']);
  });

  it('alerts: ok when nothing fires', async () => {
    expect((await buildPanel('alerts', deps({ list_alerts: { alerts: [] } })))!.status).toBe('ok');
  });

  it('disks: failing disks come first', async () => {
    const m = await buildPanel(
      'disks',
      deps({
        disk_health_smart: {
          disks: [
            { node: 'worker-1', device: 'sda', model: 'M1', smartPassed: true, temperatureC: 30, mediaErrors: 0, percentageUsed: 12, attributes: {}, problems: [] },
            { node: 'worker-2', device: 'nvme0', model: 'M2', smartPassed: false, temperatureC: 40, mediaErrors: 3, percentageUsed: null, attributes: {}, problems: ['media errors'] },
          ],
        },
      }),
    );
    expect(m!.status).toBe('crit');
    expect(m!.rows[0]).toMatchObject({ label: 'worker-2 nvme0', value: 'FAIL', status: 'crit' });
    expect(m!.rows[1]).toMatchObject({ value: '12% worn', fraction: 0.12 });
  });

  it('hardware', async () => {
    const m = await buildPanel(
      'hardware',
      deps({ node_hardware_thermals: { nodes: [{ node: 'worker-1', hottestC: 85, hottestSensor: 'cpu', critC: 90, packageW: 40, dramW: null, gpuW: null }, { node: 'worker-2', hottestC: 40, hottestSensor: 'cpu', critC: null, packageW: null, dramW: null, gpuW: null }] } }),
    );
    expect(m!.rows[0]).toMatchObject({ label: 'worker-1', value: '85 C', status: 'warn' });
    expect(m!.rows[0].fraction).toBeCloseTo(85 / 90);
    expect(m!.stats[0].value).toBe('85 C');
  });

  it('sites passes the q parameter', async () => {
    let seen: Record<string, unknown> = {};
    const m = await buildPanel(
      'sites',
      deps(
        { sites_lookup: { sites: [{ host: 'app.example.com', prefix: '/', service: 'web', namespace: 'prod', mapping: 'web' }] } },
        {
          query: new URLSearchParams('q=app'),
          call: async (_t, args) => {
            seen = args;
            return { sites: [{ host: 'app.example.com', prefix: '/', service: 'web', namespace: 'prod', mapping: 'web' }] };
          },
        },
      ),
    );
    expect(seen).toEqual({ query: 'app' });
    expect(m!.rows[0]).toMatchObject({ label: 'app.example.com/', detail: 'prod/web' });
    expect(m!.stats[0]).toMatchObject({ label: 'Routes', value: '1' });
  });

  it('updates lists only pending components, security first', async () => {
    const m = await buildPanel(
      'updates',
      deps({
        updates_components: {
          generatedAt: '',
          kubernetes: { server: '', nodes: [] },
          components: [
            { id: 'a', name: 'A', current: '1', latest: '2', status: 'available', security: false, blockers: [], releaseNotesUrl: '' },
            { id: 'b', name: 'B', current: '1', latest: '1', status: 'up-to-date', security: false, blockers: [], releaseNotesUrl: '' },
            { id: 'c', name: 'C', current: '1', latest: '3', status: 'available', security: true, blockers: [], releaseNotesUrl: '' },
            { id: 'd', name: 'D', current: '1', latest: '4', status: 'blocked', security: false, blockers: ['needs 2'], releaseNotesUrl: '' },
          ],
        },
      }),
    );
    expect(m!.status).toBe('crit');
    expect(m!.rows.map(r => r.label)).toEqual(['C', 'A', 'D']);
    expect(m!.stats.map(s => s.value)).toEqual(['2', '1', '1', '4']);
  });

  it('incidents: open first', async () => {
    const m = await buildPanel(
      'incidents',
      deps({
        list_diagnoses: {
          diagnoses: [
            { id: '1', alert: 'Old', severity: 'warning', status: 'done', createdAt: '', likelyCause: 'Fixed', confidence: 'high', resolved: true },
            { id: '2', alert: 'New', severity: 'critical', status: 'done', createdAt: '', likelyCause: 'Disk', confidence: 'high', resolved: false },
          ],
        },
      }),
    );
    expect(m!.rows.map(r => r.label)).toEqual(['New', 'Old']);
    expect(m!.status).toBe('crit');
    expect(m!.stats[0]).toMatchObject({ label: 'Open', value: '1' });
  });

  it('incidents: an open incident with a finished diagnosis shows open, not done', async () => {
    const m = await buildPanel(
      'incidents',
      deps({
        list_diagnoses: {
          diagnoses: [
            { id: '1', alert: 'Old', severity: 'warning', status: 'done', likelyCause: '', resolved: true },
            { id: '2', alert: 'New', severity: 'critical', status: 'done', likelyCause: '', resolved: false },
            { id: '3', alert: 'Broken', severity: 'critical', status: 'failed', likelyCause: '', resolved: false },
            { id: '4', alert: 'Busy', severity: 'warning', status: 'running', likelyCause: '', resolved: false },
          ],
        },
      }),
    );
    const byLabel = Object.fromEntries(m!.rows.map(r => [r.label, r]));
    expect(byLabel.New).toMatchObject({ value: 'open', detail: 'open', status: 'crit' });
    expect(byLabel.Old.value).toBe('resolved');
    expect(byLabel.Broken).toMatchObject({ value: 'failed', status: 'unknown' });
    expect(byLabel.Busy.value).toBe('running');
    expect(m!.rows.some(r => r.value === 'done')).toBe(false);
    // The failed row stays out of the panel status.
    expect(m!.status).toBe('crit');
  });

  it('prints one decimal in every percentage', async () => {
    const m = await buildPanel('agent-resource', deps({}, { serviceGet: async () => ({ error: '', host: { total: 100, available: 53 }, orchestrators: [], units: [] }) }));
    expect(m!.stats[1].value).toBe('53.0%');
    expect(m!.summary).toContain('53.0% memory free');
  });

  describe('no row cap', () => {
    it('agent-memory shows every agent', async () => {
      const units = Array.from({ length: 80 }, (_, i) => ({ name: `a${i}.scope`, role: 'agent', orchestrator: 't3', displayName: `Agent ${i}`, current: 2 ** 30, cpuCores: 0.1 }));
      const m = await buildPanel('agent-memory', deps({}, { serviceGet: async () => ({ error: '', host: { total: 100, available: 50 }, orchestrators: [], units }) }));
      expect(m!.rows).toHaveLength(80);
    });

    it('registry shows every repository', async () => {
      const repositories = Array.from({ length: 60 }, (_, i) => ({ name: `repo-${i}`, tags: [{ tag: '1', digest: 'sha256:x', mediaType: null, artifactType: null, configMediaType: null, sizeBytes: 1024 * (i + 1), created: '2026-11-17T08:00:00Z', platforms: [] }] }));
      const m = await buildPanel('registry', deps({}, { serviceGet: async () => ({ repositories }) }));
      expect(m!.rows).toHaveLength(60);
    });

    it('usage, incidents and sites ask their tools for every row and show them all', async () => {
      const asked: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const rows = Array.from({ length: 120 }, (_, i) => ({ group: `node-${i}`, value: 1 }));
      const diagnoses = Array.from({ length: 120 }, (_, i) => ({ alert: `A${i}`, status: 'done', severity: 'warning', resolved: false, likelyCause: '' }));
      const sites = Array.from({ length: 120 }, (_, i) => ({ host: `h${i}.example.com`, prefix: '/', service: 's', namespace: 'n', mapping: 'm' }));
      const outputs: Record<string, unknown> = { usage_top: { rows }, list_diagnoses: { diagnoses }, sites_lookup: { sites } };
      const call = async (tool: string, args: Record<string, unknown>) => {
        asked.push({ tool, args });
        return tool === 'query_metrics' ? { samples: [] } : outputs[tool];
      };
      expect((await buildPanel('usage', deps({}, { call })))!.rows).toHaveLength(120);
      expect((await buildPanel('incidents', deps({}, { call })))!.rows).toHaveLength(120);
      expect((await buildPanel('sites', deps({}, { call })))!.rows).toHaveLength(120);
      for (const a of asked.filter(x => x.tool === 'usage_top' || x.tool === 'list_diagnoses')) expect(a.args.limit).toBeGreaterThanOrEqual(1000);
    });
  });

  describe('usage-dashboard', () => {
    const ring = (id: 'cpu' | 'memory', capacity: number, used: number) => ({
      id,
      label: id === 'cpu' ? 'CPU' : 'Memory',
      unit: id === 'cpu' ? 'cores' : 'bytes',
      capacity,
      used,
      segments: [
        { key: 'k8s', label: 'Kubernetes', value: used * 0.7, children: [{ key: 'k8s/ns:shop', label: 'Shop', value: used * 0.4 }, { key: 'k8s/ns:web', label: 'Web', value: used * 0.2 }] },
        { key: 'system', label: 'System', value: used * 0.3 },
      ],
    });
    const out = (cpuUsed: number, memUsed: number) => ({ nodes: 5, hostMetrics: true, rings: [ring('cpu', 100, cpuUsed), ring('memory', 1000, memUsed)] });

    it('passes the rings through and maps stats, summary and rows', async () => {
      const m = await buildPanel('usage-dashboard', deps({ usage_dashboard: out(53.1, 652) }));
      expect(m!.rings).toEqual(out(53.1, 652).rings);
      expect(m!.status).toBe('ok');
      expect(m!.summary).toBe('CPU 53.1%, memory 65.2% on 5 nodes');
      expect(m!.stats).toEqual([
        { label: 'CPU', value: '53.1%', status: 'ok' },
        { label: 'Memory', value: '65.2%', status: 'ok' },
        { label: 'Nodes', value: '5', status: 'ok' },
      ]);
      // Shop and Web come from the children. System has no children and counts as its own entry.
      expect(m!.rows.map(r => r.label)).toEqual(['Shop', 'System', 'Web']);
      expect(m!.rows[0]).toMatchObject({ detail: 'CPU 21.2%, Mem 26.1%', value: '26.1%', fraction: 0.2608, status: 'ok' });
      expect(m!.rows[1]).toMatchObject({ detail: 'CPU 15.9%, Mem 19.6%' });
    });

    it('shows every segment and every row, with no cap', async () => {
      const many = Array.from({ length: 200 }, (_, i) => ({ key: `k8s/ns:n${i}`, label: `n${i}`, value: 0.001 }));
      const wide = (id: 'cpu' | 'memory') => ({ ...ring(id, 100, 10), segments: [{ key: 'k8s', label: 'Kubernetes', value: 0.2, children: many }] });
      const m = await buildPanel('usage-dashboard', deps({ usage_dashboard: { nodes: 5, hostMetrics: true, rings: [wide('cpu'), wide('memory')] } }));
      expect(m!.rows).toHaveLength(200);
      expect(m!.rings![0].segments[0].children).toHaveLength(200);
    });

    it('takes the status from the worse of the two percentages', async () => {
      expect((await buildPanel('usage-dashboard', deps({ usage_dashboard: out(76, 100) })))!.status).toBe('warn');
      expect((await buildPanel('usage-dashboard', deps({ usage_dashboard: out(50, 910) })))!.status).toBe('crit');
      expect((await buildPanel('usage-dashboard', deps({ usage_dashboard: out(75, 900) })))!.status).toBe('warn');
      const busy = await buildPanel('usage-dashboard', deps({ usage_dashboard: out(93, 810) }));
      expect(busy!.status).toBe('crit');
      expect(busy!.stats[0]).toMatchObject({ value: '93.0%', status: 'crit' });
      expect(busy!.stats[1]).toMatchObject({ value: '81.0%', status: 'warn' });
    });

    it('is unknown without capacity and keeps at most two rings', async () => {
      const none = await buildPanel('usage-dashboard', deps({ usage_dashboard: { nodes: 0, hostMetrics: false, rings: [] } }));
      expect(none).toMatchObject({ status: 'unknown', summary: 'No usage data', rows: [] });
      expect(none).not.toHaveProperty('rings');
      const zero = await buildPanel('usage-dashboard', deps({ usage_dashboard: { nodes: 2, hostMetrics: false, rings: [ring('cpu', 0, 0), ring('memory', 0, 0)] } }));
      expect(zero!.status).toBe('unknown');
      expect(zero!.stats[0]).toMatchObject({ value: '-', status: 'unknown' });
      const three = await buildPanel('usage-dashboard', deps({ usage_dashboard: { ...out(10, 100), rings: [ring('cpu', 100, 10), ring('memory', 1000, 100), ring('cpu', 100, 10)] } }));
      expect(three!.rings).toHaveLength(2);
    });

    it('runs the real tool on the fixture cluster', async () => {
      const fx = usageFixture({ nodes: 5, cpuPct: 93, memPct: 81, projects: 3 });
      const tool = provider.tools.find(t => t.name === 'usage_dashboard')!;
      const m = await buildPanel('usage-dashboard', deps({}, { call: async (name, args) => (await tool.run(args, fx.context())).data }));
      expect(m!.summary).toBe('CPU 93.0%, memory 81.0% on 5 nodes');
      expect(m!.status).toBe('crit');
      expect(m!.rings).toHaveLength(2);
      expect(m!.rows.length).toBeGreaterThan(5);
    });
  });

  it('answers the old panel id agent-memory with the same panel, and does not list it', async () => {
    const state = async () => ({ error: '', host: { total: 100, available: 50 }, orchestrators: [], units: [] });
    const m = await buildPanel('agent-memory', deps({}, { serviceGet: state }));
    expect(m!.id).toBe('agent-resource');
    expect(m!.title).toBe('Agent resources');
    expect(listPanels().panels.map(p => p.id)).not.toContain('agent-memory');
  });

  it('reads AGENT_RESOURCE_URL, then the old AGENT_MEMORY_URL, then the default', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).agentResourceUrl).toBe('http://agent-resource.agent-resource.svc/api/state');
    expect(loadConfig({} as NodeJS.ProcessEnv).agentResourceFallbackUrl).toBe('http://agent-memory.agent-memory.svc/api/state');
    expect(loadConfig({ AGENT_RESOURCE_URL: 'http://new.example.svc/s' } as NodeJS.ProcessEnv).agentResourceFallbackUrl).toBe('');
    expect(loadConfig({ AGENT_MEMORY_URL: 'http://old.example.svc/s/' } as NodeJS.ProcessEnv).agentResourceUrl).toBe('http://old.example.svc/s');
    expect(loadConfig({ AGENT_MEMORY_URL: 'http://old.example.svc/s', AGENT_RESOURCE_URL: 'http://new.example.svc/s' } as NodeJS.ProcessEnv).agentResourceUrl).toBe('http://new.example.svc/s');
  });

  it('agent-resource falls back to the old state endpoint, and fails when both fail', async () => {
    const asked: string[] = [];
    const ok = { error: '', host: { total: 100, available: 50 }, orchestrators: [], units: [] };
    const m = await buildPanel('agent-resource', deps({}, {
      agentResourceFallbackUrl: 'http://agent-memory.example.svc/api/state',
      serviceGet: async url => { asked.push(url); if (url.includes('agent-memory')) return ok; throw new Error('down'); },
    }));
    expect(asked).toEqual(['http://agent-resource.example.svc/api/state', 'http://agent-memory.example.svc/api/state']);
    expect(m!.stats[1].value).toBe('50.0%');
    await expect(buildPanel('agent-resource', deps({}, {
      agentResourceFallbackUrl: 'http://agent-memory.example.svc/api/state',
      serviceGet: async () => { throw new Error('down'); },
    }))).rejects.toThrow('agent-resource is not reachable');
    // No fallback when none is set (an explicit URL).
    const none: string[] = [];
    await expect(buildPanel('agent-resource', deps({}, { serviceGet: async url => { none.push(url); throw new Error('down'); } }))).rejects.toThrow();
    expect(none).toHaveLength(1);
  });

  it('agent-resource reads the state endpoint', async () => {
    let asked = '';
    const m = await buildPanel(
      'agent-resource',
      deps(
        {},
        {
          serviceGet: async url => {
            asked = url;
            return {
              error: '',
              host: { total: 100, available: 50 },
              orchestrators: [{ name: 't3', agents: 2, policy: { agent: { memoryHigh: 2 * 2 ** 30 } } }],
              warnings: [],
              units: [
                { name: 'a.scope', role: 'agent', orchestrator: 't3', displayName: 'Agent A', current: 2 * 2 ** 30, cpuCores: 1.25, eventsWindow: { events: { oom_kill: 0, high: 0 } } },
                { name: 'b.scope', role: 'agent', orchestrator: 't3', displayName: 'Agent B', current: 2 ** 30, cpuCores: 0.1 },
                { name: 'c.service', role: 'control', orchestrator: 't3', current: 5 },
              ],
            };
          },
        },
      ),
    );
    expect(asked).toBe('http://agent-resource.example.svc/api/state');
    expect(m!.rows.map(r => r.label)).toEqual(['Agent A', 'Agent B']);
    expect(m!.rows[0]).toMatchObject({ value: '2 GiB', fraction: 1, status: 'warn' });
    expect(m!.stats[0]).toMatchObject({ label: 'Agents', value: '2' });
    expect(m!.stats[1]).toMatchObject({ label: 'Free', value: '50.0%' });
  });

  it('keeps stats to four items with short labels and values', async () => {
    for (const p of PANELS) expect(p.id.length).toBeGreaterThan(0);
    const m = await buildPanel('alerts', deps({ list_alerts: { alerts: [] } }));
    for (const s of m!.stats) {
      expect(s.label.length).toBeLessThanOrEqual(12);
      expect(s.value.length).toBeLessThanOrEqual(8);
    }
    expect(m!.stats.length).toBeLessThanOrEqual(4);
  });
});

const hoursAgo = (h: number) => new Date(Date.parse('2026-11-18T08:00:00Z') - h * 3600_000).toISOString();
const tag = (name: string, size: number, created: string) => ({ tag: name, digest: `sha256:${name}`, mediaType: null, artifactType: null, configMediaType: null, sizeBytes: size, created, platforms: [] });
const CATALOGUE = {
  generatedAt: '2026-11-18T08:00:00Z',
  error: null,
  repositories: [
    { name: 'web', tags: [tag('1', 100 * 2 ** 20, hoursAgo(5)), tag('2', 50 * 2 ** 20, hoursAgo(2))] },
    { name: 'macos-vz/base', tags: [tag('15', 20 * 2 ** 30, hoursAgo(30))] },
    { name: 'api', tags: [tag('1', 10 * 2 ** 20, hoursAgo(1))] },
  ],
};

describe('github-runners, registry and vm-images', () => {
  const arcSet = (name: string, extra: Record<string, unknown> = {}) => ({
    metadata: { name, namespace: 'arc-runners' },
    spec: { runnerScaleSetName: name, minRunners: 0, maxRunners: 4 },
    status: { phase: 'Running', currentRunners: 2, runningEphemeralRunners: 1, pendingEphemeralRunners: 1, ...extra },
  });
  const listener = (set: string) => ({ spec: { autoscalingRunnerSetName: set, autoscalingRunnerSetNamespace: 'arc-runners' } });

  it('github-runners: one row per set, a missing listener is critical', async () => {
    const lists: Record<string, any[]> = {
      'autoscalingrunnersets.actions.github.com': [arcSet('good'), arcSet('nolistener'), arcSet('broken', { failedEphemeralRunners: 2 })],
      'ephemeralrunners.actions.github.com': [],
      'autoscalinglisteners.actions.github.com': [listener('good'), listener('broken')],
    };
    const m = await buildPanel('github-runners', deps({}, { kubeList: async kind => lists[kind] ?? [] }));
    expect(m!.status).toBe('crit');
    expect(m!.stats.map(s => [s.label, s.value])).toEqual([['Sets', '3'], ['Running', '3'], ['Idle/Pending', '0/3'], ['Failed', '1']]);
    expect(m!.rows.map(r => r.label).sort()).toEqual(['broken', 'good', 'nolistener']);
    expect(m!.rows[m!.rows.length - 1]).toMatchObject({ label: 'good', value: '2/4', fraction: 0.5, status: 'ok', detail: '1 running, 1 pending, max 4' });
    expect(m!.rows.find(r => r.label === 'nolistener')!.detail).toContain('listener missing');
    expect(m!.rows.find(r => r.label === 'broken')!.detail).toContain('2 failed');
  });

  it('github-runners: a pending runner for a long time is a warning; no ARC is a backend failure', async () => {
    const lists: Record<string, any[]> = {
      'autoscalingrunnersets.actions.github.com': [arcSet('a')],
      'ephemeralrunners.actions.github.com': [{ metadata: { name: 'r1', creationTimestamp: hoursAgo(1), annotations: { 'actions.github.com/runner-scale-set-name': 'a' } }, status: { phase: 'Pending' } }],
      'autoscalinglisteners.actions.github.com': [listener('a')],
    };
    const m = await buildPanel('github-runners', deps({}, { kubeList: async kind => lists[kind] ?? [] }));
    expect(m!.status).toBe('warn');
    await expect(buildPanel('github-runners', deps({}))).rejects.toThrow(/ARC is not installed/);
  });

  it('registry: totals and largest repositories first', async () => {
    const m = await buildPanel('registry', deps({}, { serviceGet: async () => CATALOGUE }));
    expect(m!.stats.map(s => [s.label, s.value])).toEqual([['Repositories', '3'], ['Tags', '4'], ['Size', '20.2 GiB']]);
    expect(m!.rows.map(r => r.label)).toEqual(['macos-vz/base', 'web', 'api']);
    expect(m!.rows[0]).toMatchObject({ value: '20.0 GiB', fraction: 1, detail: '1 tags, pushed 1 day ago' });
  });

  it('registry: sort=recent and backend failures', async () => {
    const m = await buildPanel('registry', deps({}, { query: new URLSearchParams('sort=recent'), serviceGet: async () => CATALOGUE }));
    expect(m!.rows.map(r => r.label)).toEqual(['api', 'web', 'macos-vz/base']);
    await expect(buildPanel('registry', deps({}, { serviceGet: async () => { throw new Error('down'); } }))).rejects.toThrow('The registry catalogue is not reachable');
    await expect(buildPanel('registry', deps({}, { serviceGet: async () => ({ error: 'scan failed', repositories: [] }) }))).rejects.toThrow('scan failed');
  });

  it('vm-images: problems first, then images with their users', async () => {
    const lists: Record<string, any[]> = {
      'datavolumes.cdi.kubevirt.io': [
        { metadata: { name: 'ok', namespace: 'vm' }, status: { phase: 'Succeeded' } },
        { metadata: { name: 'importing', namespace: 'vm' }, status: { phase: 'ImportInProgress', progress: '40.0%' }, spec: { source: { http: { url: 'https://example.com/a.img' } } } },
      ],
      'datasources.cdi.kubevirt.io': [{ metadata: { name: 'src', namespace: 'vm' }, status: { conditions: [{ type: 'Ready', status: 'False' }] } }],
      'dataimportcrons.cdi.kubevirt.io': [],
      'virtualmachines.kubevirt.io': [
        { metadata: { name: 'vm1', namespace: 'vm' }, status: { printableStatus: 'ErrorUnschedulable' }, spec: { template: { spec: { volumes: [{ name: 'd', containerDisk: { image: 'registry.example.com/macos-vz/base:15' } }] } } } },
        { metadata: { name: 'vm2', namespace: 'vm' }, status: { printableStatus: 'Running' } },
      ],
    };
    const m = await buildPanel('vm-images', deps({}, { serviceGet: async () => CATALOGUE, kubeList: async kind => lists[kind] ?? [] }));
    expect(m!.status).toBe('crit');
    expect(m!.stats.map(s => [s.label, s.value])).toEqual([['Images', '1'], ['In use', '1'], ['Problems', '3'], ['VMs running', '1']]);
    expect(m!.rows[0]).toMatchObject({ label: 'vm/vm1', value: 'ErrorUnschedulable', status: 'crit' });
    expect(m!.rows.find(r => r.label === 'vm/importing')).toMatchObject({ value: 'ImportInProgress', fraction: 0.4, status: 'warn' });
    expect(m!.rows[m!.rows.length - 1]).toMatchObject({ label: 'macos-vz/base', detail: '1 tags, used by 1', status: 'ok' });
  });

  it('vm-images: works when the KubeVirt types are not served', async () => {
    const m = await buildPanel('vm-images', deps({}, { serviceGet: async () => CATALOGUE }));
    expect(m!.status).toBe('ok');
    expect(m!.stats[0].value).toBe('1');
  });
});

describe('errors and masking', () => {
  it('returns undefined for an unknown panel', async () => {
    expect(await buildPanel('nope', deps({}))).toBeUndefined();
  });

  it('throws a short PanelError when a backend fails', async () => {
    await expect(buildPanel('uptime', deps({ uptime_status: new Error('Prometheus answered 500') }))).rejects.toThrow(PanelError);
  });

  it('masks secrets in panel output and error text', async () => {
    const m = await buildPanel('alerts', deps({ list_alerts: { alerts: [{ name: 'X', state: 'firing', severity: 'critical', labels: {}, annotations: { summary: `login failed password=${FAKE_PASSWORD}` } }] } }));
    expect(JSON.stringify(m)).not.toContain(FAKE_PASSWORD);
    expect(JSON.stringify(m)).toContain('[masked]');
    await expect(buildPanel('uptime', deps({ uptime_status: new Error(`bad token=${FAKE_PASSWORD}`) }))).rejects.toThrow(/\[masked\]/);
  });
});

describe('HTTP routes', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let url: string;
  beforeAll(async () => {
    const config = { ...loadConfig({} as NodeJS.ProcessEnv), port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent' };
    server = await startServer(config, 'test');
    url = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => server.close());

  it('GET /api/widgets lists the panels', async () => {
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number; panels: Array<{ id: string }> };
    expect(body.version).toBe(1);
    expect(body.panels.map(p => p.id)).toContain('uptime');
  });

  it('answers 404 for an unknown panel', async () => {
    const res = await fetch(`${url}/api/widgets/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown panel' });
  });

  it('answers 502 with a short reason when the backend fails', async () => {
    const res = await fetch(`${url}/api/widgets/uptime`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
    expect(body.error.length).toBeLessThanOrEqual(200);
  });

  it('serves the incidents panel from the own store', async () => {
    const res = await fetch(`${url}/api/widgets/incidents`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'incidents', status: 'ok', rows: [] });
  });

  it('is read-only', async () => {
    expect((await fetch(`${url}/api/widgets`, { method: 'POST' })).status).toBe(405);
  });
});
