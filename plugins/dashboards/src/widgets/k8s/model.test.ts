import { describe, expect, it } from 'vitest';
import { DEFAULT_REPORT, normaliseConfig, ReportConfig } from './config';
import { compareCells, formatAge, getCell, getPathValues, getValues, parseFieldPath, toNumber } from './fields';
import { compileFilters, evaluateLogic, parseFilterLogic, testFilter } from './filters';
import {
  aggregate,
  buildReport,
  csvField,
  flattenSummary,
  MatrixReport,
  reportToCsv,
  scopeObjects,
  SummaryReport,
  TabularReport,
} from './model';

const NOW = Date.parse('2026-11-20T12:00:00Z');

function pod(name: string, ns: string, phase: string, node: string, restarts: number, extra: Record<string, unknown> = {}) {
  return {
    kind: 'Pod',
    metadata: {
      name,
      namespace: ns,
      uid: `uid-${name}`,
      creationTimestamp: '2026-11-19T12:00:00Z',
      labels: { app: name.split('-')[0], 'app.kubernetes.io/name': 'x' },
      ownerReferences: [{ kind: 'ReplicaSet', name: `${name}-rs` }],
    },
    spec: { nodeName: node, containers: [{ name: 'a', image: 'img:1' }, { name: 'b', image: 'img:2' }] },
    status: {
      phase,
      containerStatuses: [
        { ready: true, restartCount: restarts },
        { ready: false, restartCount: 1 },
      ],
    },
    ...extra,
  };
}

const PODS = [
  pod('web-1', 'prod', 'Running', 'n1', 2),
  pod('web-2', 'prod', 'Running', 'n2', 0),
  pod('db-1', 'prod', 'Pending', 'n1', 5),
  pod('job-1', 'dev', 'Succeeded', 'n2', 0),
  pod('web-3', 'dev', 'Running', 'n1', 10),
];

const config = (patch: Partial<ReportConfig>): ReportConfig => ({ ...DEFAULT_REPORT, ...patch });
const opts = { now: NOW, scope: { namespaces: [], nodes: [] } };

describe('field paths', () => {
  it('parses dotted, bracketed and escaped paths', () => {
    expect(parseFieldPath('.spec.replicas')).toEqual(['spec', 'replicas']);
    expect(parseFieldPath('spec.replicas')).toEqual(['spec', 'replicas']);
    expect(parseFieldPath('{.spec.replicas}')).toEqual(['spec', 'replicas']);
    expect(parseFieldPath('.metadata.labels["app.kubernetes.io/name"]')).toEqual(['metadata', 'labels', 'app.kubernetes.io/name']);
    expect(parseFieldPath('.metadata.labels.app\\.kubernetes\\.io/name')).toEqual(['metadata', 'labels', 'app.kubernetes.io/name']);
    expect(parseFieldPath('.spec.containers[0].image')).toEqual(['spec', 'containers', 0, 'image']);
    expect(parseFieldPath('.spec.containers[*].image')).toEqual(['spec', 'containers', '*', 'image']);
  });
  it('rejects malformed paths', () => {
    expect(parseFieldPath('')).toBeNull();
    expect(parseFieldPath('.')).toBeNull();
    expect(parseFieldPath('.a..b')).toBeNull();
    expect(parseFieldPath('.a[')).toBeNull();
    expect(parseFieldPath('.a[x]')).toBeNull();
    expect(parseFieldPath('.a.')).toBeNull();
  });
  it('reads values, wildcards and missing paths', () => {
    expect(getPathValues(PODS[0], '.metadata.labels.app')).toEqual(['web']);
    expect(getPathValues(PODS[0], '.spec.containers[*].image')).toEqual(['img:1', 'img:2']);
    expect(getPathValues(PODS[0], '.spec.containers[1].name')).toEqual(['b']);
    expect(getPathValues(PODS[0], '.spec.nothing.here')).toEqual([]);
    expect(getCell(PODS[0], '.spec.containers[*].image', NOW).text).toBe('img:1, img:2');
    expect(getCell(PODS[0], '.spec.missing', NOW)).toEqual({ value: null, text: '' });
  });
  it('computes the common fields', () => {
    const p = PODS[0];
    expect(getCell(p, 'name', NOW).text).toBe('web-1');
    expect(getCell(p, 'age', NOW)).toEqual({ value: 86400, text: '1d' });
    expect(getCell(p, 'status', NOW).text).toBe('Running');
    expect(getCell(p, 'restarts', NOW).value).toBe(3);
    expect(getCell(p, 'ready', NOW).text).toBe('1/2');
    expect(getCell(p, 'owner', NOW).text).toBe('ReplicaSet/web-1-rs');
    expect(getCell(p, 'node', NOW).text).toBe('n1');
    expect(getValues(p, 'labels', NOW)).toEqual(['app=web', 'app.kubernetes.io/name=x']);
  });
  it('shows a waiting reason as the Pod status', () => {
    const p = pod('x', 'a', 'Running', 'n', 0);
    (p.status.containerStatuses[1] as any).state = { waiting: { reason: 'CrashLoopBackOff' } };
    expect(getCell(p, 'status', NOW).text).toBe('CrashLoopBackOff');
  });
  it('shows replica readiness for workloads', () => {
    const d = { kind: 'Deployment', metadata: { name: 'd' }, spec: { replicas: 3 }, status: { readyReplicas: 2 } };
    expect(getCell(d, 'ready', NOW).text).toBe('2/3');
    const n = { kind: 'Node', metadata: { name: 'n1' } };
    expect(getCell(n, 'node', NOW).text).toBe('n1');
  });
  it('reads quantities and ages', () => {
    expect(toNumber('250m')).toBe(0.25);
    expect(toNumber('1Gi')).toBe(1024 ** 3);
    expect(toNumber('12')).toBe(12);
    expect(toNumber('web')).toBeNull();
    expect(toNumber('1/2')).toBeNull();
    expect(formatAge(42)).toBe('42s');
    expect(formatAge(3700)).toBe('1h1m');
    expect(formatAge(86400 * 3 + 3600 * 4)).toBe('3d4h');
    expect(formatAge(86400 * 30)).toBe('30d');
  });
  it('compares numbers numerically, text naturally and empty values last', () => {
    expect(compareCells({ value: 9, text: '9' }, { value: 10, text: '10' })).toBeLessThan(0);
    expect(compareCells({ value: 'a2', text: 'a2' }, { value: 'a10', text: 'a10' })).toBeLessThan(0);
    expect(compareCells({ value: null, text: '' }, { value: 'a', text: 'a' })).toBeGreaterThan(0);
  });
});

