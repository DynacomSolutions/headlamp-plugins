/*
 * The data behind the two charts of the AIS tab: the agents sunburst and the gateway usage pie.
 * Both are pure functions of a panel, so a test can check them without a browser.
 *
 * Agents. The ring order is swap pool (or "Direct"), then the real logged-in identity, then the
 * tool. A new AIS source reports each agent with the fields `pool` (null for a direct login),
 * `identity`, `identitySource` and, for a gateway session, `activeIdentity` and `identities` (see
 * `agents.ts`). The active account wins over `identity`. An older source has none of these fields.
 * Its rows carry the tool in `label` and one word in `detail`: an identity name, the name of a pool
 * identity such as `claude-pool`, or `unknown identity`. `agentPlacement` maps such an old row to
 * its pool and identity. An agent that the data does not place gets a named segment, never "Other".
 */
import type { PanelAgentAccount, PanelModel, PanelRow } from '../panels/model';
import type { SunburstData, SunburstNode } from '../sunburst/geometry';
import { agentTable } from './agents';
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
 * - A row with the agent fields: the pool (null is "Direct") and `activeIdentity` or else `identity`.
 *   The rules below apply only to a row without these fields.
 * - `unknown identity` (or an empty word): neither is reported.
 * - A word that ends in `-pool` names the pool identity that the agent runs under. The pool is
 *   known. The member that the pool swapped in is not reported.
 * - Any other word is an identity. Its pool is the swap pool that lists it as a member, else it is
 *   a direct login.
 */
export function agentPlacement(row: PanelRow, members: Map<string, string>): AgentPlacement {
  const fields = row.agent;
  if (fields) {
    // The new fields are the truth: a null pool is a direct login. Neither pool nor identity: not placed.
    const identity = fields.activeIdentity ?? fields.identity;
    return {
      pool: fields.pool ?? (identity === null ? POOL_NOT_REPORTED : DIRECT),
      identity: identity ?? IDENTITY_NOT_REPORTED,
    };
  }
  const word = row.detail.trim();
  if (word === '' || /^unknown identity$/i.test(word)) {
    return { pool: POOL_NOT_REPORTED, identity: IDENTITY_NOT_REPORTED };
  }
  if (/-pool$/i.test(word)) return { pool: word, identity: IDENTITY_NOT_REPORTED };
  return { pool: members.get(canon(word)) ?? DIRECT, identity: word };
}

/** One agent placed in the rings: its pool, its identity, its tool and where the identity came from. */
interface Placed extends AgentPlacement {
  tool: string;
  /** The `identitySource` of the agent. Empty for an older source. */
  source: string;
  /** Each account of the session. Empty for an older source. */
  accounts: PanelAgentAccount[];
}

/** The agents of a panel, placed. The `Agents` table wins. An older panel falls back to its rows. */
export function placeAgents(
  agents: PanelModel | null | undefined,
  swap: PanelModel | null | undefined
): Placed[] {
  const table = agentTable(agents);
  if (table) {
    return table.map(a => ({
      // A direct login has no pool. An agent with neither a pool nor an identity is not placed.
      pool: a.pool ?? (a.identity === null ? POOL_NOT_REPORTED : DIRECT),
      identity: a.identity ?? IDENTITY_NOT_REPORTED,
      tool: a.tool || 'agent',
      source: a.source,
      accounts: a.accounts,
    }));
  }
  const members = poolMembers(swap);
  return (agents?.rows ?? []).map(row => ({
    ...agentPlacement(row, members),
    tool: row.label.trim() || 'agent',
    source: '',
    accounts: [],
  }));
}

/** "gateway-ledger" for one source, "gateway-ledger 3, config-dir 1" for several. Empty for none. */
function sourceNote(sources: Map<string, number>): string | undefined {
  const named = Array.from(sources).filter(([name]) => name !== '');
  if (named.length === 0) return undefined;
  const text =
    named.length === 1
      ? named[0][0]
      : named
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([name, n]) => `${name} ${n}`)
          .join(', ');
  return `identity source ${text}`;
}

