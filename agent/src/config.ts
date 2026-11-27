import { readFileSync } from 'node:fs';

/** Everything the service reads from the environment. Nothing is provider-specific. */
export interface Config {
  port: number;
  host: string;
  /** Kubernetes API base URL. Empty means in-cluster (service account token and CA). */
  kubeApi: string;
  kubeTokenFile: string;
  kubeCaFile: string;
  /** Prometheus-compatible query endpoint (VictoriaMetrics single or vmselect). */
  metricsUrl: string;
  /** vmalert HTTP API, for rules and active alerts. Empty disables those tools. */
  vmalertUrl: string;
  /** The agent-resource state endpoint, for the agent-resource panel. */
  agentResourceUrl: string;
  /** The old state endpoint, tried when agentResourceUrl fails. Empty when the URL was set by an environment variable. */
  agentResourceFallbackUrl: string;
  /** The registry catalogue backend (`/api/repositories`), for the registry and VM images panels. */
  registryCatalogueUrl: string;
  /** JSON file with per-provider settings (`{"<provider>": {...}}`). */
  providerConfigFile: string;
  /** Browser origins allowed to call /mcp. Requests without an Origin header are always allowed. */
  allowedOrigins: string[];
  /** Where chats and launches are kept across container restarts (and the old diagnosis files are imported from). Empty keeps them in memory only. */
  dataDir: string;
  /** PostgreSQL connection URI for the diagnosis history. Empty keeps diagnoses in memory only (tests, local runs). */
  databaseUrl: string;
  /** Chat turns that may run at once across all chats. */
  maxChatTurns: number;
  /** Launches that may be open (pending or active) at once. Finished launches are never dropped. */
  maxLaunches: number;
  /** Seconds between two reconcile runs (open diagnoses against vmalert). */
  reconcileSeconds: number;
  models: ModelRoutesConfig;
  diagnosis: DiagnosisConfig;
  launch: LaunchConfig;
  push: PushConfig;
}

/** Web Push to browsers and installed apps. Without both keys push is off. The agent has its own key pair, not the one of the Alerting plugin. */
export interface PushConfig {
  publicKey: string;
  privateKey: string;
  /** VAPID contact: a `mailto:` or `https:` URL. */
  subject: string;
  /** Extra exact push-service host names. Empty in production. */
  extraHosts: string[];
  /** Pushes one device may get in ten minutes. */
  maxPer10Min: number;
}

/** Launching T3 Code agents from the incident agent. Every value comes from the environment or the settings file. */
export interface LaunchConfig {
  /** Base URL of the T3 server. Empty disables launching. */
  t3Url: string;
  /** File that holds the bearer token. It is read on each use, so a rotated token needs no restart. */
  t3TokenFile: string;
  settingsFile: string;
  /** Approvals per hour across all launches. More get a 429. */
  maxApprovalsPerHour: number;
  settings: LaunchSettings;
  /** Why the settings file could not be used (missing, not JSON). Shown as the reason when launching is off. */
  settingsError?: string;
}

export interface LaunchProject {
  projectId: string;
  title: string;
}

export interface LaunchSettings {
  /** T3 projects by key. The key `default` is used when a request names none. */
  projects: Record<string, LaunchProject>;
  model: { instanceId: string; model: string; options?: Array<{ id: string; value: string | number | boolean }> };
  /** Text put at the top of every brief. */
  briefPreamble: string;
  /** Launches that may be active at once. */
  maxRunning: number;
  /** Link to a thread in the T3 web app, with `{threadId}` in place of the id. */
  threadUrlTemplate: string;
}

export type ModelStyle = 'anthropic' | 'openai' | 'responses';

