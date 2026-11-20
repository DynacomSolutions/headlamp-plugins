import { maskText } from '../mask.js';
import type { Diagnosis } from '../agent/report.js';
import type { LaunchFix } from './store.js';

/** The tool whose full plan data is copied into a brief. */
export const PLAN_TOOL = 'dns_placement_plan';
export const MAX_BRIEF_CHARS = 40_000;
const FACT_CHARS = 1200;
const MAX_FACTS = 10;

const cut = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit)}... [cut]`);

/** The evidence item that holds the full DNS plan, when the diagnosis has one. */
export function planEvidence(d: Diagnosis | undefined): Diagnosis['evidence'][number] | undefined {
  return d?.evidence.find(e => e.tool === PLAN_TOOL && e.ok && e.data !== undefined);
}

/** True when a fix talks about the DNS plan: it names the tool, cites its fact id, or is about DNS and a plan exists. */
export function fixCitesPlan(fix: Pick<LaunchFix, 'title' | 'detail' | 'command'> | undefined, d: Diagnosis | undefined): boolean {
  const plan = d?.evidence.find(e => e.tool === PLAN_TOOL);
  if (!fix || !plan) return false;
  const text = `${fix.title} ${fix.detail ?? ''} ${fix.command ?? ''}`;
  if (text.includes(PLAN_TOOL)) return true;
  if (new RegExp(`\\b${plan.id}\\b`).test(text)) return true;
  return /\bdns\b/i.test(text);
}

export interface BriefInput {
  preamble: string;
  purpose: string;
  diagnosis?: Diagnosis;
  fix?: LaunchFix;
  /** Text of the chat the request started from, when there is one. */
  chatId?: string;
}

/**
 * The text the launched agent starts with. It holds the operator's purpose, the
 * diagnosis, the facts the diagnosis cites and, for a DNS fix, the full change plan.
 * The agent runs with its own tools and credentials, so the brief names no secret.
 */
export function buildBrief(input: BriefInput): string {
  const parts: string[] = [];
  if (input.preamble.trim()) parts.push(input.preamble.trim());
  parts.push(`## Purpose\n${input.purpose.trim()}`);
  const d = input.diagnosis;
  if (d) {
    const labels = Object.entries(d.alert.labels)
      .filter(([k]) => k !== 'alertname' && k !== 'severity')
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    parts.push(`## Incident\nAlert: ${d.alert.name} (${d.alert.severity || 'no severity'}), ${d.resolvedAt ? 'resolved' : 'firing'}.${labels ? `\nLabels: ${labels}` : ''}\nDiagnosis id: ${d.id}`);
    if (d.result) {
      parts.push(`## Diagnosis\nLikely cause (${d.result.confidence} confidence): ${d.result.likelyCause}\n\n${d.result.summary}\n\nHow to confirm the incident is over: ${d.result.verify}`);
    } else if (d.error) parts.push(`## Diagnosis\nThe diagnosis failed: ${d.error}`);
  }
  if (input.fix) {
    const f = input.fix;
    parts.push(`## Requested fix\n${f.title}${f.detail ? `\n\n${f.detail}` : ''}${f.command ? `\n\nCheck command: \`${f.command}\`` : ''}`);
  }
  if (d) {
    const cited = new Set(d.result?.signals.flatMap(s => s.evidence) ?? []);
    let facts = d.evidence.filter(e => cited.has(e.id));
    if (facts.length === 0) facts = d.evidence.filter(e => e.ok).slice(0, MAX_FACTS);
    if (facts.length > 0) parts.push(`## Facts the diagnosis cites\n${facts.slice(0, MAX_FACTS).map(e => `- ${e.id} (${e.tool}): ${cut(e.summary, FACT_CHARS)}`).join('\n')}`);
    const plan = planEvidence(d);
    if (plan && (!input.fix || fixCitesPlan(input.fix, d))) {
      parts.push(`## DNS placement plan (${plan.id}, from ${PLAN_TOOL}, propose-only data)\nThe plan below is a proposal made from the placement check. Check it against live data before you change anything.\n\n\`\`\`json\n${JSON.stringify(plan.data, null, 2)}\n\`\`\``);
    }
  }
  parts.push('## Rules\nReport what you checked and what you changed. Stop and ask when a step needs access that you do not have.');
  return cut(maskText(parts.join('\n\n')), MAX_BRIEF_CHARS);
}
