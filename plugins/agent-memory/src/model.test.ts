/// <reference types="@kinvolk/headlamp-plugin" />
import { describe, expect, it } from 'vitest';
import {
  alertsByUnit,
  arrangeRows,
  backendUrl,
  barGeometry,
  canClose,
  changeLabel,
  checkEdit,
  cleanText,
  closeNeedsForce,
  DEFAULT_SETTINGS,
  formatSize,
  matchesFilter,
  MemUnit,
  parseSize,
  parseState,
  resolveSettings,
  shortName,
  sizeInput,
  unitDetail,
  unitLabel,
  worstSeverity,
} from './model';

const G = 1024 ** 3;
const M = 1024 ** 2;
const zero = { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 };

function unit(over: Partial<MemUnit> = {}): MemUnit {
  return {
    name: 'pane-1.scope',
    kind: 'scope',
    parent: 'panes.slice',
    depth: 2,
    current: 4 * G,
    high: 16 * G,
    max: 24 * G,
    min: 0,
    low: 0,
    swapCurrent: 0,
    swapMax: 512 * M,
    events: {},
    eventsLocal: {},
    pressureSome: zero,
    pressureFull: zero,
    procs: 3,
    orphaned: null,
    displayName: 'pane-1.scope',
    ...over,
  };
}

const ctx = { minLimit: 256 * M, hostTotal: 256 * G, protectedUnits: ['control.slice'] };

describe('sizes', () => {
  it('parses systemd style sizes', () => {
    expect(parseSize('16G')).toBe(16 * G);
    expect(parseSize('512m')).toBe(512 * M);
    expect(parseSize('1.5G')).toBe(1.5 * G);
    expect(parseSize('1024')).toBe(1024);
    expect(parseSize('infinity')).toBeNull();
    expect(parseSize('max')).toBeNull();
  });
  it('rejects nonsense', () => {
    for (const bad of ['', 'G', '12X', '-1G', '1e3G', 'lots'])
      expect(parseSize(bad)).toBeUndefined();
  });
  it('formats and round-trips', () => {
    expect(formatSize(16 * G)).toBe('16G');
    expect(formatSize(1.5 * G)).toBe('1.5G');
    expect(formatSize(null)).toBe('∞');
    expect(formatSize(100)).toBe('100B');
    expect(parseSize(sizeInput(1536 * M))).toBe(1536 * M);
    expect(sizeInput(null)).toBe('infinity');
  });
});

describe('checkEdit', () => {
  it('passes only the changed fields', () => {
    const r = checkEdit(unit(), { memoryHigh: '8G', memoryMax: '24G' }, false, ctx);
    expect(r.errors).toEqual([]);
    expect(r.changes).toEqual({ memoryHigh: '8G' });
  });
  it('reports nothing changed', () => {
    expect(checkEdit(unit(), { memoryHigh: '16G' }, false, ctx).errors).toEqual([
      'Nothing has changed.',
    ]);
  });
  it('reports unparsable input', () => {
    expect(checkEdit(unit(), { memoryHigh: 'many' }, false, ctx).errors[0]).toContain('not a size');
  });
  it('keeps the soft limit under the hard limit', () => {
    expect(checkEdit(unit(), { memoryHigh: '30G' }, false, ctx).errors[0]).toContain(
      'must not exceed'
    );
    expect(checkEdit(unit(), { memoryMax: '8G' }, false, ctx).errors[0]).toContain(
      'must not exceed'
    );
    expect(checkEdit(unit(), { memoryHigh: 'infinity' }, false, ctx).errors[0]).toContain(
      'must not exceed'
    );
    expect(checkEdit(unit(), { memoryMax: 'infinity' }, false, ctx).errors).toEqual([]);
  });
  it('enforces bounds', () => {
    expect(
      checkEdit(unit(), { memoryHigh: '64M', memoryMax: '128M' }, false, ctx).errors.join()
    ).toContain('at least 256M');
    expect(checkEdit(unit(), { memoryMax: '300G' }, false, ctx).errors.join()).toContain(
      'exceeds the host memory'
    );
  });
  it('flags a hard limit below current usage', () => {
    const r = checkEdit(
      unit({ current: 10 * G }),
      { memoryHigh: '4G', memoryMax: '5G' },
      false,
      ctx
    );
    expect(r.errors).toEqual([]);
    expect(r.belowCurrent).toBe(true);
  });
  it('only slices take min, low and persist', () => {
    expect(checkEdit(unit(), { memoryMin: '1G' } as any, false, ctx).changes).toEqual({});
    expect(checkEdit(unit(), { memoryHigh: '8G' }, true, ctx).errors[0]).toContain('Only slices');
    const slice = unit({ name: 'panes.slice', kind: 'slice', min: 0, low: 0 });
    expect(checkEdit(slice, { memoryMin: '1G', memoryLow: '2G' }, true, ctx).errors).toEqual([]);
    expect(checkEdit(slice, { memoryMin: '2G' }, false, ctx).errors[0]).toContain(
      'must not exceed'
    );
  });
  it('protects the control plane', () => {
    const ctl = unit({
      name: 'control.slice',
      kind: 'slice',
      high: null,
      max: null,
      swapMax: null,
    });
    expect(checkEdit(ctl, { memoryMax: '8G' }, false, ctx).errors[0]).toContain(
      'protected control plane'
    );
    expect(checkEdit(ctl, { memoryMin: '256M', memoryLow: '1G' }, false, ctx).errors).toEqual([]);
  });
});

