import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_MAX_MODEL_CALLS, DEFAULT_RUN_TIMEOUT_MS, formatLimit } from '../config.js';
import { mask, maskText } from '../mask.js';
import { trimHistory } from './history.js';
import { closeToolCalls, finalCallMs, reserveMs } from './limits.js';
import type { ChatModel, Message, ToolCall, ToolSpec } from './model.js';
import { renderDiagnosis, resultSchema, sanitizeResult, type Alert, type Diagnosis, type EvidenceItem } from './report.js';
import { readSkill } from './skill.js';
import { clip, withReason } from './tools.js';

/** Where tools come from: the in-process registry (server) or an MCP server (ACP agent). */
export interface ToolHost {
  list(): Promise<ToolSpec[]>;
  call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; summary: string; data: unknown }>;
}

export type EngineEvent =
  | { type: 'tool_start'; id: string; tool: string; reason: string; args: Record<string, unknown>; pack: boolean }
  | { type: 'tool_end'; id: string; tool: string; ok: boolean; summary: string }
  | { type: 'thought'; text: string }
  | { type: 'progress'; diagnosis: Diagnosis };

export interface DiagnoseOptions {
  alert: Alert;
  tools: ToolHost;
  model: ChatModel;
  /** Wall-clock limit of the run in milliseconds. A run that is near it must submit. Default 15 minutes. */
  timeoutMs?: number;
  /** A soft cap on the model calls of the run. The call that reaches it must submit. Default 60. */
  maxModelCalls?: number;
  source: Diagnosis['source'];
  host?: string;
  id?: string;
  onEvent?: (event: EngineEvent) => void;
  signal?: AbortSignal;
}

const SUBMIT = 'submit_diagnosis';
/** Tools whose full result is kept in the evidence item, so an agent can start from it. */
const KEEP_DATA = new Set(['dns_placement_plan']);
const KEEP_DATA_CHARS = 30_000;

