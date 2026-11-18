/*
 * The per-node tree a CPU or memory sunburst draws. A node's value is its own measured total
 * including descendants, so a parent may exceed the sum of its children (the gap stays empty).
 * Children that sum to more than their parent (sampling skew) are scaled down to fit.
 */
import type { AgentHost, AgentProc, AgentUnit } from './agents';
import { GENERIC, iconForContainer, iconForNamespace, iconForProcess } from './appIcons';
import { processLabel, unitLabel } from './labels';
import type { NodeMetrics } from './types';

export type Resource = 'cpu' | 'memory';

export interface SunNode {
  key: string;
  label: string;
  value: number;
  kind:
    | 'node'
    | 'category'
    | 'namespace'
    | 'pod'
    | 'container'
    | 'orchestrator'
    | 'control'
    | 'project'
    | 'thread'
    | 'process'
    | 'system'
    | 'unused';
  icon?: {
    kind: 'file' | 'lucide' | 'mdi' | 'simple-icons';
    name?: string;
    src?: string;
    color?: string;
  };
  href?: string;
  children: SunNode[];
}

export interface NodeTree {
  root: SunNode;
  capacity: number;
  used: number | null;
  hostMetrics: boolean;
  /** The first ring is one arc per node (more than one node selected), not the categories. */
  nodeRing?: boolean;
}

/** The categories the dashboard can filter, in display order. */
export const CATEGORIES: { id: string; label: string }[] = [
  { id: 'k8s', label: 'Kubernetes' },
  { id: 't3', label: 'T3 Code' },
  { id: 'herdr', label: 'Herdr' },
  { id: 'other', label: 'Other scopes' },
  { id: 'system', label: 'System' },
];

/** The filter id of a top-level arc: an orchestrator this list does not know counts as other. */
export function categoryId(key: string): string {
  return CATEGORIES.some(c => c.id === key) ? key : 'other';
}

const UNKNOWN_PROJECT = 'Unknown project';

function sum(nodes: SunNode[]): number {
  return nodes.reduce((s, n) => s + n.value, 0);
}

function byValue(a: SunNode, b: SunNode): number {
  return b.value - a.value;
}

function node(
  key: string,
  label: string,
  kind: SunNode['kind'],
  value: number,
  children: SunNode[] = [],
  extra: Partial<SunNode> = {}
): SunNode {
  return { key, label, kind, value, children: children.filter(c => c.value > 0), ...extra };
}

/** Scales children down (and their subtrees, top-down) so they never exceed the parent. */
function fitChildren(parent: SunNode): void {
  const total = sum(parent.children);
  if (total > parent.value && total > 0) {
    const f = parent.value / total;
    for (const c of parent.children) c.value *= f;
  }
  parent.children = parent.children.filter(c => c.value > 0);
  for (const c of parent.children) fitChildren(c);
}

function kubernetes(m: NodeMetrics, r: Resource): SunNode {
  const val = (p: { cpuCores: number; memBytes: number }) =>
    r === 'cpu' ? p.cpuCores : p.memBytes;
  const nss = new Map<string, Map<string, SunNode[]>>();
  for (const p of m.pods) {
    const v = val(p);
    if (!(v > 0)) continue;
    const pods = nss.get(p.namespace) ?? new Map<string, SunNode[]>();
    nss.set(p.namespace, pods);
    const cs = pods.get(p.pod) ?? [];
    pods.set(p.pod, cs);
    cs.push(
      node(`c:${p.container}`, p.container, 'container', v, [], {
        icon: iconForContainer(p.container, p.namespace),
      })
    );
  }
  const nsNodes: SunNode[] = [];
  for (const [ns, pods] of nss) {
    const nsKey = `k8s/ns:${ns}`;
    const podNodes: SunNode[] = [];
    for (const [pod, cs] of pods) {
      const podKey = `${nsKey}/pod:${pod}`;
      for (const c of cs) c.key = `${podKey}/${c.key}`;
      // A pod looks like its biggest container that is a known app, else a generic pod.
      const sorted = cs.sort(byValue);
      const known = sorted.find(c => c.icon?.name !== GENERIC.container.name);
      podNodes.push(
        node(podKey, pod, 'pod', sum(sorted), sorted, { icon: known?.icon ?? GENERIC.pod })
      );
    }
    nsNodes.push(
      node(nsKey, ns, 'namespace', sum(podNodes), podNodes.sort(byValue), {
        icon: iconForNamespace(ns),
      })
    );
  }
  return node('k8s', 'Kubernetes', 'category', sum(nsNodes), nsNodes.sort(byValue), {
    icon: { kind: 'mdi', name: 'kubernetes' },
  });
}

