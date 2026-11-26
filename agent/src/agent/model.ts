import type { ModelRoute } from '../config.js';

/**
 * One chat client for three API styles, so the model is configuration only:
 * - `anthropic`: Messages API (`POST {base}/v1/messages`)
 * - `openai`: Chat Completions (`POST {base}/chat/completions`)
 * - `responses`: OpenAI Responses API, streamed (`POST {base}/responses`)
 * All work through the AIS Gateway, whose app URL is the base and whose app
 * token is the key. No SDK, no provider is hard-coded.
 */

/** Sent on every call: some gateway providers answer a default library agent with a 403 page. */
export function userAgent(): string {
  return `headlamp-agent/${process.env.HEADLAMP_AGENT_VERSION ?? '0.1.0'}`;
}

/** The headers a route needs on every call, with `{session}` filled in. */
export function routeHeaders(route: ModelRoute, session: string): Record<string, string> {
  const out: Record<string, string> = { 'content-type': 'application/json', 'user-agent': userAgent() };
  for (const [k, v] of Object.entries(route.headers)) out[k] = v.replaceAll('{session}', session);
  if (route.style === 'anthropic') {
    out['x-api-key'] = route.apiKey;
    out['anthropic-version'] = '2023-06-01';
  }
  out.authorization = `Bearer ${route.apiKey}`;
  return out;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: Array<{ id: string; name: string; content: string; isError: boolean }> };

export interface Completion {
  text: string;
  toolCalls: ToolCall[];
  stop: string;
  usage: { input: number; output: number };
}

export interface CompleteRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  /** Force one named tool (used for the final submit after the budget is spent). */
  forceTool?: string;
  session: string;
}

/** The header with which the AIS gateway names why it built an error answer itself. */
export const GATEWAY_ERROR_HEADER = 'x-ais-gateway-error';

/** A non-2xx answer from the endpoint. `retryAfterMs` is the Retry-After header, when it has one. `headers` are the response headers, with lower-case names. */
export class ModelHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs?: number,
    readonly headers: Record<string, string> = {},
  ) {
    super(`Model endpoint answered ${status}: ${body.slice(0, 300)}`);
  }
}

/** A failed Responses stream: the endpoint answered 200, then sent a failure event. */
export class ModelStreamError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date. Undefined when absent or not readable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  const v = (value ?? '').trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** (route, model) pairs whose endpoint refused a forced tool_choice. Later calls skip the forced form. */
const noForcedChoice = new Set<string>();

/** A request after the forced-tool decision: `mustCall` is set when the tool is named in the prompt instead. */
type Req = CompleteRequest & { mustCall?: string };

/** What a run needs from a model: the full id of the model that answers, and one completion call. */
export interface ChatModel {
  /** The full id, `<route>/<model>`. With ordered default models it is the one that answered last. */
  readonly name: string;
  complete(req: CompleteRequest): Promise<Completion>;
}

export interface ModelClientOptions {
  /** Throw a 429 at once, with its Retry-After, instead of retrying. Used when a next model can take over. */
  failFast429?: boolean;
}

export class ModelClient implements ChatModel {
  constructor(
    private readonly route: ModelRoute,
    private readonly model: string,
    private readonly options: ModelClientOptions = {},
  ) {}

  /** The full id, `<route>/<model>`. */
  get name(): string {
    return `${this.route.id}/${this.model}`;
  }

  /**
   * With `forceTool` only that tool is sent, with the style's forced `tool_choice`. When the endpoint
   * answers 400 about `tool_choice`, the call is repeated once without it, with a line in the system
   * prompt that names the tool. The pair is remembered, so later calls skip the forced form.
   */
  async complete(req: CompleteRequest): Promise<Completion> {
    const key = `${this.route.id}/${this.model}`;
    if (!req.forceTool) return this.dispatch(req, false);
    if (noForcedChoice.has(key)) return this.dispatch(req, false);
    try {
      return await this.dispatch(req, true);
    } catch (error) {
      if (error instanceof ModelHttpError && error.status === 400 && /tool_choice/i.test(error.body)) {
        noForcedChoice.add(key);
        return this.dispatch(req, false);
      }
      throw error;
    }
  }

