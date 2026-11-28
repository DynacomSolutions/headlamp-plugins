/** Chat API types, parsers and picker helpers (pure, no React). */

export interface ModelOption {
  id: string;
  /** The identity: one gateway app of the agent, the pool or one pinned account. It is the id prefix of the model. */
  route: string;
  model: string;
  name: string;
  /** The provider the route belongs to. An older agent sends none: the route is then the provider. */
  provider: string;
  /** The display name of the identity, for example `Pool`. */
  identity: string;
  /** Tokens of context, when the agent knows it. */
  contextWindow?: number;
  /** True when the agent listed the identity itself. Only such an agent accepts an identity on a chat request. */
  identityListed?: boolean;
}

export interface ModelList {
  default: string;
  models: ModelOption[];
}

export type MessageStatus = 'done' | 'running' | 'failed' | 'cancelled';

export interface Step {
  id: string;
  tool: string;
  reason: string;
  ok?: boolean;
  summary?: string;
  status: 'running' | 'done';
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  args?: Record<string, unknown>;
  output?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  status: MessageStatus;
  error?: string;
  model?: string;
  steps: Step[];
  /** What the model said between tool calls, while it worked. */
  thinking?: string;
  usage?: Usage;
}

/** What one assistant turn used. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens of the last model call: the context size now. */
  contextTokens: number;
  contextWindow?: number;
  calls: number;
  costUsd?: number;
  provider?: string;
  identity?: string;
  durationMs?: number;
}

export interface ChatSummary {
  id: string;
  /** `storage` for the storage investigation, which the plugin adds to the list. Absent for the agent's chats. */
  kind?: 'storage';
  title: string;
  model: string;
  /** The first linked incident. An older agent sends this field only. */
  diagnosisId?: string;
  /** Every linked incident. A chat about one incident has one entry. */
  diagnosisIds?: string[];
  updatedAt: string;
  running: boolean;
}

/** The ids of the incidents a chat is about, from the list or, for an older agent, the single id. */
export function chatIncidentIds(c: Pick<ChatSummary, 'diagnosisId' | 'diagnosisIds'>): string[] {
  if (c.diagnosisIds && c.diagnosisIds.length > 0) return c.diagnosisIds;
  return c.diagnosisId ? [c.diagnosisId] : [];
}

