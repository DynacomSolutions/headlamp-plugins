/*
 * The logic behind the HoardDB tab widgets (`hoarddb.summary` and `hoarddb.detail`). The source has
 * seven panels: `engines`, `clusters`, `failback`, `services`, `replication`, `storage` and
 * `backups`. The old tab drew each one as its own card, and three of them (engines, clusters and
 * failback) told the same story about the same engines. This file joins them in the browser:
 *
 * - `summaryTiles` gives one tile for each engine and one tile for each store (failback,
 *   replication, services, backups and storage), each with a key number and a status.
 * - `detailRows` gives one row for each engine, the worst first, with the facts of the engines,
 *   clusters, failback and services panels. The instances of the engine are the folded part.
 *
 * Nothing here needs a change in the source. A panel that is missing leaves its facts out.
 */
import type { PanelModel, PanelRow, PanelRowIcon, PanelStatus } from '../panels/model';
import { bySeverity } from '../panels/tokens';
import { ENGINE_WORD, type HoardNode, joinHoard, worse } from './join';

/** The ids of the panels that the HoardDB tab reads. */
export const TAB_PANELS = [
  'engines',
  'clusters',
  'failback',
  'services',
  'replication',
  'storage',
  'backups',
] as const;
export type TabPanelId = (typeof TAB_PANELS)[number];
export type TabPanels = Partial<Record<TabPanelId, PanelModel | null>>;

const canon = (s: string): string => s.trim().toLowerCase();

/** The node that holds the primary, from a detail text such as "primary p-3, primary node hq, home hq". */
const primaryNodeOf = (detail: string): string | undefined =>
  /\bprimary node ([^,\s]+)/.exec(detail)?.[1] ?? /\bnode ([^,\s]+)/.exec(detail)?.[1];

const rowsOf = (p: PanelModel | null | undefined): PanelRow[] => p?.rows ?? [];

const countOk = (rows: PanelRow[]): number => rows.filter(r => r.status === 'ok').length;

/** The worst status of a list of rows. No rows: unknown. */
export function worstOf(rows: ReadonlyArray<{ status: PanelStatus }>): PanelStatus {
  return rows.reduce<PanelStatus>((a, r) => worse(a, r.status), rows.length ? 'ok' : 'unknown');
}

export type TileKind = 'engine' | 'failback' | 'replication' | 'services' | 'backups' | 'storage';

export interface SummaryTile {
  key: string;
  kind: TileKind;
  /** The big text: a count, a ratio or a size. */
  value: string;
  /** The small text under the value: the engine name or the thing that the value counts. */
  label: string;
  /** An optional third line, for example the node of the primary. */
  note?: string;
  status: PanelStatus;
  /** The row icon of an engine tile. Store tiles have a bundled icon instead (see the view). */
  icon?: PanelRowIcon;
  /** The tooltip: the reason for a status that is not ok, and the facts behind the numbers. */
  title: string;
}

/** The value of the stat with this label, matched without case. */
const statOf = (p: PanelModel | null | undefined, label: RegExp): string | undefined =>
  p?.stats.find(s => label.test(s.label))?.value;

/** The size at the start of the summary text, for example "160.1 GiB" in "160.1 GiB used by 2 tenants". */
export const sizeOf = (summary: string): string | undefined =>
  /^\s*([\d.,]+\s?[KMGTPE]i?B)\b/.exec(summary)?.[1];

/** One tile for the rows of a store panel: `ok of total`, with the status of the panel. */
function ratioTile(
  kind: TileKind,
  p: PanelModel | null | undefined,
  label: string,
  words: string
): SummaryTile | undefined {
  if (!p) return undefined;
  const rows = p.rows;
  const bad = rows.filter(r => r.status !== 'ok');
  return {
    key: kind,
    kind,
    value: rows.length === 0 ? '-' : `${countOk(rows)}/${rows.length}`,
    label,
    status: worse(p.status, worstOf(rows) === 'unknown' ? 'ok' : worstOf(rows)),
    title: [
      p.summary || `${words}: ${countOk(rows)} of ${rows.length}`,
      ...bad.map(r => `${r.label}: ${r.value}${r.detail ? `, ${r.detail}` : ''}`),
    ].join('\n'),
  };
}