function procValue(p: AgentProc, r: Resource): number {
  return (
    (r === 'cpu' ? p.cpuCores ?? 0 : p.rss) + p.children.reduce((s, c) => s + procValue(c, r), 0)
  );
}

function procNodes(procs: AgentProc[], prefix: string, r: Resource): SunNode[] {
  return procs
    .map(p => {
      const key = `${prefix}/pid:${p.pid}`;
      return node(
        key,
        processLabel(p.command),
        'process',
        procValue(p, r),
        procNodes(p.children, key, r),
        { icon: iconForProcess(p.command) }
      );
    })
    .filter(n => n.value > 0)
    .sort(byValue);
}

const unitValue = (u: AgentUnit, r: Resource) => (r === 'cpu' ? u.cpuCores ?? 0 : u.memBytes);

function projectIcon(u: AgentUnit, iconSrc: (id: string) => string): SunNode['icon'] {
  if (u.icon?.kind === 'file' && u.projectId) {
    return { kind: 'file', src: iconSrc(u.projectId), color: u.icon.color };
  }
  if (u.icon?.kind === 'lucide') return { kind: 'lucide', name: u.icon.name, color: u.icon.color };
  return { kind: 'mdi', name: 'folder' };
}

const noRole = (u: AgentUnit) => !u.role;

/** Names of a unit's ancestors among `byName`, nearest first (stops on a cycle). */
function ancestors(u: AgentUnit, byName: Map<string, AgentUnit>): string[] {
  const out: string[] = [];
  let p = u.parent;
  while (p && !out.includes(p)) {
    out.push(p);
    p = byName.get(p)?.parent;
  }
  return out;
}

/**
 * Arcs for `units` nested by their parent links: a unit inside another listed unit becomes its
 * child arc, not a sibling, so nothing is counted twice. Each unit's own processes follow its
 * child units.
 */
function unitForest(
  units: AgentUnit[],
  prefix: string,
  kind: SunNode['kind'],
  byName: Map<string, AgentUnit>,
  r: Resource
): SunNode[] {
  const listed = new Set(units.map(u => u.name));
  const nearest = (u: AgentUnit) => ancestors(u, byName).find(a => listed.has(a));
  const build = (u: AgentUnit): SunNode => {
    const key = `${prefix}/u:${u.name}`;
    const kids = units.filter(c => nearest(c) === u.name).map(build);
    return node(key, unitLabel(u.name), kind, unitValue(u, r), [
      ...kids.sort(byValue),
      ...procNodes(u.procs, key, r),
    ]);
  };
  return units
    .filter(u => nearest(u) === undefined)
    .map(build)
    .filter(n => n.value > 0)
    .sort(byValue);
}

