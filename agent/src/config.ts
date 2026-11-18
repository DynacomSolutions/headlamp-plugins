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
  /** JSON file with per-provider settings (`{"<provider>": {...}}`). */
  providerConfigFile: string;
  /** Browser origins allowed to call /mcp. Requests without an Origin header are always allowed. */
  allowedOrigins: string[];
  /** Where diagnoses are kept across container restarts. Empty keeps them in memory only. */
  dataDir: string;
  maxDiagnoses: number;
  model: ModelConfig;
  diagnosis: DiagnosisConfig;
}

export interface ModelConfig {
  /** `anthropic` (Messages API) or `openai` (Chat Completions). */
  style: 'anthropic' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Extra headers; `{session}` in a value is replaced by a stable id per diagnosis. */
  headers: Record<string, string>;
  /** Text put before the system prompt, for endpoints that insist on their own identity line. */
  systemPrefix: string;
  maxTokens: number;
  timeoutMs: number;
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

function headers(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AGENT_MODEL_HEADERS must be a JSON object');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) out[k] = String(v);
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const style = (env.AGENT_MODEL_STYLE ?? 'openai').toLowerCase();
  if (style !== 'anthropic' && style !== 'openai') throw new Error(`AGENT_MODEL_STYLE must be anthropic or openai, not ${style}`);
  return {
    port: int(env.PORT, 8080),
    host: env.HOST ?? '0.0.0.0',
    kubeApi: env.KUBE_API ?? '',
    kubeTokenFile: env.KUBE_TOKEN_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/token',
    kubeCaFile: env.KUBE_CA_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    metricsUrl: (env.METRICS_URL ?? '').replace(/\/+$/, ''),
    vmalertUrl: (env.VMALERT_URL ?? '').replace(/\/+$/, ''),
    agentMemoryUrl: (env.AGENT_MEMORY_URL ?? 'http://agent-memory.agent-memory.svc/api/state').replace(/\/+$/, ''),
    providerConfigFile: env.PROVIDER_CONFIG_FILE ?? '',
    allowedOrigins: list(env.ALLOWED_ORIGINS, []),
    dataDir: env.DATA_DIR ?? '',
    maxDiagnoses: int(env.MAX_DIAGNOSES, 200),
    model: {
      style,
      baseUrl: (env.AGENT_MODEL_BASE_URL || env.AIS_GATEWAY_URL || '').replace(/\/+$/, ''),
      apiKey: env.AGENT_MODEL_API_KEY || env.AIS_GATEWAY_TOKEN || '',
      model: env.AGENT_MODEL ?? '',
      headers: headers(env.AGENT_MODEL_HEADERS),
      systemPrefix: env.AGENT_MODEL_SYSTEM_PREFIX ?? '',
      maxTokens: int(env.AGENT_MODEL_MAX_TOKENS, 4096),
      timeoutMs: int(env.AGENT_MODEL_TIMEOUT_MS, 120_000),
    },
    diagnosis: {
      toolBudget: int(env.AGENT_TOOL_BUDGET, 10),
      severities: list(env.AGENT_DIAGNOSE_SEVERITIES, ['warning', 'critical']).map(s => s.toLowerCase()),
      maxPerHour: int(env.AGENT_MAX_DIAGNOSES_PER_HOUR, 6),
      ignoreAlerts: list(env.AGENT_IGNORE_ALERTS, ['Watchdog', 'InfoInhibitor']),
    },
  };
}

export function modelConfigured(model: ModelConfig): boolean {
  return Boolean(model.baseUrl && model.apiKey && model.model);
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
