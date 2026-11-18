/*
 * What the detail panel describes: the focused node with its CPU and memory values, its parent's
 * values (for "% of parent"), every child of it in either tree, and the breadcrumb trail. Both
 * charts share one focus path, but a key may exist in only one tree (a thread with CPU but no
 * memory, say), so the deeper of the two resolved paths wins, memory on a tie.
 */
import { findPath, NodeTree, SunNode } from './tree';

export interface DetailRow {
  key: string;
  label: string;
  kind: SunNode['kind'];
  icon?: SunNode['icon'];
  href?: string;
  /** null when the node is not in that tree. */
  cpu: number | null;
  mem: number | null;
  /** Focus path that selects this node. */
  path: string[];
}

export interface Detail {
  /** The resolved focus path (the deepest prefix of the requested path either tree has). */
  path: string[];
  focus: DetailRow & { cpuParent: number | null; memParent: number | null };
  children: DetailRow[];
  trail: { key: string; label: string; path: string[] }[];
}

/** The nodes along exactly `keys` (root first), or null when the tree does not have all of them. */
function exact(tree: NodeTree, keys: string[]): SunNode[] | null {
  const p = findPath(tree.root, keys);
  return p.length === keys.length + 1 ? p : null;
}

function share(v: number | null, capacity: number): number {
  return v !== null && capacity > 0 ? v / capacity : 0;
}

export function detailFor(cpu: NodeTree, mem: NodeTree, path: string[]): Detail {
  const cpuPath = findPath(cpu.root, path);
  const memPath = findPath(mem.root, path);
  const chosen = cpuPath.length > memPath.length ? cpuPath : memPath;
  const keys = chosen.slice(1).map(n => n.key);
  const c = exact(cpu, keys);
  const m = exact(mem, keys);
  const node = chosen[chosen.length - 1];
  const parentValue = (p: SunNode[] | null) => (p && p.length > 1 ? p[p.length - 2].value : null);

  const rows = new Map<string, DetailRow>();
  const add = (n: SunNode, field: 'cpu' | 'mem') => {
    const row = rows.get(n.key) ?? {
      key: n.key,
      label: n.label,
      kind: n.kind,
      icon: n.icon,
      href: n.href,
      cpu: null,
      mem: null,
      path: [...keys, n.key],
    };
    row[field] = n.value;
    row.icon = row.icon ?? n.icon;
    row.href = row.href ?? n.href;
    rows.set(n.key, row);
  };
  for (const n of m?.[m.length - 1].children ?? []) add(n, 'mem');
  for (const n of c?.[c.length - 1].children ?? []) add(n, 'cpu');
  const weight = (r: DetailRow) => Math.max(share(r.cpu, cpu.capacity), share(r.mem, mem.capacity));
  const children = [...rows.values()].sort((a, b) => weight(b) - weight(a));

  const cn = c?.[c.length - 1];
  const mn = m?.[m.length - 1];
  return {
    path: keys,
    focus: {
      key: node.key,
      label: node.label,
      kind: node.kind,
      icon: mn?.icon ?? cn?.icon,
      href: mn?.href ?? cn?.href,
      cpu: cn?.value ?? null,
      mem: mn?.value ?? null,
      path: keys,
      cpuParent: parentValue(c),
      memParent: parentValue(m),
    },
    children,
    trail: chosen.map((n, i) => ({ key: n.key, label: n.label, path: keys.slice(0, i) })),
  };
}