/** The tiles of the summary strip: the engines first, then the stores. */
export function summaryTiles(panels: TabPanels): SummaryTile[] {
  const model = joinHoard({
    engines: panels.engines,
    clusters: panels.clusters,
    replication: panels.replication,
    failback: panels.failback,
  });
  const failRows = new Map(rowsOf(panels.failback).map(r => [canon(r.label), r]));
  const clusterRows = new Map(rowsOf(panels.clusters).map(r => [canon(r.label), r]));
  const tiles: SummaryTile[] = model.engines.map(e => {
    const fail = failRows.get(canon(e.name));
    const cluster = clusterRows.get(canon(e.name));
    const node = primaryNodeOf(fail?.detail ?? '') ?? primaryNodeOf(cluster?.detail ?? '');
    const place = node ? `${node}${fail ? `, ${fail.value}` : ''}` : undefined;
    return {
      key: `engine-${e.name}`,
      kind: 'engine',
      value: e.countText,
      label: e.name,
      note: place,
      status: e.status,
      icon: e.icon,
      title: [
        `${e.name}: ${ENGINE_WORD[e.status]}, ${e.countText}`,
        ...(e.issue ? [e.issue] : []),
        ...(place ? [`Primary node ${place}`] : []),
      ].join('\n'),
    };
  });

  const fail = panels.failback;
  if (fail) {
    const t = ratioTile('failback', fail, 'at home', 'Engines at home');
    if (t) tiles.push(t);
  }
  const rep = panels.replication;
  if (rep) {
    const lag = statOf(rep, /max lag/i);
    tiles.push({
      key: 'replication',
      kind: 'replication',
      value: lag ?? (rep.rows.length === 0 ? '-' : `${rep.rows.length}`),
      label: `lag, ${rep.rows.length} ${rep.rows.length === 1 ? 'standby' : 'standbys'}`,
      status: worse(rep.status, worstOf(rep.rows) === 'unknown' ? 'ok' : worstOf(rep.rows)),
      title: [
        rep.summary,
        ...rep.rows.filter(r => r.status !== 'ok').map(r => `${r.label}: ${r.value}, ${r.detail}`),
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
  const services = ratioTile('services', panels.services, 'services ready', 'Services ready');
  if (services) tiles.push(services);
  const backups = ratioTile('backups', panels.backups, 'backups ok', 'Backups ok');
  if (backups) tiles.push(backups);
  const st = panels.storage;
  if (st) {
    tiles.push({
      key: 'storage',
      kind: 'storage',
      value: sizeOf(st.summary) ?? statOf(st, /total size/i) ?? '-',
      label: 'used',
      note: statOf(st, /databases/i) ? `${statOf(st, /databases/i)} databases` : undefined,
      status: st.status,
      title: st.summary,
    });
  }
  return tiles;
}

export interface DetailRow {
  name: string;
  status: PanelStatus;
  icon?: PanelRowIcon;
  /** The line under the name: what the engines panel says (kind, instances, probe age). */
  headline: string;
  /** The count of the engine, for example "14 dbs". */
  count: string;
  /** Ready over total instances from the clusters panel, for example "4/4". */
  ready?: string;
  readyStatus: PanelStatus;
  /** The failback state: "home", or the words of the source when the primary is away. */
  failback?: { value: string; status: PanelStatus; detail: string };
  /** The detail of the clusters panel: primary, home, storage and backup facts. */
  clusterDetail?: string;
  /** The data service of the engine, matched by icon: readiness and last restore drill. */
  service?: { label: string; value: string; status: PanelStatus; detail: string };
  /** A short reason for a status that is not ok. */
  issue?: string;
  /** The instances, in the order of the source. Shown when the row is open. */
  nodes: HoardNode[];
}

/** One row for each engine, the worst first. */
export function detailRows(panels: TabPanels): DetailRow[] {
  const model = joinHoard({
    engines: panels.engines,
    clusters: panels.clusters,
    replication: panels.replication,
    failback: panels.failback,
  });
  const clusterRows = new Map(rowsOf(panels.clusters).map(r => [canon(r.label), r]));
  const failRows = new Map(rowsOf(panels.failback).map(r => [canon(r.label), r]));
  const engineRows = new Map(rowsOf(panels.engines).map(r => [canon(r.label), r]));
  const services = rowsOf(panels.services);
  const rows = model.engines.map<DetailRow>(e => {
    const key = canon(e.name);
    const cluster = clusterRows.get(key);
    const fail = failRows.get(key);
    const engine = engineRows.get(key);
    // A data service belongs to the engine that has the same icon file (d1 and sqlite, queues and queue).
    const svc = e.icon ? services.find(s => s.icon?.src === e.icon?.src) : undefined;
    return {
      name: e.name,
      status: e.status,
      icon: e.icon,
      headline: engine?.detail ?? '',
      count: e.countText,
      ready: cluster?.value || undefined,
      readyStatus: cluster?.status ?? 'ok',
      failback: fail ? { value: fail.value, status: fail.status, detail: fail.detail } : undefined,
      clusterDetail: cluster?.detail || undefined,
      service: svc
        ? { label: svc.label, value: svc.value, status: svc.status, detail: svc.detail }
        : undefined,
      issue: e.issue,
      nodes: e.nodes,
    };
  });
  return bySeverity(rows);
}

/** The summary line of the detail list: the engines, the worst first reason. */
export function detailSummary(rows: ReadonlyArray<DetailRow>): {
  text: string;
  status: PanelStatus;
} {
  const bad = rows.filter(r => r.status !== 'ok');
  const status = rows.length === 0 ? 'unknown' : worstOf(rows);
  if (rows.length === 0) return { text: 'No engines', status };
  if (bad.length === 0) return { text: `${rows.length} of ${rows.length} engines healthy`, status };
  const first = bad[0];
  return {
    text: `${rows.length - bad.length} of ${rows.length} engines healthy. Worst: ${
      first.name
    } ${ENGINE_WORD[first.status].toLowerCase()}${
      first.issue && first.issue !== ENGINE_WORD[first.status].toLowerCase()
        ? `, ${first.issue}`
        : ''
    }`,
    status,
  };
}
