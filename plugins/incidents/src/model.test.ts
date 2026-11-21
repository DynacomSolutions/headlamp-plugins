import { describe, expect, it } from 'vitest';
import {
  backendUrl,
  DiagnosisSummary,
  filterDiagnoses,
  parseDetail,
  parseList,
  resolveSettings,
  severityColour,
  summariseDiagnoses,
} from './model';

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

describe('widget filters and summary', () => {
  const d = (over: Partial<DiagnosisSummary>): DiagnosisSummary => ({
    id: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    status: 'done',
    source: 'alert',
    alertName: 'A',
    severity: 'critical',
    likelyCause: '',
    confidence: '',
    resolved: false,
    ...over,
  });
  const list = [
    d({ id: '1', severity: 'critical', status: 'done' }),
    d({ id: '2', severity: 'Warning', status: 'running' }),
    d({ id: '3', severity: 'info', status: 'failed', resolved: true }),
    d({ id: '4', severity: '', status: 'queued' }),
  ];
  it('filters by status, severity group and resolved', () => {
    expect(filterDiagnoses(list, {}).map(x => x.id)).toEqual(['1', '2', '3', '4']);
    expect(filterDiagnoses(list, { status: 'running' }).map(x => x.id)).toEqual(['2']);
    expect(filterDiagnoses(list, { severity: 'warning' }).map(x => x.id)).toEqual(['2']);
    expect(filterDiagnoses(list, { severity: 'other' }).map(x => x.id)).toEqual(['3', '4']);
    expect(filterDiagnoses(list, { openOnly: true }).map(x => x.id)).toEqual(['1', '2', '4']);
  });
  it('ignores unknown filter keys from an old saved config', () => {
    expect(filterDiagnoses(list, { status: undefined } as any)).toHaveLength(4);
  });
  it('counts by severity and status', () => {
    expect(summariseDiagnoses(list)).toEqual({
      total: 4,
      bySeverity: { critical: 1, warning: 1, other: 2 },
      // Each lower severity has its own name: no shared "other" count.
      lower: [
        { name: 'info', n: 1 },
        { name: 'unrated', n: 1 },
      ],
      byStatus: { queued: 1, running: 1, done: 1, failed: 1 },
      resolved: 1,
    });
  });
});
