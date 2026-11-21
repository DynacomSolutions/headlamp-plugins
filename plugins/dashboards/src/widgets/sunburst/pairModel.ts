/*
 * The legend model of a pair of node-first sunbursts that share one legend. Pure functions, no
 * React. The legend has one row per node, one row per category inside each node and one free row per
 * node. A row holds one value for each chart, or no value when that chart has no such group. Every
 * group is its own row: no "Other" row and no top-N cut.
 */
import { freeKey, nodeSpan, SunburstData, SunburstNode } from './geometry';
import { categoryArcId, freeArcId, freeOf, nodeArcId } from './NodeRing';

export type PairValues = [number | undefined, number | undefined];

export interface PairRow {
  kind: 'node' | 'category' | 'free';
  /** The arc id that this row highlights in both charts. */
  id: string;
  /** The `data-legend-row` key. */
  key: string;
  label: string;
  /** The category key, for a category row. */
  categoryKey?: string;
  values: PairValues;
}

export interface PairNode {
  key: string;
  label: string;
  rows: PairRow[];
}

const used = (n: SunburstNode | undefined): number | undefined =>
  n ? Math.max(0, n.used) : undefined;

/** The nodes of both charts, in the order of the first chart, then the nodes that only the second has. */
export function pairNodes(a: SunburstData, b: SunburstData): PairNode[] {
  const an = a.nodes ?? [];
  const bn = b.nodes ?? [];
  const keys = [...new Set([...an.map(n => n.key), ...bn.map(n => n.key)])];
  return keys.map(key => {
    const na = an.find(n => n.key === key);
    const nb = bn.find(n => n.key === key);
    const label = (na ?? nb)!.label;
    const catKeys = [
      ...new Set([
        ...(na?.categories ?? []).filter(c => c.value > 0).map(c => c.key),
        ...(nb?.categories ?? []).filter(c => c.value > 0).map(c => c.key),
      ]),
    ];
    const value = (n: SunburstNode | undefined, ck: string): number | undefined => {
      const c = n?.categories.find(x => x.key === ck);
      return c && c.value > 0 ? c.value : undefined;
    };
    const shareOf = (n: SunburstNode | undefined, v: number | undefined): number =>
      n && v !== undefined && nodeSpan(n) > 0 ? v / nodeSpan(n) : 0;
    const cats: PairRow[] = catKeys
      .map(ck => {
        const va = value(na, ck);
        const vb = value(nb, ck);
        const c = na?.categories.find(x => x.key === ck) ?? nb?.categories.find(x => x.key === ck);
        return {
          row: {
            kind: 'category' as const,
            id: categoryArcId(key, ck),
            key: `${key}/${ck}`,
            label: c!.label,
            categoryKey: ck,
            values: [va, vb] as PairValues,
          },
          weight: shareOf(na, va) + shareOf(nb, vb),
        };
      })
      .sort((x, y) => y.weight - x.weight || x.row.key.localeCompare(y.row.key))
      .map(e => e.row);
    const fa = na ? freeOf(na) : 0;
    const fb = nb ? freeOf(nb) : 0;
    const rows: PairRow[] = [
      { kind: 'node', id: nodeArcId(key), key, label, values: [used(na), used(nb)] },
      ...cats,
    ];
    if (fa > 0 || fb > 0)
      rows.push({
        kind: 'free',
        id: freeArcId(key),
        key: freeKey(key),
        label: 'Free',
        values: [na && fa > 0 ? fa : undefined, nb && fb > 0 ? fb : undefined],
      });
    return { key, label, rows };
  });
}
