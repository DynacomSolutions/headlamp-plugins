import { describe, expect, it } from 'vitest';
import { defaultFilters } from '../../spec/model';
import { parseBlocks } from './blocks';
import { resolveEndpoint } from './endpoint';
import {
  buildTableRows,
  groupSamples,
  legendName,
  mergeTimes,
  nearestIndex,
  parseMatrix,
  parseValue,
  parseVector,
  pickLabelColumns,
  reduceSamples,
  seriesStats,
  stackSeries,
} from './mapping';
import { colourAt, ColourBook } from './palette';
import { queryUrl } from './prom';
import {
  areaPath,
  computeDomain,
  formatTick,
  linePath,
  niceTicks,
  slicePath,
  timeTicks,
} from './scale';
import { chooseStep, NICE_STEPS, rangeSeconds } from './step';
import { alternation, buildVars, formatDuration, selectorToMatchers, substitute } from './template';
import { parseThresholds, thresholdLevel } from './thresholds';
import { formatBytes, formatSeconds, formatValue, parseOptionalNumber, sig } from './units';

describe('template substitution', () => {
  const vars = buildVars(
    {
      ...defaultFilters(),
      namespaces: ['web', 'api'],
      nodes: ['worker-1.example.com'],
      range: '6h',
    },
    60
  );
  it('joins namespaces into a regex alternation and escapes regex characters', () => {
    expect(substitute('up{namespace=~"$namespace"}', vars)).toBe('up{namespace=~"web|api"}');
    expect(substitute('up{node=~"${node}"}', vars)).toBe(
      'up{node=~"worker-1\\\\.example\\\\.com"}'
    );
  });
  it('uses .* when nothing is chosen, so series without the label still match', () => {
    expect(alternation([])).toBe('.*');
    expect(substitute('$namespace', buildVars(defaultFilters(), 60))).toBe('.*');
  });
  it('gives the range, step and rate window', () => {
    expect(substitute('rate(x[$rate])', vars)).toBe('rate(x[4m])');
    expect(substitute('avg_over_time(x[$range:$step])', vars)).toBe('avg_over_time(x[6h:60s])');
    expect(vars.rate).toBe('4m');
    expect(buildVars(defaultFilters(), 15).rate).toBe('1m');
  });
  it('leaves unknown variables and longer names alone', () => {
    expect(substitute('$unknown $namespaces', vars)).toBe('$unknown $namespaces');
  });
  it('escapes quotes in a value', () => {
    expect(alternation(['a"b'])).toBe('a\\"b');
  });
  it('formats durations', () => {
    expect(formatDuration(120)).toBe('2m');
    expect(formatDuration(7200)).toBe('2h');
    expect(formatDuration(90)).toBe('90s');
    expect(formatDuration(172800)).toBe('2d');
  });
  it('turns a label selector into matchers', () => {
    expect(selectorToMatchers('app=web,tier!=db')).toBe('app="web",tier!="db"');
    expect(selectorToMatchers('env in (a,b),!legacy,team')).toBe('env=~"a|b",legacy="",team=~".+"');
    expect(selectorToMatchers('')).toBe('');
    expect(
      substitute('up{$selector}', buildVars({ ...defaultFilters(), labelSelector: 'app=web' }, 60))
    ).toBe('up{app="web"}');
  });
});

describe('step choice', () => {
  it('gives round steps and at most 300 points', () => {
    for (const w of [100, 400, 900, 2000, 4000]) {
      for (const r of ['5m', '1h', '24h', '30d']) {
        const step = chooseStep(rangeSeconds(r), w);
        expect(NICE_STEPS).toContain(step);
        expect(rangeSeconds(r) / step).toBeLessThanOrEqual(300 + 1e-9);
      }
    }
  });
  it('gives a larger step for a longer range and a smaller step for a wider chart', () => {
    expect(chooseStep(rangeSeconds('7d'), 600)).toBeGreaterThan(
      chooseStep(rangeSeconds('1h'), 600)
    );
    expect(chooseStep(rangeSeconds('24h'), 1200)).toBeLessThanOrEqual(
      chooseStep(rangeSeconds('24h'), 300)
    );
  });
  it('keeps the same step for a small change in width', () => {
    expect(chooseStep(3600, 640)).toBe(chooseStep(3600, 660));
  });
  it('uses a default width when the width is unknown', () => {
    expect(chooseStep(3600, 0)).toBe(chooseStep(3600, 600));
  });
});

