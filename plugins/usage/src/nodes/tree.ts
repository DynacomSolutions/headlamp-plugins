/*
 * The per-node tree a CPU or memory sunburst draws. A node's value is its own measured total
 * including descendants, so a parent may exceed the sum of its children (the gap stays empty).
 * Children that sum to more than their parent (sampling skew) are scaled down to fit.
 */
import type { AgentHost, AgentProc, AgentUnit } from './agents';
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
    | 'system';
  icon?: { kind: 'file' | 'lucide' | 'mdi'; name?: string; src?: string; color?: string };
  href?: string;
  children: SunNode[];
}

export interface NodeTree {
  root: SunNode;
  capacity: number;
  used: number | null;
  hostMetrics: boolean;
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
    cs.push(node(`c:${p.container}`, p.container, 'container', v));
  }
  const nsNodes: SunNode[] = [];
  for (const [ns, pods] of nss) {
    const nsKey = `k8s/ns:${ns}`;
    const podNodes: SunNode[] = [];
    for (const [pod, cs] of pods) {
      const podKey = `${nsKey}/pod:${pod}`;
      for (const c of cs) c.key = `${podKey}/${c.key}`;
      podNodes.push(node(podKey, pod, 'pod', sum(cs), cs.sort(byValue)));
    }
    nsNodes.push(node(nsKey, ns, 'namespace', sum(podNodes), podNodes.sort(byValue)));
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
        p.command || `pid ${p.pid}`,
        'process',
        procValue(p, r),
        procNodes(p.children, key, r)
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

function orchestrator(
  name: string,
  title: string,
  units: AgentUnit[],
  r: Resource,
  iconSrc: (id: string) => string
): SunNode | null {
  const own = units.filter(u => u.orchestrator === name);
  const controls = own.filter(u => u.role === 'control');
  const slice = own.find(u => u.role === 'agents');
  const agents = own.filter(u => u.role === 'agent');

  const controlNodes: SunNode[] = [];
  const controlValue = controls.reduce((s, u) => s + unitValue(u, r), 0);
  if (controlValue > 0) {
    const key = `${name}/control`;
    controlNodes.push(
      node(
        key,
        `${title} itself`,
        'control',
        controlValue,
        procNodes(
          controls.flatMap(u => u.procs),
          key,
          r
        )
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

  const agentsValue = slice ? unitValue(slice, r) : sum(projects);
  const total = sum(controlNodes) + agentsValue;
  if (!(total > 0)) return null;
  return node(name, title, 'orchestrator', total, [...controlNodes, ...known, ...unknown], {
    icon: { kind: 'mdi', name: /herdr/i.test(name) ? 'console' : 'robot' },
  });
}

function otherScopes(units: AgentUnit[], r: Resource): SunNode | null {
  const items = units
    .filter(
      u => u.kind === 'scope' && u.role !== 'control' && u.role !== 'agents' && u.role !== 'agent'
    )
    .map(u => {
      const key = `other/${u.name}`;
      return node(key, u.name, 'thread', unitValue(u, r), procNodes(u.procs, key, r));
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
  iconSrc: (projectId: string) => string
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
  const root = node('root', m.node, 'node', used ?? attributed, cats);
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
