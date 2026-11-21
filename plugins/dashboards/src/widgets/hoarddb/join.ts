/*
 * The join behind the HoardDB widget. Four panels of the HoardDB source say different things about
 * the same engines: `engines` (health, instance count and database count), `clusters` (ready
 * instances and, in the detail line, the nodes), `replication` (one row for each standby, with its
 * node and status) and `failback` (the node of the primary). The join runs in the browser. It needs
 * no server change.
 *
 * The result is one entry for each engine, with one section for each node that runs the engine. The
 * source has no per-instance status for most engines. A section takes the status of its standby row
 * when it has one. Otherwise it takes the status of its cluster, when every instance of the cluster
 * is ready. When an instance is not ready and the source does not say which one, the sections of
 * that engine have the status "unknown", and the engine itself keeps the real status.
 */
import type {
  PanelInstanceRole,
  PanelModel,
  PanelRow,
  PanelRowCount,
  PanelRowIcon,
  PanelStatus,
} from '../panels/model';

export interface HoardNode {
  /** The node name, or "instance 2" when the source names no nodes. */
  name: string;
  status: PanelStatus;
  primary: boolean;
  /** A short reason for a status that is not ok. */
  note?: string;
  /** The instance name. Only set when the source sends the `instances` field. */
  instance?: string;
  /** The role of the instance. Only set when the source sends the `instances` field. */
  role?: PanelInstanceRole;
}

export interface HoardEngine {
  /** The engine name, for example "postgres". */
  name: string;
  status: PanelStatus;
  /** The databases of the engine. Undefined when the source gives no database count. */
  databases?: number;
  /** The live count of the engine (databases, namespaces, buckets or queues). */
  count?: PanelRowCount;
  /** The text under the icon: the count with a short unit, or the old value text, or "no count". */
  countText: string;
  /** True when the sections come from the `instances` field and not from the text join. */
  fromInstances: boolean;
  nodes: HoardNode[];
  icon?: PanelRowIcon;
  /** The raw link of the engine row. The widget maps it to the HoardDB tab. */
  link?: string;
  /** A short reason for a status that is not ok. */
  issue?: string;
}

export interface HoardModel {
  engines: HoardEngine[];
  /** Every node name once, sorted. */
  nodes: string[];
  /** The status of each node across all engines (the worst of its sections). */
  nodeStatus: Record<string, PanelStatus>;
  databases: number;
  healthy: number;
  summary: string;
  /** The summary with the reason of the worst issue. */
  summaryTitle: string;
  status: PanelStatus;
}

export interface HoardPanels {
  engines?: PanelModel | null;
  clusters?: PanelModel | null;
  replication?: PanelModel | null;
  failback?: PanelModel | null;
}

const RANK: Record<PanelStatus, number> = { ok: 0, unknown: 1, warn: 2, crit: 3 };
export const worse = (a: PanelStatus, b: PanelStatus): PanelStatus => (RANK[b] > RANK[a] ? b : a);

/** The words for a status in this widget: degraded for a warning and down for a critical status. */
export const ENGINE_WORD: Record<PanelStatus, string> = {
  ok: 'OK',
  warn: 'Degraded',
  crit: 'Down',
  unknown: 'Unknown',
};

/** The short form of a count unit, in the singular and in the plural. */
const UNIT_WORDS: Record<string, [string, string]> = {
  databases: ['db', 'dbs'],
  namespaces: ['ns', 'ns'],
  buckets: ['bucket', 'buckets'],
  queues: ['queue', 'queues'],
};

/** The count with its short unit, for example "14 dbs", "3 ns", "5 buckets" or "1 queue". */
export function countText(count: PanelRowCount): string {
  const words = UNIT_WORDS[count.unit.toLowerCase()];
  const unit = words ? words[count.value === 1 ? 0 : 1] : count.unit;
  return `${count.value} ${unit}`;
}

/** The old value text of a row. A dash or an empty value is no count. */
const valueText = (value: string): string => {
  const v = value.trim();
  return /^[-\u2013\u2014]*$/.test(v) ? '' : v;
};