export interface ChatDetail extends ChatSummary {
  createdAt: string;
  messages: ChatMessage[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const STATUSES: MessageStatus[] = ['done', 'running', 'failed', 'cancelled'];

export function parseModels(json: unknown): ModelList {
  const j = rec(json);
  const models = (Array.isArray(j.models) ? j.models : [])
    .map(raw => {
      const m = rec(raw);
      const id = str(m.id);
      const slash = id.indexOf('/');
      const route = str(m.route) || (slash > 0 ? id.slice(0, slash) : '');
      const model = str(m.model) || (slash > 0 ? id.slice(slash + 1) : id);
      const window = typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : undefined;
      return {
        id,
        route,
        model,
        name: str(m.name) || model,
        provider: str(m.provider) || route,
        identity: str(m.identity) || 'Pool',
        ...(window ? { contextWindow: window } : {}),
        ...(str(m.identity) ? { identityListed: true } : {}),
      };
    })
    .filter(m => m.id);
  return { default: str(j.default), models };
}

export function parseSummary(raw: unknown): ChatSummary {
  const c = rec(raw);
  const ids = Array.isArray(c.diagnosisIds)
    ? [...new Set(c.diagnosisIds.map(str).filter(Boolean))]
    : [];
  return {
    id: str(c.id),
    title: str(c.title),
    model: str(c.model),
    diagnosisId: str(c.diagnosisId) || ids[0] || undefined,
    ...(ids.length ? { diagnosisIds: ids } : {}),
    updatedAt: str(c.updatedAt),
    running: c.running === true,
  };
}

export function parseChats(json: unknown): ChatSummary[] {
  const list = rec(json).chats;
  if (!Array.isArray(list)) return [];
  return list
    .map(parseSummary)
    .filter(c => c.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function parseStep(raw: unknown): Step {
  const s = rec(raw);
  return {
    id: str(s.id),
    tool: str(s.tool),
    reason: str(s.reason),
    ok: typeof s.ok === 'boolean' ? s.ok : undefined,
    summary: str(s.summary) || undefined,
    status: s.status === 'running' ? 'running' : 'done',
    startedAt: str(s.startedAt) || undefined,
    endedAt: str(s.endedAt) || undefined,
    durationMs: typeof s.durationMs === 'number' ? s.durationMs : undefined,
    args: s.args && typeof s.args === 'object' && !Array.isArray(s.args) ? (s.args as Record<string, unknown>) : undefined,
    output: str(s.output) || undefined,
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function parseUsage(raw: unknown): Usage | undefined {
  const u = rec(raw);
  if (!Object.keys(u).length) return undefined;
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    contextTokens: num(u.contextTokens),
    contextWindow: num(u.contextWindow) || undefined,
    calls: num(u.calls),
    costUsd: typeof u.costUsd === 'number' ? u.costUsd : undefined,
    provider: str(u.provider) || undefined,
    identity: str(u.identity) || undefined,
    durationMs: typeof u.durationMs === 'number' ? u.durationMs : undefined,
  };
}

function parseMessage(raw: unknown): ChatMessage {
  const m = rec(raw);
  return {
    id: str(m.id),
    role: m.role === 'user' ? 'user' : 'assistant',
    text: str(m.text),
    createdAt: str(m.createdAt),
    status: STATUSES.includes(m.status as MessageStatus) ? (m.status as MessageStatus) : 'done',
    error: str(m.error) || undefined,
    model: str(m.model) || undefined,
    steps: Array.isArray(m.steps) ? m.steps.map(parseStep) : [],
    thinking: str(m.thinking) || undefined,
    usage: parseUsage(m.usage),
  };
}

export function parseChat(json: unknown): ChatDetail {
  const c = rec(json);
  return {
    ...parseSummary(json),
    createdAt: str(c.createdAt),
    messages: Array.isArray(c.messages) ? c.messages.map(parseMessage) : [],
  };
}

/* ---------- Model picker helpers ---------- */

export const FAVOURITES = '__favourites__';

const PROVIDER_NAMES: Record<string, string> = {
  zai: 'Z.ai',
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  grok: 'Grok',
  opencode: 'OpenCode',
};

const PROVIDER_ICONS: Record<string, string> = {
  claude: 'simple-icons:anthropic',
  codex: 'simple-icons:openai',
  grok: 'simple-icons:x',
  kimi: 'simple-icons:kimi',
  opencode: 'simple-icons:opencode',
  zai: 'mdi:alpha-z-box',
};

export const GENERIC_ICON = 'mdi:robot-outline';

export const providerName = (route: string): string => PROVIDER_NAMES[route] ?? route;
export const providerIcon = (route: string): string => PROVIDER_ICONS[route] ?? GENERIC_ICON;

/**
 * One entry of the picker rail, as in the T3 Code picker: an instance, here the identity (gateway app) of a provider.
 * When two or more identities share a provider each shows a small badge with the initials of its identity.
 */
export interface Instance {
  route: string;
  provider: string;
  /** The provider name, for example `Claude`. */
  name: string;
  identity: string;
  /** The text of the tooltip and the accessible name: the provider, and the identity when the provider has several. */
  label: string;
  showBadge: boolean;
  /** One or two letters for the badge. */
  badge: string;
  models: ModelOption[];
}

export function identityInitials(identity: string): string {
  const words = identity.trim().split(/[\s_-]+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map(w => w[0]) : [...(words[0] ?? '?')].slice(0, 2);
  return letters.join('').toUpperCase();
}

/** The identities that have models, in the order the agent lists them. */
export function instancesOf(models: ModelOption[]): Instance[] {
  const byRoute = new Map<string, ModelOption[]>();
  for (const m of models) {
    const list = byRoute.get(m.route);
    if (list) list.push(m);
    else byRoute.set(m.route, [m]);
  }
  const perProvider = new Map<string, number>();
  for (const list of byRoute.values()) perProvider.set(list[0].provider, (perProvider.get(list[0].provider) ?? 0) + 1);
  return [...byRoute.entries()].map(([route, list]) => {
    const { provider, identity } = list[0];
    const shared = (perProvider.get(provider) ?? 0) > 1;
    return {
      route,
      provider,
      name: providerName(provider),
      identity,
      label: shared ? `${providerName(provider)} \u00b7 ${identity}` : providerName(provider),
      showBadge: shared,
      badge: identityInitials(identity),
      models: list,
    };
  });
}

export function matchesQuery(m: ModelOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${m.name} ${m.model} ${m.id} ${providerName(m.provider)} ${m.identity}`.toLowerCase();
  return q.split(/\s+/).every(t => hay.includes(t));
}

/** Rows of the picker list, one shape in every tab: favourites, one identity, or the search results across all of them. */
export function pickerRows(
  models: ModelOption[],
  active: string,
  query: string,
  favourites: string[]
): ModelOption[] {
  if (query.trim()) return models.filter(m => matchesQuery(m, query));
  if (active === FAVOURITES) return models.filter(m => favourites.includes(m.id));
  return models.filter(m => m.route === active);
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(t).toLocaleDateString();
}

/* ---------- Number formats for the usage line and the context meter ---------- */

/** `950`, `12.3k`, `1.2M`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** US dollars with enough digits for a small cost: `$0.0042`, `$1.28`. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** `840 ms`, `12 s`, `2 min 5 s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

/** The share of the context window in use, 0 to 1, or undefined when the window is unknown. */
export function contextShare(used: number, window?: number): number | undefined {
  return window && window > 0 ? Math.min(1, Math.max(0, used / window)) : undefined;
}

/** Turn an ApiProxy error into banner text: drop a leading list marker or whitespace. */
export function cleanErrorText(e: unknown): string {
  const raw = String((e as any)?.message || e || '');
  const text = raw.replace(/^[\s\-*\u2022\u2013\u2014:]+/, '').trim();
  return text || 'Something went wrong.';
}

/** The prompts that the empty chat offers. */
export const EXAMPLE_PROMPTS = [
  'Which pods are failing right now, and why?',
  'Summarise the most recent incidents.',
  'Are any nodes under memory or disk pressure?',
  'What changed in the cluster in the last hour?',
];
