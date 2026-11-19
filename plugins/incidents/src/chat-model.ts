/** Chat API types, parsers and picker helpers (pure, no React). */

export interface ModelOption {
  id: string;
  route: string;
  model: string;
  name: string;
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
}

export interface ChatSummary {
  id: string;
  title: string;
  model: string;
  diagnosisId?: string;
  updatedAt: string;
  running: boolean;
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
      return { id, route, model, name: str(m.name) || model };
    })
    .filter(m => m.id);
  return { default: str(j.default), models };
}

export function parseSummary(raw: unknown): ChatSummary {
  const c = rec(raw);
  return {
    id: str(c.id),
    title: str(c.title),
    model: str(c.model),
    diagnosisId: str(c.diagnosisId) || undefined,
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
};

export const GENERIC_ICON = 'mdi:robot-outline';

export const providerName = (route: string): string => PROVIDER_NAMES[route] ?? route;
export const providerIcon = (route: string): string => PROVIDER_ICONS[route] ?? GENERIC_ICON;

export interface ProviderGroup {
  route: string;
  name: string;
  models: ModelOption[];
}

export function groupByProvider(models: ModelOption[]): ProviderGroup[] {
  const map = new Map<string, ModelOption[]>();
  for (const m of models) {
    const list = map.get(m.route);
    if (list) list.push(m);
    else map.set(m.route, [m]);
  }
  return [...map.entries()].map(([route, list]) => ({
    route,
    name: providerName(route),
    models: list,
  }));
}

export function matchesQuery(m: ModelOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${m.name} ${m.model} ${m.id} ${providerName(m.route)}`.toLowerCase();
  return q.split(/\s+/).every(t => hay.includes(t));
}

/** Rows shown in the picker list: favourites, one provider, or search results grouped by provider. */
export function pickerRows(
  models: ModelOption[],
  active: string,
  query: string,
  favourites: string[]
): { group: string | null; models: ModelOption[] }[] {
  if (query.trim()) {
    return groupByProvider(models.filter(m => matchesQuery(m, query))).map(g => ({
      group: g.name,
      models: g.models,
    }));
  }
  if (active === FAVOURITES) {
    const list = models.filter(m => favourites.includes(m.id));
    return list.length ? [{ group: null, models: list }] : [];
  }
  const list = models.filter(m => m.route === active);
  return list.length ? [{ group: null, models: list }] : [];
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

/** Turn an ApiProxy error into banner text: drop a leading list marker or whitespace. */
export function cleanErrorText(e: unknown): string {
  const raw = String((e as any)?.message || e || '');
  const text = raw.replace(/^[\s\-*\u2022\u2013\u2014:]+/, '').trim();
  return text || 'Something went wrong.';
}
