import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render } from '@testing-library/react';
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

import { parsePanel } from '../panels/model';
import { HoardDetailView } from './HoardDetailWidget';
import { HoardSummaryView, STORE_ICONS, stripLabel } from './HoardSummaryWidget';
import { detailRows, detailSummary, sizeOf, summaryTiles, type TabPanels } from './tab';

afterEach(cleanup);

const LINK = 'https://data.example.com/engines';
const PG = { src: 'icons/pg.svg', alt: 'PostgreSQL' };
const KV = { src: 'icons/kv.svg', alt: 'KV' };
const D1 = { src: 'icons/sqlite.svg', alt: 'SQLite' };

const panel = (
  id: string,
  rows: Array<Record<string, unknown>>,
  more: Record<string, unknown> = {}
) =>
  parsePanel({
    version: 1,
    id,
    title: id,
    status: 'ok',
    summary: '',
    stats: [],
    link: LINK,
    rows: rows.map(r => ({ detail: '', value: '', status: 'ok', link: LINK, ...r })),
    ...more,
  });

const inst = (name: string, node: string, role: string, status = 'ok', reason?: string) => ({
  name,
  node,
  role,
  status,
  ...(reason ? { reason } : {}),
});

/** Three engines: a healthy postgres, a kv and a sqlite. Each can be made worse. */
function panels(over: { kvStatus?: string; backup?: string; lag?: string } = {}): TabPanels {
  const kvStatus = over.kvStatus ?? 'ok';
  return {
    engines: panel(
      'engines',
      [
        {
          label: 'postgres',
          detail: 'cnpg, 4 instances, probed 8s ago',
          value: '14 dbs',
          icon: PG,
          count: { value: 14, unit: 'databases' },
          instances: [
            inst('pg-3', 'hq', 'primary'),
            inst('pg-1', 'n1', 'standby'),
            inst('pg-2', 'n2', 'standby'),
          ],
        },
        {
          label: 'kv',
          detail: 'kv, hoard-raft, 3 instances',
          value: '-',
          icon: KV,
          status: kvStatus,
          count: { value: 3, unit: 'namespaces' },
          instances: [
            inst('kv-0', 'hq', 'primary'),
            inst('kv-1', 'n1', 'replica', kvStatus === 'ok' ? 'ok' : 'crit', 'no heartbeat'),
          ],
        },
        {
          label: 'sqlite',
          detail: 'sqlite, hoard-raft, 1 instances',
          value: '-',
          icon: D1,
          count: { value: 8, unit: 'databases' },
          instances: [inst('d1-0', 'hq', 'primary')],
        },
      ],
      { summary: '3 engines' }
    ),
    clusters: panel('clusters', [
      {
        label: 'postgres',
        detail: 'primary pg-3, primary node hq, home hq, 1.2 TiB used, backup ok 3h ago',
        value: '3/3',
      },
      {
        label: 'kv',
        detail: 'kv, hoard-raft, nodes hq, n1, home hq',
        value: kvStatus === 'ok' ? '2/2' : '1/2',
        status: kvStatus,
      },
      { label: 'sqlite', detail: 'sqlite, nodes hq, home hq', value: '1/1' },
    ]),
    failback: panel(
      'failback',
      [
        { label: 'postgres', detail: 'primary pg-3, node hq, home hq', value: 'home' },
        {
          label: 'kv',
          detail: 'primary kv-1, node n1, home hq',
          value: kvStatus === 'ok' ? 'home' : 'away 2h',
          status: kvStatus === 'ok' ? 'ok' : 'warn',
        },
        { label: 'sqlite', detail: 'primary d1-0, node hq, home hq', value: 'home' },
      ],
      { status: kvStatus === 'ok' ? 'ok' : 'warn', summary: '2 of 3 engines at home' }
    ),
    services: panel('services', [
      { label: 'd1', detail: 'drill never_run', value: 'ready', icon: D1 },
      { label: 'kv', detail: 'drill never_run', value: 'ready', icon: KV },
    ]),
    replication: panel(
      'replication',
      [
        { label: 'postgres/pg-1', detail: 'node n1', value: '0.0 s' },
        {
          label: 'postgres/pg-2',
          detail: 'node n2',
          value: over.lag ?? '0.0 s',
          status: over.lag ? 'warn' : 'ok',
        },
      ],
      { stats: [{ label: 'Max lag', value: over.lag ?? '0.0 s', status: 'ok' }] }
    ),
    storage: panel('storage', [], {
      summary: '160.1 GiB used by 2 tenants',
      stats: [
        { label: 'Total size', value: '160.1 Gi', status: 'ok' },
        { label: 'Databases', value: '14', status: 'ok' },
      ],
    }),
    backups: panel(
      'backups',
      [
        { label: 'app', detail: 'postgres, ok', value: '3h' },
        {
          label: 'walt',
          detail: 'postgres, failing',
          value: '31h',
          status: over.backup ?? 'ok',
        },
      ],
      { status: over.backup ?? 'ok', summary: '1 of 2 backups ok' }
    ),
  };
}