describe('filter operators', () => {
  const f = (op: any, value: string) => ({ field: 'x', op, value });
  it('equals and not equals ignore case and compare numbers numerically', () => {
    expect(testFilter(['Running'], f('eq', 'running'))).toBe(true);
    expect(testFilter(['Running'], f('ne', 'running'))).toBe(false);
    expect(testFilter([3], f('eq', '3.0'))).toBe(true);
    expect(testFilter(['250m'], f('eq', '0.25'))).toBe(true);
    expect(testFilter([], f('ne', 'a'))).toBe(true);
  });
  it('contains and starts with', () => {
    expect(testFilter(['web-frontend'], f('contains', 'FRONT'))).toBe(true);
    expect(testFilter(['web-frontend'], f('startsWith', 'web'))).toBe(true);
    expect(testFilter(['web-frontend'], f('startsWith', 'front'))).toBe(false);
  });
  it('exists, and does not exist with a false value', () => {
    expect(testFilter(['a'], f('exists', ''))).toBe(true);
    expect(testFilter([null], f('exists', ''))).toBe(false);
    expect(testFilter([], f('exists', 'false'))).toBe(true);
    expect(testFilter(['a'], f('exists', 'no'))).toBe(false);
  });
  it('greater than and less than use numbers and quantities', () => {
    expect(testFilter([5], f('gt', '3'))).toBe(true);
    expect(testFilter([5], f('lt', '3'))).toBe(false);
    expect(testFilter(['2Gi'], f('gt', '1Gi'))).toBe(true);
    expect(testFilter(['abc'], f('gt', '1'))).toBe(false);
    expect(testFilter([5], f('gt', 'abc'))).toBe(false);
  });
  it('in matches any item of a comma list', () => {
    expect(testFilter(['b'], f('in', 'a, b ,c'))).toBe(true);
    expect(testFilter(['d'], f('in', 'a,b,c'))).toBe(false);
    expect(testFilter(['d'], f('in', ''))).toBe(false);
  });
  it('multi value fields match when any value matches', () => {
    expect(testFilter(['app=web', 'tier=fe'], f('eq', 'tier=fe'))).toBe(true);
    expect(testFilter(['app=web', 'tier=fe'], f('ne', 'tier=fe'))).toBe(false);
  });
});