function orchestrator(
  name: string,
  title: string,
  units: AgentUnit[],
  r: Resource,
  iconSrc: (id: string) => string
): SunNode | null {
  const own = units.filter(u => u.orchestrator === name);
  const byName = new Map(own.map(u => [u.name, u]));
  const controls = own.filter(u => u.role === 'control');
  const controlNames = new Set(controls.map(u => u.name));
  // A control slice already includes the control units inside it: only the shallowest count.
  const topControls = controls.filter(u => !u.parent || !controlNames.has(u.parent));
  const slices = own.filter(u => u.role === 'agents');
  const sliceNames = new Set(slices.map(u => u.name));
  const agents = own.filter(u => u.role === 'agent');

  const controlNodes: SunNode[] = [];
  const controlValue = topControls.reduce((s, u) => s + unitValue(u, r), 0);
  if (controlValue > 0) {
    const key = `${name}/control`;
    const inner = controls.filter(u => !topControls.includes(u));
    controlNodes.push(
      node(
        key,
        `${title} itself`,
        'control',
        controlValue,
        [
          ...unitForest(inner, key, 'control', byName, r),
          ...procNodes(
            topControls.flatMap(u => u.procs),
            key,
            r
          ),
        ],
        { icon: { kind: 'mdi', name: 'cog' } }
      )
    );
  }

  const groups = new Map<string, { label: string; unit: AgentUnit; threads: SunNode[] }>();
  for (const u of agents) {
    const v = unitValue(u, r);
    if (!(v > 0)) continue;
    const gid = u.projectId || u.project || 'unknown';
    const g = groups.get(gid) ?? { label: u.project || UNKNOWN_PROJECT, unit: u, threads: [] };
    groups.set(gid, g);
    const key = `${name}/p:${gid}/t:${u.name}`;
    g.threads.push(
      node(key, u.thread || u.name, 'thread', v, procNodes(u.procs, key, r), {
        href: u.threadUrl,
        icon: GENERIC.thread,
      })
    );
  }
  const projects = [...groups.entries()].map(([gid, g]) =>
    node(`${name}/p:${gid}`, g.label, 'project', sum(g.threads), g.threads.sort(byValue), {
      icon: projectIcon(g.unit, iconSrc),
    })
  );
  const known = projects.filter(p => p.key !== `${name}/p:unknown`).sort(byValue);
  const unknown = projects.filter(p => p.key === `${name}/p:unknown`);

  // Other scopes: role-less scopes, and role-less sub-slices of an agents slice that hold no
  // agent scopes (a builds slice, say). A sub-slice that holds agents is drawn as its projects.
  const holdsAgents = new Set(agents.flatMap(a => ancestors(a, byName)));
  const others = own.filter(
    u =>
      noRole(u) &&
      !ancestors(u, byName).some(a => controlNames.has(a)) &&
      (u.kind === 'scope' ||
        (u.kind === 'slice' &&
          !holdsAgents.has(u.name) &&
          ancestors(u, byName).some(a => sliceNames.has(a))))
  );
  const otherItems = unitForest(others, `${name}/other`, 'thread', byName, r);
  const otherNodes = otherItems.length
    ? [
        node(`${name}/other`, 'Other scopes', 'project', sum(otherItems), otherItems, {
          icon: { kind: 'mdi', name: 'folder' },
        }),
      ]
    : [];

  // Role-less scopes outside every agents and control unit are not in either total yet.
  const outside = others
    .filter(u => !ancestors(u, byName).some(a => byName.has(a)))
    .reduce((s, u) => s + unitValue(u, r), 0);
  const agentsValue = slices.length
    ? slices.reduce((s, u) => s + unitValue(u, r), 0) + outside
    : sum(projects) + sum(otherNodes);
  const total = sum(controlNodes) + agentsValue;
  if (!(total > 0)) return null;
  return node(
    name,
    title,
    'orchestrator',
    total,
    [...controlNodes, ...known, ...unknown, ...otherNodes],
    { icon: { kind: 'mdi', name: /herdr/i.test(name) ? 'console' : 'robot' } }
  );
}

/** Role-less scopes that belong to no orchestrator. */
function otherScopes(units: AgentUnit[], r: Resource): SunNode | null {
  const items = units
    .filter(u => !u.orchestrator && u.kind === 'scope' && noRole(u))
    .map(u => {
      const key = `other/${u.name}`;
      return node(key, unitLabel(u.name), 'thread', unitValue(u, r), procNodes(u.procs, key, r));
    })
    .filter(n => n.value > 0)
    .sort(byValue);
  if (items.length === 0) return null;
  return node('other', 'Other scopes', 'category', sum(items), items, {
    icon: { kind: 'mdi', name: 'folder' },
  });
}