/** One AIS Gateway app. A gateway app serves one provider, so each provider is one route. */
export interface ModelRoute {
  id: string;
  /** `anthropic` (Messages), `openai` (Chat Completions) or `responses` (OpenAI Responses). */
  style: ModelStyle;
  baseUrl: string;
  apiKey: string;
  /** Extra headers; `{session}` in a value is replaced by a stable id per diagnosis. */
  headers: Record<string, string>;
  /** Text put before the system prompt, for endpoints that insist on their own identity line. */
  systemPrefix: string;
  /** Allowlist of model ids. Also the list used when the gateway cannot list models. */
  models?: string[];
  /**
   * The provider the route belongs to (`claude`, `codex`, ...). A gateway app serves one provider, and one provider may have
   * several apps: the pool app and apps pinned to one account. Routes with the same provider are the identities of that provider.
   * Absent means the route id.
   */
  provider?: string;
  /** The size of the context window in tokens, for models of this route whose gateway list does not state it. */
  contextWindow?: number;
  /** Price per million tokens in US dollars, for the cost line under an answer. Absent means no cost is shown. */
  pricing?: { input: number; output: number };
  /** The name of the identity this route uses, for the picker: `Pool`, or the account of a pinned app. Absent means `Pool`. */
  identity?: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface ModelRoutesConfig {
  routes: ModelRoute[];
  /** Model id used when a run names none: `<route>/<model>` or a bare model id. The first entry of `defaultOrder`. */
  defaultModel: string;
  /**
   * The ordered default models, from AGENT_MODEL (one id, or a comma-separated list). A run with no explicit
   * model tries them in order and moves to the next only on a usage failure. Absent means just `defaultModel`.
   */
  defaultOrder?: string[];
  /** Routes left out because their URL or token variable is empty. */
  skipped: string[];
}

/** The wall-clock limit of one run when AGENT_RUN_TIMEOUT_MS is not set. */
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000;

/** The wall-clock limit of one webhook diagnosis when AGENT_DIAGNOSIS_TIMEOUT_MS is not set. Diagnoses run one after another, so it is shorter than a chat turn. */
export const DEFAULT_DIAGNOSIS_TIMEOUT_MS = 8 * 60_000;

/** The most model calls in one run when AGENT_MAX_MODEL_CALLS is not set. */
export const DEFAULT_MAX_MODEL_CALLS = 60;

/** A time limit as words: `15 minutes`, or `3 seconds` for a short limit. */
export function formatLimit(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.round(ms / 60_000);
    return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
  }
  const sec = Math.max(1, Math.round(ms / 1000));
  return `${sec} ${sec === 1 ? 'second' : 'seconds'}`;
}

export interface DiagnosisConfig {
  /**
   * The wall-clock limit of one diagnosis or one chat turn, in milliseconds. There is no cap on tool calls: a run ends when the
   * model answers, when the context is full, when a person stops it, or at this limit (AGENT_RUN_TIMEOUT_MS, default 15 minutes).
   * AGENT_TOOL_BUDGET of older releases is accepted and ignored.
   */
  runTimeoutMs: number;
  /** The wall-clock limit of one diagnosis that the webhook, a rerun or a resume starts (AGENT_DIAGNOSIS_TIMEOUT_MS, default 8 minutes). */
  diagnosisTimeoutMs: number;
  /**
   * A soft cap on the model calls of one run (AGENT_MAX_MODEL_CALLS, default 60). Tool calls have no cap, but each round is a model call
   * that costs tokens. The last call of a run that reaches the cap must submit or answer.
   */
  maxModelCalls: number;
  /** Alert severities that start a diagnosis from the webhook. */
  severities: string[];
  /** Upper bound on webhook-started diagnoses per hour (protects the model quota). */
  maxPerHour: number;
  /** Re-runs a person started by hand that may be queued or running at one time. They do not count against `maxPerHour`. */
  maxConcurrentReruns: number;
  /** Alerts with these alertnames are never diagnosed. */
  ignoreAlerts: string[];
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value.trim() === '') return fallback;
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const GATEWAY_ENV = /^AIS_GATEWAY_[A-Z0-9_]*(URL|TOKEN)$/;
const STYLES: ModelStyle[] = ['anthropic', 'openai', 'responses'];

function style(value: unknown, where: string): ModelStyle {
  const v = String(value ?? 'openai').toLowerCase();
  if (!STYLES.includes(v as ModelStyle)) throw new Error(`${where}: style must be anthropic, openai or responses, not ${v}`);
  return v as ModelStyle;
}

