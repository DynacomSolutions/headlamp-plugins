/// <reference types="@kinvolk/headlamp-plugin" />
import { describe, expect, it } from 'vitest';
import {
  alertsByUnit,
  arrangeRows,
  backendUrl,
  barGeometry,
  canEdit,
  changeLabel,
  checkDefaults,
  checkEdit,
  cleanText,
  DEFAULT_SETTINGS,
  formatSize,
  formatSpan,
  formatStall,
  matchesFilter,
  MemUnit,
  parseProcTree,
  parseSize,
  parseState,
  parseWarnings,
  processCommands,
  resolveSettings,
  shortName,
  sizeInput,
  stallLevel,
  unitDetail,
  unitLabel,
  visibleAlerts,
  visibleProcesses,
  windowedEvent,
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
  it('ignores soft-limit high events', () => {
    const hi = { unit: 'c', severity: 'warning' as const, reason: 'high-events', detail: '' };
    expect(visibleAlerts([...alerts, hi])).toEqual(alerts);
    expect(worstSeverity(alertsByUnit(visibleAlerts([hi])).get('c'))).toBeNull();
  });
  it('shortens scope names', () => {
    expect(shortName('t3code-claude-9e2d894e.scope')).toBe('claude 9e2d894e');
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

describe('T3 agents', () => {
  const agent = unit({
    name: 't3code-claude-9e2d894e.scope',
    parent: 'app-t3code-agents-efeffeed54ea.slice',
    displayName: 'claude · .cluster · 32a684cb',
    agent: {
      provider: 'claude',
      id: '9e2d894e',
      threadId: '273f3474-ede1',
      sessionId: '32a684cb-0521',
      resumed: true,
      cwd: '/home/u/repos/.cluster',
      pid: 11950,
    },
  });
  const bare = unit({ name: 't3code-codex-77aa.scope', displayName: 't3code-codex-77aa.scope' });
  const host = unit({
    name: 'app-t3code-agents.slice',
    kind: 'slice',
    parent: '',
    displayName: 'app-t3code-agents.slice',
  });
  const inner = unit({
    name: 'app-t3code-agents-efeffeed54ea.slice',
    kind: 'slice',
    displayName: 'app-t3code-agents-efeffeed54ea.slice',
  });

  it('labels with provider, cwd and session, falling back to the short scope name', () => {
    expect(unitLabel(agent)).toBe('claude · .cluster · 32a684cb');
    expect(unitLabel(bare)).toBe('codex 77aa');
    expect(changeLabel({ unit: 't3code-claude-1.scope' })).toBe('claude 1');
    expect(changeLabel({ unit: 'x.scope', displayName: 'claude · a · b' })).toBe('claude · a · b');
    expect(unitDetail(agent)).toBe('resumed 32a684cb-0521 · thread 273f3474-ede1 · pid 11950');
    expect(unitDetail(host)).toBe('');
  });

  it('search matches session, thread, cwd, provider and the scope name', () => {
    for (const q of ['32a684cb', '273F3474', '/repos/.cluster', 'claude', '9e2d894e'])
      expect(matchesFilter(agent, q)).toBe(true);
    expect(matchesFilter(agent, 'nothing like it')).toBe(false);
    expect(arrangeRows([host, agent, bare], 'cluster')).toEqual([agent]);
    expect(arrangeRows([host, agent, bare], '')).toHaveLength(3);
  });

  it('edits only the agents slice and agent scopes', () => {
    const st = { agentSlice: 'app-t3code-agents.slice', writable: true };
    expect(canEdit(host, st)).toBe(true);
    expect(canEdit(agent, st)).toBe(true);
    expect(canEdit(inner, st)).toBe(false);
    expect(canEdit(agent, { ...st, writable: false })).toBe(false);
    const c = checkEdit(inner, { memoryMax: '100G' }, true, { ...ctx, agentSlice: st.agentSlice });
    expect(c.errors.join(' ')).toMatch(/belongs to T3/);
  });

  it('checks the per-agent default like the backend', () => {
    const cur = { file: '/x/50-agent-cap.conf', memoryHigh: 60 * G, memoryMax: 64 * G };
    const base = { minLimit: 256 * M, hostTotal: 256 * G };
    expect(
      checkDefaults(cur, { memoryHigh: '60G', memoryMax: '64G' }, base, [], {}).errors
    ).toEqual(['Nothing has changed.']);
    expect(checkDefaults(cur, { memoryHigh: '70G' }, base, [], {}).errors.join(' ')).toMatch(
      /must not exceed/
    );
    expect(
      checkDefaults(cur, { memoryMax: '100M', memoryHigh: '100M' }, base, [], {}).errors
    ).toHaveLength(2);
    const ok = checkDefaults(cur, { memoryHigh: '40G', memoryMax: '48G' }, base, [agent], {});
    expect(ok.errors).toEqual([]);
    expect(ok.changes).toEqual({ memoryHigh: '40G', memoryMax: '48G' });
    const heavy = unit({ ...agent, current: 50 * G });
    expect(
      checkDefaults(cur, { memoryHigh: '40G', memoryMax: '48G' }, base, [heavy], {}).belowCurrent
    ).toEqual([heavy]);
    // An agent with its own hard limit keeps it, so it is not at risk.
    expect(
      checkDefaults(cur, { memoryHigh: '40G', memoryMax: '48G' }, base, [heavy], {
        [heavy.name]: { MemoryMax: '60G' },
      }).belowCurrent
    ).toEqual([]);
  });

  it('parses agents, the default, overrides and pods, and tolerates old backends', () => {
    const st = parseState({
      agentSlice: 'app-t3code-agents.slice',
      t3: { agentSlice: 'app-t3code-agents.slice', agents: 1 },
      agentDefault: { file: '/x/50-agent-cap.conf', memoryHigh: 60 * G, memoryMax: null },
      overrides: { 't3code-claude-1.scope': { MemoryMax: '24G' } },
      pods: {
        current: 700,
        max: 1000,
        classes: [{ class: 'burstable', pods: 2, current: 500, anon: 300, file: 200 }],
      },
      units: [
        {
          name: 't3code-claude-1.scope',
          kind: 'scope',
          peak: 9,
          agent: { provider: 'claude', id: '1', sessionId: 's\u202E1', resumed: 1 },
        },
        { name: 'b.slice', kind: 'slice' },
      ],
    });
    expect(st.units[0].agent).toEqual({
      provider: 'claude',
      id: '1',
      sessionId: 's1',
      resumed: true,
    });
    expect(st.units[0].peak).toBe(9);
    expect(st.units[1].agent).toBeUndefined();
    expect(st.units[1].displayName).toBe('b.slice');
    expect(st.t3.agents).toBe(1);
    expect(st.agentDefault).toEqual({
      file: '/x/50-agent-cap.conf',
      memoryHigh: 60 * G,
      memoryMax: null,
    });
    expect(st.overrides['t3code-claude-1.scope'].MemoryMax).toBe('24G');
    expect(st.pods?.classes[0]).toEqual({
      class: 'burstable',
      pods: 2,
      current: 500,
      anon: 300,
      file: 200,
    });
    const old = parseState({});
    expect(old.agentSlice).toBe('');
    expect(old.agentDefault).toBeNull();
    expect(old.pods).toBeNull();
    expect(old.overrides).toEqual({});
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
          agent: { provider: 'claude', id: '1', cwd: '/t\u2067x' },
        },
      ],
    });
    expect(st.units[0].displayName).toBe('proj / evil');
    expect(st.units[0].agent?.cwd).toBe('/tx');
  });
});