describe('sizeOf', () => {
  it('takes the size at the start of the storage summary', () => {
    expect(sizeOf('160.1 GiB used by 2 tenants')).toBe('160.1 GiB');
    expect(sizeOf('1.5 TiB used')).toBe('1.5 TiB');
    expect(sizeOf('2 tenants')).toBeUndefined();
  });
});

describe('summaryTiles', () => {
  it('gives one tile for each engine, then one for each store', () => {
    const t = summaryTiles(panels());
    expect(t.map(x => x.key)).toEqual([
      'engine-postgres',
      'engine-kv',
      'engine-sqlite',
      'failback',
      'replication',
      'services',
      'backups',
      'storage',
    ]);
    expect(t.slice(0, 3).map(x => [x.label, x.value])).toEqual([
      ['postgres', '14 dbs'],
      ['kv', '3 ns'],
      ['sqlite', '8 dbs'],
    ]);
  });

  it('shows the node of the primary and its failback state on the engine tile', () => {
    const t = summaryTiles(panels({ kvStatus: 'crit' }));
    expect(t[0].note).toBe('hq, home');
    expect(t[1].note).toBe('n1, away 2h');
    expect(t[1].title).toContain('Primary node n1, away 2h');
  });

  it('counts the rows of the failback, services and backups panels', () => {
    const ok = Object.fromEntries(summaryTiles(panels()).map(x => [x.key, x]));
    expect([ok.failback.value, ok.failback.label]).toEqual(['3/3', 'at home']);
    expect([ok.services.value, ok.services.label]).toEqual(['2/2', 'services ready']);
    expect([ok.backups.value, ok.backups.label]).toEqual(['2/2', 'backups ok']);
    const bad = Object.fromEntries(
      summaryTiles(panels({ kvStatus: 'crit', backup: 'crit' })).map(x => [x.key, x])
    );
    expect([bad.failback.value, bad.failback.status]).toEqual(['2/3', 'warn']);
    expect([bad.backups.value, bad.backups.status]).toEqual(['1/2', 'crit']);
    expect(bad.backups.title).toContain('walt: 31h, postgres, failing');
    expect(bad.failback.title).toContain('kv: away 2h');
  });

  it('shows the worst lag, the standby count and the storage size', () => {
    const t = Object.fromEntries(summaryTiles(panels({ lag: '6.2 s' })).map(x => [x.key, x]));
    expect(t.replication.value).toBe('6.2 s');
    expect(t.replication.label).toBe('lag, 2 standbys');
    expect(t.replication.status).toBe('warn');
    expect(t.storage.value).toBe('160.1 GiB');
    expect(t.storage.note).toBe('14 databases');
  });

  it('makes the engine tile not ok when one instance is not ok', () => {
    const t = summaryTiles(panels({ kvStatus: 'crit' }));
    expect(t[1].status).toBe('crit');
    expect(t[1].title).toContain('kv: Down');
  });

  it('leaves out the tile of a panel that is missing', () => {
    const p = panels();
    const t = summaryTiles({ engines: p.engines, storage: p.storage });
    expect(t.map(x => x.kind)).toEqual(['engine', 'engine', 'engine', 'storage']);
    expect(summaryTiles({})).toEqual([]);
  });

  it('has a bundled icon name for each store tile', () => {
    for (const t of summaryTiles(panels()).filter(x => x.kind !== 'engine'))
      expect(STORE_ICONS[t.kind as keyof typeof STORE_ICONS]).toMatch(/^mdi:/);
  });
});

