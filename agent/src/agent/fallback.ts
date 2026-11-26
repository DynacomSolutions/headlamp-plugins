import { ModelHttpError, ModelStreamError, type ChatModel, type CompleteRequest, type Completion } from './model.js';

/**
 * Ordered default models. A run that names no model tries the entries of AGENT_MODEL in order.
 * It moves to the next entry only when the endpoint reports that the model has no usage left.
 * Any other failure (400, 5xx, timeout, a tool error) is reported as before.
 */

/** Why an entry was passed over. Also the `reason` label of headlamp_agent_model_fallback_total. */
export type FallbackReason = 'rate_limit' | 'payment' | 'quota' | 'usage_limit' | 'missing_credentials';

export interface UsageFailure {
  reason: FallbackReason;
  /** How long the endpoint says the model stays unavailable. Absent when it did not say. */
  retryAfterMs?: number;
}

/** Error codes that name a usage, quota, credit or rate limit. The Codex backend and the gateway send these. */
const USAGE_CODES = new Set([
  'rate_limit_exceeded',
  'rate_limit',
  'rate_limited',
  'usage_limit_reached',
  'usage_limit_exceeded',
  'usage_limit',
  'insufficient_quota',
  'quota_exceeded',
  'quota_exhausted',
  'resource_exhausted',
  'billing_hard_limit_reached',
  'credit_balance_too_low',
  'insufficient_credits',
  'account_exhausted',
  'plan_limit_reached',
  'too_many_requests',
]);
const USAGE_WORDS = /\b(quota|usage|credits?|limits?|limited|exhausted|billing)\b/i;

/** The error object of a JSON body: `{error:{code,type,message}}`, `{code,message}` or `{error:"text"}`. */
function bodyError(body: string): { code: string; message: string; retryAfterMs?: number } {
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    return { code: '', message: body.slice(0, 500) };
  }
  const err = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error : json;
  const field = (v: unknown): string => (typeof v === 'string' ? v : '');
  const code = [err?.code, err?.type, json?.code].map(field).find(Boolean) ?? '';
  const message = [err?.message, typeof json?.error === 'string' ? json.error : '', json?.message].map(field).find(Boolean) ?? '';
  const secs = [err?.resets_in_seconds, err?.retry_after, json?.retry_after].find(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  return { code: code.toLowerCase(), message, ...(typeof secs === 'number' ? { retryAfterMs: Math.round(secs * 1000) } : {}) };
}

/**
 * Tells a usage failure from any other failure. A usage failure is:
 * - HTTP 429 or 402;
 * - HTTP 403 whose body names a quota, usage, credit or limit;
 * - any answer with an explicit usage error code (the gateway and Codex shape: `usage_limit_reached` and the like);
 * - a Responses stream that fails with such a code, or with 429 or 402.
 * Everything else returns undefined: 400 validation, 5xx, timeouts, network errors and tool errors.
 */
export function classifyUsageFailure(error: unknown): UsageFailure | undefined {
  if (error instanceof ModelHttpError) {
    const body = bodyError(error.body);
    const retryAfterMs = error.retryAfterMs ?? body.retryAfterMs;
    const keep = (reason: FallbackReason): UsageFailure => ({ reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
    if (error.status === 429) return keep('rate_limit');
    if (error.status === 402) return keep('payment');
    if (USAGE_CODES.has(body.code)) return keep('usage_limit');
    if (error.status === 403 && USAGE_WORDS.test(body.message || body.code)) return keep('quota');
    return undefined;
  }
  if (error instanceof ModelStreamError) {
    const code = error.code.toLowerCase();
    if (error.status === 429 || USAGE_CODES.has(code)) return { reason: error.status === 429 || code.startsWith('rate_limit') ? 'rate_limit' : 'usage_limit' };
    if (error.status === 402) return { reason: 'payment' };
    return undefined;
  }
  return undefined;
}

/** What the catalogue gives a run: one candidate of the default order. */
export interface Candidate {
  /** Full id, `<route>/<model>`. */
  id: string;
  client: ChatModel;
}

export interface FallbackHooks {
  /** An entry hit a usage failure: remember it for a cool-down. */
  exhausted(id: string, failure: UsageFailure): void;
  /** The run moved from one entry to the next. */
  moved(from: string, to: string, reason: FallbackReason): void;
}

/**
 * One chat client for a run with no explicit model. It tries the candidates in order.
 * It moves on only for a usage failure, and only before any call of the run has succeeded:
 * once the model has answered, the user has seen its output, so a later usage failure is reported as it is.
 */
export class FallbackModel implements ChatModel {
  private index = 0;
  private answered = false;

  constructor(
    private readonly candidates: Candidate[],
    private readonly hooks: FallbackHooks,
  ) {
    if (!candidates.length) throw new Error('FallbackModel needs at least one candidate');
  }

  /** The model that answered last, or the one that tries first. */
  get name(): string {
    return this.candidates[this.index]!.id;
  }

  async complete(req: CompleteRequest): Promise<Completion> {
    for (;;) {
      const current = this.candidates[this.index]!;
      try {
        const out = await current.client.complete(req);
        this.answered = true;
        return out;
      } catch (error) {
        const failure = this.answered ? undefined : classifyUsageFailure(error);
        const next = this.candidates[this.index + 1];
        if (!failure) throw error;
        this.hooks.exhausted(current.id, failure);
        if (!next) throw error;
        this.hooks.moved(current.id, next.id, failure.reason);
        this.index++;
      }
    }
  }
}
