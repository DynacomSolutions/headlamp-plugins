/*
 * The join behind the AIS widget. Four panels of the AIS source say different things about the
 * same identities: `limits` (one row for each identity and limit window), `identities` (the login
 * state), `claude-swap` (the pool members and the active one) and `agents` (the sessions that run).
 * The join runs in the browser. It needs no server change.
 *
 * The result is a list of groups. A pool is a group with its member identities. Every identity that
 * is in no pool goes into a group named by its real provider. There is no "Other" group, no top-N
 * cut and no "+N more": every identity of every panel appears once.
 */
import type { PanelModel, PanelRow, PanelStatus, Stat } from '../panels/model';
import { orderLimits } from '../panels/rowGroups';

export interface AisLimit {
  /** The window name, for example "5-hour" or "Weekly". */
  name: string;
  value: string;
  fraction?: number;
  status: PanelStatus;
}

export interface AisLogin {
  status: PanelStatus;
  /** The word for the state: "Logged in", "Expiring" or "Expired". */
  word: string;
  detail: string;
}

export interface AisIdentity {
  /** One key for the identity across the panels. */
  key: string;
  name: string;
  /** The real provider name, for example "Anthropic". */
  provider: string;
  login?: AisLogin;
  limits: AisLimit[];
  /** The name of the pool, when the identity is a member of one. */
  pool?: string;
  active: boolean;
  /** The worst status of the login state and the limits. */
  status: PanelStatus;
  /** The raw link of the first row that names the identity. The widget maps it to a dashboard tab. */
  link?: string;
}

export interface AisGroup {
  key: string;
  kind: 'pool' | 'provider';
  title: string;
  members: AisIdentity[];
  /** The name of the active member of a pool. */
  active?: string;
  link?: string;
}

export interface AisModel {
  groups: AisGroup[];
  /** Every limit name once, in display order. */
  limits: string[];
  stats: Stat[];
  /** The indexes of `stats` that hold a name and not a number. */
  textTiles: number[];
  summary: string;
  status: PanelStatus;
  identityCount: number;
}

export interface AisPanels {
  limits?: PanelModel | null;
  identities?: PanelModel | null;
  swap?: PanelModel | null;
  agents?: PanelModel | null;
}

/** The identity provider keys that the login panel uses, and the provider names that the limits panel uses. */
const LIMIT_PROVIDER: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  grok: 'xai',
  kimi: 'kimi',
  zai: 'zai',
  opencode: 'opencodego',
};

/** The real provider name for each key of the login panel. */
const PROVIDER_NAME: Record<string, string> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  grok: 'xAI',
  kimi: 'Kimi',
  zai: 'Z.ai',
  opencode: 'OpenCode Go',
  pi: 'Pi',
};

const RANK: Record<PanelStatus, number> = { ok: 0, unknown: 1, warn: 2, crit: 3 };
export const worse = (a: PanelStatus, b: PanelStatus): PanelStatus => (RANK[b] > RANK[a] ? b : a);

const canon = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const providerId = (s: string): string => LIMIT_PROVIDER[canon(s)] ?? canon(s);
const capital = (s: string): string => (s === '' ? s : s[0].toUpperCase() + s.slice(1));

/** "Provider / name" as two parts. A label with no separator has no provider. */
export function splitLabel(label: string): { provider: string; name: string } {
  const at = label.indexOf(' / ');
  return at < 0
    ? { provider: '', name: label.trim() }
    : { provider: label.slice(0, at).trim(), name: label.slice(at + 3).trim() };
}

const keyOf = (provider: string, name: string): string => `${providerId(provider)}/${canon(name)}`;

/** The name of a limit from a swap detail such as "Active, weekly". */
function swapLimitName(detail: string): string {
  const part = detail.split(',')[1]?.trim() ?? '';
  return part === '' ? 'Weekly' : capital(part);
}

interface Draft extends AisIdentity {
  order: number;
}