/** All tokens of one account: input, output and both cache kinds. */
export const accountTokens = (a: PanelAgentAccount): number =>
  a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheWriteTokens;

/** A token count as short text: "431", "12.3K", "80.8M", "3.1B". */
export function compactTokens(n: number): string {
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, unit] of units) {
    if (n >= size) {
      const v = n / size;
      return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${unit}`;
    }
  }
  return String(Math.round(n));
}

/**
 * The accounts note of the agents in one arc: "2 accounts: red 1.2M, blue 300K". It counts only the
 * agents whose session used more than one account. The accounts add up over these agents and come
 * largest first (a tie goes to the name). Undefined when no agent used more than one account.
 */
export function accountsNote(lists: PanelAgentAccount[][]): string | undefined {
  const total = new Map<string, number>();
  for (const accounts of lists) {
    if (accounts.length < 2) continue;
    for (const a of accounts)
      total.set(a.identity, (total.get(a.identity) ?? 0) + accountTokens(a));
  }
  if (total.size === 0) return undefined;
  const split = Array.from(total)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, tokens]) => `${name} ${compactTokens(tokens)}`)
    .join(', ');
  return `${total.size} accounts: ${split}`;
}

/** The parts of a tooltip note, joined. Undefined when there is no part. */
const joinNotes = (...parts: Array<string | undefined>): string | undefined => {
  const kept = parts.filter((p): p is string => p !== undefined && p !== '');
  return kept.length > 0 ? kept.join(', ') : undefined;
};

const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);

/**
 * The agents panel as a sunburst: pool (or "Direct"), then the real identity, then the tool. The
 * values are counts. The tooltip of an arc names the identity source of its agents. It also gives the
 * token split per account for agents whose session used more than one account.
 */
export function agentsToSunburst(
  agents: PanelModel | null | undefined,
  swap: PanelModel | null | undefined
): SunburstData {
  interface Leaf {
    n: number;
    sources: Map<string, number>;
    accounts: PanelAgentAccount[][];
  }
  // pool -> identity -> tool -> count and sources, in first-seen order.
  const tree = new Map<string, Map<string, Map<string, Leaf>>>();
  for (const a of placeAgents(agents, swap)) {
    const ids = tree.get(a.pool) ?? new Map<string, Map<string, Leaf>>();
    const tools = ids.get(a.identity) ?? new Map<string, Leaf>();
    const leaf = tools.get(a.tool) ?? { n: 0, sources: new Map<string, number>(), accounts: [] };
    leaf.n += 1;
    leaf.accounts.push(a.accounts);
    bump(leaf.sources, a.source);
    tools.set(a.tool, leaf);
    ids.set(a.identity, tools);
    tree.set(a.pool, ids);
  }
  const merge = (leaves: Iterable<Leaf>): Map<string, number> => {
    const out = new Map<string, number>();
    for (const l of leaves) for (const [k, n] of l.sources) out.set(k, (out.get(k) ?? 0) + n);
    return out;
  };
  const lists = (leaves: Iterable<Leaf>): PanelAgentAccount[][] =>
    Array.from(leaves).flatMap(l => l.accounts);
  const sum = (leaves: Iterable<Leaf>): number => {
    let n = 0;
    for (const l of leaves) n += l.n;
    return n;
  };
  const nodes: SunburstNode[] = Array.from(tree, ([pool, ids]) => {
    const categories = Array.from(ids, ([identity, tools]) => ({
      key: identity,
      label: identity,
      value: sum(tools.values()),
      detail: joinNotes(sourceNote(merge(tools.values())), accountsNote(lists(tools.values()))),
      children: Array.from(tools, ([tool, leaf]) => ({
        key: `${identity}/${tool}`,
        label: tool,
        value: leaf.n,
        detail: joinNotes(sourceNote(leaf.sources), accountsNote(leaf.accounts)),
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
export const PROVIDER_ORDER = ['claude', 'codex', 'xai', 'zai', 'kimi', 'opencode', 'ali'];

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
