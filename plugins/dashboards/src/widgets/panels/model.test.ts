import { describe, expect, it } from 'vitest';
import { agentUrl, DEFAULT_AGENT, isEmptyPanel, mayFetch, parsePanel, parsePanelList, resolveAgent, ringToSunburst, safeLink } from './model';

const full = {
  version: 1,
  id: 'uptime',
  title: 'Uptime',
  generatedAt: '2026-11-20T10:00:00Z',
  link: '/uptime',
  status: 'warn',
  summary: '1 check degraded',
  stats: [{ label: 'Up', value: '9', status: 'ok' }, { label: 'Down', value: 1, status: 'bogus' }],
  rows: [
    { label: 'Site', detail: 'slow', value: '2.1 s', fraction: 1.7, status: 'warn', link: '/sites/a' },
    { label: 'Bad', detail: '', value: '-', fraction: 'x', status: 'crit', link: 'javascript:alert(1)' },
  ],
  series: [{ label: 'Latency', points: [1, 2, NaN, 3, 'x'] }],
  rings: [
    {
      id: 'cpu',
      label: 'CPU',
      unit: 'cores',
      capacity: 8,
      used: 5,
      segments: [
        { key: 'k8s', label: 'Kubernetes', value: 4, children: [{ key: 'k8s/ns:shop', label: 'shop', value: 2 }, { key: 'zero', label: 'zero', value: 0 }] },
        { key: 'sys', label: 'System', value: 1 },
        { key: '', label: 'no key', value: 3 },
      ],
    },
  ],
};

describe('parsePanel', () => {
  it('maps a panel with stats, rows, series and rings', () => {
    const p = parsePanel(full);
    expect(p.id).toBe('uptime');
    expect(p.status).toBe('warn');
    expect(p.stats).toEqual([
      { label: 'Up', value: '9', status: 'ok' },
      { label: 'Down', value: '1', status: 'unknown' },
    ]);
    expect(p.rows[0]).toMatchObject({ label: 'Site', fraction: 1, link: '/sites/a' });
    expect(p.rows[1].fraction).toBeUndefined();
    expect(p.rows[1].link).toBeUndefined();
    expect(p.series[0].points).toEqual([1, 2, 3]);
    expect(p.rings[0].segments.map(s => s.key)).toEqual(['k8s', 'sys']);
    expect(p.rings[0].segments[0].children?.map(c => c.key)).toEqual(['k8s/ns:shop']);
  });
  it('fills defaults for a minimal panel', () => {
    const p = parsePanel({ id: 'x' });
    expect(p).toMatchObject({ title: 'x', status: 'unknown', summary: '', stats: [], rows: [], series: [], rings: [] });
    expect(isEmptyPanel(p)).toBe(true);
  });
  it('rejects an answer that is not a panel', () => {
    expect(() => parsePanel(null)).toThrow(/not a panel/);
    expect(() => parsePanel([])).toThrow();
    expect(() => parsePanel({ title: 'x' })).toThrow(/no id/);
  });
  it('is not empty with a summary, a row or a ring', () => {
    expect(isEmptyPanel(parsePanel({ id: 'x', summary: 'hi' }))).toBe(false);
    expect(isEmptyPanel(parsePanel(full))).toBe(false);
  });
});

describe('parsePanelList', () => {
  it('keeps valid entries and drops the rest', () => {
    const list = parsePanelList([{ id: 'a', title: 'A', description: 'd', plugin: 'p', link: '/a', refreshSeconds: 30 }, { title: 'no id' }, 5]);
    expect(list).toEqual([{ id: 'a', title: 'A', description: 'd', plugin: 'p', link: '/a', refreshSeconds: 30 }]);
    expect(parsePanelList({})).toEqual([]);
  });
});

describe('safeLink', () => {
  it('allows web and path links only', () => {
    expect(safeLink('https://example.com/x')).toBe('https://example.com/x');
    expect(safeLink('/a/b')).toBe('/a/b');
    expect(safeLink('//evil.example.com')).toBeUndefined();
    expect(safeLink('javascript:x')).toBeUndefined();
    expect(safeLink(3)).toBeUndefined();
  });
});

describe('ringToSunburst', () => {
  it('keeps every segment and child as its own arc', () => {
    const data = ringToSunburst(parsePanel(full).rings[0]);
    expect(data.capacity).toBe(8);
    expect(data.categories.map(c => c.key)).toEqual(['k8s', 'sys']);
    expect(data.categories[0].children).toEqual([{ key: 'k8s/ns:shop', label: 'shop', value: 2 }]);
  });
});

describe('agent location', () => {
  it('uses defaults for blank settings and trims values', () => {
    expect(resolveAgent(undefined)).toEqual(DEFAULT_AGENT);
    expect(resolveAgent({ agentNamespace: ' ops ', agentService: '', agentPort: 8080 })).toEqual({ namespace: 'ops', serviceName: DEFAULT_AGENT.serviceName, servicePort: DEFAULT_AGENT.servicePort });
  });
  it('builds the service-proxy path', () => {
    expect(agentUrl(DEFAULT_AGENT, '/api/widgets')).toBe('/api/v1/namespaces/headlamp-agent/services/headlamp-agent:80/proxy/api/widgets');
    expect(agentUrl({ namespace: 'a b', serviceName: 's', servicePort: '' }, 'x')).toBe('/api/v1/namespaces/a%20b/services/s/proxy/x');
  });
});

describe('mayFetch', () => {
  it('fetches the first time and then only after the minimum wait', () => {
    expect(mayFetch(null, 1000, 60)).toBe(true);
    expect(mayFetch(1000, 30_000, 60)).toBe(false);
    expect(mayFetch(1000, 61_000, 60)).toBe(true);
    expect(mayFetch(1000, 1001, 0)).toBe(true);
  });
});