describe('process trees', () => {
  const raw = {
    total: 6,
    shown: 6,
    roots: [
      { pid: 9, ppid: 1, command: 'tail -f x', rss: 100, reparented: true },
      {
        pid: 10,
        ppid: 2,
        command: 'zsh‮\u001b[31m',
        state: 'S',
        rss: 10,
        children: [
          { pid: 12, ppid: 10, command: 'small', rss: 5 },
          {
            pid: 11,
            ppid: 10,
            command: 'node',
            rss: 50,
            children: [{ pid: 13, ppid: 11, command: 'rg', rss: 500 }],
          },
        ],
      },
    ],
  };

  it('cleans text, recomputes subtree totals and orders largest subtree first', () => {
    const t = parseProcTree(raw)!;
    expect(t.roots.map(r => r.pid)).toEqual([10, 9]);
    const zsh = t.roots[0];
    expect(zsh.command).toBe('zsh[31m');
    expect(zsh.subtreeRss).toBe(10 + 5 + 50 + 500);
    expect(zsh.subtreeProcs).toBe(4);
    expect(zsh.children.map(c => c.pid)).toEqual([11, 12]);
    expect(t.roots[1].reparented).toBe(true);
    expect(zsh.reparented).toBe(false);
  });

  it('tolerates missing or malformed trees', () => {
    expect(parseProcTree(undefined)).toBeUndefined();
    expect(parseProcTree({ roots: 'x' })).toBeUndefined();
    const t = parseProcTree({ roots: [null, { pid: 'a', rss: -5, children: 'no' }] })!;
    expect(t.roots).toHaveLength(1);
    expect(t.roots[0].pid).toBe(0);
    expect(t.roots[0].rss).toBe(0);
  });

  it('bounds hostile depth', () => {
    let n: any = { pid: 1, command: 'leaf', rss: 1 };
    for (let i = 0; i < 500; i++) n = { pid: 2, command: 'x', rss: 1, children: [n] };
    const t = parseProcTree({ roots: [n] })!;
    expect(t.shown).toBeLessThanOrEqual(65);
  });

  it('flattens only the visible rows', () => {
    const t = parseProcTree(raw)!;
    expect(visibleProcesses(t, new Set()).map(r => [r.node.pid, r.depth])).toEqual([
      [10, 0],
      [11, 1],
      [13, 2],
      [12, 1],
      [9, 0],
    ]);
    const rows = visibleProcesses(t, new Set([11]));
    expect(rows.map(r => r.node.pid)).toEqual([10, 11, 12, 9]);
    expect(rows[1]).toMatchObject({ hasChildren: true, expanded: false });
  });

  it('is parsed by parseState and searchable by process command', () => {
    const st = parseState({
      units: [
        { name: 'a.scope', kind: 'scope', processes: raw },
        { name: 'b.slice', kind: 'slice' },
      ],
    });
    expect(st.units[0].processes?.roots).toHaveLength(2);
    expect(st.units[1].processes).toBeUndefined();
    expect(processCommands(st.units[0].processes)).toContain('rg');
    expect(matchesFilter(st.units[0], 'tail -f')).toBe(true);
    expect(matchesFilter(st.units[1], 'tail -f')).toBe(false);
  });
});