describe('detailRows', () => {
  it('joins the engines, clusters, failback and services panels in one row', () => {
    const rows = detailRows(panels());
    expect(rows.map(r => r.name)).toEqual(['postgres', 'kv', 'sqlite']);
    const pg = rows[0];
    expect(pg.headline).toBe('cnpg, 4 instances, probed 8s ago');
    expect(pg.count).toBe('14 dbs');
    expect(pg.ready).toBe('3/3');
    expect(pg.failback?.value).toBe('home');
    expect(pg.clusterDetail).toContain('1.2 TiB used, backup ok 3h ago');
    expect(pg.nodes.map(n => [n.instance, n.name, n.role])).toEqual([
      ['pg-3', 'hq', 'primary'],
      ['pg-1', 'n1', 'standby'],
      ['pg-2', 'n2', 'standby'],
    ]);
    expect(pg.service).toBeUndefined();
  });

  it('matches a data service to its engine by the icon file', () => {
    const rows = detailRows(panels());
    expect(rows.find(r => r.name === 'sqlite')?.service?.label).toBe('d1');
    expect(rows.find(r => r.name === 'kv')?.service).toMatchObject({
      label: 'kv',
      value: 'ready',
      detail: 'drill never_run',
    });
  });

  it('puts the worst engine first and keeps the order of the others', () => {
    const rows = detailRows(panels({ kvStatus: 'crit' }));
    expect(rows.map(r => r.name)).toEqual(['kv', 'postgres', 'sqlite']);
    expect(rows[0].status).toBe('crit');
    expect(rows[0].ready).toBe('1/2');
    expect(rows[0].issue).toBe('1 of 2 instances ready');
    expect(rows[0].failback).toMatchObject({ value: 'away 2h', status: 'warn' });
  });

  it('works with the engines panel alone', () => {
    const rows = detailRows({ engines: panels().engines });
    expect(rows).toHaveLength(3);
    expect(rows[0].ready).toBeUndefined();
    expect(rows[0].failback).toBeUndefined();
    expect(rows[0].clusterDetail).toBeUndefined();
    expect(detailRows({})).toEqual([]);
  });
});

describe('detailSummary', () => {
  it('says that every engine is healthy', () => {
    expect(detailSummary(detailRows(panels()))).toEqual({
      text: '3 of 3 engines healthy',
      status: 'ok',
    });
  });

  it('names the worst engine and the reason', () => {
    const s = detailSummary(detailRows(panels({ kvStatus: 'crit' })));
    expect(s.status).toBe('crit');
    expect(s.text).toMatch(/^2 of 3 engines healthy\. Worst: kv down/);
  });

  it('handles no engines', () => {
    expect(detailSummary([])).toEqual({ text: 'No engines', status: 'unknown' });
  });
});

const theme = createTheme({ palette: { mode: 'dark' } });
const wrap = (ui: React.ReactNode) =>
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>
  );

