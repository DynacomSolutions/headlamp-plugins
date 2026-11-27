import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fingerprint } from './alerts.js';
import { alertSchema, renderDiagnosis, resultSchema, sanitizeResult, type Diagnosis } from './agent/report.js';
import { mask } from './mask.js';
import type { DiagnosisStore } from './store.js';

/** The body of POST /api/diagnoses that publishes a diagnosis an agent made elsewhere (the ACP agent, a CLI run). */
export const publishSchema = z.object({
  diagnosis: z.object({
    id: z.string().uuid().optional(),
    source: z.enum(['acp', 'api', 'cli']).default('api'),
    host: z.string().max(80).optional(),
    alert: alertSchema,
    status: z.enum(['done', 'failed']),
    result: resultSchema.optional(),
    error: z.string().max(2000).optional(),
    evidence: z.array(z.object({ id: z.string().max(16), tool: z.string().max(80), reason: z.string().max(400), summary: z.string().max(2000), ok: z.boolean(), data: z.unknown().refine(v => v === undefined || JSON.stringify(v).length <= 30_000, 'data is too large').optional() })).max(60).default([]),
    toolCalls: z.number().int().min(0).max(1000).default(0),
    // Records of older releases carry a tool budget. It is accepted and not kept.
    toolBudget: z.number().int().min(0).max(1000).optional(),
    model: z.string().max(120).default(''),
    createdAt: z.string().optional(),
  }),
});

export type PublishInput = z.infer<typeof publishSchema>['diagnosis'];

/**
 * Stores a diagnosis that an outside agent made. Its full tool data is dropped: a launch brief never trusts it.
 * The HTTP route and the in-process ACP endpoint both call this, so Headlamp shows both the same way.
 */
export async function storePublished(store: DiagnosisStore, p: PublishInput): Promise<Diagnosis> {
  const known = new Set(p.evidence.map(e => e.id));
  const d: Diagnosis = mask({
    id: p.id ?? randomUUID(),
    createdAt: p.createdAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: p.status,
    source: p.source,
    host: p.host,
    alert: { ...p.alert, fingerprint: p.alert.fingerprint || fingerprint({ alertname: p.alert.name, ...p.alert.labels }) },
    result: p.result ? sanitizeResult(p.result, known) : undefined,
    error: p.error,
    evidence: p.evidence.map(({ data: _data, ...e }) => e),
    published: true,
    toolCalls: p.toolCalls,
    model: p.model,
    a2ui: [],
  });
  d.a2ui = renderDiagnosis(d);
  await store.put(d);
  return d;
}