describe('windowed events and stall time', () => {
  const win = (events: Record<string, number>, fullUs = 0) =>
    unit({
      eventsLocal: { high: 147740, max: 270917, oom: 0, oom_kill: 2 },
      pressureFull: { ...zero, totalUs: 9e12 },
      eventsWindow: { windowSeconds: 600, partial: false, reset: false, events },
      pressureWindow: { windowSeconds: 600, partial: false, reset: false, someUs: fullUs, fullUs },
    });

  it('does not highlight a unit with old lifetime events and none in the window', () => {
    const u = win({ high: 0, max: 0, oom: 0, oom_kill: 0 });
    for (const k of ['high', 'max', 'oom', 'oom_kill']) {
      expect(windowedEvent(u, k)).toEqual({ n: 0, active: false });
    }
    expect(stallLevel(u)).toBe('default');
  });

  it('highlights from the window only', () => {
    const u = win({ high: 3, max: 1240 }, 12e6);
    expect(windowedEvent(u, 'max')).toEqual({ n: 1240, active: true });
    expect(stallLevel(u)).toBe('error');
  });

  it('parses the window fields and tolerates their absence', () => {
    const st = parseState({
      units: [
        {
          name: 'a',
          eventsWindow: { windowSeconds: 30, partial: true, events: { max: 4 } },
          pressureWindow: { fullUs: 2e6 },
        },
        { name: 'b' },
      ],
    });
    expect(st.units[0].eventsWindow?.events.max).toBe(4);
    expect(st.units[0].pressureWindow?.fullUs).toBe(2e6);
    expect(st.units[1].eventsWindow).toBeUndefined();
  });

  it('formats spans and stall time', () => {
    expect(formatSpan(600)).toBe('10 min');
    expect(formatSpan(45)).toBe('45 s');
    expect(formatStall(0)).toBe('0 s');
    expect(formatStall(3.4e6)).toBe('3.4 s');
    expect(formatStall(150e6)).toBe('2.5 min');
  });
});

describe('agent warnings', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const w = (time: string, over: object = {}) => ({
    time,
    unit: 'a.scope',
    displayName: 'proj / chat',
    threadId: '273f3474',
    agent: 'claude',
    types: ['hard-limit'],
    message: 'm',
    sent: true,
    ...over,
  });

  it('keeps the last 24 hours, newest first, and drops older warnings', () => {
    const out = parseWarnings(
      [
        w('2026-10-05T10:00:00Z'),
        w('2026-10-04T11:59:00Z'),
        w('2026-10-05T11:00:00Z', { sent: false, error: 'agent_blocked' }),
      ],
      now
    );
    expect(out.map(x => x.time)).toEqual(['2026-10-05T11:00:00.000Z', '2026-10-05T10:00:00.000Z']);
    expect(out[0].sent).toBe(false);
  });

  it('tolerates a missing or malformed list', () => {
    expect(parseWarnings(undefined, now)).toEqual([]);
    expect(parseWarnings([null, { time: 'nope' }], now)).toEqual([]);
    expect(parseState({}).warnings).toEqual([]);
    expect(parseState({}).warningPolicy.enabled).toBe(false);
  });
});
