import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
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
    agentMemoryUrl: 'http://agent-memory.example.svc/api/state',
    query: new URLSearchParams(),
    now: new Date('2026-11-18T08:00:00Z'),
    ...extra,
  };
}

describe('panel list', () => {
  it('lists the v1 panels with the contract fields', () => {
    const { version, panels } = listPanels();
    expect(version).toBe(1);
    expect(panels.map(p => p.id)).toEqual(['uptime', 'usage', 'alerts', 'disks', 'hardware', 'sites', 'updates', 'incidents', 'agent-memory']);
    for (const p of panels) {
      expect(p.title).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.link).toContain('{cluster}');
      expect(p.refreshSeconds).toBeGreaterThan(0);
      expect(p).not.toHaveProperty('build');
    }
  });
});

describe('sorting', () => {
  it('puts crit, warn, unknown, ok first and keeps the panel order inside a group', () => {
    const r = (label: string, status: Row['status']): Row => ({ label, detail: '', value: '', status });
    expect(sortRows([r('a', 'ok'), r('b', 'warn'), r('c', 'crit'), r('d', 'unknown'), r('e', 'warn')]).map(x => x.label)).toEqual(['c', 'b', 'e', 'd', 'a']);
  });
  it('keeps at most 50 rows', () => {
    const rows = Array.from({ length: 80 }, (_, i): Row => ({ label: String(i), detail: '', value: '', status: 'ok' }));
    expect(sortRows(rows)).toHaveLength(50);
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
    expect(m!.rows[0]).toMatchObject({ label: 'worker-1', value: '90%', fraction: 0.9, status: 'warn' });
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

  it('agent-memory reads the state endpoint', async () => {
    let asked = '';
    const m = await buildPanel(
      'agent-memory',
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
    expect(asked).toBe('http://agent-memory.example.svc/api/state');
    expect(m!.rows.map(r => r.label)).toEqual(['Agent A', 'Agent B']);
    expect(m!.rows[0]).toMatchObject({ value: '2 GiB', fraction: 1, status: 'warn' });
    expect(m!.stats[0]).toMatchObject({ label: 'Agents', value: '2' });
    expect(m!.stats[1]).toMatchObject({ label: 'Free', value: '50%' });
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
