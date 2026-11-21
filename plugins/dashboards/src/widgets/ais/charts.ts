/*
 * The data behind the two charts of the AIS tab: the agents sunburst and the gateway usage pie.
 * Both are pure functions of a panel, so a test can check them without a browser.
 *
 * Agents. The ring order is swap pool (or "Direct"), then the real logged-in identity, then the
 * agent. The AIS `agents` panel does not report the pool and the identity as fields yet. Its rows
 * carry the agent kind in `label` and one word in `detail`: an identity name, the name of a pool
 * identity such as `claude-pool`, or `unknown identity`. `agentPlacement` is the one place that
 * maps a row to its pool and identity. When the panel gets real `pool` and `identity` fields, only
 * this function changes. An agent that the data does not place gets a named segment, never "Other".
 */
import type { PanelModel, PanelRow } from '../panels/model';
import type { SunburstData, SunburstNode } from '../sunburst/geometry';
import { splitLabel } from './join';

/** The ring names for what the panel does not report. These are real states, not a catch-all. */
export const POOL_NOT_REPORTED = 'Pool not reported';
export const IDENTITY_NOT_REPORTED = 'Identity not reported';
/** The inner ring name of an identity that is in no swap pool. */
export const DIRECT = 'Direct';

export interface AgentPlacement {
  pool: string;
  identity: string;
}

const canon = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Which pool each identity belongs to, from the rows of the claude-swap panel ("pool / identity"). */
export function poolMembers(swap: PanelModel | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of swap?.rows ?? []) {
    const { provider: pool, name } = splitLabel(row.label);
    if (pool !== '' && name !== '') out.set(canon(name), pool);
  }
  return out;
}

/**
 * The pool and the identity of one agent row.
 * - `unknown identity` (or an empty word): neither is reported.
 * - A word that ends in `-pool` names the pool identity that the agent runs under. The pool is
 *   known. The member that the pool swapped in is not reported.
 * - Any other word is an identity. Its pool is the swap pool that lists it as a member, else it is
 *   a direct login.
 */
export function agentPlacement(row: PanelRow, members: Map<string, string>): AgentPlacement {
  const word = row.detail.trim();
  if (word === '' || /^unknown identity$/i.test(word)) {
    return { pool: POOL_NOT_REPORTED, identity: IDENTITY_NOT_REPORTED };
  }
  if (/-pool$/i.test(word)) return { pool: word, identity: IDENTITY_NOT_REPORTED };
  return { pool: members.get(canon(word)) ?? DIRECT, identity: word };
}

/** The agents panel as a sunburst: pool, then identity, then agent kind. The values are counts. */
export function agentsToSunburst(
  agents: PanelModel | null | undefined,
  swap: PanelModel | null | undefined
): SunburstData {
  const members = poolMembers(swap);
  // pool -> identity -> agent kind -> count, in first-seen order.
  const tree = new Map<string, Map<string, Map<string, number>>>();
  for (const row of agents?.rows ?? []) {
    const { pool, identity } = agentPlacement(row, members);
    const kind = row.label.trim() || 'agent';
    const ids = tree.get(pool) ?? new Map<string, Map<string, number>>();
    const kinds = ids.get(identity) ?? new Map<string, number>();
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    ids.set(identity, kinds);
    tree.set(pool, ids);
  }
  const sum = (m: Map<string, number>): number => Array.from(m.values()).reduce((a, b) => a + b, 0);
  const nodes: SunburstNode[] = Array.from(tree, ([pool, ids]) => {
    const categories = Array.from(ids, ([identity, kinds]) => ({
      key: identity,
      label: identity,
      value: sum(kinds),
      children: Array.from(kinds, ([kind, n]) => ({
        key: `${identity}/${kind}`,
        label: kind,
        value: n,
      })),
    })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
    const used = categories.reduce((s, c) => s + c.value, 0);
    return { key: pool, label: pool, capacity: used, used, categories };
  }).sort((a, b) => b.used - a.used || a.label.localeCompare(b.label));
  const total = nodes.reduce((s, n) => s + n.used, 0);
  return {
    capacity: total,
    categories: nodes.flatMap(n => n.categories),
    nodes,
  };
}

/** A token count such as "3B", "80.8M", "431K" or "0" as a number. A bad text gives 0. */
export function parseTokens(text: string): number {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*([KMBT]?)\s*$/i.exec(text);
  if (!m) return 0;
  const unit = { '': 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[
    m[2].toUpperCase() as '' | 'K' | 'M' | 'B' | 'T'
  ];
  return Number(m[1]) * unit;
}

export interface GatewaySlice {
  key: string;
  /** The app name. */
  label: string;
  /** The provider name, for example "Claude". */
  group: string;
  value: number;
  /** The value as the panel wrote it. */
  valueText: string;
}

/** The providers in a fixed order, so a provider keeps its colour when the data changes. */
const PROVIDER_ORDER = ['claude', 'codex', 'xai', 'zai', 'kimi', 'opencode', 'ali'];

/** The colour index of a provider group. Known providers have a fixed index. */
export function providerIndex(group: string, all: ReadonlyArray<string>): number {
  const id = canon(group);
  const known = PROVIDER_ORDER.indexOf(id);
  if (known >= 0) return known;
  const extra = Array.from(new Set(all.map(canon)))
    .filter(g => !PROVIDER_ORDER.includes(g))
    .sort();
  return PROVIDER_ORDER.length + extra.indexOf(id);
}

/** The gateway usage rows (one for each app) as pie slices. Every row stays its own slice. */
export function gatewaySlices(panel: PanelModel | null | undefined): GatewaySlice[] {
  const slices = (panel?.rows ?? []).map(row => ({
    key: `${row.label}/${row.detail}`,
    label: row.label,
    group: row.detail.split(',')[0].trim() || 'Provider not reported',
    value: parseTokens(row.value),
    valueText: row.value,
  }));
  return slices.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}