function headerMap(value: unknown, where: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: headers must be a JSON object`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) out[k] = String(v);
  return out;
}

/** A short display text. `pattern` limits the characters when set. */
function label(value: unknown, field: string, where: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 60 || (pattern && !pattern.test(value))) {
    throw new Error(`${where}: ${field} must be a short text${pattern ? ' of letters, digits, dot, dash or underscore' : ''}`);
  }
  return value.trim();
}

function gatewayEnv(name: unknown, field: string, where: string): string {
  if (typeof name !== 'string' || !GATEWAY_ENV.test(name)) throw new Error(`${where}: ${field} must name an environment variable matching ${GATEWAY_ENV.source}. Models are reached only through the AIS Gateway.`);
  return name;
}

/**
 * Checks an ordered default list. A single id keeps its old meaning, so a bare model id still works.
 * With two or more entries each must be `<route>/<model>` and name a route of the routes file. A route with
 * no credentials is allowed: the run skips it at run time. A repeated entry or an unknown route throws.
 */
function checkDefaultOrder(order: string[], routeIds: Set<string>): void {
  if (order.length < 2) return;
  const seen = new Set<string>();
  for (const entry of order) {
    const slash = entry.indexOf('/');
    if (slash <= 0 || slash === entry.length - 1) throw new Error(`AGENT_MODEL: "${entry}" must be <route>/<model> when more than one model is listed`);
    const route = entry.slice(0, slash);
    if (!routeIds.has(route)) throw new Error(`AGENT_MODEL: unknown route "${route}" in "${entry}". Known routes: ${[...routeIds].join(', ') || 'none'}`);
    if (seen.has(entry)) throw new Error(`AGENT_MODEL: "${entry}" is listed twice`);
    seen.add(entry);
  }
}

/** Reads the routes from AGENT_MODEL_ROUTES_FILE or AGENT_MODEL_ROUTES, else builds the single legacy route. */
export function loadModelRoutes(env: NodeJS.ProcessEnv): ModelRoutesConfig {
  const defaultOrder = list(env.AGENT_MODEL, []);
  const defaultModel = defaultOrder[0] ?? '';
  const maxTokens = int(env.AGENT_MODEL_MAX_TOKENS, 4096);
  const timeoutMs = int(env.AGENT_MODEL_TIMEOUT_MS, 120_000);
  let raw: string | undefined;
  if (env.AGENT_MODEL_ROUTES_FILE) raw = readFileSync(env.AGENT_MODEL_ROUTES_FILE, 'utf8');
  else if (env.AGENT_MODEL_ROUTES) raw = env.AGENT_MODEL_ROUTES;
  const routes: ModelRoute[] = [];
  const skipped: string[] = [];
  if (raw === undefined || raw.trim() === '') {
    const url = (env.AIS_GATEWAY_URL ?? '').replace(/\/+$/, '');
    const token = env.AIS_GATEWAY_TOKEN ?? '';
    const where = 'AGENT_MODEL_STYLE';
    const st = style(env.AGENT_MODEL_STYLE, where);
    if (url && token) {
      routes.push({ id: 'gateway', style: st, baseUrl: url, apiKey: token, headers: headerMap(env.AGENT_MODEL_HEADERS ? JSON.parse(env.AGENT_MODEL_HEADERS) : undefined, 'AGENT_MODEL_HEADERS'), systemPrefix: env.AGENT_MODEL_SYSTEM_PREFIX ?? '', maxTokens, timeoutMs });
    } else skipped.push('gateway');
    checkDefaultOrder(defaultOrder, new Set(['gateway']));
    return { routes, defaultModel, defaultOrder, skipped };
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('The model routes must be a JSON array');
  const seen = new Set<string>();
  for (const [i, entry] of parsed.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Model route ${i} must be an object`);
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : '';
    if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(id)) throw new Error(`Model route ${i}: id must be letters, digits, dot, dash or underscore`);
    if (seen.has(id)) throw new Error(`Model route ${id} is listed twice`);
    seen.add(id);
    const where = `Model route ${id}`;
    if ('baseUrl' in e || 'apiKey' in e) throw new Error(`${where}: baseUrl and apiKey are not allowed. Use urlEnv and tokenEnv with AIS_GATEWAY_* variables.`);
    const urlEnv = gatewayEnv(e.urlEnv, 'urlEnv', where);
    const tokenEnv = gatewayEnv(e.tokenEnv, 'tokenEnv', where);
    const st = style(e.style, where);
    const url = (env[urlEnv] ?? '').replace(/\/+$/, '');
    const token = env[tokenEnv] ?? '';
    if (!url || !token) {
      skipped.push(id);
      continue;
    }
    let models: string[] | undefined;
    if (e.models !== undefined) {
      if (!Array.isArray(e.models) || e.models.some(m => typeof m !== 'string')) throw new Error(`${where}: models must be an array of strings`);
      models = e.models as string[];
    }
    const contextWindow = typeof e.contextWindow === 'number' && e.contextWindow > 0 ? Math.floor(e.contextWindow) : undefined;
    const price = e.pricing as { input?: unknown; output?: unknown } | undefined;
    const pricing = price && typeof price.input === 'number' && typeof price.output === 'number' && price.input >= 0 && price.output >= 0 ? { input: price.input, output: price.output } : undefined;
    const provider = e.provider === undefined ? undefined : label(e.provider, 'provider', where, /^[a-z0-9][a-z0-9_.-]*$/i);
    const identity = e.identity === undefined ? undefined : label(e.identity, 'identity', where);
    routes.push({
      id,
      style: st,
      baseUrl: url,
      apiKey: token,
      headers: headerMap(e.headers, where),
      systemPrefix: typeof e.systemPrefix === 'string' ? e.systemPrefix : '',
      models,
      ...(contextWindow ? { contextWindow } : {}),
      ...(pricing ? { pricing } : {}),
      ...(provider ? { provider } : {}),
      ...(identity ? { identity } : {}),
      maxTokens: typeof e.maxTokens === 'number' && e.maxTokens > 0 ? Math.floor(e.maxTokens) : maxTokens,
      timeoutMs: typeof e.timeoutMs === 'number' && e.timeoutMs > 0 ? Math.floor(e.timeoutMs) : timeoutMs,
    });
  }
  checkDefaultOrder(defaultOrder, seen);
  return { routes, defaultModel, defaultOrder, skipped };
}

