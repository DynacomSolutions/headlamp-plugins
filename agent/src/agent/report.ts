import { z } from 'zod';
import { SurfaceBuilder, surfaceId, type A2uiMessage, type IconName } from '../a2ui/index.js';
import { mask } from '../mask.js';

export const alertSchema = z.object({
  name: z.string(),
  severity: z.string().default(''),
  labels: z.record(z.string(), z.string()).default({}),
  annotations: z.record(z.string(), z.string()).default({}),
  startsAt: z.string().default(''),
  endsAt: z.string().optional(),
  fingerprint: z.string().default(''),
  generatorURL: z.string().optional(),
});
export type Alert = z.infer<typeof alertSchema>;

/** What the model hands in through the submit_diagnosis tool. */
export const resultSchema = z.object({
  summary: z.string().min(1).max(1200).describe('What happened, why and since when, in at most four plain sentences'),
  likelyCause: z.string().min(1).max(400).describe('The single most likely cause, one sentence'),
  confidence: z.enum(['high', 'medium', 'low']),
  signals: z
    .array(
      z.object({
        text: z.string().min(1).max(400).describe('One observation from the evidence'),
        evidence: z.array(z.string()).min(1).describe('Fact ids (e1, t3, ...) the observation rests on'),
        holds: z.boolean().default(true).describe('false when this checked signal argues against the cause'),
      }),
    )
    .max(8),
  fixes: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        detail: z.string().min(1).max(600),
        command: z.string().max(300).optional().describe('Optional read-only command to check or confirm, for example kubectl describe or smartctl -a'),
        recommended: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(5),
  verify: z.string().min(1).max(400).describe('How a person confirms the incident is over'),
});
export type DiagnosisResult = z.infer<typeof resultSchema>;

export interface EvidenceItem {
  id: string;
  tool: string;
  reason: string;
  summary: string;
  ok: boolean;
  /** Full tool data, kept only for the tools whose data a launched agent needs (the DNS placement plan). */
  data?: unknown;
}

/** A failed attempt that a re-run replaced. The record keeps it, so the history of the failure stays. */
export interface PreviousAttempt {
  /** When the attempt ended (ISO). */
  at: string;
  model: string;
  error: string;
}

export interface Diagnosis {
  id: string;
  createdAt: string;
  finishedAt?: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  source: 'webhook' | 'acp' | 'api' | 'cli';
  host?: string;
  alert: Alert;
  resolvedAt?: string;
  /** Why the diagnosis was resolved when no resolve notification did it: a fold into a newer one, or an alert that vmalert no longer has. */
  resolvedNote?: string;
  /** How many times the alert fired (activations, each with a new `startsAt`) while this diagnosis was open. Absent means once. */
  fires?: number;
  /** The `startsAt` (ISO) of the latest activation that this diagnosis took in. */
  lastFiredAt?: string;
  result?: DiagnosisResult;
  evidence: EvidenceItem[];
  toolCalls: number;
  toolBudget: number;
  /** The model that answered. With the default order it can differ from the first choice. */
  model: string;
  /** True when a person or an alert picked `model`: it was used as it is, with no fallback. Absent on records from before the default order. */
  modelPinned?: boolean;
  error?: string;
  a2ui: A2uiMessage[];
  /** True when an outside agent (ACP, CLI) published this diagnosis through the API. Its evidence data is not trusted. */
  published?: boolean;
  /** The process that holds this record while it is queued or running. */
  owner?: string;
  /** The holder's claim ends at this time (ISO). After it, another process may take over. */
  leaseUntil?: string;
  /** How many times a process started this diagnosis. A takeover adds one. */
  attempts?: number;
  /** When a person last ran this diagnosis again (ISO). A re-run does not count against the hourly limit. */
  rerunAt?: string;
  /** The failed attempts that re-runs replaced, oldest first. */
  previousAttempts?: PreviousAttempt[];
}