describe('barGeometry', () => {
  it('places the lines against the hard limit', () => {
    const g = barGeometry(unit({ current: 12 * G }), 256 * G);
    expect(g.fill).toBeCloseTo(50);
    expect(g.highAt).toBeCloseTo((16 / 24) * 100);
    expect(g.maxAt).toBeCloseTo(100);
    expect(g.level).toBe('ok');
  });
  it('turns warning at the soft limit and critical at the hard limit', () => {
    expect(barGeometry(unit({ current: 16 * G }), 0).level).toBe('warning');
    expect(barGeometry(unit({ current: 23.5 * G }), 0).level).toBe('critical');
  });
  it('copes with unlimited units', () => {
    const g = barGeometry(unit({ high: null, max: null, current: 2 * G }), 256 * G);
    expect(g.highAt).toBeNull();
    expect(g.maxAt).toBeNull();
    expect(g.fill).toBeGreaterThan(0);
    expect(g.fill).toBeLessThanOrEqual(100);
  });
  it('shows swap use', () => {
    expect(barGeometry(unit({ swapCurrent: 256 * M }), 0).swapFill).toBeCloseTo(50);
    expect(barGeometry(unit({ swapMax: null }), 0).swapFill).toBeNull();
  });
});

describe('alerts and names', () => {
  const alerts = [
    { unit: 'a', severity: 'warning' as const, reason: 'soft-limit', detail: '' },
    { unit: 'a', severity: 'critical' as const, reason: 'oom-kill', detail: '' },
    { unit: 'b', severity: 'warning' as const, reason: 'soft-limit', detail: '' },
  ];
  it('groups and ranks', () => {
    const by = alertsByUnit(alerts);
    expect(by.get('a')).toHaveLength(2);
    expect(worstSeverity(by.get('a'))).toBe('critical');
    expect(worstSeverity(by.get('b'))).toBe('warning');
    expect(worstSeverity(undefined)).toBeNull();
  });
  it('shortens scope names', () => {
    expect(shortName('agent-workload-native-12-345.scope')).toBe('pane 12-345');
    expect(shortName('panes.slice')).toBe('panes');
  });
});

describe('settings and payload', () => {
  it('layers stored over deployment defaults over built-ins', () => {
    expect(resolveSettings(undefined, undefined)).toEqual(DEFAULT_SETTINGS);
    expect(
      resolveSettings(
        { backend: 'service/x/y:1' },
        { backend: 'service/d/d:2', refreshSeconds: 30 }
      )
    ).toEqual({
      backend: 'service/x/y:1',
      refreshSeconds: 30,
    });
    expect(resolveSettings({ refreshSeconds: 1 }, undefined).refreshSeconds).toBe(2);
    expect(resolveSettings({ backend: '' }, { backend: 'service/d/d:2' }).backend).toBe(
      'service/d/d:2'
    );
  });
  it('builds a service-proxy URL', () => {
    expect(backendUrl('service/ns/svc:80', '/api/state')).toBe(
      '/api/v1/namespaces/ns/services/svc:80/proxy/api/state'
    );
    expect(backendUrl('service/ns/svc', 'api/state')).toBe(
      '/api/v1/namespaces/ns/services/svc/proxy/api/state'
    );
    expect(() => backendUrl('https://example.com', '/x')).toThrow();
  });
  it('parses a partial payload', () => {
    const s = parseState({
      node: 'n',
      units: [{ name: 'a.slice', kind: 'slice', current: 1, high: null }],
    });
    expect(s.units[0].events).toEqual({});
    expect(s.units[0].pressureSome.avg10).toBe(0);
    expect(s.writable).toBe(false);
    expect(parseState(null).units).toEqual([]);
  });
});

