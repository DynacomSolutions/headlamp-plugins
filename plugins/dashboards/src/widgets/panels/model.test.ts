import { describe, expect, it } from 'vitest';
import {
  isEmptyPanel,
  mayFetch,
  parsePanel,
  parsePanelList,
  ringToSunburst,
  safeLink,
  sortTableRows,
} from './model';

const full = {
  version: 1,
  id: 'uptime',
  title: 'Uptime',
  generatedAt: '2026-11-20T10:00:00Z',
  link: '/uptime',
  status: 'warn',
  summary: '1 check degraded',
  stats: [
    { label: 'Up', value: '9', status: 'ok' },
    { label: 'Down', value: 1, status: 'bogus' },
  ],
  rows: [
    {
      label: 'Site',
      detail: 'slow',
      value: '2.1 s',
      fraction: 1.7,
      status: 'warn',
      link: '/sites/a',
    },
    {
      label: 'Bad',
      detail: '',
      value: '-',
      fraction: 'x',
      status: 'crit',
      link: 'javascript:alert(1)',
    },
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
        {
          key: 'k8s',
          label: 'Kubernetes',
          value: 4,
          children: [
            { key: 'k8s/ns:shop', label: 'shop', value: 2 },
            { key: 'zero', label: 'zero', value: 0 },
          ],
        },
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
    const p = parsePanel({ version: 1, id: 'x' });
    expect(p).toMatchObject({
      title: 'x',
      status: 'unknown',
      summary: '',
      stats: [],
      rows: [],
      series: [],
      rings: [],
      tables: [],
    });
    expect(isEmptyPanel(p)).toBe(true);
  });
  it('rejects an answer that is not a panel', () => {
    expect(() => parsePanel(null)).toThrow(/not a panel/);
    expect(() => parsePanel([])).toThrow();
    expect(() => parsePanel({ version: 1, title: 'x' })).toThrow(/no id/);
  });
  it('is not empty with a summary, a row or a ring', () => {
    expect(isEmptyPanel(parsePanel({ version: 1, id: 'x', summary: 'hi' }))).toBe(false);
    expect(isEmptyPanel(parsePanel(full))).toBe(false);
  });
});

describe('response shape (version 1)', () => {
  it('rejects a panel with no version or another version', () => {
    expect(() => parsePanel({ id: 'x' })).toThrow(/no version/);
    expect(() => parsePanel({ version: 2, id: 'x' })).toThrow(/version 2/);
    expect(() => parsePanel('<html></html>')).toThrow(/not a panel/);
  });
  it('ignores unknown extra fields', () => {
    const p = parsePanel({
      version: 1,
      id: 'x',
      extra: { a: 1 },
      stats: [{ label: 'a', value: 'b', status: 'ok', more: true }],
    });
    expect(p.stats).toEqual([{ label: 'a', value: 'b', status: 'ok' }]);
    expect(p).not.toHaveProperty('extra');
  });
});

describe('parsePanelList', () => {
  it('keeps valid entries and drops the rest', () => {
    const list = parsePanelList({
      version: 1,
      extra: true,
      panels: [
        {
          id: 'a',
          title: 'A',
          description: 'd',
          plugin: 'p',
          link: '/a',
          refreshSeconds: 30,
          more: 1,
        },
        { title: 'no id' },
        5,
      ],
    });
    expect(list).toEqual([
      { id: 'a', title: 'A', description: 'd', plugin: 'p', link: '/a', refreshSeconds: 30 },
    ]);
  });
  it('rejects a wrong shape', () => {
    expect(() => parsePanelList([])).toThrow(/not a panel list/);
    expect(() => parsePanelList({ panels: [] })).toThrow(/no version/);
    expect(() => parsePanelList({ version: 3, panels: [] })).toThrow(/version 3/);
    expect(() => parsePanelList({ version: 1 })).toThrow(/no panels/);
  });
});

describe('tables (optional v1 extension)', () => {
  const raw = {
    version: 1,
    id: 't',
    tables: [
      {
        title: 'Hosts',
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'load', label: 'Load', align: 'right' },
          { key: '', label: 'dropped' },
        ],
        rows: [{ name: 'b', load: 10, extra: 'x' }, { name: 'a', load: 2 }, 'bad'],
      },
      { title: 'No columns', columns: [], rows: [] },
      5,
    ],
  };
  it('parses columns, aligns and rows, and drops what is not a table', () => {
    const p = parsePanel(raw);
    expect(p.tables).toHaveLength(1);
    expect(p.tables[0].columns).toEqual([
      { key: 'name', label: 'Name', align: 'left' },
      { key: 'load', label: 'Load', align: 'right' },
    ]);
    expect(p.tables[0].rows).toEqual([
      { name: 'b', load: 10 },
      { name: 'a', load: 2 },
    ]);
    expect(isEmptyPanel(p)).toBe(false);
  });
  it('is absent on a panel without tables', () => {
    expect(parsePanel({ version: 1, id: 'x' }).tables).toEqual([]);
  });
  it('sorts numbers as numbers and text naturally, in both directions, without changing the input', () => {
    const rows = [
      { n: 'host10', v: 10 },
      { n: 'host2', v: 2 },
      { n: 'host1', v: 33 },
    ];
    expect(sortTableRows(rows, 'v', 'asc').map(r => r.v)).toEqual([2, 10, 33]);
    expect(sortTableRows(rows, 'v', 'desc').map(r => r.v)).toEqual([33, 10, 2]);
    expect(sortTableRows(rows, 'n', 'asc').map(r => r.n)).toEqual(['host1', 'host2', 'host10']);
    expect(rows.map(r => r.n)).toEqual(['host10', 'host2', 'host1']);
    const ties = [
      { k: 1, o: 'a' },
      { k: 1, o: 'b' },
    ];
    expect(sortTableRows(ties, 'k', 'desc').map(r => r.o)).toEqual(['a', 'b']);
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

describe('mayFetch', () => {
  it('fetches the first time and then only after the minimum wait', () => {
    expect(mayFetch(null, 1000, 60)).toBe(true);
    expect(mayFetch(1000, 30_000, 60)).toBe(false);
    expect(mayFetch(1000, 61_000, 60)).toBe(true);
    expect(mayFetch(1000, 1001, 0)).toBe(true);
  });
});