describe('unit formatting', () => {
  it('formats bytes with binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5 GiB');
    expect(formatBytes(-2048)).toBe('-2 KiB');
  });
  it('formats cores, percent, ratio and seconds', () => {
    expect(formatValue(0.5, 'cores')).toBe('0.5 cores');
    expect(formatValue(0.5, 'cores', { compact: true })).toBe('0.5');
    expect(formatValue(42.123, 'percent')).toBe('42.1%');
    expect(formatValue(0.255, 'ratio')).toBe('25.5%');
    expect(formatSeconds(0.0042)).toBe('4.2 ms');
    expect(formatSeconds(90)).toBe('1.5 min');
    expect(formatSeconds(7200)).toBe('2 h');
    expect(formatSeconds(172800)).toBe('2 d');
  });
  it('formats plain numbers with SI suffixes', () => {
    expect(formatValue(1500, 'plain')).toBe('1.5k');
    expect(formatValue(12, 'plain')).toBe('12');
    expect(formatValue(2_500_000, undefined)).toBe('2.5M');
  });
  it('shows a dash for values that are not numbers', () => {
    expect(formatValue(NaN, 'bytes')).toBe('-');
    expect(sig(Infinity)).toBe('-');
  });
  it('parses optional numbers', () => {
    expect(parseOptionalNumber('')).toBeUndefined();
    expect(parseOptionalNumber(' 12.5 ')).toBe(12.5);
    expect(parseOptionalNumber('abc')).toBeUndefined();
    expect(parseOptionalNumber(3)).toBe(3);
  });
});

describe('thresholds', () => {
  const steps = parseThresholds('70:warning, 90:critical');
  it('parses steps and ignores bad parts', () => {
    expect(steps).toEqual([
      { value: 70, level: 'warning' },
      { value: 90, level: 'critical' },
    ]);
    expect(parseThresholds('x:red, 5:nonsense, 10=ok')).toEqual([{ value: 10, level: 'good' }]);
    expect(parseThresholds(undefined)).toEqual([]);
  });
  it('gives the level of a value', () => {
    expect(thresholdLevel(50, steps)).toBe('good');
    expect(thresholdLevel(70, steps)).toBe('warning');
    expect(thresholdLevel(89.9, steps)).toBe('warning');
    expect(thresholdLevel(95, steps)).toBe('critical');
  });
  it('reads steps as "or less" when inverted', () => {
    const low = parseThresholds('20:warning, 10:critical');
    expect(thresholdLevel(50, low, true)).toBe('good');
    expect(thresholdLevel(15, low, true)).toBe('warning');
    expect(thresholdLevel(5, low, true)).toBe('critical');
  });
  it('shows no level without steps or without a value', () => {
    expect(thresholdLevel(5, [])).toBeUndefined();
    expect(thresholdLevel(NaN, steps)).toBeUndefined();
  });
});

