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
  /** The agent-memory state endpoint, for the agent-memory panel. */
  agentMemoryUrl: string;
  /** The registry catalogue backend (`/api/repositories`), for the registry and VM images panels. */
  registryCatalogueUrl: string;
  /** JSON file with per-provider settings (`{"<provider>": {...}}`). */
  providerConfigFile: string;
  /** Browser origins allowed to call /mcp. Requests without an Origin header are always allowed. */
  allowedOrigins: string[];
  /** Where diagnoses are kept across container restarts. Empty keeps them in memory only. */
  dataDir: string;
  maxDiagnoses: number;
  /** Chats kept in the data directory. The oldest are dropped first. */
  maxChats: number;
  /** Chat turns that may run at once across all chats. */
  maxChatTurns: number;
  models: ModelRoutesConfig;
  diagnosis: DiagnosisConfig;
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
  maxTokens: number;
  timeoutMs: number;
}

export interface ModelRoutesConfig {
  routes: ModelRoute[];
  /** Model id used when a run names none: `<route>/<model>` or a bare model id. */
  defaultModel: string;
  /** Routes left out because their URL or token variable is empty. */
  skipped: string[];
}

export interface DiagnosisConfig {
  /** Tool calls the model may make per diagnosis. */
  toolBudget: number;
  /** Alert severities that start a diagnosis from the webhook. */
  severities: string[];
  /** Upper bound on webhook-started diagnoses per hour (protects the model quota). */
  maxPerHour: number;
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

function gatewayEnv(name: unknown, field: string, where: string): string {
  if (typeof name !== 'string' || !GATEWAY_ENV.test(name)) throw new Error(`${where}: ${field} must name an environment variable matching ${GATEWAY_ENV.source}. Models are reached only through the AIS Gateway.`);
  return name;
}

/** Reads the routes from AGENT_MODEL_ROUTES_FILE or AGENT_MODEL_ROUTES, else builds the single legacy route. */
export function loadModelRoutes(env: NodeJS.ProcessEnv): ModelRoutesConfig {
  const defaultModel = (env.AGENT_MODEL ?? '').trim();
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
    return { routes, defaultModel, skipped };
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
    routes.push({
      id,
      style: st,
      baseUrl: url,
      apiKey: token,
      headers: headerMap(e.headers, where),
      systemPrefix: typeof e.systemPrefix === 'string' ? e.systemPrefix : '',
      models,
      maxTokens: typeof e.maxTokens === 'number' && e.maxTokens > 0 ? Math.floor(e.maxTokens) : maxTokens,
      timeoutMs: typeof e.timeoutMs === 'number' && e.timeoutMs > 0 ? Math.floor(e.timeoutMs) : timeoutMs,
    });
  }
  return { routes, defaultModel, skipped };
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
    agentMemoryUrl: (env.AGENT_MEMORY_URL ?? 'http://agent-memory.agent-memory.svc/api/state').replace(/\/+$/, ''),
    registryCatalogueUrl: (env.REGISTRY_CATALOGUE_URL ?? 'http://registry-catalog.registry.svc/api/repositories').replace(/\/+$/, ''),
    providerConfigFile: env.PROVIDER_CONFIG_FILE ?? '',
    allowedOrigins: list(env.ALLOWED_ORIGINS, []),
    dataDir: env.DATA_DIR ?? '',
    maxDiagnoses: int(env.MAX_DIAGNOSES, 200),
    maxChats: int(env.AGENT_MAX_CHATS, 200),
    maxChatTurns: int(env.AGENT_MAX_CHAT_TURNS, 3),
    models: loadModelRoutes(env),
    diagnosis: {
      toolBudget: int(env.AGENT_TOOL_BUDGET, 10),
      severities: list(env.AGENT_DIAGNOSE_SEVERITIES, ['warning', 'critical']).map(s => s.toLowerCase()),
      maxPerHour: int(env.AGENT_MAX_DIAGNOSES_PER_HOUR, 6),
      ignoreAlerts: list(env.AGENT_IGNORE_ALERTS, ['Watchdog', 'InfoInhibitor']),
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