  private dispatch(req: CompleteRequest, force: boolean): Promise<Completion> {
    const tools = req.forceTool ? req.tools.filter(t => t.name === req.forceTool) : req.tools;
    const r = { ...req, tools, forceTool: force ? req.forceTool : undefined, mustCall: !force ? req.forceTool : undefined };
    if (this.route.style === 'anthropic') return this.anthropic(r);
    if (this.route.style === 'responses') return this.responses(r);
    return this.openai(r);
  }

  /** Anthropic style: a prefix goes out as its own first block, as the upstream rejects it inside one string. */
  private systemBlocks(text: string, mustCall?: string): string | Array<{ type: 'text'; text: string }> {
    const prefix = this.route.systemPrefix;
    if (!prefix) return this.system(text, mustCall);
    const rest = mustCall ? `${text}\n\nYou must call the ${mustCall} tool now.` : text;
    return [{ type: 'text', text: prefix }, { type: 'text', text: rest }];
  }

  private system(text: string, mustCall?: string): string {
    const base = this.route.systemPrefix ? `${this.route.systemPrefix}\n\n${text}` : text;
    return mustCall ? `${base}\n\nYou must call the ${mustCall} tool now.` : base;
  }

  /** POST with retries on 429, 5xx and network errors. Returns the raw body text. */
  private async postText(url: string, headers: Record<string, string>, body: unknown): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.route.timeoutMs) });
        const text = await res.text();
        if (res.ok) return text;
        const answered: Record<string, string> = {};
        res.headers.forEach((value, name) => {
          answered[name.toLowerCase()] = value;
        });
        // A missing or expired upstream login does not heal in seconds: no retries, so the next model takes over at once.
        const credential = answered[GATEWAY_ERROR_HEADER] === 'credential_unavailable';
        const retryable = !credential && ((res.status === 429 && !this.options.failFast429) || res.status >= 500);
        lastError = new ModelHttpError(res.status, text, parseRetryAfter(res.headers.get('retry-after')), answered);
        if (!retryable) break;
        const wait = Math.min(Number(res.headers.get('retry-after') ?? 0) * 1000 || 2000 * (attempt + 1), 20_000);
        await new Promise(r => setTimeout(r, wait));
      } catch (error) {
        lastError = error;
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
    return JSON.parse(await this.postText(url, headers, body));
  }

  private async anthropic(req: Req): Promise<Completion> {
    const messages: any[] = [];
    for (const m of req.messages) {
      if (m.role === 'user') messages.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant') {
        const content: any[] = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
        messages.push({ role: 'assistant', content });
      } else {
        messages.push({ role: 'user', content: m.results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError })) });
      }
    }
    const body: any = {
      model: this.model,
      max_tokens: this.route.maxTokens,
      system: this.systemBlocks(req.system, req.mustCall),
      messages,
      tools: req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    };
    if (req.forceTool) body.tool_choice = { type: 'tool', name: req.forceTool };
    const headers = routeHeaders(this.route, req.session);
    const res = await this.post(`${this.route.baseUrl}/v1/messages`, headers, body);
    const blocks: any[] = Array.isArray(res.content) ? res.content : [];
    return {
      text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'),
      toolCalls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input })),
      stop: res.stop_reason ?? '',
      usage: { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 },
    };
  }

  private async openai(req: Req): Promise<Completion> {
    const messages: any[] = [{ role: 'system', content: this.system(req.system, req.mustCall) }];
    for (const m of req.messages) {
      if (m.role === 'user') messages.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant') {
        const msg: any = { role: 'assistant', content: m.text || null };
        if (m.toolCalls.length) msg.tool_calls = m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }));
        messages.push(msg);
      } else {
        for (const r of m.results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
    }
    const body: any = {
      model: this.model,
      max_tokens: this.route.maxTokens,
      messages,
      tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    };
    if (req.forceTool) body.tool_choice = { type: 'function', function: { name: req.forceTool } };
    const headers = routeHeaders(this.route, req.session);
    const res = await this.post(`${this.route.baseUrl}/chat/completions`, headers, body);
    const choice = res.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => {
      let args: unknown = {};
      try {
        args = typeof c.function?.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : (c.function?.arguments ?? {});
      } catch {
        args = { __unparsable: String(c.function?.arguments ?? '') };
      }
      return { id: c.id ?? `call_${i}`, name: c.function?.name ?? '', args };
    });
    return {
      text: typeof msg.content === 'string' ? msg.content : '',
      toolCalls,
      stop: choice.finish_reason ?? '',
      usage: { input: res.usage?.prompt_tokens ?? 0, output: res.usage?.completion_tokens ?? 0 },
    };
  }

  private async responses(req: Req): Promise<Completion> {
    const input: any[] = [];
    for (const m of req.messages) {
      if (m.role === 'user') input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: m.text }] });
      else if (m.role === 'assistant') {
        if (m.text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.text }] });
        for (const c of m.toolCalls) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
      } else {
        for (const r of m.results) input.push({ type: 'function_call_output', call_id: r.id, output: r.content });
      }
    }
    // No max-token field: the backend behind this style does not accept one.
    const body: any = {
      model: this.model,
      instructions: this.system(req.system, req.mustCall),
      input,
      tools: req.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
      store: false,
      stream: true,
    };
    if (req.forceTool) body.tool_choice = { type: 'function', name: req.forceTool };
    const text = await this.postText(`${this.route.baseUrl}/responses`, routeHeaders(this.route, req.session), body);
    return parseResponses(text);
  }
}

