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
import { HoardView, sectionsOf } from './HoardView';
import { joinHoard } from './join';

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
