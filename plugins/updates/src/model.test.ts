import { describe, expect, it } from 'vitest';
import { FIXTURE } from './fixture';
import {
  blockerChain,
  compareVersions,
  countsOf,
  DEFAULT_VIEW,
  filterComponents,
  formatAge,
  isStale,
  nodeSkew,
  parseReport,
  pickConfigMap,
  reportAgeHours,
  sortComponents,
  viewFromSearch,
  viewToSearch,
} from './model';

const report = () => {
  const r = parseReport(JSON.stringify(FIXTURE));
  if (r.kind !== 'ok') throw new Error(r.message);
  return r.report;
};

describe('parseReport', () => {
  it('parses the fixture', () => {
    expect(report().components).toHaveLength(4);
  });
  it('rejects malformed JSON, empty input and non-objects', () => {
    for (const t of ['{nope', '', undefined, '[]']) {
      const r = parseReport(t);
      expect(r.kind).toBe('malformed');
    }
  });
  it('rejects a schema mismatch with both versions in the message', () => {
    const r = parseReport(JSON.stringify({ ...FIXTURE, schemaVersion: 2 }));
    expect(r.kind).toBe('schema');
    expect(r.kind !== 'ok' && r.message).toContain('version 2');
  });
  it('tolerates odd components: unknown status, missing arrays, no id', () => {
    const r = parseReport(
      JSON.stringify({
        schemaVersion: 1,
        components: [{ id: 'x', status: 'weird' }, { name: 'no id' }, 3],
      })
    );
    expect(r.kind === 'ok' && r.report.components).toHaveLength(1);
    expect(r.kind === 'ok' && r.report.components[0]).toMatchObject({
      status: 'unknown',
      blockers: [],
      blocks: [],
    });
  });
});

describe('derived values', () => {
  it('counts statuses and security', () => {
    expect(countsOf(report().components)).toEqual({
      available: 1,
      blocked: 1,
      security: 1,
      unknown: 1,
      upToDate: 1,
    });
  });
  it('compares versions ignoring build metadata', () => {
    expect(compareVersions('v1.10.0', 'v1.9.0')).toBe(1);
    expect(compareVersions('v1.34.6+k3s1', 'v1.34.6+k3s2')).toBe(0);
    expect(compareVersions('abc', 'v1')).toBe(0);
  });
  it('detects node skew', () => {
    expect(nodeSkew('v1.34.6+k3s1', 'v1.35.0+k3s1')).toBe('newer');
    expect(nodeSkew('v1.34.6+k3s1', 'v1.33.0')).toBe('older');
    expect(nodeSkew('v1.34.6+k3s1', 'v1.34.6+k3s1')).toBe('none');
  });
  it('computes report age and staleness at the 13 h boundary', () => {
    const t = Date.parse('2026-10-11T00:00:00Z');
    expect(isStale(reportAgeHours('2026-10-11T00:00:00Z', t + 13 * 3_600_000))).toBe(false);
    expect(isStale(reportAgeHours('2026-10-11T00:00:00Z', t + 13.1 * 3_600_000))).toBe(true);
    expect(isStale(reportAgeHours('garbage', t))).toBe(true);
    expect(formatAge(1.5)).toBe('1 h 30 min');
  });
  it('builds the blocker chain both ways', () => {
    const r = report();
    const get = (id: string) => r.components.find(c => c.id === id)!;
    expect(blockerChain(r, get('k3s')).blockedBy.map(c => c.id)).toEqual(['kubevirt']);
    expect(blockerChain(r, get('kubevirt')).blocks.map(c => c.id)).toEqual(['k3s']);
  });
  it('prefers the monitoring namespace when picking the ConfigMap', () => {
    const cm = (namespace: string) => ({ metadata: { name: 'version-tracker-report', namespace } });
    expect(pickConfigMap([cm('zeta'), cm('monitoring'), cm('alpha')])?.metadata.namespace).toBe(
      'monitoring'
    );
    expect(pickConfigMap([cm('zeta'), cm('alpha')])?.metadata.namespace).toBe('alpha');
    expect(pickConfigMap([])).toBeUndefined();
  });
});

describe('filters, sort and URL state', () => {
  const list = () => report().components;
  it('filters by status, security, category and search', () => {
    expect(filterComponents(list(), { ...DEFAULT_VIEW, status: 'blocked' }).map(c => c.id)).toEqual(
      ['k3s']
    );
    expect(
      filterComponents(list(), { ...DEFAULT_VIEW, status: 'security' }).map(c => c.id)
    ).toEqual(['grafana']);
    expect(filterComponents(list(), { ...DEFAULT_VIEW, category: 'monitoring' })).toHaveLength(2);
    expect(
      filterComponents(list(), { ...DEFAULT_VIEW, q: 'supports kubernetes' }).map(c => c.id)
    ).toEqual(['k3s']);
  });
  it('sorts by status (blocked first) and by version', () => {
    expect(sortComponents(list(), 'status', 'asc')[0].id).toBe('k3s');
    expect(sortComponents(list(), 'current', 'desc')[0].id).toBe('grafana');
    expect(sortComponents(list(), 'name', 'desc').map(c => c.id)[0]).toBe('mystery');
  });
  it('round-trips the view through the query string and omits defaults', () => {
    expect(viewToSearch(DEFAULT_VIEW)).toBe('');
    const v = {
      q: 'k3s',
      status: 'blocked' as const,
      category: 'platform',
      sort: 'status' as const,
      dir: 'desc' as const,
    };
    expect(viewFromSearch(viewToSearch(v))).toEqual(v);
  });
  it('ignores invalid query values', () => {
    expect(viewFromSearch('?status=bogus&sort=nope&dir=up')).toEqual(DEFAULT_VIEW);
  });
});