describe('pane names and orphans', () => {
  const live = unit({
    name: 'herdr-workload-native-1-2.scope',
    displayName: 'proj / Fix bug',
    orphaned: false,
    herdr: { paneId: 'w1:p1', workspace: 'proj', tab: 'Tasks', title: 'Fix bug', agent: 'claude', agentStatus: 'idle' },
  });
  const orphan = unit({ name: 'herdr-workload-native-3-4.scope', displayName: 'herdr-workload-native-3-4.scope', orphaned: true });
  const unknown = unit({ name: 'herdr-workload-native-5-6.scope', orphaned: null });
  const slice = unit({ name: 'panes.slice', kind: 'slice', parent: '', displayName: 'panes.slice' });

  it('labels with the chat name, falling back to the short scope name', () => {
    expect(unitLabel(live)).toBe('proj / Fix bug');
    expect(unitLabel(orphan)).toBe('pane 3-4');
    expect(changeLabel({ unit: 'a-workload-native-1.scope' })).toBe('pane 1');
    expect(changeLabel({ unit: 'x.scope', displayName: 'proj / Fix bug' })).toBe('proj / Fix bug');
    expect(unitDetail(live)).toBe('tab Tasks · claude idle');
    expect(unitDetail(orphan)).toBe('');
  });

  it('search matches names, workspace, tab, agent and the scope name', () => {
    for (const q of ['fix bug', 'PROJ', 'tasks', 'claude', 'native-1-2', 'w1:p1'])
      expect(matchesFilter(live, q)).toBe(true);
    expect(matchesFilter(live, 'nothing like it')).toBe(false);
    expect(matchesFilter(orphan, 'orphaned')).toBe(true);
    expect(matchesFilter(live, '')).toBe(true);
  });

  it('sorts orphans to the top and can show only orphans', () => {
    const all = [slice, live, unknown, orphan];
    expect(arrangeRows(all, '', false).map(u => u.name)).toEqual([
      orphan.name,
      slice.name,
      live.name,
      unknown.name,
    ]);
    expect(arrangeRows(all, '', true)).toEqual([orphan]);
    expect(arrangeRows(all, 'fix', false)).toEqual([live]);
  });

  it('only closes scopes directly under the panes slice, never protected ones', () => {
    const st = { panesSlice: 'panes.slice', protected: ['control.slice'] };
    expect(canClose(orphan, st)).toBe(true);
    expect(canClose(slice, st)).toBe(false);
    expect(canClose(unit({ parent: 'control.slice' }), st)).toBe(false);
    expect(canClose(unit({ parent: 'other.slice' }), st)).toBe(false);
    expect(canClose(orphan, { panesSlice: '', protected: [] })).toBe(false);
  });

  it('needs the strong confirmation unless the pane is confirmed gone', () => {
    expect(closeNeedsForce(orphan)).toBe(false);
    expect(closeNeedsForce(live)).toBe(true);
    expect(closeNeedsForce(unknown)).toBe(true);
  });

  it('parses the new fields and tolerates old backends', () => {
    const st = parseState({
      panesSlice: 'panes.slice',
      herdr: { enabled: true, up: true, panes: 2 },
      units: [
        { name: 'a.scope', kind: 'scope', orphaned: true, displayName: 'proj / x' },
        { name: 'b.scope', kind: 'scope' },
      ],
    });
    expect(st.units[0].orphaned).toBe(true);
    expect(st.units[1].orphaned).toBeNull();
    expect(st.units[1].displayName).toBe('b.scope');
    expect(st.herdr.up).toBe(true);
    expect(parseState({}).panesSlice).toBe('');
  });
});

describe('cleanText', () => {
  it('strips control and bidi characters and caps length', () => {
    expect(cleanText('a\u202Eb\u2066c\u2069d\u0007e\u0085f')).toBe('abcdef');
    expect(cleanText('  two \n lines ')).toBe('two lines');
    const long = cleanText('x'.repeat(500));
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
  });
  it('sanitises names in parseState', () => {
    const st = parseState({
      units: [
        {
          name: 'a.scope',
          kind: 'scope',
          displayName: 'proj / ev\u202Eil',
          herdr: { paneId: 'p', title: 't\u2067x', workspace: 'w' },
        },
      ],
    });
    expect(st.units[0].displayName).toBe('proj / evil');
    expect(st.units[0].herdr?.title).toBe('tx');
  });
});
