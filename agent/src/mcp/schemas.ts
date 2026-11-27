import { z } from 'zod';

const str = z.string();
const maybe = <T extends z.ZodType>(t: T) => t.nullable();
const labels = z.record(z.string(), z.string());

export const investigationSummary = z.object({
  status: z.enum(['none', 'queued', 'running', 'done', 'failed']),
  attempt: z.number().int(),
  model: maybe(str),
  startedAt: maybe(str),
  finishedAt: maybe(str),
  error: maybe(str),
  automatic: z.boolean(),
});

export const incident = z.object({
  id: str,
  uri: str,
  name: str,
  severity: z.enum(['critical', 'warning', 'info', 'none']),
  state: z.enum(['open', 'acknowledged', 'resolved']),
  escalated: z.boolean(),
  labels,
  annotations: labels,
  fingerprint: str,
  test: z.boolean(),
  startsAt: str,
  createdAt: str,
  updatedAt: str,
  fires: z.number().int(),
  acknowledgedAt: maybe(str),
  acknowledgedBy: maybe(str),
  resolvedAt: maybe(str),
  resolvedBy: maybe(str),
  resolution: maybe(str),
  escalatedAt: maybe(str),
  noteCount: z.number().int(),
  investigation: investigationSummary,
});

export const investigation = investigationSummary.extend({
  incidentId: str,
  uri: str,
  toolCalls: z.number().int(),
  previousAttempts: z.array(z.object({ at: str, model: str, error: str })),
});

export const timelineEntry = z.object({
  seq: z.number().int(),
  at: str,
  kind: z.enum(['fired', 'refired', 'alert_resolved', 'investigation_queued', 'investigation_started', 'investigation_done', 'investigation_failed', 'acknowledged', 'note', 'escalated', 'resolved']),
  actor: str,
  text: maybe(str),
  data: maybe(z.record(z.string(), z.unknown())),
});

export const investigationResult = z.object({
  summary: str,
  likelyCause: str,
  confidence: z.enum(['high', 'medium', 'low']),
  signals: z.array(z.object({ text: str, evidence: z.array(str), holds: z.boolean() })),
  fixes: z.array(z.object({ title: str, detail: str, command: str.optional(), recommended: z.boolean() })),
  verify: str,
  evidence: z.array(z.object({ id: str, tool: str, reason: str, summary: str, ok: z.boolean() })),
});

export const requestId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional().describe('Makes a retry safe: the same requestId returns the first result.');
export const incidentId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).describe('The incident id (a UUID).');

export const eventSchema = z.object({
  id: str,
  at: str,
  kind: str,
  uri: str,
  incidentId: maybe(str),
  labels,
  actor: maybe(str),
});

export const eventPage = z.object({
  events: z.array(eventSchema),
  nextAfter: str,
  hasMore: z.boolean(),
  latest: maybe(str),
  oldestRetained: maybe(str),
  reset: z.boolean(),
});