/**
 * One line for a failed Responses stream: the event type, the HTTP status and the error code when
 * the upstream sends them, then its message. The upstream puts the error in `response.error`, in
 * `error` or at the top of the event, so all three are read. With no message, the raw event shows.
 */
export function describeStreamFailure(event: any): string {
  const { message, code, status } = streamFailureFields(event);
  const head = [String(event?.type ?? 'error'), status !== undefined ? String(status) : '', code ? `(${code})` : ''].filter(Boolean).join(' ');
  return `Model stream failed: ${head}: ${message || JSON.stringify(event)}`.slice(0, 600);
}

function streamFailureFields(event: any): { message: string; code: string; status?: number } {
  const err = [event?.response?.error, event?.error, event].find(e => e && typeof e === 'object' && (e.message || e.code)) ?? {};
  const message = typeof err.message === 'string' ? err.message : '';
  const code = [err.code, err.type].find(c => typeof c === 'string' && c && c !== event?.type) ?? '';
  const status = event?.status ?? event?.status_code ?? err.status ?? err.status_code;
  return { message, code, status: typeof status === 'number' ? status : undefined };
}

/** The final response object from a Responses stream (SSE, with or without a content-type) or from a plain JSON body. */
function parseResponses(text: string): Completion {
  let response: any;
  const items: any[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    response = JSON.parse(trimmed);
  } else {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.type === 'response.completed' || event.type === 'response.incomplete') response = event.response;
      else if (event.type === 'response.failed' || event.type === 'error') {
        throw new ModelStreamError(describeStreamFailure(event), streamFailureFields(event).code, streamFailureFields(event).status);
      } else if (event.type === 'response.output_item.done' && event.item) items.push(event.item);
    }
  }
  if (!response) {
    if (!items.length) throw new Error('Model stream ended without a completed response');
    response = { output: items };
  }
  const output: any[] = Array.isArray(response.output) && response.output.length ? response.output : items;
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const [i, item] of output.entries()) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) if (part.type === 'output_text' && typeof part.text === 'string') textParts.push(part.text);
    } else if (item.type === 'function_call') {
      let args: unknown = {};
      try {
        args = typeof item.arguments === 'string' ? JSON.parse(item.arguments || '{}') : (item.arguments ?? {});
      } catch {
        args = { __unparsable: String(item.arguments ?? '') };
      }
      toolCalls.push({ id: item.call_id ?? item.id ?? `call_${i}`, name: item.name ?? '', args });
    }
  }
  return {
    text: textParts.join('\n'),
    toolCalls,
    stop: toolCalls.length ? 'tool_use' : (response.status ?? 'completed'),
    usage: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 },
  };
}
