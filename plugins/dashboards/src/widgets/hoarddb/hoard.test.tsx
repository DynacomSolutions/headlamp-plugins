import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn(), clusterRequest: vi.fn() },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));

import { LinkContext } from '../../links';
import { parsePanel } from '../panels/model';
import { engineTitle, HoardView, sectionsOf } from './HoardView';
import { countText, joinHoard } from './join';

afterEach(cleanup);

const LINK = 'https://data.example.com/engines';
const panel = (id: string, rows: Array<Record<string, unknown>>) =>
  parsePanel({
    version: 1,
    id,
    title: id,
    status: 'ok',
    summary: '',
    stats: [],
    rows: rows.map(r => ({ detail: '', value: '', status: 'ok', link: LINK, ...r })),
  });

const engines = (over: Record<string, Partial<{ status: string; detail: string }>> = {}) =>
  panel('engines', [
    {
      label: 'postgres',
      detail: 'cnpg, 3 instances, probed 8s ago',
      value: '13 dbs',
      icon: { src: 'icons/pg.svg', alt: 'PostgreSQL' },
      ...over.postgres,
    },
    { label: 'kv', detail: 'kv, hoard-raft, 3 instances', value: '-', ...over.kv },
    { label: 'queue', detail: 'queue, single, 1 instances', value: '-', ...over.queue },
  ]);
const clusters = (over: Record<string, Partial<{ status: string; value: string }>> = {}) =>
  panel('clusters', [
    {
      label: 'postgres',
      detail: 'primary p-3, primary node n1, home n1, 1 TiB used',
      value: '3/3',
      ...over.postgres,
    },
    { label: 'kv', detail: 'kv, hoard-raft, nodes n1, n2, n3, home n1', value: '3/3', ...over.kv },
    { label: 'queue', detail: 'queue, single, nodes n1, home n1', value: '1/1', ...over.queue },
  ]);
const replication = (status = 'ok') =>
  panel('replication', [
    { label: 'postgres/p-1', detail: 'node n2', value: '0.0 s', status },
    { label: 'postgres/p-2', detail: 'node n3', value: '0.0 s' },
  ]);
const failback = panel('failback', [
  { label: 'kv', detail: 'primary kv-0, node n1, home n1', value: 'home' },
]);