function urlHost(instance: string | undefined): string | undefined {
  if (!instance) return undefined;
  try {
    return new URL(instance).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** The deterministic first look, chosen from the alert's labels; calls no model. */
export function evidencePlan(alert: Alert, available: Set<string>): Array<{ tool: string; reason: string; args: Record<string, unknown> }> {
  const l = alert.labels;
  const plan: Array<{ tool: string; reason: string; args: Record<string, unknown> }> = [];
  const add = (tool: string, reason: string, args: Record<string, unknown>) => {
    if (available.has(tool)) plan.push({ tool, reason, args });
  };
  const ns = l.namespace ?? l.exported_namespace;
  const pod = l.pod ?? l.exported_pod;
  const node = l.node ?? l.nodename ?? l.kubernetes_node;
  add('list_alert_rules', 'What does this alert measure?', { filter: alert.name });
  if (ns && pod) {
    add('get_resource', 'What state is the pod in, and what happened to it?', { kind: 'Pod', name: pod, namespace: ns, includeEvents: true });
    add('get_pod_logs', 'What did the container log before the alert?', { namespace: ns, pod, tailLines: 80, ...(l.container ? { container: l.container } : {}) });
  }
  for (const [label, kind] of [
    ['deployment', 'Deployment'],
    ['statefulset', 'StatefulSet'],
    ['daemonset', 'DaemonSet'],
    ['job_name', 'Job'],
    ['persistentvolumeclaim', 'PersistentVolumeClaim'],
  ] as const) {
    if (ns && l[label]) add('get_resource', `What state is the ${kind} in?`, { kind, name: l[label], namespace: ns, includeEvents: true });
  }
  if (node) add('get_resource', 'Is the node healthy?', { kind: 'Node', name: node, section: 'status.conditions' });
  if (/smart|disk|nvme/i.test(alert.name) || l.device) add('disk_health_smart', 'What does SMART say about the disks?', node ? { node } : {});
  if (/disk|filesystem|space|inode/i.test(alert.name)) add('disk_health_capacity', 'How full are the filesystems, and how fast are they growing?', node ? { node, minUsedPercent: 50 } : { minUsedPercent: 80 });
  if (/probe|uptime|http|endpoint|tls|cert/i.test(alert.name) || l.target) add('uptime_status', 'What do the uptime probes show?', l.target || l.instance ? { target: l.target ?? l.instance } : { onlyFailing: true });
  const host = l.host;
  if (/dns|placement/i.test(alert.name)) {
    add('dns_placement_status', 'Do the DNS records match the placement rules?', { onlyDrift: true, ...(host ? { host } : {}) });
    add('dns_placement_plan', 'What exact DNS change would fix the placement? (proposal only)', host ? { hosts: [host] } : {});
  }
  if (/probe|uptime|slow|latency/i.test(alert.name)) {
    const target = l.target ?? l.instance;
    add('uptime_response_times', 'How slow are the probes, and from which site?', { ...(target ? { target } : {}), ...(host ? { host } : {}) });
    if (/slow|latency/i.test(alert.name) && !/dns|placement/i.test(alert.name)) {
      const probeHost = host ?? urlHost(l.instance);
      if (probeHost) add('dns_placement_status', 'Do the DNS records of this host point at the right nodes?', { host: probeHost });
    }
  }
  add('list_events', 'What warnings happened recently?', { ...(ns ? { namespace: ns } : {}), type: 'Warning', sinceMinutes: 120, limit: 25 });
  if (!ns && !pod && !node) add('cluster_overview', 'What else is broken right now?', {});
  return plan;
}

export async function diagnose(opts: DiagnoseOptions): Promise<Diagnosis> {
  const started = Date.now();
  const limit = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const maxCalls = Math.max(2, opts.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS);
  const callMs = opts.model.callTimeoutMs;
  const reserve = reserveMs(limit, callMs);
  const elapsed = () => Date.now() - started;
  // The run signal ends at the limit. A model call, a retry wait and a tool call in flight all stop with it.
  const runSignal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(limit)]) : AbortSignal.timeout(limit);
  const stopped = new Promise<never>((_, reject) => runSignal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  stopped.catch(() => undefined);
  const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, stopped]);
  const timedOut = () => runSignal.aborted && !opts.signal?.aborted;
  const diagnosis: Diagnosis = {
    id: opts.id ?? randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'running',
    source: opts.source,
    host: opts.host,
    alert: mask(opts.alert),
    evidence: [],
    toolCalls: 0,
    model: opts.model.name,
    a2ui: [],
  };
  const emit = (event: EngineEvent) => opts.onEvent?.(event);
  const progress = () => {
    diagnosis.a2ui = renderDiagnosis(diagnosis);
    emit({ type: 'progress', diagnosis });
  };
  progress();
  const known = new Set<string>();
  const facts: string[] = [];

  async function run(tool: string, args: Record<string, unknown>, reason: string, id: string, pack: boolean): Promise<string> {
    emit({ type: 'tool_start', id, tool, reason, args, pack });
    let item: EvidenceItem;
    let content: string;
    try {
      const out = await guard(opts.tools.call(tool, args));
      item = { id, tool, reason: maskText(reason), summary: maskText(out.summary), ok: out.ok };
      content = clip(maskText(JSON.stringify(mask(out.data))));
      const data = KEEP_DATA.has(tool) && out.ok ? mask(out.data) : undefined;
      if (data !== undefined && JSON.stringify(data).length <= KEEP_DATA_CHARS) item.data = data;
    } catch (error) {
      const message = maskText(error instanceof Error ? error.message : String(error));
      item = { id, tool, reason: maskText(reason), summary: message, ok: false };
      content = JSON.stringify({ error: message });
    }
    diagnosis.evidence.push(item);
    known.add(id);
    emit({ type: 'tool_end', id, tool, ok: item.ok, summary: item.summary });
    progress();
    return content;
  }

  try {
    const specs = await guard(opts.tools.list());
    const names = new Set(specs.map(s => s.name));
    const skill = readSkill();
    const tools: ToolSpec[] = specs.map(s => withReason(s));
    const submit: ToolSpec = { name: SUBMIT, description: 'Give the final diagnosis. Call exactly once, at the end.', parameters: submitSchema() };
    const messages: Message[] = [];
    const initial = (): Message => ({
      role: 'user',
      text: [
        `## Alert\n${JSON.stringify(diagnosis.alert, null, 2)}`,
        `## Evidence pack\n${facts.join('\n\n')}`,
        `## Method\nCall as many tools as you need. Each tool call needs a \`reason\`. Results are numbered t1, t2, ... in order. Stop when the evidence is enough, and finish with ${SUBMIT}. The run has a time limit of ${formatLimit(limit)}.`,
      ].join('\n\n'),
    });
    /** Records a submit call. Returns true when it was valid. */
    const takeSubmit = (call: ToolCall): boolean => {
      const parsed = resultSchema.safeParse(call.args);
      if (!parsed.success) return false;
      diagnosis.result = sanitizeResult(parsed.data, known);
      return true;
    };
    let pending: Array<{ id: string; name: string; content: string; isError: boolean }> = [];
    let calls = 0;
    let n = 0;

    try {
      for (const step of evidencePlan(opts.alert, names)) {
        if (opts.signal?.aborted) throw new Error('cancelled');
        if (runSignal.aborted) throw new Error('cancelled');
        const id = `e${++n}`;
        const content = await run(step.tool, step.args, step.reason, id, true);
        facts.push(`### ${id}: ${step.tool} ${JSON.stringify(step.args)}\nQuestion: ${step.reason}\n${content}`);
      }
      messages.push(initial());
      let t = 0;
      let nudges = 0;
      for (;;) {
        if (opts.signal?.aborted) throw new Error('cancelled');
        if (runSignal.aborted) throw new Error('cancelled');
        // A model that sends invalid diagnoses to the end of its calls will not recover: stop, do not wait for the time limit.
        if (calls >= maxCalls + 1) throw new Error('The model gave no valid diagnosis');
        // The model may only submit when the time that is left is the time of two calls, or when the next call is the last one allowed.
        const late = elapsed() >= limit - reserve || calls >= maxCalls - 1;
        const completion = await guard(
          opts.model.complete({
            system: skill.body,
            messages: trimHistory(messages),
            tools: late ? [submit] : [...tools, submit],
            forceTool: late ? SUBMIT : undefined,
            session: diagnosis.id,
            signal: runSignal,
          }),
        );
        calls++;
        // With ordered default models the answering model can differ from the first choice.
        diagnosis.model = opts.model.name;
        if (completion.text.trim()) emit({ type: 'thought', text: maskText(completion.text.trim()) });
        messages.push({ role: 'assistant', text: completion.text, toolCalls: completion.toolCalls });
        if (completion.toolCalls.length === 0) {
          // A model that answers in plain text twice after the nudge will not submit: stop, do not wait for the time limit.
          if (++nudges > 2) break;
          messages.push({ role: 'user', text: `Call ${SUBMIT} now with your diagnosis.` });
          continue;
        }
        nudges = 0;
        const results: Array<{ id: string; name: string; content: string; isError: boolean }> = [];
        pending = results;
        let submitted = false;
        for (const call of completion.toolCalls) {
          // The limit or a stop came in this round: the rest of the round does not run. The catch below answers the open calls.
          if (opts.signal?.aborted || runSignal.aborted) throw new Error('cancelled');
          if (call.name === SUBMIT) {
            if (!takeSubmit(call)) {
              const parsed = resultSchema.safeParse(call.args);
              const why = parsed.success ? '' : z.prettifyError(parsed.error);
              results.push({ id: call.id, name: call.name, content: `Invalid diagnosis: ${why}. Fix it and call ${SUBMIT} again.`, isError: true });
              continue;
            }
            submitted = true;
            results.push({ id: call.id, name: call.name, content: 'Diagnosis recorded.', isError: false });
            continue;
          }
          if (!names.has(call.name)) {
            results.push({ id: call.id, name: call.name, content: `There is no tool named ${call.name}.`, isError: true });
            continue;
          }
          // A forced submit call that names another tool is not run.
          if (late) {
            results.push({ id: call.id, name: call.name, content: `Call ${SUBMIT} now. No other tool runs.`, isError: true });
            continue;
          }
          diagnosis.toolCalls++;
          const { reason, ...args } = (call.args ?? {}) as Record<string, unknown>;
          const id = `t${++t}`;
          const content = await run(call.name, args, typeof reason === 'string' && reason ? reason : '(no reason given)', id, false);
          results.push({ id: call.id, name: call.name, content: `[${id}] ${content}`, isError: false });
        }
        messages.push({ role: 'tool', results });
        pending = [];
        if (submitted) break;
      }
    } catch (error) {
      // The time limit ended the run before a submit. One last call, with its own short limit, so the work is not lost.
      if (!timedOut() || diagnosis.result) throw error;
      if (!messages.length) messages.push(initial());
      closeToolCalls(messages, pending);
      const last = await opts.model.complete({
        system: skill.body,
        messages: trimHistory(messages),
        tools: [submit],
        forceTool: SUBMIT,
        session: diagnosis.id,
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(finalCallMs(callMs))]) : AbortSignal.timeout(finalCallMs(callMs)),
      });
      diagnosis.model = opts.model.name;
      const call = last.toolCalls.find(c => c.name === SUBMIT);
      if (!call || !takeSubmit(call)) throw error;
    }
    if (!diagnosis.result) throw new Error('The model did not submit a diagnosis');
    diagnosis.status = 'done';
  } catch (error) {
    diagnosis.status = 'failed';
    diagnosis.error = timedOut() ? `The diagnosis took longer than ${formatLimit(limit)}.` : maskText(error instanceof Error ? error.message : String(error));
  }
  diagnosis.finishedAt = new Date().toISOString();
  diagnosis.a2ui = renderDiagnosis(diagnosis);
  emit({ type: 'progress', diagnosis });
  return diagnosis;
}

function submitSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(resultSchema, { io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
