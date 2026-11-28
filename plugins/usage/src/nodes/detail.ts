/*
 * The shared focus of both charts: the resolved path, the focused node (name, icon, thread link)
 * and the breadcrumb trail. A key may exist in only one tree (a thread with CPU but no memory,
 * say), so the deeper of the two resolved paths wins, memory on a tie.
 */
import { idOf, nameOf } from './names';
import { capacityZoom, findPath, gapNodes, NodeTree, SunNode, UNUSED } from './tree';

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

/** The value of the node at exactly `keys` in `tree`, or null when the tree does not have it. */
export function valueAt(tree: NodeTree, keys: string[]): number | null {
  return exact(tree, keys)?.value ?? null;
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
      label: nameOf(node),
      icon: m?.icon ?? c?.icon,
      href: m?.href ?? c?.href, // dashboard-links: allow data field, shown as a copy control, never as an anchor
    },
    trail: chosen.map((n, i) => ({ key: n.key, label: nameOf(n), path: keys.slice(0, i) })),
  };
}

/** One resource's numbers for a selected segment. */
export interface SegmentInfo {
  value: number;
  ofCapacity: number;
  /** Null when there is no parent (the root) or the segment is unused capacity. */
  ofParent: number | null;
  /** Share of the zoom root. Null for unused capacity. */
  ofRoot: number | null;
}

/** The selected node in `tree` (a real arc or an empty-space arc), with its parent. */
function resolve(tree: NodeTree, sel: string[]): { node: SunNode; parent: SunNode | null } | null {
  const node = exact(tree, sel);
  if (node) return { node, parent: sel.length ? exact(tree, sel.slice(0, -1)) ?? null : null };
  if (sel.length === 0) return null;
  const parent = exact(tree, sel.slice(0, -1));
  if (!parent) return null;
  const gap = gapNodes(tree, parent, parent === tree.root).find(g => g.key === sel[sel.length - 1]);
  return gap ? { node: gap, parent } : null;
}

function segmentFor(tree: NodeTree, zoom: string[], sel: string[]): SegmentInfo | null {
  const r = resolve(tree, sel);
  if (!r) return null;
  const zoomRoot = findPath(tree.root, zoom).slice(-1)[0];
  const capacityGap = r.node.key.endsWith(`/${UNUSED}`);
  const share = (of: number) => (of > 0 ? r.node.value / of : 0);
  return {
    value: r.node.value,
    // Zoomed into one node of a node ring, shares are of that node's capacity.
    ofCapacity: share(capacityZoom(tree, zoom) ?? tree.capacity),
    ofParent: r.parent && !capacityGap ? share(r.parent.value) : null,
    ofRoot: capacityGap ? null : share(zoomRoot.value),
  };
}

export interface Selection {
  /** The friendly name. */
  label: string;
  /** The raw id, shown under the name; absent when it is the name. */
  id?: string;
  kind: SunNode['kind'];
  icon?: SunNode['icon'];
  href?: string;
  /** A thread's CPU limit and throttling; absent for other segments. */
  note?: string;
  /** The segment has children in either chart, so it can be opened. */
  canOpen: boolean;
  cpu: SegmentInfo | null;
  mem: SegmentInfo | null;
}

/** What the details card shows for the selected path, or null when it is in neither tree. */
export function selectionFor(
  cpu: NodeTree,
  mem: NodeTree,
  zoom: string[],
  sel: string[]
): Selection | null {
  const c = resolve(cpu, sel);
  const m = resolve(mem, sel);
  const n = m?.node ?? c?.node;
  if (!n) return null;
  const shown = nameOf(n);
  const raw = idOf(n);
  return {
    label: shown,
    id: raw !== shown ? raw : undefined,
    kind: n.kind,
    icon: m?.node.icon ?? c?.node.icon,
    href: m?.node.href ?? c?.node.href, // dashboard-links: allow data field, shown as a copy control, never as an anchor
    note: m?.node.note ?? c?.node.note,
    canOpen:
      n.kind !== 'unused' &&
      ((c?.node.children.length ?? 0) > 0 || (m?.node.children.length ?? 0) > 0),
    cpu: segmentFor(cpu, zoom, sel),
    mem: segmentFor(mem, zoom, sel),
  };
}

export interface ChildRow {
  key: string;
  label: string;
  icon?: SunNode['icon'];
  cpu: number | null;
  mem: number | null;
  /** Share of the active section (see `childRows`). Null with no value or no base. */
  cpuShare: number | null;
  memShare: number | null;
}

/**
 * The children of the node at `base` in either chart, biggest share first. The active section is
 * the zoom focus `zoom`: when it is not the root, shares are of that node's value in each tree.
 * At the root they are of capacity.
 */
export function childRows(
  cpu: NodeTree,
  mem: NodeTree,
  base: string[],
  zoom: string[] = []
): ChildRow[] {
  const baseOf = (tree: NodeTree) =>
    capacityZoom(tree, zoom) ?? (zoom.length > 0 ? valueAt(tree, zoom) ?? 0 : tree.capacity);
  const cpuBase = baseOf(cpu);
  const memBase = baseOf(mem);
  const rows = new Map<string, ChildRow>();
  const add = (tree: NodeTree, field: 'cpu' | 'mem') => {
    for (const ch of exact(tree, base)?.children ?? []) {
      const row = rows.get(ch.key) ?? {
        key: ch.key,
        label: nameOf(ch),
        icon: ch.icon,
        cpu: null,
        mem: null,
        cpuShare: null,
        memShare: null,
      };
      row[field] = ch.value;
      const of = field === 'cpu' ? cpuBase : memBase;
      row[field === 'cpu' ? 'cpuShare' : 'memShare'] = of > 0 ? ch.value / of : null;
      rows.set(ch.key, row);
    }
  };
  add(cpu, 'cpu');
  add(mem, 'mem');
  const weight = (r: ChildRow) =>
    (cpuBase > 0 ? (r.cpu ?? 0) / cpuBase : 0) + (memBase > 0 ? (r.mem ?? 0) / memBase : 0);
  return [...rows.values()].sort(
    (a, b) => weight(b) - weight(a) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
  );
}
