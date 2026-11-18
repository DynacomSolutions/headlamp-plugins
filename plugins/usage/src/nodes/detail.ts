/*
 * The shared focus of both charts: the resolved path, the focused node (name, icon, thread link)
 * and the breadcrumb trail. A key may exist in only one tree (a thread with CPU but no memory,
 * say), so the deeper of the two resolved paths wins, memory on a tie.
 */
import { findPath, NodeTree, SunNode } from './tree';

export interface Detail {
  /** The resolved focus path (the deepest prefix of the requested path either tree has). */
  path: string[];
  focus: { key: string; label: string; icon?: SunNode['icon']; href?: string };
  trail: { key: string; label: string; path: string[] }[];
}

/** The last node along exactly `keys`, or undefined when the tree does not have all of them. */
function exact(tree: NodeTree, keys: string[]): SunNode | undefined {
  const p = findPath(tree.root, keys);
  return p.length === keys.length + 1 ? p[p.length - 1] : undefined;
}

export function detailFor(cpu: NodeTree, mem: NodeTree, path: string[]): Detail {
  const cpuPath = findPath(cpu.root, path);
  const memPath = findPath(mem.root, path);
  const chosen = cpuPath.length > memPath.length ? cpuPath : memPath;
  const keys = chosen.slice(1).map(n => n.key);
  const c = exact(cpu, keys);
  const m = exact(mem, keys);
  const node = chosen[chosen.length - 1];
  return {
    path: keys,
    focus: {
      key: node.key,
      label: node.label,
      icon: m?.icon ?? c?.icon,
      href: m?.href ?? c?.href,
    },
    trail: chosen.map((n, i) => ({ key: n.key, label: n.label, path: keys.slice(0, i) })),
  };
}
