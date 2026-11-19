import type { ToolSpec } from './model.js';

const RESULT_CHARS = 7000;

/** Cuts a tool result so one call cannot fill the model's context. */
export function clip(text: string, limit = RESULT_CHARS): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… [cut: ${text.length - limit} more characters; ask a narrower question]`;
}

/** Adds the required `reason` argument, so every call states the question it answers. */
export function withReason(spec: ToolSpec): ToolSpec {
  const params = structuredClone(spec.parameters) as { type?: string; properties?: Record<string, unknown>; required?: string[] };
  params.type = 'object';
  params.properties = { reason: { type: 'string', description: 'The one question this call should answer' }, ...(params.properties ?? {}) };
  params.required = ['reason', ...(params.required ?? []).filter(r => r !== 'reason')];
  return { ...spec, parameters: params as Record<string, unknown> };
}
