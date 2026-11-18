import { z } from 'zod';
import { mask, maskText } from './mask.js';
import { summaryViewData, type A2uiMessage, type SummaryView } from './a2ui/index.js';
import type { ProviderDefinition, ToolContext, ToolDefinition } from './sdk.js';

const NAME = /^[a-z][a-z0-9_]{2,63}$/;

export interface ToolOutcome {
  tool: string;
  ok: boolean;
  /** Masked, schema-checked structured data (or `{error}` when ok is false). */
  data: unknown;
  /** Masked one-line summary. */
  summary: string;
  /** A2UI data update for the shared summary view. */
  a2ui: A2uiMessage[];
}

export interface RegisteredTool {
  provider: ProviderDefinition;
  tool: ToolDefinition;
  inputJsonSchema: Record<string, unknown>;
  outputJsonSchema: Record<string, unknown>;
}

/**
 * All tools from the core and plugin providers. Every call goes through
 * `call`, which validates input, runs the tool with read-only clients,
 * validates the output, masks secrets and builds the A2UI view, so a plugin
 * cannot skip any of those steps.
 */
export class Registry {
  readonly tools = new Map<string, RegisteredTool>();
  readonly providers: ProviderDefinition[] = [];

  constructor(providers: ProviderDefinition[]) {
    for (const provider of providers) this.add(provider);
  }

  private add(provider: ProviderDefinition): void {
    if (!NAME.test(provider.name)) throw new Error(`Provider name "${provider.name}" must be snake_case`);
    if (this.providers.some(p => p.name === provider.name)) throw new Error(`Duplicate provider ${provider.name}`);
    for (const tool of provider.tools) {
      if (!NAME.test(tool.name)) throw new Error(`Tool name "${tool.name}" must be snake_case`);
      if (this.tools.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
      this.tools.set(tool.name, {
        provider,
        tool,
        inputJsonSchema: jsonSchema(tool.input),
        outputJsonSchema: jsonSchema(tool.output),
      });
    }
    this.providers.push(provider);
  }

  async call(name: string, args: unknown, ctxFor: (provider: ProviderDefinition) => ToolContext): Promise<ToolOutcome> {
    const entry = this.tools.get(name);
    if (!entry) return failure(name, `Unknown tool ${name}`);
    const parsed = entry.tool.input.safeParse(args ?? {});
    if (!parsed.success) return failure(name, `Invalid arguments: ${z.prettifyError(parsed.error)}`);
    try {
      const result = await entry.tool.run(parsed.data, ctxFor(entry.provider));
      const checked = entry.tool.output.safeParse(result.data);
      if (!checked.success) return failure(name, `Tool returned data that does not match its output schema: ${z.prettifyError(checked.error)}`);
      const data = mask(checked.data);
      const summary = maskText(result.summary);
      const view: SummaryView = mask({
        title: result.view?.title ?? entry.tool.title,
        summary: result.view?.summary ?? summary,
        rows: result.view?.rows ?? [],
      });
      return { tool: name, ok: true, data, summary, a2ui: [summaryViewData(view)] };
    } catch (error) {
      return failure(name, maskText(error instanceof Error ? error.message : String(error)));
    }
  }
}

function failure(tool: string, message: string): ToolOutcome {
  return {
    tool,
    ok: false,
    data: { error: message },
    summary: message,
    a2ui: [summaryViewData({ title: `${tool} failed`, summary: message, rows: [] })],
  };
}

export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}