describe('filter logic', () => {
  const run = (logic: string, results: boolean[]) => {
    const parsed = parseFilterLogic(logic, results.length);
    if (!parsed.ok || !parsed.ast) throw new Error(parsed.error);
    return evaluateLogic(parsed.ast, results);
  };
  it('follows AND over OR precedence and brackets', () => {
    expect(run('1 AND 2 OR 3', [false, false, true])).toBe(true);
    expect(run('1 AND (2 OR 3)', [false, false, true])).toBe(false);
    expect(run('1 AND (2 OR 3)', [true, false, true])).toBe(true);
    expect(run('1 or 2', [false, true])).toBe(true);
  });
  it('supports NOT', () => {
    expect(run('NOT 1 AND 2', [false, true])).toBe(true);
    expect(run('NOT (1 AND 2)', [true, true])).toBe(false);
  });
  it('reports errors', () => {
    expect(parseFilterLogic('', 2).ok).toBe(false);
    expect(parseFilterLogic('1 AND', 2)).toMatchObject({ ok: false });
    expect(parseFilterLogic('1 AND 3', 2)).toMatchObject({ ok: false, error: expect.stringContaining('Filter 3') });
    expect(parseFilterLogic('1 AND (2', 2)).toMatchObject({ ok: false });
    expect(parseFilterLogic('1 XOR 2', 2)).toMatchObject({ ok: false });
    expect(parseFilterLogic('1 2', 2)).toMatchObject({ ok: false });
    expect(parseFilterLogic('1 & 2', 2)).toMatchObject({ ok: false });
    expect(parseFilterLogic('1', 2)).toMatchObject({ ok: false, error: expect.stringContaining('Filter 2') });
  });
  it('compiles filters with AND by default and with custom logic', () => {
    const filters = [
      { field: 'namespace', op: 'eq' as const, value: 'prod' },
      { field: 'status', op: 'eq' as const, value: 'Pending' },
      { field: 'name', op: 'startsWith' as const, value: 'web' },
    ];
    const and = compileFilters(filters, '', NOW);
    expect(PODS.filter(and.test).map(p => p.metadata.name)).toEqual([]);
    const custom = compileFilters(filters, '1 AND (2 OR 3)', NOW);
    expect(PODS.filter(custom.test).map(p => p.metadata.name)).toEqual(['web-1', 'web-2', 'db-1']);
    expect(custom.logicError).toBeNull();
  });
  it('falls back to AND and reports a bad logic string', () => {
    const filters = [{ field: 'namespace', op: 'eq' as const, value: 'dev' }];
    const bad = compileFilters(filters, '1 AND 2', NOW);
    expect(bad.logicError).toContain('Filter 2');
    expect(PODS.filter(bad.test)).toHaveLength(2);
  });
  it('skips draft filters without a field', () => {
    const c = compileFilters([{ field: '', op: 'eq', value: 'x' }], '', NOW);
    expect(PODS.filter(c.test)).toHaveLength(5);
  });
});

describe('scope', () => {
  it('filters by namespace and, for Pods, by node', () => {
    expect(scopeObjects(PODS, { namespaces: ['dev'], nodes: [] }, true, NOW)).toHaveLength(2);
    expect(scopeObjects(PODS, { namespaces: [], nodes: ['n1'] }, true, NOW)).toHaveLength(3);
    expect(scopeObjects(PODS, { namespaces: ['prod'], nodes: ['n1'] }, true, NOW)).toHaveLength(2);
  });
  it('ignores namespaces for cluster scoped kinds and nodes for kinds without a node', () => {
    const cm = [{ kind: 'ConfigMap', metadata: { name: 'a', namespace: 'x' } }];
    expect(scopeObjects(cm, { namespaces: [], nodes: ['n1'] }, true, NOW)).toHaveLength(1);
    const ns = [{ kind: 'Namespace', metadata: { name: 'a' } }];
    expect(scopeObjects(ns, { namespaces: ['x'], nodes: [] }, false, NOW)).toHaveLength(1);
  });
});