const emptyLaunchSettings = (): LaunchSettings => ({ projects: {}, model: { instanceId: '', model: '' }, briefPreamble: '', maxRunning: 2, threadUrlTemplate: '' });

function plainString(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Parses the launch settings JSON. A wrong value is dropped, so a bad file turns launching off and never stops the service. */
export function parseLaunchSettings(raw: unknown): LaunchSettings {
  const out = emptyLaunchSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (r.projects && typeof r.projects === 'object' && !Array.isArray(r.projects)) {
    for (const [key, value] of Object.entries(r.projects as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_.-]{1,60}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || !value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      const projectId = plainString(v.projectId, 100);
      if (!projectId) continue;
      out.projects[key] = { projectId, title: plainString(v.title, 120) || key };
    }
  }
  if (r.model && typeof r.model === 'object' && !Array.isArray(r.model)) {
    const m = r.model as Record<string, unknown>;
    out.model.instanceId = plainString(m.instanceId, 100);
    out.model.model = plainString(m.model, 100);
    if (Array.isArray(m.options)) {
      const options = m.options
        .filter((o): o is { id: string; value: string | number | boolean } => !!o && typeof o === 'object' && typeof (o as { id?: unknown }).id === 'string' && ['string', 'number', 'boolean'].includes(typeof (o as { value?: unknown }).value))
        .map(o => ({ id: o.id, value: o.value }));
      if (options.length > 0) out.model.options = options;
    }
  }
  out.briefPreamble = typeof r.briefPreamble === 'string' ? r.briefPreamble.slice(0, 8000) : '';
  out.maxRunning = typeof r.maxRunning === 'number' && Number.isFinite(r.maxRunning) && r.maxRunning >= 1 ? Math.floor(r.maxRunning) : 2;
  const template = plainString(r.threadUrlTemplate, 500);
  out.threadUrlTemplate = /^https?:\/\//.test(template) ? template : '';
  return out;
}

export function loadLaunchConfig(env: NodeJS.ProcessEnv): LaunchConfig {
  const settingsFile = env.AGENT_LAUNCH_SETTINGS_FILE ?? '';
  let settings = emptyLaunchSettings();
  let settingsError: string | undefined;
  if (settingsFile) {
    try {
      settings = parseLaunchSettings(JSON.parse(readFileSync(settingsFile, 'utf8')));
    } catch (error) {
      settingsError = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'The launch settings file does not exist' : 'The launch settings file is not valid JSON';
    }
  }
  return { t3Url: (env.T3_URL ?? '').trim().replace(/\/+$/, ''), t3TokenFile: env.T3_TOKEN_FILE ?? '', settingsFile, maxApprovalsPerHour: int(env.AGENT_MAX_LAUNCH_APPROVALS_PER_HOUR, 4), settings, settingsError };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env.PORT, 8080),
    host: env.HOST ?? '0.0.0.0',
    kubeApi: env.KUBE_API ?? '',
    kubeTokenFile: env.KUBE_TOKEN_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/token',
    kubeCaFile: env.KUBE_CA_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    metricsUrl: (env.METRICS_URL ?? '').replace(/\/+$/, ''),
    vmalertUrl: (env.VMALERT_URL ?? '').replace(/\/+$/, ''),
    // AGENT_MEMORY_URL is the old name, still read until every deployment has moved.
    agentResourceFallbackUrl: env.AGENT_RESOURCE_URL ?? env.AGENT_MEMORY_URL ? '' : 'http://agent-memory.agent-memory.svc/api/state',
    agentResourceUrl: (env.AGENT_RESOURCE_URL ?? env.AGENT_MEMORY_URL ?? 'http://agent-resource.agent-resource.svc/api/state').replace(/\/+$/, ''),
    registryCatalogueUrl: (env.REGISTRY_CATALOGUE_URL ?? 'http://registry-catalog.registry.svc/api/repositories').replace(/\/+$/, ''),
    providerConfigFile: env.PROVIDER_CONFIG_FILE ?? '',
    allowedOrigins: list(env.ALLOWED_ORIGINS, []),
    dataDir: env.DATA_DIR ?? '',
    databaseUrl: (env.DATABASE_URL ?? '').trim(),
    maxChatTurns: int(env.AGENT_MAX_CHAT_TURNS, 3),
    maxLaunches: int(env.AGENT_MAX_LAUNCHES, 200),
    reconcileSeconds: int(env.AGENT_RECONCILE_SECONDS, 60),
    models: loadModelRoutes(env),
    diagnosis: {
      runTimeoutMs: int(env.AGENT_RUN_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS),
      diagnosisTimeoutMs: int(env.AGENT_DIAGNOSIS_TIMEOUT_MS, DEFAULT_DIAGNOSIS_TIMEOUT_MS),
      maxModelCalls: Math.max(2, int(env.AGENT_MAX_MODEL_CALLS, DEFAULT_MAX_MODEL_CALLS)),
      severities: list(env.AGENT_DIAGNOSE_SEVERITIES, ['warning', 'critical']).map(s => s.toLowerCase()),
      maxPerHour: int(env.AGENT_MAX_DIAGNOSES_PER_HOUR, 6),
      maxConcurrentReruns: int(env.AGENT_MAX_CONCURRENT_RERUNS, 2),
      ignoreAlerts: list(env.AGENT_IGNORE_ALERTS, ['Watchdog', 'InfoInhibitor']),
    },
    launch: loadLaunchConfig(env),
    push: {
      publicKey: (env.PUSH_VAPID_PUBLIC_KEY ?? '').trim(),
      privateKey: (env.PUSH_VAPID_PRIVATE_KEY ?? '').trim(),
      subject: (env.PUSH_SUBJECT ?? '').trim() || 'mailto:noreply@example.com',
      extraHosts: list(env.PUSH_EXTRA_HOSTS, []).map(h => h.toLowerCase()),
      maxPer10Min: int(env.PUSH_MAX_PER_10_MIN, 10),
    },
  };
}

export function modelConfigured(models: ModelRoutesConfig): boolean {
  return models.routes.length > 0 && Boolean(models.defaultModel);
}

export function loadProviderSettings(file: string): Record<string, Record<string, unknown>> {
  if (!file) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Record<string, unknown>>) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}
