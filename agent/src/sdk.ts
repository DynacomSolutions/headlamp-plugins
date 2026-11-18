/**
 * The extension point. A Headlamp plugin adds data for agents by exporting a
 * provider from `plugins/<plugin>/agent/provider.ts`:
 *
 *   import { defineProvider, defineTool, z } from '../../../agent/src/sdk.js';
 *
 *   export const provider = defineProvider({
 *     name: 'disk_health',
 *     title: 'Disk health',
 *     description: 'SMART health and disk performance per node',
 *     tools: [defineTool({ name: 'disk_health_smart', input: z.object({...}), output: z.object({...}), run })],
 *   });
 *
 * and listing it in `agent/src/providers/plugins.ts`. Each tool declares zod
 * schemas for its input and output; the server publishes them as the MCP
 * tool's `inputSchema` and `outputSchema`, validates every call and every
 * result against them, masks secrets in the result and attaches an A2UI view.
 *
 * Providers get read-only clients only: Kubernetes GET, Prometheus queries and
 * GETs to in-cluster services. There is no way to write from a provider.
 */
import { z } from 'zod';
import type { KubeClient } from './kube.js';
import type { PromClient } from './prom.js';
import type { SummaryView } from './a2ui/index.js';

export { z };

export interface ToolContext {
  kube: KubeClient;
  prom: PromClient;
  /** vmalert API GET (`/api/v1/alerts`, `/api/v1/rules`); throws when VMALERT_URL is unset. */
  vmalert(path: string): Promise<unknown>;
  /** GET a JSON document from an in-cluster Service (`http://name.namespace.svc...`). */
  serviceGet(url: string): Promise<unknown>;
  /** This provider's settings from the provider config file (cluster-specific names and URLs). */
  settings: Record<string, unknown>;
  now: Date;
}

export interface ToolResult<Output> {
  /** Structured result, validated against the tool's output schema and sent as `structuredContent`. */
  data: Output;
  /** One or two plain sentences for text-only hosts and for the model. */
  summary: string;
  /** Rows for the shared A2UI summary view. Omitted rows mean the summary alone is shown. */
  view?: Omit<SummaryView, 'summary'> & { summary?: string };
}

export interface ToolDefinition<In extends z.ZodType = z.ZodType, Out extends z.ZodType = z.ZodType> {
  /** `snake_case`, unique across all providers; plugin tools start with the provider name. */
  name: string;
  title: string;
  description: string;
  input: In;
  output: Out;
  run(args: z.infer<In>, ctx: ToolContext): Promise<ToolResult<z.infer<Out>>>;
}

export interface ProviderDefinition {
  /** `snake_case`; also the key of this provider's settings in the provider config file. */
  name: string;
  title: string;
  description: string;
  tools: ToolDefinition[];
}

export function defineTool<In extends z.ZodType, Out extends z.ZodType>(tool: ToolDefinition<In, Out>): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

export function defineProvider(provider: ProviderDefinition): ProviderDefinition {
  return provider;
}

/** Reads a string setting with a default, for cluster-specific names in providers. */
export function setting(settings: Record<string, unknown>, key: string, fallback: string): string {
  const value = settings[key];
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

/** Escapes a value for use inside a PromQL label matcher string. */
export function promString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