describe('tabular report', () => {
  it('builds columns, headers, rows and sorts', () => {
    const cfg = config({
      columns: [
        { field: 'name', header: 'Pod' },
        { field: 'restarts', header: '' },
        { field: '.metadata.labels.app', header: '' },
      ],
    });
    const r = buildReport(PODS, cfg, { ...opts, sortField: 'restarts', sortDir: 'desc' }) as TabularReport;
    expect(r.columns.map(c => c.header)).toEqual(['Pod', 'Restarts', 'app']);
    expect(r.rows.map(x => x.cells[0].text)).toEqual(['web-3', 'db-1', 'web-1', 'web-2', 'job-1']);
    const asc = buildReport(PODS, cfg, { ...opts, sortField: 'name', sortDir: 'asc' }) as TabularReport;
    expect(asc.rows[0].cells[0].text).toBe('db-1');
  });
  it('uses the name column when none is set', () => {
    const r = buildReport(PODS, config({ columns: [] }), opts) as TabularReport;
    expect(r.columns.map(c => c.field)).toEqual(['name']);
  });
});

describe('summary report', () => {
  const summary = (patch: Partial<ReportConfig>) =>
    buildReport(PODS, config({ reportType: 'summary', ...patch }), opts) as SummaryReport;
  it('aggregates', () => {
    expect(aggregate([1, 2, 6, null], 'sum')).toBe(9);
    expect(aggregate([1, 2, 6, null], 'avg')).toBe(3);
    expect(aggregate([1, 2, 6], 'min')).toBe(1);
    expect(aggregate([1, 2, 6], 'max')).toBe(6);
    expect(aggregate([null], 'sum')).toBeNull();
  });
  it('groups by one field with counts and aggregates', () => {
    const r = summary({ groupBy: ['status'], aggregates: [{ field: 'restarts', fn: 'sum' }, { field: 'restarts', fn: 'max' }] });
    expect(r.groups.map(g => [g.label, g.count])).toEqual([
      ['Pending', 1],
      ['Running', 3],
      ['Succeeded', 1],
    ]);
    const running = r.groups.find(g => g.label === 'Running')!;
    expect(running.aggs).toEqual([3 + 1 + 11, 11]);
    expect(r.total.count).toBe(5);
    expect(r.total.aggs[0]).toBe(3 + 1 + 6 + 1 + 11);
  });
  it('groups by two fields with subtotals', () => {
    const r = summary({ groupBy: ['namespace', 'status'], aggregates: [{ field: 'restarts', fn: 'avg' }] });
    const prod = r.groups.find(g => g.label === 'prod')!;
    expect(prod.count).toBe(3);
    expect(prod.children.map(c => [c.label, c.count])).toEqual([
      ['Pending', 1],
      ['Running', 2],
    ]);
    expect(prod.children[1].rows).toHaveLength(2);
    expect(prod.aggs[0]).toBeCloseTo((3 + 1 + 6) / 3, 5);
    expect(r.groups.reduce((n, g) => n + g.count, 0)).toBe(r.total.count);
  });
  it('limits grouping to two fields and every group is its own line', () => {
    const r = summary({ groupBy: ['namespace', 'status', 'node'] as any });
    expect(r.groupFields).toHaveLength(2);
    const many = Array.from({ length: 40 }, (_, i) => pod(`p-${i}`, `ns-${i}`, 'Running', 'n1', 0));
    const big = buildReport(many, config({ reportType: 'summary', groupBy: ['namespace'] }), opts) as SummaryReport;
    expect(big.groups).toHaveLength(40);
  });
  it('sorts groups by count and puts empty groups last', () => {
    const objs = [...PODS, { kind: 'Pod', metadata: { name: 'z', namespace: 'prod' } }];
    const r = buildReport(objs, config({ reportType: 'summary', groupBy: ['status'], groupSort: 'count' }), opts) as SummaryReport;
    expect(r.groups.map(g => g.label)).toEqual(['Running', 'Pending', 'Succeeded', '(none)']);
  });
  it('flattens with collapse state and rows', () => {
    const r = summary({ groupBy: ['namespace', 'status'] });
    const open = flattenSummary(r, new Set(), true, false);
    expect(open.filter(i => i.kind === 'group')).toHaveLength(6);
    expect(open[open.length - 1].kind).toBe('total');
    const prodId = r.groups.find(g => g.label === 'prod')!.id;
    const collapsed = flattenSummary(r, new Set([prodId]), true, false);
    expect(collapsed.filter(i => i.kind === 'group')).toHaveLength(4);
    const withRows = flattenSummary(r, new Set(), true, true);
    expect(withRows.filter(i => i.kind === 'row')).toHaveLength(5);
    const closedByDefault = flattenSummary(r, new Set(), false, true);
    expect(closedByDefault.filter(i => i.kind === 'group')).toHaveLength(2);
    expect(closedByDefault.filter(i => i.kind === 'group').every(i => i.kind === 'group' && i.hasBody)).toBe(true);
  });
  it('falls back to a table when there is no group field', () => {
    expect(summary({ groupBy: [] }).type).toBe('tabular');
  });
});