describe('joinHoard', () => {
  it('gives one section for each node, with the primary marked', () => {
    const m = joinHoard({
      engines: engines(),
      clusters: clusters(),
      replication: replication(),
      failback,
    });
    expect(m.engines.map(e => e.name)).toEqual(['postgres', 'kv', 'queue']);
    const pg = m.engines[0];
    expect(pg.databases).toBe(13);
    expect(pg.nodes.map(n => [n.name, n.primary, n.status])).toEqual([
      ['n1', true, 'ok'],
      ['n2', false, 'ok'],
      ['n3', false, 'ok'],
    ]);
    expect(m.engines[1].databases).toBeUndefined();
    expect(m.engines[1].nodes.map(n => n.name)).toEqual(['n1', 'n2', 'n3']);
    expect(m.nodes).toEqual(['n1', 'n2', 'n3']);
    expect(m.databases).toBe(13);
    expect(m.summary).toBe('3 of 3 engines healthy, 13 databases');
    expect(m.status).toBe('ok');
  });

  it('takes the status of a standby row for its node', () => {
    const m = joinHoard({
      engines: engines({ postgres: { status: 'warn' } }),
      clusters: clusters(),
      replication: replication('warn'),
    });
    const pg = m.engines[0];
    expect(pg.nodes.find(n => n.name === 'n2')?.status).toBe('warn');
    expect(pg.nodes.find(n => n.name === 'n3')?.status).toBe('ok');
    expect(pg.status).toBe('warn');
    expect(m.summary).toBe('2 of 3 engines healthy, 13 databases. Worst: postgres degraded');
  });

  it('marks the sections unknown when an instance is missing and the source does not say which', () => {
    const m = joinHoard({
      engines: engines({ kv: { status: 'warn' } }),
      clusters: clusters({ kv: { status: 'warn', value: '2/3' } }),
    });
    const kv = m.engines[1];
    expect(kv.nodes.map(n => n.status)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(kv.status).toBe('warn');
    expect(kv.issue).toBe('2 of 3 instances ready');
    expect(m.summary).toContain('Worst: kv degraded');
    expect(m.summaryTitle).toContain('Worst: kv degraded, 2 of 3 instances ready');
  });

  it('gives every node the cluster status when no instance is ready', () => {
    const m = joinHoard({
      engines: engines({ queue: { status: 'crit' } }),
      clusters: clusters({ queue: { status: 'crit', value: '0/1' } }),
    });
    expect(m.engines[2].nodes.map(n => n.status)).toEqual(['crit']);
    expect(m.summary).toBe('2 of 3 engines healthy, 13 databases. Worst: queue down');
    expect(m.summaryTitle).toBe(
      '2 of 3 engines healthy, 13 databases. Worst: queue down, 0 of 1 instances ready'
    );
  });

  it('names the worst engine first and treats critical as down', () => {
    const m = joinHoard({
      engines: engines({ queue: { status: 'crit' }, kv: { status: 'warn' } }),
      clusters: clusters(),
    });
    expect(m.status).toBe('crit');
    expect(m.summary).toMatch(/Worst: queue down/);
  });

  it('works with an engine panel only and with an unknown future engine', () => {
    const m = joinHoard({
      engines: panel('engines', [
        { label: 'vector', detail: 'vector, single, 2 instances', value: '4 dbs' },
      ]),
    });
    expect(m.engines[0].nodes.map(n => n.name)).toEqual(['instance 1', 'instance 2']);
    expect(m.nodes).toEqual([]);
    expect(m.databases).toBe(4);
    expect(joinHoard({}).summary).toBe('0 of 0 engines healthy, 0 databases');
    expect(joinHoard({}).status).toBe('unknown');
  });
});

describe('sectionsOf', () => {
  it('draws a full ring for one node and equal sections for more', () => {
    const m = joinHoard({ engines: engines(), clusters: clusters(), replication: replication() });
    expect(sectionsOf(m.engines[2])).toHaveLength(1);
    expect(sectionsOf(m.engines[0])).toHaveLength(3);
    expect(sectionsOf(m.engines[0]).filter(s => s.primary)).toHaveLength(1);
  });
});

function view(
  model: ReturnType<typeof joinHoard>,
  targets = { base: '', dashboard: 'ops', tabs: ['hoarddb'] }
) {
  return render(
    <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
      <MemoryRouter>
        <LinkContext.Provider value={targets}>
          <HoardView model={model} source={undefined} sourceId="hoarddb" editing={false} />
        </LinkContext.Provider>
      </MemoryRouter>
    </ThemeProvider>
  );
}

describe('HoardView', () => {
  const model = joinHoard({
    engines: engines(),
    clusters: clusters(),
    replication: replication('warn'),
  });

  it('draws one tile for each engine with its name, count and one section for each node', () => {
    const { container } = view(model);
    expect(container.querySelectorAll('[data-engine]')).toHaveLength(3);
    expect(
      container.querySelector('[data-engine="postgres"] [data-engine-count]')?.textContent
    ).toBe('13 dbs');
    expect(container.querySelector('[data-engine="kv"] [data-engine-count]')?.textContent).toBe(
      'no count'
    );
    expect(container.querySelectorAll('[data-engine="postgres"] [data-section]')).toHaveLength(3);
    expect(
      container
        .querySelector('[data-engine="postgres"] [data-section="n2"]')
        ?.getAttribute('data-section-status')
    ).toBe('warn');
    expect(container.querySelectorAll('[data-engine="postgres"] [data-primary-dot]')).toHaveLength(
      1
    );
    expect(
      container.querySelector('[data-engine="postgres"] [data-section="n2"] title')?.textContent
    ).toContain('n2');
  });

  it('draws a legend of the nodes and the summary, and no "more" row', () => {
    const { container } = view(model);
    expect([...container.querySelectorAll('[data-legend-node]')].map(n => n.textContent)).toEqual([
      'n1',
      'n2',
      'n3',
    ]);
    expect(container.querySelector('[data-hoard-summary]')?.textContent).toContain(
      '2 of 3 engines healthy, 13 databases'
    );
    expect(container.textContent).not.toMatch(/\+\s*\d+\s*more|\d+ more|Other/);
  });

  it('links each tile only to the HoardDB tab', () => {
    const { container } = view(model);
    const hrefs = [...container.querySelectorAll('a')].map(a => a.getAttribute('href'));
    expect(hrefs).toHaveLength(3);
    for (const h of hrefs) expect(h).toBe('/dashboards/ops/hoarddb');
  });

  it('has no link when the dashboard has no HoardDB tab', () => {
    const { container } = view(model, { base: '', dashboard: 'ops', tabs: [] });
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });
});

const inst = (
  name: string,
  node: string,
  role: string,
  status = 'ok',
  reason?: string
): Record<string, unknown> => ({ name, node, role, status, ...(reason ? { reason } : {}) });

/** An engines panel with the live fields: a count and the instances for each row. */
const live = (critical = false) =>
  panel('engines', [
    {
      label: 'postgres',
      detail: 'cnpg, 3 instances',
      value: '14 dbs',
      status: critical ? 'warn' : 'ok',
      icon: { src: 'icons/pg.svg', alt: 'PostgreSQL' },
      count: { value: 14, unit: 'databases' },
      instances: [
        inst('db-1', 'node-a', 'primary'),
        inst('db-2', 'node-b', 'standby'),
        inst(
          'db-3',
          'node-c',
          'standby',
          critical ? 'critical' : 'ok',
          critical ? 'replication stopped' : undefined
        ),
      ],
    },
    {
      label: 'kv',
      detail: 'kv, 2 instances',
      value: '-',
      count: { value: 3, unit: 'namespaces' },
      instances: [inst('kv-0', 'node-a', 'primary'), inst('kv-1', 'node-b', 'replica')],
    },
    {
      label: 'objectstore',
      detail: 'single',
      value: '-',
      count: { value: 1, unit: 'buckets' },
      instances: [inst('os-0', 'node-a', 'single')],
    },
    {
      label: 'queue',
      detail: 'single',
      value: '-',
      count: { value: 2, unit: 'queues' },
      instances: [inst('q-0', 'node-a', 'single')],
    },
  ]);

describe('parsePanel: count and instances', () => {
  it('reads count and instances, and maps warning and critical', () => {
    const row = live(true).rows[0];
    expect(row.count).toEqual({ value: 14, unit: 'databases' });
    expect(row.instances?.map(i => [i.name, i.node, i.role, i.status, i.reason])).toEqual([
      ['db-1', 'node-a', 'primary', 'ok', undefined],
      ['db-2', 'node-b', 'standby', 'ok', undefined],
      ['db-3', 'node-c', 'standby', 'crit', 'replication stopped'],
    ]);
  });

  it('drops bad values and never throws', () => {
    const p = panel('engines', [
      {
        label: 'x',
        count: { value: 'many', unit: 'databases' },
        instances: [{ node: 'node-a' }, 7, { name: 'i-1', role: 'boss', status: 'fine' }],
      },
      { label: 'y', count: { value: -1, unit: 'queues' }, instances: [] },
      { label: 'z', count: 'five', instances: 'no' },
    ]);
    expect(p.rows[0].count).toBeUndefined();
    expect(p.rows[0].instances).toEqual([
      { name: 'i-1', node: '', role: 'unknown', status: 'unknown' },
    ]);
    expect(p.rows[1].count).toBeUndefined();
    expect(p.rows[1].instances).toBeUndefined();
    expect(p.rows[2].count).toBeUndefined();
    expect(p.rows[2].instances).toBeUndefined();
  });
});

describe('joinHoard with the live fields', () => {
  it('uses the count and one section for each instance, in the order of the source', () => {
    const m = joinHoard({ engines: live() });
    expect(m.engines.map(e => e.countText)).toEqual(['14 dbs', '3 ns', '1 bucket', '2 queues']);
    const pg = m.engines[0];
    expect(pg.fromInstances).toBe(true);
    expect(pg.nodes.map(n => [n.instance, n.name, n.role, n.primary, n.status])).toEqual([
      ['db-1', 'node-a', 'primary', true, 'ok'],
      ['db-2', 'node-b', 'standby', false, 'ok'],
      ['db-3', 'node-c', 'standby', false, 'ok'],
    ]);
    expect(m.engines[2].nodes[0].primary).toBe(true);
    expect(m.nodes).toEqual(['node-a', 'node-b', 'node-c']);
    expect(m.databases).toBe(14);
    expect(m.summary).toBe('4 of 4 engines healthy, 14 databases');
  });

  it('does not use the text join when the instances exist', () => {
    const m = joinHoard({
      engines: live(),
      clusters: clusters(),
      replication: replication('warn'),
      failback,
    });
    expect(m.engines[0].nodes.map(n => n.name)).toEqual(['node-a', 'node-b', 'node-c']);
    expect(m.engines[0].nodes.every(n => n.status === 'ok')).toBe(true);
  });

  it('makes the engine at least degraded when an instance is not ok', () => {
    const m = joinHoard({ engines: live(true) });
    const pg = m.engines[0];
    expect(pg.nodes[2].status).toBe('crit');
    expect(pg.nodes[2].note).toBe('replication stopped');
    expect(pg.status).toBe('warn');
    expect(pg.issue).toBe('db-3 on node-c down: replication stopped');
    expect(m.summary).toBe('3 of 4 engines healthy, 14 databases. Worst: postgres degraded');
    expect(m.summaryTitle).toContain('db-3 on node-c down: replication stopped');
    expect(m.nodeStatus['node-c']).toBe('crit');
  });

  it('raises an ok row to degraded for an instance that is not ok, and keeps a worse row status', () => {
    const rows = (rowStatus: string) =>
      panel('engines', [
        {
          label: 'kv',
          status: rowStatus,
          instances: [
            inst('kv-0', 'node-a', 'primary'),
            inst('kv-1', 'node-b', 'replica', 'unknown'),
          ],
        },
      ]);
    expect(joinHoard({ engines: rows('ok') }).engines[0].status).toBe('warn');
    expect(joinHoard({ engines: rows('crit') }).engines[0].status).toBe('crit');
  });

  it('formats the units', () => {
    expect(countText({ value: 1, unit: 'databases' })).toBe('1 db');
    expect(countText({ value: 0, unit: 'databases' })).toBe('0 dbs');
    expect(countText({ value: 1, unit: 'namespaces' })).toBe('1 ns');
    expect(countText({ value: 5, unit: 'buckets' })).toBe('5 buckets');
    expect(countText({ value: 2, unit: 'queues' })).toBe('2 queues');
    expect(countText({ value: 4, unit: 'streams' })).toBe('4 streams');
  });
});

describe('joinHoard without the live fields', () => {
  it('falls back to the value text, then to "no count"', () => {
    const m = joinHoard({
      engines: panel('engines', [
        { label: 'a', value: '13 dbs' },
        { label: 'b', value: '7 topics' },
        { label: 'c', value: '-' },
        { label: 'd', value: '' },
      ]),
    });
    expect(m.engines.map(e => e.countText)).toEqual(['13 dbs', '7 topics', 'no count', 'no count']);
    expect(m.engines.map(e => e.fromInstances)).toEqual([false, false, false, false]);
    expect(m.engines[0].databases).toBe(13);
  });

  it('keeps the count when only the count is missing, and the ring when only instances are missing', () => {
    const only = panel('engines', [
      {
        label: 'kv',
        detail: 'kv, 1 instances',
        count: { value: 3, unit: 'namespaces' },
        instances: [{ nothing: true }],
      },
    ]);
    const m = joinHoard({ engines: only });
    expect(m.engines[0].countText).toBe('3 ns');
    expect(m.engines[0].fromInstances).toBe(false);
    expect(m.engines[0].nodes.map(n => n.name)).toEqual(['instance 1']);
  });
});

describe('HoardView with the live fields', () => {
  it('shows the count under each icon and one coloured segment for each instance', () => {
    const { container } = view(joinHoard({ engines: live(true) }));
    const counts = [...container.querySelectorAll('[data-engine-count]')].map(n => n.textContent);
    expect(counts).toEqual(['14 dbs', '3 ns', '1 bucket', '2 queues']);
    const pg = container.querySelectorAll('[data-engine="postgres"] [data-section]');
    expect([...pg].map(n => n.getAttribute('data-section-status'))).toEqual(['ok', 'ok', 'crit']);
    expect(container.querySelectorAll('[data-engine="postgres"] [data-primary-dot]')).toHaveLength(
      1
    );
    expect(
      container.querySelectorAll('[data-engine="objectstore"] [data-primary-dot]')
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-engine="postgres"]')?.getAttribute('data-engine-status')
    ).toBe('warn');
  });

  it('puts instance, node, role, status and reason in the segment tooltip and the icon tooltip', () => {
    const { container } = view(joinHoard({ engines: live(true) }));
    const seg = container.querySelector('[data-engine="postgres"] [data-instance="db-3"] title');
    expect(seg?.textContent).toBe(
      'postgres, instance db-3, node node-c, role standby, status down, reason: replication stopped'
    );
    const ok = container.querySelector('[data-engine="postgres"] [data-instance="db-1"] title');
    expect(ok?.textContent).toBe('postgres, instance db-1, node node-a, role primary, status ok');
    const icon = container.querySelector('[data-engine="postgres"] [data-ring-hit] title');
    expect(icon?.textContent).toContain('postgres: Degraded, 14 dbs');
    expect(icon?.textContent).toContain(
      'db-3, node node-c, role standby, status down, reason: replication stopped'
    );
    const m = joinHoard({ engines: live(true) });
    expect(icon?.textContent).toBe(engineTitle(m.engines[0]));
  });

  it('keeps the legend, the summary and no "more" or "Other" row', () => {
    const { container } = view(joinHoard({ engines: live(true) }));
    expect([...container.querySelectorAll('[data-legend-node]')].map(n => n.textContent)).toEqual([
      'node-a',
      'node-b',
      'node-c',
    ]);
    expect(container.querySelector('[data-hoard-summary]')?.textContent).toBe(
      '3 of 4 engines healthy, 14 databases. Worst: postgres degraded'
    );
    expect(container.textContent).not.toMatch(/\+\s*\d+\s*more|\d+ more|Other/);
  });
});