/** The number in a stat value such as "98", or 0. */
const count = (v: string): number => {
  const n = Number(v.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const statValue = (panel: PanelModel | null | undefined, label: string): Stat | undefined =>
  panel?.stats.find(s => s.label.toLowerCase() === label.toLowerCase());

export function joinAis(panels: AisPanels): AisModel {
  const drafts = new Map<string, Draft>();
  const ensure = (provider: string, name: string, link: string | undefined): Draft => {
    const key = keyOf(provider, name);
    let d = drafts.get(key);
    if (!d) {
      d = {
        key,
        name,
        provider,
        limits: [],
        active: false,
        status: 'ok',
        link,
        order: drafts.size,
      };
      drafts.set(key, d);
    }
    if (!d.link && link) d.link = link;
    return d;
  };

  // The real provider name of a limits row wins over the short key of a login row.
  const limitRows: PanelRow[] = panels.limits?.rows ?? [];
  for (const row of limitRows) {
    const { provider, name } = splitLabel(row.label);
    const d = ensure(provider, name, row.link);
    d.provider = provider || d.provider;
    d.limits.push({
      name: row.detail === '' ? 'Value' : row.detail,
      value: row.value,
      fraction: row.fraction,
      status: row.status,
    });
  }

  for (const row of panels.identities?.rows ?? []) {
    const { provider, name } = splitLabel(row.label);
    const existing = drafts.get(keyOf(provider, name));
    const d = existing ?? ensure(provider, name, row.link);
    // A login-only identity has the short key as provider, so it gets the real name.
    if (!existing) d.provider = PROVIDER_NAME[canon(provider)] ?? capital(provider);
    d.login = { status: row.status, word: row.value || row.detail, detail: row.detail };
  }

  // The pool members. A pool member belongs to the provider of the swap panel (Anthropic).
  const poolOrder: string[] = [];
  const poolLink = new Map<string, string | undefined>();
  const poolActive = new Map<string, string>();
  for (const row of panels.swap?.rows ?? []) {
    const { provider: pool, name } = splitLabel(row.label);
    if (!poolOrder.includes(pool)) {
      poolOrder.push(pool);
      poolLink.set(pool, row.link);
    }
    const d = ensure('Anthropic', name, row.link);
    d.pool = pool;
    d.active = /^active\b/i.test(row.detail);
    if (d.active) poolActive.set(pool, name);
    if (d.limits.length === 0 && row.fraction !== undefined) {
      d.limits.push({
        name: swapLimitName(row.detail),
        value: row.value,
        fraction: row.fraction,
        status: row.status,
      });
    }
  }

  for (const d of drafts.values()) {
    d.status = d.limits.reduce<PanelStatus>((s, l) => worse(s, l.status), d.login?.status ?? 'ok');
  }

  const all = Array.from(drafts.values());
  const bySeverity = (a: Draft, b: Draft): number =>
    RANK[b.status] - RANK[a.status] || a.order - b.order;

  const groups: AisGroup[] = poolOrder.map(pool => ({
    key: `pool:${pool}`,
    kind: 'pool',
    title: pool,
    members: all
      .filter(d => d.pool === pool)
      .sort((a, b) => Number(b.active) - Number(a.active) || a.order - b.order),
    active: poolActive.get(pool),
    link: poolLink.get(pool),
  }));

  const providerOrder: string[] = [];
  for (const d of all) {
    if (d.pool !== undefined) continue;
    const id = providerId(d.provider);
    if (!providerOrder.includes(id)) providerOrder.push(id);
  }
  for (const id of providerOrder) {
    const members = all.filter(d => d.pool === undefined && providerId(d.provider) === id);
    groups.push({
      key: `provider:${id}`,
      kind: 'provider',
      title: members[0].provider || 'No provider',
      members: members.sort(bySeverity),
      link: members[0].link,
    });
  }

  const names: string[] = [];
  for (const d of all) for (const l of d.limits) if (!names.includes(l.name)) names.push(l.name);
  const limits = orderLimits(names);

  // Stat tiles: sessions, the login states, the pools and the active member of each pool.
  const stats: Stat[] = [];
  const textTiles: number[] = [];
  const agents = panels.agents;
  if (agents) {
    const total =
      agents.stats.length > 0
        ? agents.stats.reduce((n, s) => n + count(s.value), 0)
        : agents.rows.length;
    stats.push({ label: 'Sessions', value: String(total), status: 'ok' });
  }
  if (panels.identities) {
    for (const label of ['Logged in', 'Expiring', 'Expired', 'Logged out']) {
      const s = statValue(panels.identities, label);
      if (!s) continue;
      // The logged out tile only shows when it has something to say.
      if (label === 'Logged out' && count(s.value) === 0) continue;
      stats.push({ label, value: s.value, status: s.status });
    }
  }
  if (poolOrder.length > 0) {
    const pools = statValue(panels.swap, 'Pools');
    stats.push({ label: 'Pools', value: pools?.value ?? String(poolOrder.length), status: 'ok' });
    for (const pool of poolOrder) {
      const active = poolActive.get(pool);
      textTiles.push(stats.length);
      stats.push({
        label: poolOrder.length === 1 ? 'Active member' : `Active in ${pool}`,
        value: active ?? 'None',
        status: active ? 'ok' : 'warn',
      });
    }
  }

  const status = all.reduce<PanelStatus>((s, d) => worse(s, d.status), 'ok');
  const sessions = stats.find(s => s.label === 'Sessions');
  const bits: string[] = [];
  if (sessions) bits.push(`${sessions.value} sessions`);
  bits.push(`${all.length} identities`);
  if (poolOrder.length > 0)
    bits.push(`${poolOrder.length} ${poolOrder.length === 1 ? 'pool' : 'pools'}`);
  return {
    groups,
    limits,
    stats,
    textTiles,
    summary: bits.join(', '),
    status,
    identityCount: all.length,
  };
}
