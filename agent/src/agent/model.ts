import type { ModelConfig } from '../config.js';

/**
 * One chat client for two API styles, so the model is configuration only:
 * - `anthropic`: Messages API (`POST {base}/v1/messages`)
 * - `openai`: Chat Completions (`POST {base}/chat/completions`)
 * Both work through the AIS Gateway, whose app URL is the base and whose app
 * token is the key. No SDK, no provider is hard-coded.
 */

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

export class ModelClient {
  constructor(private readonly config: ModelConfig) {}

  get name(): string {
    return this.config.model;
  }

  private headers(session: string): Record<string, string> {
    const out: Record<string, string> = { 'content-type': 'application/json' };
    for (const [k, v] of Object.entries(this.config.headers)) out[k] = v.replaceAll('{session}', session);
    return out;
  }

  async complete(req: CompleteRequest): Promise<Completion> {
    return this.config.style === 'anthropic' ? this.anthropic(req) : this.openai(req);
  }

  private system(text: string): string {
    return this.config.systemPrefix ? `${this.config.systemPrefix}\n\n${text}` : text;
  }

  private async post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.config.timeoutMs) });
        const text = await res.text();
        if (res.ok) return JSON.parse(text);
        const retryable = res.status === 429 || res.status >= 500;
        lastError = new Error(`Model endpoint answered ${res.status}: ${text.slice(0, 300)}`);
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

  private async anthropic(req: CompleteRequest): Promise<Completion> {
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
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system: this.system(req.system),
      messages,
      tools: req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    };
    if (req.forceTool) body.tool_choice = { type: 'tool', name: req.forceTool };
    const headers = { ...this.headers(req.session), 'x-api-key': this.config.apiKey, authorization: `Bearer ${this.config.apiKey}`, 'anthropic-version': '2023-06-01' };
    const res = await this.post(`${this.config.baseUrl}/v1/messages`, headers, body);
    const blocks: any[] = Array.isArray(res.content) ? res.content : [];
    return {
      text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'),
      toolCalls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input })),
      stop: res.stop_reason ?? '',
      usage: { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 },
    };
  }

  private async openai(req: CompleteRequest): Promise<Completion> {
    const messages: any[] = [{ role: 'system', content: this.system(req.system) }];
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
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages,
      tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    };
    if (req.forceTool) body.tool_choice = { type: 'function', function: { name: req.forceTool } };
    const headers = { ...this.headers(req.session), authorization: `Bearer ${this.config.apiKey}` };
    const res = await this.post(`${this.config.baseUrl}/chat/completions`, headers, body);
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
}
