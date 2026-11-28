/*
 * The per-node tree a CPU or memory sunburst draws. A node's value is its own measured total
 * including descendants, so a parent may exceed the sum of its children (the gap stays empty).
 * Children that sum to more than their parent (sampling skew) are scaled down to fit.
 */
import type { AgentHost, AgentProc, AgentUnit } from './agentState';
import { GENERIC, iconForContainer, iconForNamespace, iconForProcess } from './appIcons';
import { cpuNote } from './cpuNote';
import { cgroupLabel, processLabel, unitLabel } from './labels';
import { applyNames, NameContext, NO_NAMES } from './names';
import type { NodeMetrics, RunnerInfo, SystemUsage } from './types';

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
    | 'runner'
    | 'repo'
    | 'workflow'
    | 'job'
    | 'run'
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
  /** Friendly name for arcs, centre, breadcrumb and lists; `label` stays the raw id. */
  displayName?: string;
  /** The raw command line of a process, its id. */
  command?: string;
  /** A thread's CPU limit and throttling, for the details strip. */
  note?: string;
  /**
   * Node ring only: the angular size of the node's wedge, its capacity or its use when that is
   * higher. `value` stays the use. Absent everywhere else.
   */
  span?: number;
  /** Node ring only: the node's own capacity, which `span` exceeds when the node is overcommitted. */
  capacity?: number;
  children: SunNode[];
}

export interface NodeTree {
  root: SunNode;
  capacity: number;
  used: number | null;
  hostMetrics: boolean;
  /** CPU trees only: where the used figure comes from and over what time. Absent when unknown or mixed. */
  source?: string;
  /** The first ring is one arc per node (more than one node selected), not the categories. */
  nodeRing?: boolean;
}

/** The categories the dashboard can filter, in display order. */
export const CATEGORIES: { id: string; label: string }[] = [
  { id: 'k8s', label: 'Kubernetes' },
  { id: 't3', label: 'T3 Code' },
  { id: 'herdr', label: 'Herdr' },
  { id: 'system', label: 'System' },
];

/**
 * The filter id of a top-level arc. It is the arc key. An orchestrator or scope the list does
 * not know has no filter entry of its own, so a category filter hides it (there is no catch-all).
 */