describe('matrix report', () => {
  const matrix = (patch: Partial<ReportConfig>) =>
    buildReport(PODS, config({ reportType: 'matrix', matrixRow: 'namespace', matrixCol: 'status', ...patch }), opts) as MatrixReport;
  it('counts rows by one field and columns by another', () => {
    const m = matrix({});
    expect(m.rowLabels).toEqual(['dev', 'prod']);
    expect(m.colLabels).toEqual(['Pending', 'Running', 'Succeeded']);
    expect(m.cells).toEqual([
      [null, 1, 1],
      [1, 2, null],
    ]);
    expect(m.rowTotals).toEqual([2, 3]);
    expect(m.colTotals).toEqual([1, 3, 1]);
    expect(m.grandTotal).toBe(5);
  });
  it('aggregates a numeric column, with totals from the rows and not from the cells', () => {
    const m = matrix({ matrixFn: 'avg', matrixField: 'restarts' });
    expect(m.measure).toBe('avg of Restarts');
    // prod / Running: pods with 3 and 1 restarts.
    expect(m.cells[1][1]).toBe((3 + 1) / 2);
    expect(m.grandTotal).toBeCloseTo((3 + 1 + 6 + 1 + 11) / 5, 5);
    const sum = matrix({ matrixFn: 'sum', matrixField: 'restarts' });
    expect(sum.rowTotals[0]).toBe(1 + 11);
    expect(sum.cells[0][0]).toBeNull();
  });
  it('respects report filters', () => {
    const m = matrix({ filters: [{ field: 'namespace', op: 'eq', value: 'prod' }] });
    expect(m.rowLabels).toEqual(['prod']);
    expect(m.grandTotal).toBe(3);
  });
  it('handles no rows', () => {
    const m = buildReport([], config({ reportType: 'matrix' }), opts) as MatrixReport;
    expect(m.rowLabels).toEqual([]);
    expect(m.grandTotal).toBeNull();
  });
});

describe('CSV', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('a\nb')).toBe('"a\nb"');
    expect(csvField(null)).toBe('');
    expect(csvField(3, true)).toBe('3');
  });
  it('neutralises spreadsheet formulas in text but not numbers', () => {
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvField('@x')).toBe("'@x");
    expect(csvField(-3, true)).toBe('-3');
  });
  it('exports a table', () => {
    const cfg = config({ columns: [{ field: 'name', header: '' }, { field: 'status', header: 'Phase' }] });
    const r = buildReport(PODS.slice(0, 2), cfg, opts);
    expect(reportToCsv(r, cfg)).toBe('Name,Phase\r\nweb-1,Running\r\nweb-2,Running');
  });
  it('exports a summary with a grand total', () => {
    const cfg = config({ reportType: 'summary', groupBy: ['namespace', 'status'], aggregates: [{ field: 'restarts', fn: 'sum' }] });
    const csv = reportToCsv(buildReport(PODS, cfg, opts), cfg).split('\r\n');
    expect(csv[0]).toBe('Namespace,Status,Rows,sum of Restarts');
    expect(csv[1]).toBe('dev,,2,12');
    expect(csv[2]).toBe(',Running,1,11');
    expect(csv[csv.length - 1]).toBe('Grand total,,5,22');
  });
  it('exports a matrix', () => {
    const cfg = config({ reportType: 'matrix' });
    const csv = reportToCsv(buildReport(PODS, cfg, opts), cfg).split('\r\n');
    expect(csv[0]).toBe('Namespace / Status,Pending,Running,Succeeded,Total');
    expect(csv[1]).toBe('dev,,1,1,2');
    expect(csv[3]).toBe('Total,1,3,1,5');
  });
});

describe('config normaliser', () => {
  it('returns defaults for junk and clamps values', () => {
    expect(normaliseConfig(null).source.plural).toBe('pods');
    const c = normaliseConfig({ groupBy: ['a', 'b', 'c'], reportType: 'nope', chart: 'donut', filters: [{ field: 'x', op: 'zzz', value: 3 }], columns: 'x' });
    expect(c.groupBy).toEqual(['a', 'b']);
    expect(c.reportType).toBe('tabular');
    expect(c.chart).toBe('donut');
    expect(c.filters[0]).toEqual({ field: 'x', op: 'eq', value: '' });
    expect(c.columns).toEqual(DEFAULT_REPORT.columns);
  });
});
