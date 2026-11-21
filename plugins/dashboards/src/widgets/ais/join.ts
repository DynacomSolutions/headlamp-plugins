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
import { agentCount, servingByPool } from './agents';

export interface AisLimit {
  /** The window name, for example "5-hour" or "Weekly". */
  name: string;
  value: string;
  fraction?: number;
  status: PanelStatus;
  /** Absolute used and limit values, when the source gives them (row meta `used` and `limit`). */
  used?: number;
  cap?: number;
  /** When the window resets, as the source wrote it (row meta `resetsAt`). */
  resetsAt?: string;
}

/** One limit window of a pool, summed over the members that report it. */
export interface AisJointLimit extends AisLimit {
  /** The members that report this window. */
  reporting: number;
  /** `absolute` when every reporting member gave used and limit values, else `share`. */
  basis: 'share' | 'absolute';
}

/** The joint usage of a pool: one value for each limit window, over all members. */
export interface AisJoint {
  /** The members of the pool. */
  members: number;
  /** The members that report at least one window. */
  reporting: number;
  limits: AisJointLimit[];
  /** The joint status: the worst of the joint windows. */
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
  /** The registry marks the identity as the active member of its pool. */
  active: boolean;
  /**
   * The gateway really serves the identity now: the agents data names it for its gateway-routed
   * pool. Absent when the agents data says nothing about the pool.
   */
  serving?: boolean;
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
  /** The name of the registry active member of a pool. */
  active?: string;
  /**
   * The members that a gateway-routed pool really serves now, from the agents data (the member the
   * gateway served last). Absent when the agents data does not name one. It can differ from `active`:
   * the gateway picks a member for each request, so the registry value can be old.
   */
  serving?: string[];
  /**
   * The limits of a pool: the limits of the member that it serves now (the worst one, when it
   * serves several), else the limits of its registry active member. Work goes through that member,
   * so its windows decide what the pool can do now. A pool with no such member has none.
   */
  poolLimits?: AisLimit[];
  /** The member whose limits `poolLimits` holds. */
  poolLimitsOf?: string;
  /** The worst status of the pool limits. */
  poolStatus?: PanelStatus;
  /** The joint usage of all members, for each limit window. */
  joint?: AisJoint;
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
  /** The login states in one line, for example "20 logged in, 1 expiring, 2 expired". Empty without login data. */
  loginSummary: string;
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

/** The joint thresholds: the share of a window at which the pool shows a warning or is critical. */
export const JOINT_WARN = 0.8;
export const JOINT_CRIT = 0.95;
export const jointStatus = (fraction: number): PanelStatus =>
  fraction >= JOINT_CRIT ? 'crit' : fraction >= JOINT_WARN ? 'warn' : 'ok';

const unit = (f: number): number => Math.min(1, Math.max(0, f));
const percent = (f: number): string => `${Math.round(unit(f) * 100)}%`;

/** The earliest valid time of a list of times as written, or undefined. */
function earliest(times: ReadonlyArray<string | undefined>): string | undefined {
  let best: { at: number; raw: string } | undefined;
  for (const raw of times) {
    if (raw === undefined) continue;
    const at = Date.parse(raw);
    if (Number.isFinite(at) && (!best || at < best.at)) best = { at, raw };
  }
  return best?.raw;
}

/**
 * The joint usage of the members of a pool. For each window, only the members that report it count.
 * With used and limit values on every reporting member the joint value is sum(used) / sum(limit).
 * Else every member is one equal unit of capacity and the joint value is the mean of the shares.
 * The reset is the earliest one of the reporting members: that window frees capacity first.
 */
export function jointLimits(members: ReadonlyArray<AisIdentity>): AisJoint {
  const names: string[] = [];
  for (const m of members)
    for (const l of m.limits)
      if (l.fraction !== undefined && !names.includes(l.name)) names.push(l.name);
  const limits: AisJointLimit[] = [];
  for (const name of orderLimits(names)) {
    const own = members
      .map(m => m.limits.find(l => l.name === name))
      .filter((l): l is AisLimit => l !== undefined && l.fraction !== undefined);
    const absolute = own.every(l => l.used !== undefined && l.cap !== undefined && l.cap > 0);
    const fraction = absolute
      ? unit(own.reduce((s, l) => s + (l.used ?? 0), 0) / own.reduce((s, l) => s + (l.cap ?? 0), 0))
      : unit(own.reduce((s, l) => s + unit(l.fraction ?? 0), 0) / own.length);
    limits.push({
      name,
      value: percent(fraction),
      fraction,
      status: jointStatus(fraction),
      resetsAt: earliest(own.map(l => l.resetsAt)),
      reporting: own.length,
      basis: absolute ? 'absolute' : 'share',
    });
  }
  return {
    members: members.length,
    reporting: members.filter(m => m.limits.some(l => l.fraction !== undefined)).length,
    limits,
    status:
      limits.length === 0
        ? 'unknown'
        : limits.reduce<PanelStatus>((s, l) => worse(s, l.status), 'ok'),
  };
}

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
    const used = Number(row.meta?.used);
    const cap = Number(row.meta?.limit);
    d.limits.push({
      name: row.detail === '' ? 'Value' : row.detail,
      value: row.value,
      fraction: row.fraction,
      status: row.status,
      ...(row.meta?.used !== undefined && Number.isFinite(used) ? { used } : {}),
      ...(row.meta?.limit !== undefined && Number.isFinite(cap) ? { cap } : {}),
      ...(row.meta?.resetsAt ? { resetsAt: row.meta.resetsAt } : {}),
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

  // The members that the gateway really serves, by pool (names as the swap panel writes them).
  const servingRaw = servingByPool(panels.agents);
  const servingOf = (pool: string): string[] | undefined => {
    for (const [name, who] of servingRaw) if (canon(name) === canon(pool)) return who;
    return undefined;
  };

  const groups: AisGroup[] = poolOrder.map(pool => {
    const names = servingOf(pool);
    const inPool = all.filter(d => d.pool === pool);
    // Use the name that the swap panel gives, so the row and the pool line say the same word.
    const serving = names?.map(n => inPool.find(m => canon(m.name) === canon(n))?.name ?? n);
    if (serving) {
      for (const m of inPool) m.serving = serving.some(n => canon(n) === canon(m.name));
    }
    const members = inPool.sort(
      (a, b) =>
        Number(b.serving ?? false) - Number(a.serving ?? false) ||
        Number(b.active) - Number(a.active) ||
        a.order - b.order
    );
    const registry = members.find(m => m.active);
    // The pool windows are those of the member that it serves now. With several, the one in the
    // worst state decides what the pool can do. With none, the registry active member decides.
    const serves = members.filter(m => m.serving && m.limits.length > 0);
    const limitsOf =
      serves.reduce<Draft | undefined>(
        (best, m) => (best === undefined || RANK[m.status] > RANK[best.status] ? m : best),
        undefined
      ) ?? registry;
    return {
      key: `pool:${pool}`,
      kind: 'pool',
      title: pool,
      members,
      active: poolActive.get(pool),
      serving,
      poolLimits: limitsOf?.limits,
      poolLimitsOf: limitsOf?.name,
      poolStatus: limitsOf?.limits.reduce<PanelStatus>((s, l) => worse(s, l.status), 'ok'),
      joint: jointLimits(members),
      link: poolLink.get(pool),
    };
  });

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
  // The same count as the agents sunburst (see `agentCount`): no helper process, one per agent.
  if (panels.agents) {
    stats.push({ label: 'Sessions', value: String(agentCount(panels.agents)), status: 'ok' });
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
    for (const group of groups.filter(g => g.kind === 'pool')) {
      const pool = group.title;
      if (group.serving) {
        // The member that the gateway really serves wins over the registry active member. The tile
        // is a number, like the other tiles, so it is never cut. The names are on the pool line and
        // on the member rows.
        stats.push({
          label: poolOrder.length === 1 ? 'Serving' : `Serving in ${pool}`,
          value: String(group.serving.length),
          status: group.serving.length > 0 ? 'ok' : 'warn',
        });
        continue;
      }
      // No serving data: the tile names the registry active member.
      textTiles.push(stats.length);
      stats.push({
        label: poolOrder.length === 1 ? 'Active member' : `Active in ${pool}`,
        value: group.active ?? 'None',
        status: group.active ? 'ok' : 'warn',
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
  const loginBits = ['Logged in', 'Expiring', 'Expired', 'Logged out']
    .map(label => ({ label, s: statValue(panels.identities, label) }))
    .filter(x => x.s && (x.label !== 'Logged out' || count(x.s.value) > 0))
    .map(x => `${x.s?.value} ${x.label.toLowerCase()}`);
  return {
    groups,
    limits,
    stats,
    textTiles,
    summary: bits.join(', '),
    loginSummary: loginBits.join(', '),
    status,
    identityCount: all.length,
  };
}
