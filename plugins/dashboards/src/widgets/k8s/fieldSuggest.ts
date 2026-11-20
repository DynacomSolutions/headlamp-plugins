/* Field path suggestions for the settings editor, taken from the objects that are loaded. */
import type { Segment } from './fields';

/** Write segments as a path that `parseFieldPath` reads back. Keys with odd characters use brackets. */
export function formatPath(segments: Segment[]): string {
  return segments
    .map(seg => {
      if (seg === '*') return '[*]';
      if (typeof seg === 'number') return `[${seg}]`;
      return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(seg) ? `.${seg}` : `["${seg.replace(/"/g, '')}"]`;
    })
    .join('');
}

const SKIP = new Set(['managedFields']);
/** The keys of a Secret that hold values. They are never suggested. */
const SECRET_KEYS = new Set(['data', 'stringData']);

/**
 * Leaf paths found in a sample of objects, most common first. Arrays use the index 0 so the
 * list stays short. The result is capped, because an object can be deep.
 */
export function suggestPaths(
  objects: unknown[],
  limit = 400,
  sample = 25,
  maxDepth = 6,
  /** The kind of the source. A Secret gives no `data` or `stringData` path. */
  kind = ''
): string[] {
  const counts = new Map<string, number>();
  const visit = (node: unknown, segs: Segment[]) => {
    if (counts.size >= limit * 4) return;
    if (node === null || typeof node !== 'object') {
      if (segs.length > 0) {
        const path = formatPath(segs);
        counts.set(path, (counts.get(path) ?? 0) + 1);
      }
      return;
    }
    if (segs.length >= maxDepth) return;
    if (Array.isArray(node)) {
      if (node.length > 0) visit(node[0], [...segs, 0]);
      return;
    }
    const isSecret = segs.length === 0 && (kind === 'Secret' || (node as any).kind === 'Secret');
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (SKIP.has(k) || (isSecret && SECRET_KEYS.has(k))) continue;
      visit(v, [...segs, k]);
    }
  };
  objects.slice(0, sample).forEach(o => visit(o, []));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([p]) => p)
    .sort((a, b) => a.localeCompare(b));
}
