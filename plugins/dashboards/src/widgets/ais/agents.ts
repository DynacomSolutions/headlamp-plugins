/*
 * The agents of the AIS `agents` panel, read from its `Agents` table.
 *
 * A new AIS source (the one that names the pool and the real login of each agent) adds an `Agents`
 * table with one row for each running agent and the columns pool, identity, tool, identitySource
 * and age. The row fields of the panel carry the same data, but the panel parser drops unknown row
 * fields, so this module reads the table. An older source has no such table: `agentTable` gives
 * null and the callers fall back to the old rows, where one word in `detail` names the identity.
 *
 * The count of agents lives here, so the sunburst and the Sessions tile use one number.
 */
import type { PanelAgentAccount, PanelModel, PanelTable } from '../panels/model';

/** One running agent, as the `Agents` table reports it. */
export interface AgentRecord {
  /** The swap pool, or null for a direct login (or when the pool is not reported). */
  pool: string | null;
  /** The real login now, or null when the source could not resolve it. */
  identity: string | null;
  tool: string;
  /** Each account that the session used, newest first. Empty when the source gives no split. */
  accounts: PanelAgentAccount[];
  /** Where the identity came from, for example `gateway-ledger`. Empty when not reported. */
  source: string;
  age: string;
}

const TABLE_TITLE = /^agents$/i;

function findTable(panel: PanelModel | null | undefined): PanelTable | undefined {
  const tables = panel?.tables ?? [];
  const byTitle = tables.find(t => TABLE_TITLE.test(t.title.trim()));
  if (byTitle) return byTitle;
  // A table without the title still counts when it has the pool and identity columns.
  return tables.find(
    t => t.columns.some(c => c.key === 'pool') && t.columns.some(c => c.key === 'identity')
  );
}

const text = (v: string | number | undefined): string => (v === undefined ? '' : String(v).trim());

/**
 * The agents of the panel, or null for an older source. A row that carries the agent fields is the
 * best record: it has the active account and the account split, which a table cell cannot hold. Else
 * the `Agents` table gives the records. An empty table is an empty list: the source said that no
 * agent runs.
 */
export function agentTable(panel: PanelModel | null | undefined): AgentRecord[] | null {
  const withFields = (panel?.rows ?? []).filter(r => r.agent !== undefined);
  if (withFields.length > 0) {
    return withFields.map(r => {
      const a = r.agent!;
      return {
        pool: a.pool,
        // The active account wins over the identity that the console resolved.
        identity: a.activeIdentity ?? a.identity,
        tool: r.label.trim(),
        accounts: a.identities,
        source: a.identitySource,
        age: r.value.trim(),
      };
    });
  }
  const table = findTable(panel);
  if (!table) return null;
  return table.rows.map(r => ({
    pool: text(r.pool) || null,
    identity: text(r.identity) || null,
    tool: text(r.tool),
    accounts: [],
    source: text(r.identitySource),
    age: text(r.age),
  }));
}

/** A number in a stat value such as "98", or 0. */
const count = (v: string): number => {
  const n = Number(v.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * The number of running agents. The table is the truth when the panel has one. Else the rows are
 * the agents (the sunburst of an older source counts them). A panel with stats only uses the sum of
 * its stats.
 */
export function agentCount(panel: PanelModel | null | undefined): number {
  if (!panel) return 0;
  const table = agentTable(panel);
  if (table) return table.length;
  if (panel.rows.length > 0) return panel.rows.length;
  return panel.stats.reduce((n, s) => n + count(s.value), 0);
}

/** The sources that make a member the one that a gateway-routed pool serves now. */
export const GATEWAY_SOURCES = ['gateway-ledger', 'gateway-session'];

/**
 * For each pool (by name), the members that the gateway served last, as the agents table says. Only
 * a record with the source `gateway-ledger` or `gateway-session` counts: a plain pool follows its registry active member,
 * and that member already carries the Active mark. The names keep the first-seen order.
 */
export function servingByPool(panel: PanelModel | null | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const a of agentTable(panel) ?? []) {
    if (!GATEWAY_SOURCES.includes(a.source) || a.pool === null || a.identity === null) continue;
    const names = out.get(a.pool) ?? [];
    if (!names.includes(a.identity)) names.push(a.identity);
    out.set(a.pool, names);
  }
  return out;
}