const canon = (s: string): string => s.trim().toLowerCase();

const nodesOf = (detail: string): string[] => {
  const m = /\bnodes ([^]+?)(?:, home\b|$)/.exec(detail);
  return m
    ? m[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : [];
};
const primaryNodeOf = (detail: string): string | undefined =>
  /\bprimary node ([^,\s]+)/.exec(detail)?.[1] ?? /\bnode ([^,\s]+)/.exec(detail)?.[1];
const instancesOf = (detail: string): number | undefined => {
  const m = /(\d+) instances?\b/.exec(detail);
  return m ? Number(m[1]) : undefined;
};
const databasesOf = (value: string): number | undefined => {
  const m = /^(\d+)\s*dbs?$/i.exec(value.trim());
  return m ? Number(m[1]) : undefined;
};
const readyOf = (row: PanelRow | undefined): { ready: number; total: number } | undefined => {
  const m = row ? /^(\d+)\s*\/\s*(\d+)$/.exec(row.value.trim()) : null;
  return m ? { ready: Number(m[1]), total: Number(m[2]) } : undefined;
};

const byLabel = (p: PanelModel | null | undefined): Map<string, PanelRow> =>
  new Map((p?.rows ?? []).map(r => [canon(r.label), r]));

/** The standby rows of the replication panel: label "engine/pod", detail "node <name>". */
function standbysOf(p: PanelModel | null | undefined): Map<string, Map<string, PanelRow>> {
  const out = new Map<string, Map<string, PanelRow>>();
  for (const r of p?.rows ?? []) {
    const slash = r.label.indexOf('/');
    const node = /\bnode ([^,\s]+)/.exec(r.detail)?.[1];
    if (slash < 0 || !node) continue;
    const engine = canon(r.label.slice(0, slash));
    const map = out.get(engine) ?? new Map<string, PanelRow>();
    map.set(node, r);
    out.set(engine, map);
  }
  return out;
}

export function joinHoard(panels: HoardPanels): HoardModel {
  const engineRows = byLabel(panels.engines);
  const clusterRows = byLabel(panels.clusters);
  const failRows = byLabel(panels.failback);
  const standbys = standbysOf(panels.replication);
  // The engines panel sets the order. An engine that only another panel names comes after.
  const order = [...engineRows.keys()];
  for (const k of [...clusterRows.keys(), ...failRows.keys()])
    if (!order.includes(k)) order.push(k);

  const engines: HoardEngine[] = order.map(key => {
    const engine = engineRows.get(key);
    const cluster = clusterRows.get(key);
    const fail = failRows.get(key);
    const stand = standbys.get(key) ?? new Map<string, PanelRow>();
    const row = engine ?? cluster ?? fail;
    const name = row?.label.trim() ?? key;
    const primary =
      primaryNodeOf(cluster?.detail ?? '') ?? primaryNodeOf(fail?.detail ?? '') ?? undefined;
    const names = new Set<string>(nodesOf(cluster?.detail ?? ''));
    if (primary) names.add(primary);
    for (const n of stand.keys()) names.add(n);
    const ready = readyOf(cluster);
    const total = instancesOf(engine?.detail ?? '') ?? ready?.total ?? names.size;
    const allReady = ready ? ready.ready >= ready.total : cluster ? cluster.status === 'ok' : true;
    const clusterStatus = cluster?.status ?? engine?.status ?? 'unknown';
    const issueText = ready && !allReady ? `${ready.ready} of ${ready.total} instances ready` : '';
    const sorted = [...names].sort((a, b) =>
      a === primary ? -1 : b === primary ? 1 : a.localeCompare(b)
    );
    // No node names: one unnamed section for each instance.
    const labels =
      sorted.length > 0
        ? sorted
        : Array.from({ length: Math.max(total, 1) }, (_, i) => `instance ${i + 1}`);
    const given = engine?.instances;
    const fromInstances = given !== undefined && given.length > 0;
    const textNodes = (): HoardNode[] =>
      labels.map(label => {
        const standby = stand.get(label);
        const isPrimary = label === primary || (primary === undefined && labels.length === 1);
        let status: PanelStatus;
        let note: string | undefined;
        if (standby) {
          status = standby.status;
          note = standby.status === 'ok' ? undefined : standby.value;
        } else if (allReady || ready?.ready === 0) {
          // Every instance is ready, or none is: the cluster status is the status of each node.
          status = clusterStatus;
        } else {
          status = 'unknown';
          note = `${issueText}. The source does not say which one.`;
        }
        return { name: label, status, primary: isPrimary, note };
      });
    // One section for each instance, in the order of the source, with the status of the instance.
    const nodes: HoardNode[] = fromInstances
      ? given.map(i => ({
          name: i.node !== '' ? i.node : i.name,
          status: i.status,
          primary: i.role === 'primary' || i.role === 'single',
          note: i.reason,
          instance: i.name,
          role: i.role,
        }))
      : textNodes();
    let status: PanelStatus = engine?.status ?? clusterStatus;
    if (cluster) status = worse(status, cluster.status);
    const failing = nodes.find(n => n.status !== 'ok' && n.status !== 'unknown');
    if (fromInstances) {
      // An instance that is not ok makes the engine at least degraded. The row status can say more.
      if (nodes.some(n => n.status !== 'ok')) status = worse(status, 'warn');
    } else {
      for (const n of nodes)
        if (n.status === 'warn' || n.status === 'crit') status = worse(status, n.status);
    }
    const badInstance = nodes.find(n => n.status !== 'ok');
    const issue =
      status === 'ok'
        ? undefined
        : fromInstances && issueText === '' && badInstance
        ? `${badInstance.instance} on ${badInstance.name} ${ENGINE_WORD[
            badInstance.status
          ].toLowerCase()}${badInstance.note ? `: ${badInstance.note}` : ''}`
        : issueText !== ''
        ? issueText
        : failing
        ? `node ${failing.name} ${ENGINE_WORD[failing.status].toLowerCase()}`
        : `${ENGINE_WORD[status].toLowerCase()}`;
    return {
      name,
      status,
      databases: engine?.count
        ? engine.count.unit.toLowerCase() === 'databases'
          ? engine.count.value
          : undefined
        : databasesOf(engine?.value ?? ''),
      count: engine?.count,
      countText: engine?.count
        ? countText(engine.count)
        : valueText(engine?.value ?? '') || 'no count',
      fromInstances,
      nodes,
      icon: engine?.icon ?? cluster?.icon ?? fail?.icon,
      link: engine?.link ?? cluster?.link ?? fail?.link,
      issue,
    };
  });

  const nodeStatus: Record<string, PanelStatus> = {};
  for (const e of engines)
    for (const n of e.nodes) {
      if (/^instance \d+$/.test(n.name)) continue;
      if (n.instance !== undefined && n.name === n.instance) continue;
      nodeStatus[n.name] = n.name in nodeStatus ? worse(nodeStatus[n.name], n.status) : n.status;
    }
  const nodes = Object.keys(nodeStatus).sort((a, b) => a.localeCompare(b));
  const databases = engines.reduce((s, e) => s + (e.databases ?? 0), 0);
  const healthy = engines.filter(e => e.status === 'ok').length;
  let status: PanelStatus = engines.length === 0 ? 'unknown' : 'ok';
  let worst: HoardEngine | undefined;
  for (const e of engines) {
    status = worse(status, e.status);
    if (e.status !== 'ok' && (!worst || RANK[e.status] > RANK[worst.status])) worst = e;
  }
  const base = `${healthy} of ${engines.length} engines healthy, ${databases} ${
    databases === 1 ? 'database' : 'databases'
  }`;
  const word = worst ? ENGINE_WORD[worst.status].toLowerCase() : '';
  const summary = worst ? `${base}. Worst: ${worst.name} ${word}` : base;
  // The full reason, for the title of the summary line.
  const summaryTitle =
    worst?.issue && worst.issue !== word ? `${summary}, ${worst.issue}` : summary;
  return { engines, nodes, nodeStatus, databases, healthy, summary, summaryTitle, status };
}
