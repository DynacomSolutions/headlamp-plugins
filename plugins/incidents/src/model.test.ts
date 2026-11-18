import { describe, expect, it } from 'vitest';
import { backendUrl, parseDetail, parseList, resolveSettings, severityColour } from './model';

describe('settings', () => {
  it('layers stored over defaults over built-ins', () => {
    expect(resolveSettings(undefined, undefined)).toEqual({
      namespace: 'headlamp-agent',
      serviceName: 'headlamp-agent',
      servicePort: '80',
    });
    expect(resolveSettings({ namespace: 'a' }, { namespace: 'b', servicePort: '8080' })).toEqual({
      namespace: 'a',
      serviceName: 'headlamp-agent',
      servicePort: '8080',
    });
  });
  it('builds the service proxy url', () => {
    expect(backendUrl(resolveSettings({}, {}), '/api/diagnoses')).toBe(
      '/api/v1/namespaces/headlamp-agent/services/headlamp-agent:80/proxy/api/diagnoses'
    );
  });
});

describe('parsing', () => {
  it('sorts newest first and takes cause from result or error', () => {
    const list = parseList({
      diagnoses: [
        {
          id: 'a',
          createdAt: '2026-01-01T00:00:00Z',
          status: 'done',
          source: 'api',
          alert: { name: 'A', severity: 'critical' },
          result: { likelyCause: 'disk', confidence: 'high' },
        },
        {
          id: 'b',
          createdAt: '2026-01-02T00:00:00Z',
          status: 'failed',
          source: 'webhook',
          alert: { name: 'B' },
          error: 'boom',
          resolvedAt: 'x',
        },
        { createdAt: 'no id' },
      ],
    });
    expect(list.map(d => d.id)).toEqual(['b', 'a']);
    expect(list[0].likelyCause).toBe('boom');
    expect(list[0].resolved).toBe(true);
    expect(list[1].confidence).toBe('high');
    expect(parseList(null)).toEqual([]);
  });
  it('parses details', () => {
    expect(parseDetail({ id: 'a', status: 'running', a2ui: [{}] }).a2ui.length).toBe(1);
    expect(parseDetail({ status: 'weird' }).status).toBe('queued');
  });
  it('colours severity', () => {
    expect(severityColour('critical')).toBe('error');
    expect(severityColour('Warning')).toBe('warning');
    expect(severityColour('info')).toBe('default');
  });
});
