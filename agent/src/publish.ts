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
    /** The name of the token that started the run (ACP). A label, never the token. */
    client: z.string().max(80).optional(),
    createdAt: z.string().optional(),
  }),
});

const MAX_EVIDENCE = 60;

const cut = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);

/**
 * Cuts a finished diagnosis to the limits of `publishSchema`, so a long run does not lose its result to a validation error.
 * Evidence that the result cites stays first, then the earliest items, in the original order.
 */
export function fitForPublish<T extends { evidence: EvidenceLike[]; error?: string; host?: string; model: string; toolCalls: number; client?: string; result?: { signals?: Array<{ evidence: string[] }> } }>(d: T): T {
  let evidence = d.evidence;
  if (evidence.length > MAX_EVIDENCE) {
    const cited = new Set((d.result?.signals ?? []).flatMap(s => s.evidence));
    const keep = new Set<EvidenceLike>(evidence.filter(e => cited.has(e.id)).slice(0, MAX_EVIDENCE));
    for (const e of evidence) if (keep.size < MAX_EVIDENCE) keep.add(e);
    evidence = evidence.filter(e => keep.has(e));
  }
  return {
    ...d,
    evidence: evidence.map(e => ({
      ...e,
      id: cut(e.id, 16),
      tool: cut(e.tool, 80),
      reason: cut(e.reason, 400),
      summary: cut(e.summary, 2000),
      // Large data is dropped: the stored record never keeps it.
      data: e.data !== undefined && JSON.stringify(e.data).length <= 30_000 ? e.data : undefined,
    })),
    error: d.error === undefined ? undefined : cut(d.error, 2000),
    host: d.host === undefined ? undefined : cut(d.host, 80),
    model: cut(d.model, 120),
    client: d.client === undefined ? undefined : cut(d.client, 80),
    toolCalls: Math.min(d.toolCalls, 1000),
  };
}

interface EvidenceLike {
  id: string;
  tool: string;
  reason: string;
  summary: string;
  ok: boolean;
  data?: unknown;
}

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
    client: p.client,
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