describe('HoardSummaryView', () => {
  it('draws each tile with its value, label and status, and tints a tile that is not ok', () => {
    const { container } = wrap(
      <HoardSummaryView panels={panels({ kvStatus: 'crit', backup: 'crit' })} source={undefined} />
    );
    const tiles = [...container.querySelectorAll('[data-tile]')];
    expect(tiles).toHaveLength(8);
    const kv = container.querySelector('[data-tile="engine-kv"]');
    expect(kv?.getAttribute('data-tile-status')).toBe('crit');
    expect(kv?.querySelector('[data-tile-value]')?.textContent).toBe('3 ns');
    expect(kv?.querySelector('[data-tile-note]')?.textContent).toBe('n1, away 2h');
    expect(container.querySelector('[data-tile="backups"] [data-tile-value]')?.textContent).toBe(
      '1/2'
    );
    expect(
      container.querySelector('[data-tile="storage"] [data-tile-icon="storage"]')
    ).not.toBeNull();
    expect(container.textContent).not.toMatch(/\+\s*\d+\s*more|\d+ more|Other/);
  });

  it('has a list label that names every tile that is not ok', () => {
    const t = summaryTiles(panels({ kvStatus: 'crit', backup: 'crit' }));
    expect(stripLabel(t)).toBe('HoardDB summary: kv down, at home degraded, backups ok down');
    expect(stripLabel(summaryTiles(panels()))).toBe('HoardDB summary: everything is fine');
  });
});

describe('HoardDetailView', () => {
  it('starts with every row folded and shows the worst first', () => {
    const { container } = wrap(
      <HoardDetailView panels={panels({ kvStatus: 'crit' })} source={undefined} />
    );
    const rows = [...container.querySelectorAll('[data-engine-row]')];
    expect(rows.map(r => r.getAttribute('data-engine-row'))).toEqual(['kv', 'postgres', 'sqlite']);
    expect(rows.every(r => r.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(container.querySelector('[data-engine-body]')).toBeNull();
    const kv = rows[0];
    expect(kv.querySelector('[data-engine-ready]')?.textContent).toBe('1/2');
    expect(kv.querySelector('[data-engine-failback]')?.textContent).toBe('away 2h');
    expect(kv.querySelector('[data-engine-count]')?.textContent).toBe('3 ns');
    expect(kv.querySelector('[data-engine-headline]')?.textContent).toContain(
      '1 of 2 instances ready. kv, hoard-raft, 3 instances'
    );
    expect(container.querySelector('[data-detail-summary]')?.textContent).toMatch(
      /^2 of 3 engines healthy\. Worst: kv down/
    );
  });

  it('opens a row with a click or the keyboard and shows its instances and facts', () => {
    const { container } = wrap(
      <HoardDetailView panels={panels({ kvStatus: 'crit' })} source={undefined} />
    );
    const kv = container.querySelector('[data-engine-row="kv"]') as HTMLElement;
    fireEvent.click(kv);
    expect(kv.getAttribute('aria-expanded')).toBe('true');
    const body = container.querySelector('[data-engine-body]') as HTMLElement;
    const facts = [...body.querySelectorAll('[data-fact]')].map(f => f.textContent);
    expect(facts).toEqual([
      'kv-0, node hq, primary',
      'kv-1, node n1, replica, no heartbeat',
      'kv, hoard-raft, nodes hq, n1, home hq',
      'Failback: away 2h, primary kv-1, node n1, home hq',
      'Service kv: ready, drill never_run',
    ]);
    // The other rows stay folded.
    expect(
      container.querySelector('[data-engine-row="postgres"]')?.getAttribute('aria-expanded')
    ).toBe('false');
    fireEvent.keyDown(kv, { key: 'Enter' });
    expect(kv.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-engine-body]')).toBeNull();
    fireEvent.keyDown(kv, { key: ' ' });
    expect(kv.getAttribute('aria-expanded')).toBe('true');
  });

  it('leaves the failback detail out when the primary is home (it repeats the instances)', () => {
    const { container } = wrap(<HoardDetailView panels={panels()} source={undefined} />);
    fireEvent.click(container.querySelector('[data-engine-row="postgres"]') as HTMLElement);
    const fb = container.querySelector('[data-engine-body] [data-fact="failback"]');
    expect(fb?.textContent).toBe('Failback: home');
  });
});