/** Commands a fix may show: reads and checks only. Anything else is dropped from the fix, its text stays. */
const READ_ONLY_COMMAND =
  /^\s*(kubectl\s+(get|describe|logs|top|events|explain|auth\s+can-i|version|api-resources|cluster-info)\b|smartctl\s+(-[aAiHxlc]+|--(all|health|info|xall))\b|df\b|du\b|lsblk\b|journalctl\b|dmesg\b|free\b|uptime\b|systemctl\s+(status|is-active|list-units)\b|ss\b|ip\s+(a|addr|route|link)\b|dig\b|nslookup\b|host\b|ping\b|traceroute\b|openssl\s+(s_client|x509)\b|curl\s+(-[sSfILkvo]+\s+)*(--head\s+)?['"]?https?:\/\/|argocd\s+app\s+(get|diff|history)\b|helm\s+(status|history|get)\b|cat\s|ls\b|stat\b)/;
const CHAINING = /[;&|`]|\$\(|>\s*\S/;

export function isReadOnlyCommand(command: string): boolean {
  return READ_ONLY_COMMAND.test(command) && !CHAINING.test(command.replace(/\|\s*(head|tail|grep|less|wc|jq|sort|uniq)\b[^|;&]*/g, ''));
}

/**
 * Applies the rules the model is told but cannot be trusted to keep: evidence
 * ids must exist, at most one fix is recommended, commands are read-only, and
 * every string is masked.
 */
export function sanitizeResult(result: DiagnosisResult, knownIds: Set<string>): DiagnosisResult {
  const signals = result.signals
    .map(s => ({ ...s, evidence: s.evidence.filter(id => knownIds.has(id)) }))
    .filter(s => s.evidence.length > 0);
  let recommended = false;
  const fixes = result.fixes.map(f => {
    const fix = { ...f };
    if (fix.recommended) {
      if (recommended) fix.recommended = false;
      recommended = true;
    }
    if (fix.command && !isReadOnlyCommand(fix.command)) {
      fix.detail = `${fix.detail} (A suggested command was removed because it was not read-only; make changes through Git.)`;
      delete fix.command;
    }
    return fix;
  });
  return mask({ ...result, signals, fixes });
}

function severityIcon(severity: string, status: Diagnosis['status']): IconName {
  if (status === 'failed') return 'error';
  if (status !== 'done') return 'refresh';
  if (severity === 'critical') return 'error';
  if (severity === 'warning') return 'warning';
  return 'info';
}

function md(text: string): string {
  // Basic catalog Text supports simple Markdown; keep model text from opening links or HTML.
  return text.replace(/[<>]/g, '').replace(/\]\(/g, '] (');
}

/** The diagnosis as one self-contained A2UI v1.0 surface (basic catalog only). */
export function renderDiagnosis(d: Diagnosis): A2uiMessage[] {
  const b = new SurfaceBuilder();
  const r = d.result;
  const headline = r ? r.likelyCause : d.status === 'failed' ? `Diagnosis failed: ${d.error ?? 'unknown error'}` : 'Diagnosis in progress';
  const header = b.row([b.icon(severityIcon(d.alert.severity, d.status)), b.text(`## ${md(d.alert.name)}`)], undefined, 'start', 'center');
  const meta = [
    d.alert.severity || 'no severity',
    d.resolvedAt ? 'alert resolved' : 'alert firing',
    r ? `${r.confidence} confidence` : d.status,
    `${d.toolCalls}/${d.toolBudget} tool calls`,
    d.model,
    d.createdAt.replace('T', ' ').slice(0, 16) + ' UTC',
  ].filter(Boolean);
  const top = [header, b.text(`**${md(headline)}**`), b.text(meta.join(' · '), 'caption')];
  const labels = Object.entries(d.alert.labels)
    .filter(([k]) => k !== 'alertname' && k !== 'severity')
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  if (labels) top.push(b.text(labels, 'caption'));

  const tabs: Array<{ title: string; child: string }> = [];
  if (r) {
    const diag: string[] = [b.text(md(r.summary))];
    if (r.signals.length) {
      diag.push(b.text('**Evidence**'));
      diag.push(
        b.list(r.signals.map(s => b.text(`${s.holds ? '✓' : '✗'} ${md(s.text)}  \n_${s.evidence.join(', ')}_`))),
      );
    }
    diag.push(b.text('**Suggested fixes**'));
    diag.push(
      b.list(
        r.fixes.map((f, i) => {
          const parts = [b.text(`${i + 1}. **${md(f.title)}**${f.recommended ? ' (recommended)' : ''}`), b.text(md(f.detail), 'caption')];
          if (f.command) parts.push(b.text(`\`${f.command.replace(/`/g, "'")}\``, 'caption'));
          return b.column(parts);
        }),
      ),
    );
    diag.push(b.text('**How to confirm**'));
    diag.push(b.text(md(r.verify)));
    tabs.push({ title: 'Diagnosis', child: b.column(diag) });
  }
  // The evidence trail uses data binding: one template row over /trail.
  const trailRow = b.column([b.text({ '@path': 'heading' }), b.text({ '@path': 'summary' }, 'caption')], 'trail_row');
  const trail = b.list({ path: '/trail', componentId: trailRow });
  tabs.push({ title: `Evidence trail (${d.evidence.length})`, child: trail });
  const alertText = [d.alert.annotations.summary, d.alert.annotations.description].filter(Boolean).join('\n\n');
  tabs.push({ title: 'Alert', child: b.text(md(alertText || 'No annotations.')) });

  const body = b.column([...top, b.divider(), b.tabs(tabs)]);
  b.card(body, 'root');
  const dataModel = {
    trail: d.evidence.map(e => ({ heading: `**${e.id}** ${e.tool}${e.ok ? '' : ' (failed)'}: ${md(e.reason)}`, summary: md(e.summary) })),
  };
  return b.build(surfaceId('diagnosis', d.id), dataModel);
}

/** Plain Markdown for text-only hosts (ACP message chunks, Claude Code). */
export function diagnosisMarkdown(d: Diagnosis): string {
  const r = d.result;
  if (!r) return d.status === 'failed' ? `Diagnosis failed: ${d.error ?? 'unknown error'}` : 'Diagnosis in progress.';
  const lines = [
    `## ${d.alert.name}: ${r.likelyCause}`,
    `${d.alert.severity || 'no severity'} · ${r.confidence} confidence · ${d.toolCalls}/${d.toolBudget} tool calls`,
    '',
    r.summary,
    '',
    '**Evidence**',
    ...r.signals.map(s => `- ${s.holds ? '✓' : '✗'} ${s.text} (${s.evidence.join(', ')})`),
    '',
    '**Suggested fixes**',
    ...r.fixes.map((f, i) => `${i + 1}. **${f.title}**${f.recommended ? ' (recommended)' : ''}: ${f.detail}${f.command ? `\n   \`${f.command}\`` : ''}`),
    '',
    `**How to confirm:** ${r.verify}`,
    '',
    '**Evidence trail**',
    ...d.evidence.map(e => `- ${e.id} ${e.tool}: ${e.reason} → ${e.summary}`),
  ];
  return lines.join('\n');
}