describe('response mapping', () => {
  const matrix = [
    {
      metric: { __name__: 'cpu', pod: 'a' },
      values: [
        [100, '1'],
        [160, 'NaN'],
        [220, '3'],
      ],
    },
    {
      metric: { pod: 'b' },
      values: [
        [100, '2'],
        [160, '2'],
        [220, '+Inf'],
      ],
    },
    { nothing: true },
  ];
  it('parses a matrix, turning NaN and Inf into gaps', () => {
    const s = parseMatrix(matrix);
    expect(s).toHaveLength(3);
    expect(s[0].points).toEqual([
      { t: 100, v: 1 },
      { t: 160, v: null },
      { t: 220, v: 3 },
    ]);
    expect(s[1].points[2].v).toBeNull();
    expect(s[2].points).toEqual([]);
  });
  it('names series from a legend template or from the labels', () => {
    expect(legendName('{{pod}} cpu', { pod: 'a' })).toBe('a cpu');
    expect(legendName('{{missing}}!', {})).toBe('!');
    expect(legendName('', { __name__: 'cpu', pod: 'a' })).toBe('cpu{pod="a"}');
    expect(legendName(undefined, {})).toBe('value');
    expect(parseMatrix(matrix, '{{pod}}')[0].name).toBe('a');
  });
  it('gives each label set its own stable key', () => {
    const [a, b] = parseMatrix(matrix);
    expect(a.key).not.toBe(b.key);
    expect(parseMatrix(matrix)[0].key).toBe(a.key);
  });
  it('parses vectors, scalars and bad data', () => {
    const v = parseVector([
      { metric: { ns: 'x' }, value: [1, '4.5'] },
      { metric: {}, value: [1, 'NaN'] },
    ]);
    expect(v.map(s => s.value)).toEqual([4.5, null]);
    expect(parseVector([1, '7'], undefined, 'scalar')[0].value).toBe(7);
    expect(parseVector(undefined)).toEqual([]);
    expect(parseMatrix('nope')).toEqual([]);
    expect(parseValue('x')).toBeNull();
  });
  it('merges times and finds the nearest', () => {
    const s = parseMatrix(matrix);
    expect(mergeTimes(s)).toEqual([100, 160, 220]);
    expect(nearestIndex([100, 160, 220], 170)).toBe(1);
    expect(nearestIndex([100, 160, 220], 1000)).toBe(2);
    expect(nearestIndex([100, 160, 220], -5)).toBe(0);
    expect(nearestIndex([], 1)).toBe(-1);
  });
  it('computes series statistics and ignores gaps', () => {
    expect(seriesStats(parseMatrix(matrix)[0])).toEqual({ last: 3, min: 1, max: 3, avg: 2 });
    expect(seriesStats(parseMatrix(matrix)[2]).last).toBeNull();
  });
  it('stacks series and counts gaps as zero', () => {
    const { bases, tops } = stackSeries(parseMatrix(matrix).slice(0, 2), [100, 160, 220]);
    expect(bases[0]).toEqual([0, 0, 0]);
    expect(tops[0]).toEqual([1, 0, 3]);
    expect(bases[1]).toEqual([1, 0, 3]);
    expect(tops[1]).toEqual([3, 2, 3]);
  });
  it('reduces several values to one', () => {
    expect(reduceSamples([1, null, 5], 'sum')).toBe(6);
    expect(reduceSamples([1, null, 5], 'avg')).toBe(3);
    expect(reduceSamples([1, 9, 5], 'max')).toBe(9);
    expect(reduceSamples([4, 2], 'min')).toBe(2);
    expect(reduceSamples([null, 2, 3], 'first')).toBe(2);
    expect(reduceSamples([null], 'sum')).toBeNull();
  });
});

describe('table rows and breakdown groups', () => {
  const a = parseVector([
    { metric: { ns: 'x', pod: 'p1' }, value: [1, '10'] },
    { metric: { ns: 'x', pod: 'p2' }, value: [1, '5'] },
  ]);
  const b = parseVector([{ metric: { ns: 'x', pod: 'p1' }, value: [1, '99'] }]);
  it('picks label columns', () => {
    expect(pickLabelColumns(a, 'pod, ns')).toEqual(['pod', 'ns']);
    expect(pickLabelColumns(a, '')).toEqual(['ns', 'pod']);
  });
  it('joins several queries into value columns', () => {
    const rows = buildTableRows([a, b], ['pod']);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.cells[0] === 'p1')?.values).toEqual([10, 99]);
    expect(rows.find(r => r.cells[0] === 'p2')?.values).toEqual([5, null]);
  });
  it('adds series that share the chosen labels', () => {
    expect(buildTableRows([a], ['ns'])[0].values).toEqual([15]);
  });
  it('groups by a label with every group kept: no other bucket and no top-N', () => {
    const many = parseVector(
      Array.from({ length: 40 }, (_, i) => ({ metric: { ns: `n${i}` }, value: [1, String(i + 1)] }))
    );
    const groups = groupSamples(many, 'ns');
    expect(groups).toHaveLength(40);
    expect(groups.map(g => g.name)).not.toContain('Other');
    expect(groups[0].value).toBe(40);
    expect(groups.reduce((s, g) => s + g.value, 0)).toBe((40 * 41) / 2);
  });
  it('adds series in one group and names a missing label', () => {
    const groups = groupSamples(a, 'ns');
    expect(groups).toEqual([{ key: 'x', name: 'x', value: 15 }]);
    expect(groupSamples(a, 'zone')[0].name).toBe('(none)');
  });
  it('parses query blocks with a title and a unit', () => {
    const blocks = parseBlocks('# Memory | bytes\nsum(a)\n---\n# {{pod}}\nsum(b)\n---\n\n');
    expect(blocks).toEqual([
      { title: 'Memory', unit: 'bytes', query: 'sum(a)' },
      { title: '{{pod}}', unit: undefined, query: 'sum(b)' },
    ]);
    expect(parseBlocks('up')).toEqual([{ title: '', unit: undefined, query: 'up' }]);
    expect(parseBlocks('  ')).toEqual([]);
  });
});