export function categoryId(key: string): string {
  return key;
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

const runnerIcon = {
  runner: { kind: 'mdi', name: 'dns' },
  repo: { kind: 'simple-icons', name: 'github' },
  workflow: { kind: 'mdi', name: 'code-braces' },
  job: { kind: 'mdi', name: 'hammer-wrench' },
  run: { kind: 'mdi', name: 'console' },
  warm: { kind: 'mdi', name: 'folder-outline' },
} as const satisfies Record<string, NonNullable<SunNode['icon']>>;

const WAITING = 'Waiting for job';
const UNKNOWN = 'unknown';

/** A runner pool tenant label `Owner.Repo`, split on the first dot only (a repo may start with one). */
export function splitTenant(tenant: string): { owner: string; repo: string } {
  const i = tenant.indexOf('.');
  if (i < 0) return { owner: tenant, repo: '' };
  return { owner: tenant.slice(0, i), repo: tenant.slice(i + 1) };
}

/** Where a runner pod sits in the runner pool rings: the group labels from the outer ring inwards. */
interface RunnerPath {
  /** Key, label and kind of each ring from the first one inside the namespace down. */
  rings: { key: string; label: string; kind: SunNode['kind']; icon: SunNode['icon'] }[];
  /** True when the containers sit straight under the last ring (a job run); else a pod arc holds them. */
  podLeaf: boolean;
}

/** The rings for a pod the runner pool manages, or null when it has too little to group by. */
function runnerPath(r: RunnerInfo): RunnerPath | null {
  const { tenant, pool, job } = r;
  if (job) {
    const t = splitTenant(tenant);
    const owner = job.owner || t.owner || UNKNOWN;
    const label = job.runsOn || pool || UNKNOWN;
    const repo = job.repo || t.repo || UNKNOWN;
    const wf = job.workflow || UNKNOWN;
    const jb = job.job || UNKNOWN;
    return {
      rings: [
        { key: `runner:${owner}|${label}`, label: `${owner} / ${label}`, kind: 'runner', icon: runnerIcon.runner },
        { key: `repo:${repo}`, label: repo, kind: 'repo', icon: runnerIcon.repo },
        { key: `wf:${wf}`, label: wf, kind: 'workflow', icon: runnerIcon.workflow },
        { key: `job:${jb}`, label: jb, kind: 'job', icon: runnerIcon.job },
        { key: `run:${job.runId || UNKNOWN}`, label: `#${job.runId || UNKNOWN}`, kind: 'run', icon: runnerIcon.run },
      ],
      podLeaf: true,
    };
  }
  if (tenant) {
    const t = splitTenant(tenant);
    const owner = t.owner || UNKNOWN;
    const label = pool || UNKNOWN;
    const repo = t.repo || tenant;
    return {
      rings: [
        { key: `runner:${owner}|${label}`, label: `${owner} / ${label}`, kind: 'runner', icon: runnerIcon.runner },
        { key: `repo:${repo}`, label: repo, kind: 'repo', icon: runnerIcon.repo },
        { key: 'wf:~waiting', label: WAITING, kind: 'workflow', icon: runnerIcon.workflow },
      ],
      podLeaf: false,
    };
  }
  if (pool || r.role === 'warm') {
    return {
      rings: [
        { key: 'runner:~warm', label: 'Warm pool', kind: 'runner', icon: runnerIcon.warm },
        { key: `pool:${pool || UNKNOWN}`, label: pool || UNKNOWN, kind: 'runner', icon: runnerIcon.warm },
      ],
      podLeaf: false,
    };
  }
  return null;
}

/** The own value of a subtree: leaves keep theirs, a group is the sum of its children. */
function rollUp(n: SunNode): number {
  if (n.children.length > 0) n.value = n.children.reduce((s, c) => s + rollUp(c), 0);
  return n.value;
}

function sortDeep(n: SunNode): void {
  n.children.sort(byValue);
  n.children.forEach(sortDeep);
}

/** Finds or adds the child with `key` under `parent`. A group starts at value 0 (see rollUp). */
function groupChild(parent: SunNode, p: RunnerPath['rings'][number], prefix: string): SunNode {
  const key = `${prefix}/${p.key}`;
  let c = parent.children.find(x => x.key === key);
  if (!c) {
    c = { key, label: p.label, kind: p.kind, value: 0, children: [], icon: p.icon };
    parent.children.push(c);
  }
  return c;
}

function kubernetes(m: NodeMetrics, r: Resource): SunNode {
  const val = (p: { cpuCores: number; memBytes: number }) =>
    r === 'cpu' ? p.cpuCores : p.memBytes;
  interface PodAcc {
    cs: SunNode[];
    runner?: RunnerInfo;
  }
  const nss = new Map<string, Map<string, PodAcc>>();
  for (const p of m.pods) {
    const v = val(p);
    if (!(v > 0)) continue;
    const pods = nss.get(p.namespace) ?? new Map<string, PodAcc>();
    nss.set(p.namespace, pods);
    const acc = pods.get(p.pod) ?? { cs: [] };
    pods.set(p.pod, acc);
    if (p.runner) acc.runner = p.runner;
    acc.cs.push(
      node(`c:${p.container}`, p.container, 'container', v, [], {
        icon: iconForContainer(p.container, p.namespace),
      })
    );
  }
  const nsNodes: SunNode[] = [];
  for (const [ns, pods] of nss) {
    const nsKey = `k8s/ns:${ns}`;
    const podNodes: SunNode[] = [];
    // Runner pool groups: built top-down by key, values rolled up from the container leaves.
    const holder: SunNode = { key: nsKey, label: ns, kind: 'namespace', value: 0, children: [] };
    for (const [pod, acc] of pods) {
      const podKey = `${nsKey}/pod:${pod}`;
      const path = acc.runner ? runnerPath(acc.runner) : null;
      // A pod looks like its biggest container that is a known app, else a generic pod.
      const sorted = acc.cs.sort(byValue);
      const known = sorted.find(c => c.icon?.name !== GENERIC.container.name);
      if (!path) {
        for (const c of sorted) c.key = `${podKey}/${c.key}`;
        podNodes.push(
          node(podKey, pod, 'pod', sum(sorted), sorted, { icon: known?.icon ?? GENERIC.pod })
        );
        continue;
      }
      let parent = holder;
      let prefix = nsKey;
      for (const ring of path.rings) {
        parent = groupChild(parent, ring, prefix);
        prefix = parent.key;
      }
      // A job run holds the containers itself; the pod id stays in their keys.
      const leafPrefix = `${prefix}/pod:${pod}`;
      for (const c of sorted) c.key = `${leafPrefix}/${c.key}`;
      if (path.podLeaf) {
        parent.children.push(...sorted);
      } else {
        parent.children.push({
          key: leafPrefix,
          label: pod,
          kind: 'pod',
          value: sum(sorted),
          children: sorted,
          icon: known?.icon ?? GENERIC.pod,
        });
      }
    }
    rollUp(holder);
    sortDeep(holder);
    const kids = [...podNodes, ...holder.children];
    nsNodes.push(
      node(nsKey, ns, 'namespace', sum(kids), kids.sort(byValue), {
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
        { icon: iconForProcess(p.command), command: p.command }
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
        href: u.threadUrl, // dashboard-links: allow data field, shown as a copy control, never as an anchor
        icon: GENERIC.thread,
        note: cpuNote(u),
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

  // Scopes with no role: role-less scopes, and role-less sub-slices of an agents slice that hold no
  // agent scopes (a builds slice, say). A sub-slice that holds agents is drawn as its projects.
  // Each one is its own arc under the orchestrator, with its own name. There is no bucket.
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
  const otherNodes = unitForest(others, name, 'thread', byName, r);

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

/** Role-less scopes that belong to no orchestrator: one category each, named after the scope. */
function looseScopes(units: AgentUnit[], r: Resource): SunNode[] {
  return units
    .filter(u => !u.orchestrator && u.kind === 'scope' && noRole(u))
    .map(u => {
      const key = `scope:${u.name}`;
      return node(key, unitLabel(u.name), 'category', unitValue(u, r), procNodes(u.procs, key, r), {
        icon: { kind: 'mdi', name: 'folder' },
      });
    })
    .filter(n => n.value > 0)
    .sort(byValue);
}

/**
 * The System arc's children from the host cgroup series: top-level cgroups, their child cgroups
 * and program groups, plus the kernel and cache remainder. Agent cgroups are not drawn here (the
 * agent categories hold them), so their values are taken off every cgroup above them.
 */
function systemChildren(sys: SystemUsage, r: Resource): SunNode[] {
  const val = (p: { cpuCores: number; memBytes: number }) =>
    r === 'cpu' ? p.cpuCores : p.memBytes;
  const all = new Map(sys.cgroups.map(c => [c.unit, c]));
  const ancestorsOf = (unit: string): string[] => {
    const out: string[] = [];
    let p = all.get(unit)?.parent;
    while (p && all.has(p) && !out.includes(p)) {
      out.push(p);
      p = all.get(p)?.parent;
    }
    return out;
  };
  const taken = new Map<string, number>();
  for (const c of sys.cgroups) {
    if (!c.agentUnit) continue;
    const up = ancestorsOf(c.unit);
    // Only the outermost agent cgroup: its value already holds the agent cgroups inside it.
    if (up.some(a => all.get(a)?.agentUnit)) continue;
    for (const a of up) taken.set(a, (taken.get(a) ?? 0) + val(c));
  }
  const plain = sys.cgroups.filter(c => !c.agentUnit);
  const plainUnits = new Set(plain.map(c => c.unit));
  const progs = new Map<string, SunNode[]>();
  for (const p of sys.programs) {
    if (!plainUnits.has(p.unit) || !(val(p) > 0)) continue;
    const list = progs.get(p.unit) ?? [];
    progs.set(p.unit, list);
    list.push(
      node(`system/cg:${p.unit}/prog:${p.program}`, p.program, 'process', val(p), [], {
        icon: iconForProcess(p.program),
        command: p.program,
      })
    );
  }
  const build = (c: (typeof plain)[number], seen: string[]): SunNode => {
    const key = `system/cg:${c.unit}`;
    const kids = plain
      .filter(k => k.parent === c.unit && !seen.includes(k.unit))
      .map(k => build(k, [...seen, c.unit, k.unit]))
      .sort(byValue);
    const value = Math.max(0, val(c) - (taken.get(c.unit) ?? 0));
    const own = (progs.get(c.unit) ?? []).sort(byValue);
    return node(key, c.unit, 'system', value, [...kids, ...own], {
      icon: iconForProcess(cgroupLabel(c.unit)),
      displayName: cgroupLabel(c.unit),
    });
  };
  const roots = plain.filter(c => !plainUnits.has(c.parent) || c.parent === c.unit);
  const out = roots.map(c => build(c, [c.unit])).sort(byValue);
  const rest = r === 'cpu' ? sys.remainderCpu : sys.remainderMem;
  if (rest !== null && rest > 0) {
    out.push(
      node('system/kernel', 'Kernel and cache', 'system', rest, [], {
        icon: { kind: 'mdi', name: 'linux' },
      })
    );
  }
  return out.sort(byValue);
}

/**
 * The agent host with each unit's CPU and memory taken from the exporter's agent-unit series, when
 * the node reports them. Those share their window and instant with the node used and the cgroup
 * values, while the backend's own numbers come from another poll: mixing the two made the agent
 * categories exceed the node used and left System empty. Units the series lack keep the backend's.
 */
function onSeriesBasis(agents: AgentHost, sys: SystemUsage | undefined): AgentHost {
  if (!sys || sys.agentUnits.length === 0) return agents;
  const series = new Map(sys.agentUnits.map(u => [u.unit, u]));
  return {
    ...agents,
    units: agents.units.map(u => {
      const s = series.get(u.name);
      return s ? { ...u, cpuCores: s.cpuCores, memBytes: s.memBytes } : u;
    }),
  };
}

/**
 * What the root share of a chart is measured against. CPU is measured against the allocatable
 * cores, the figure `kubectl top` uses. Memory stays against the node's capacity.
 */
export function capacityWord(r: Resource): 'allocatable' | 'capacity' {
  return r === 'cpu' ? 'allocatable' : 'capacity';
}

export function buildNodeTree(
  m: NodeMetrics,
  hostState: AgentHost | null,
  r: Resource,
  iconSrc: (projectId: string) => string,
  categories: string[] = [],
  names: NameContext = NO_NAMES
): NodeTree {
  const capacity = r === 'cpu' ? m.cpuCapacity : m.memCapacity;
  const used = r === 'cpu' ? m.cpuUsed : m.memUsed;
  const cats: SunNode[] = [kubernetes(m, r)];
  if (hostState) {
    const agents = onSeriesBasis(hostState, m.system);
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
    cats.push(...looseScopes(agents.units, r));
  }
  const attributed = sum(cats);
  if (used !== null) {
    const kids = m.system ? systemChildren(m.system, r) : [];
    // System is what is left of the used; sampling skew can leave less than its own cgroups hold,
    // and it must never vanish while they exist, so it is at least their sum (the root then
    // scales every category down to fit).
    const rest = Math.max(0, used - attributed);
    cats.push(
      node('system', 'System', 'system', Math.max(rest, sum(kids)), kids, {
        icon: { kind: 'mdi', name: 'cog' },
      })
    );
  }
  // The root keeps the unfiltered total: a dropped category leaves its gap, nothing is rescaled.
  const kept = categories.length ? cats.filter(c => categories.includes(categoryId(c.key))) : cats;
  const root = node('root', m.node, 'node', used ?? attributed, kept);
  fitChildren(root);
  applyNames(root, names);
  const source = r === 'cpu' && used !== null ? m.cpuSource : undefined;
  return { root, capacity, used, hostMetrics: used !== null, ...(source ? { source } : {}) };
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
 * The capacity a zoom is measured against, or null. Zoomed straight into one node of a node ring
 * (focus `node:<name>`), the view reads like a single-node root: shares are of that node's
 * capacity. Any other focus, and any tree with no node ring, gives null.
 */
export function capacityZoom(tree: NodeTree, focus: string[]): number | null {
  if (!tree.nodeRing || focus.length !== 1) return null;
  const n = tree.root.children.find(c => c.key === focus[0]);
  return n && n.span !== undefined ? n.capacity ?? n.span : null;
}

/** A short name for a selection of nodes, small enough for the chart centre. */
export function nodesLabel(count: number): string {
  return `${count} nodes`;
}

/**
 * One tree for the selected nodes. One node gives that node's tree. More than one gives a root
 * whose first ring is one arc per node (key `node:<name>`). Each node's wedge is sized by its
 * capacity (`span`), so the circle is split per node, and its value is its use. An empty `categories` keeps
 * every category.
 */
export function buildCombinedTree(
  metrics: NodeMetrics[],
  hostOf: (node: string) => AgentHost | null,
  r: Resource,
  iconSrc: (node: string, projectId: string) => string,
  categories: string[] = [],
  names: NameContext = NO_NAMES
): NodeTree {
  const trees = metrics.map(m => ({
    m,
    t: buildNodeTree(m, hostOf(m.node), r, id => iconSrc(m.node, id), categories, names),
  }));
  if (trees.length === 1) return trees[0].t;
  const nodes = trees
    .map(({ m, t }) => ({
      ...t.root,
      key: `node:${m.node}`,
      label: m.node,
      icon: GENERIC.node,
      // A node using more than its capacity still gets a fully drawn wedge.
      span: Math.max(t.capacity, t.root.value),
      capacity: t.capacity,
    }))
    // An idle node keeps its wedge: only a node with no capacity and no use has nothing to show.
    .filter(n => n.span > 0)
    .sort((a, b) => b.span - a.span || byValue(a, b));
  const hostMetrics = trees.length > 0 && trees.every(x => x.t.hostMetrics);
  const total = sum(nodes);
  // One label for the ring only when every node with a figure reports the same source.
  const sources = new Set(trees.filter(x => x.t.used !== null).map(x => x.t.source));
  const [source] = sources.size === 1 ? [...sources] : [];
  return {
    // Built by hand: `node` would drop an idle node, which keeps its wedge.
    root: {
      key: 'root',
      label: nodesLabel(trees.length),
      kind: 'node',
      value: total,
      children: nodes,
    },
    capacity: trees.reduce((s, x) => s + x.t.capacity, 0),
    // Nodes without host metrics count by what is attributed to them.
    used: trees.some(x => x.t.used !== null) ? total : null,
    hostMetrics,
    ...(source ? { source } : {}),
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
 * capacity nothing uses (a node wedge of a node ring holds its own "Unused on <node>" instead).
 * Keys are `<parent key>/~unattributed` and `<parent key>/~unused`.
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
  if (parent.span !== undefined) {
    // A node wedge: the capacity the node's own use leaves free, drawn to the rim.
    const free = parent.span - parent.value;
    if (free / parent.span > MIN_GAP) {
      out.push({
        key: `${parent.key}/${UNUSED}`,
        label: `Unused on ${parent.label}`,
        kind: 'unused',
        icon: EMPTY_ICON,
        value: free,
        children: [],
      });
    }
  }
  // A node ring has no root-level unused arc: each node wedge holds its own.
  if (atRoot && !tree.nodeRing) {
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