export function buildNodeTree(
  m: NodeMetrics,
  agents: AgentHost | null,
  r: Resource,
  iconSrc: (projectId: string) => string,
  categories: string[] = []
): NodeTree {
  const capacity = r === 'cpu' ? m.cpuCapacity : m.memCapacity;
  const used = r === 'cpu' ? m.cpuUsed : m.memUsed;
  const cats: SunNode[] = [kubernetes(m, r)];
  if (agents) {
    const names = agents.orchestrators.map(o => ({ name: o.name, title: o.title }));
    for (const u of agents.units) {
      if (u.orchestrator && !names.some(n => n.name === u.orchestrator)) {
        names.push({ name: u.orchestrator, title: u.orchestrator });
      }
    }
    for (const o of names) {
      const n = orchestrator(o.name, o.title, agents.units, r, iconSrc);
      if (n) cats.push(n);
    }
    const other = otherScopes(agents.units, r);
    if (other) cats.push(other);
  }
  const attributed = sum(cats);
  if (used !== null) {
    cats.push(
      node('system', 'System', 'system', Math.max(0, used - attributed), [], {
        icon: { kind: 'mdi', name: 'cog' },
      })
    );
  }
  // The root keeps the unfiltered total: a dropped category leaves its gap, nothing is rescaled.
  const kept = categories.length ? cats.filter(c => categories.includes(categoryId(c.key))) : cats;
  const root = node('root', m.node, 'node', used ?? attributed, kept);
  fitChildren(root);
  return { root, capacity, used, hostMetrics: used !== null };
}

/** The nodes along `path` (keys), starting with the root; stops at the deepest existing prefix. */
export function findPath(root: SunNode, path: string[]): SunNode[] {
  const out = [root];
  let cur = root;
  for (const k of path) {
    const next = cur.children.find(c => c.key === k);
    if (!next) break;
    out.push(next);
    cur = next;
  }
  return out;
}

/**
 * One tree for the selected nodes. One node gives that node's tree. More than one gives a root
 * whose first ring is one arc per node (key `node:<name>`), each sized by its own total and drawn
 * against the sum of the capacities, so the unused share stays empty. An empty `categories` keeps
 * every category.
 */
export function buildCombinedTree(
  metrics: NodeMetrics[],
  hostOf: (node: string) => AgentHost | null,
  r: Resource,
  iconSrc: (node: string, projectId: string) => string,
  categories: string[] = []
): NodeTree {
  const trees = metrics.map(m => ({
    m,
    t: buildNodeTree(m, hostOf(m.node), r, id => iconSrc(m.node, id), categories),
  }));
  if (trees.length === 1) return trees[0].t;
  const nodes = trees
    .map(({ m, t }) => ({ ...t.root, key: `node:${m.node}`, label: m.node, icon: GENERIC.node }))
    .filter(n => n.value > 0)
    .sort(byValue);
  const hostMetrics = trees.length > 0 && trees.every(x => x.t.hostMetrics);
  const total = sum(nodes);
  return {
    root: node('root', 'All selected nodes', 'node', total, nodes),
    capacity: trees.reduce((s, x) => s + x.t.capacity, 0),
    // Nodes without host metrics count by what is attributed to them.
    used: trees.some(x => x.t.used !== null) ? total : null,
    hostMetrics,
    nodeRing: true,
  };
}

/** Key suffix of the unused capacity at the root, and of space a parent holds but no child does. */
export const UNUSED = '~unused';
const EMPTY_ICON: NonNullable<SunNode['icon']> = { kind: 'mdi', name: 'selection-ellipse' };
export const UNATTRIBUTED = '~unattributed';
/** Gaps smaller than this share of their parent are not drawn: nobody can tap them. */
const MIN_GAP = 0.002;

/**
 * The empty space under `parent` as nodes of their own, so it can be drawn and selected:
 * "Unattributed" where the children sum to less than the parent, and at the root "Unused", the
 * capacity nothing uses. Keys are `<parent key>/~unattributed` and `<parent key>/~unused`.
 */
export function gapNodes(tree: NodeTree, parent: SunNode, atRoot: boolean): SunNode[] {
  const out: SunNode[] = [];
  const gap = parent.value - sum(parent.children);
  // A leaf has nothing below it, so it holds no unattributed space.
  const hasKids = parent.children.length > 0;
  if (parent.value > 0 && hasKids && gap / parent.value > MIN_GAP) {
    out.push({
      key: `${parent.key}/${UNATTRIBUTED}`,
      label: `Unattributed in ${parent.label}`,
      kind: 'unused',
      value: gap,
      icon: EMPTY_ICON,
      children: [],
    });
  }
  if (atRoot) {
    const free = tree.capacity - (tree.used ?? parent.value);
    if (tree.capacity > 0 && free / tree.capacity > MIN_GAP) {
      out.push({
        key: `${parent.key}/${UNUSED}`,
        label: 'Unused',
        kind: 'unused',
        icon: EMPTY_ICON,
        value: free,
        children: [],
      });
    }
  }
  return out;
}