describe('scales and paths', () => {
  it('makes nice ticks', () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 1, 4)).toEqual([0, 0.5, 1]);
    expect(niceTicks(5, 5, 4)).toEqual([5]);
  });
  it('makes ticks for bytes on powers of 1024', () => {
    const ticks = niceTicks(0, 3 * 1024 ** 3, 4, 'bytes');
    expect(ticks.every(t => (t / 1024 ** 3) % 1 === 0)).toBe(true);
  });
  it('widens the domain to zero for filled marks and applies limits', () => {
    expect(computeDomain({ min: 5, max: 10, includeZero: true })).toEqual({ min: 0, max: 10 });
    expect(computeDomain({ min: 5, max: 10, includeZero: false })).toEqual({ min: 5, max: 10 });
    expect(computeDomain({ min: 5, max: 10, includeZero: true, yMin: 2, yMax: 20 })).toEqual({
      min: 2,
      max: 20,
    });
    const flat = computeDomain({ min: 4, max: 4, includeZero: false });
    expect(flat.min).toBeLessThan(4);
    expect(flat.max).toBeGreaterThan(4);
    expect(computeDomain({ min: Infinity, max: -Infinity, includeZero: false })).toEqual({
      min: 0,
      max: 1,
    });
  });
  it('breaks a line at a gap instead of drawing zero', () => {
    expect(
      linePath([
        [0, 5],
        [10, null],
        [20, 7],
        [30, 8],
      ])
    ).toBe('M0,5M20,7L30,8');
  });
  it('closes an area between a top and a base', () => {
    expect(areaPath([0, 10], [5, 6], [20, 20])).toBe('M0,5L10,6L10,20L0,20Z');
  });
  it('draws a full circle slice as two arcs', () => {
    expect(slicePath(100, 100, 90, 58, 0, Math.PI * 2).match(/A/g)).toHaveLength(4);
    expect(slicePath(100, 100, 90, 58, 0, 1)).toMatch(/^M[\d.,]+A90,90 0 0 1/);
  });
  it('picks time ticks at round local times', () => {
    const offset = 7 * 3600;
    const ticks = timeTicks(1_700_000_000, 1_700_000_000 + 3600, 6, offset);
    expect(ticks.length).toBeGreaterThan(2);
    for (const t of ticks) expect((t + offset) % 600).toBe(0);
    expect(formatTick(1_700_000_000, 3600, 0)).toBe('22:13');
    expect(formatTick(1_700_006_400 - 6400 + 6400, 7 * 86400, 0)).toMatch(/^\d+ [A-Z][a-z]{2}/);
  });
});

describe('colours', () => {
  it('uses the eight hues in fixed order and generates more beyond them', () => {
    expect(colourAt(0, 'light')).toBe('#2a78d6');
    expect(colourAt(7, 'dark')).toBe('#e66767');
    const extra = new Set(Array.from({ length: 50 }, (_, i) => colourAt(8 + i, 'light')));
    expect(extra.size).toBe(50);
  });
  it('keeps a colour with its series when others come and go', () => {
    const book = new ColourBook();
    const a = book.colour('a', 'light');
    const b = book.colour('b', 'light');
    expect(a).not.toBe(b);
    expect(book.colour('b', 'light')).toBe(b);
    expect(book.colour('a', 'light')).toBe(a);
  });
});

describe('endpoint', () => {
  it('uses defaults for blank or bad fields and builds the proxy URL', () => {
    const d = resolveEndpoint(undefined);
    expect(resolveEndpoint({ metricsNamespace: 'Bad Name', metricsPort: '!!' })).toEqual(d);
    const e = resolveEndpoint({
      metricsNamespace: 'obs',
      metricsService: 'prom',
      metricsPort: 'http',
      metricsPathPrefix: '/prometheus/',
    });
    expect(e).toEqual({
      namespace: 'obs',
      service: 'prom',
      port: 'http',
      pathPrefix: '/prometheus',
    });
    expect(queryUrl(e, 'query', { query: 'up' })).toBe(
      '/api/v1/namespaces/obs/services/prom:http/proxy/prometheus/api/v1/query?query=up'
    );
    expect(resolveEndpoint({ metricsPathPrefix: 'no-slash' }).pathPrefix).toBe('');
  });
});
