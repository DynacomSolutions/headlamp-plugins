/*
 * Pure functions: derive the runner board from Kubernetes objects and merge in
 * the optional scanner endpoint. No React and no network access here so it is
 * unit-testable. The output shape matches the scanner's status.json.
 */
import type {
  History,
  Job,
  ModelInput,
  NodeStatus,
  PluginConfig,
  Raw,
  ScaleSetSummary,
  Starting,
  Status,
} from './types';

export const STALE_AFTER_S = 180;

const meta = (o: Raw): Raw => o?.metadata ?? {};
const annotations = (o: Raw): Raw => meta(o).annotations ?? {};
const labels = (o: Raw): Raw => meta(o).labels ?? {};

export function scaleSetOf(o: Raw): string {
  return (
    annotations(o)['actions.github.com/runner-scale-set-name'] ||
    labels(o)['actions.github.com/scale-set-name'] ||
    ''
  );
}

/** "owner/repo/.github/workflows/ci.yml@refs/heads/main" -> "ci.yml" */
export function workflowName(ref?: string | null): string {
  if (!ref) return '';
  return String(ref).split('@', 1)[0].split('/').pop() || '';
}

export function phaseStatus(phase?: string | null): string {
  const map: Record<string, string> = {
    Running: 'in_progress',
    Pending: 'queued',
    Succeeded: 'completed',
    Failed: 'completed',
    Deleting: 'in_progress',
  };
  const v = (phase || '').trim();
  return map[v] || v.toLowerCase() || 'in_progress';
}

export function phaseConclusion(phase?: string | null): string | null {
  const v = (phase || '').trim();
  if (v === 'Succeeded') return 'success';
  if (v === 'Failed') return 'failure';
  return null;
}

export function runUrl(repository?: string | null, runId?: unknown): string | null {
  if (!repository || !runId) return null;
  return `https://github.com/${repository}/actions/runs/${runId}`;
}

/** Link to the workflow file for a jobWorkflowRef, or null. */
export function workflowUrl(ref?: string | null): string | null {
  if (!ref) return null;
  const [path, gitRef = 'HEAD'] = String(ref).split('@', 2);
  const m = path.match(/^([^/]+\/[^/]+)\/(.+)$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/blob/${gitRef.replace(/^refs\/(heads|tags)\//, '')}/${m[2]}`;
}

export function repoUrl(repository?: string | null): string | null {
  return repository ? `https://github.com/${repository}` : null;
}

export function parseAliases(text?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (text || '').split(',')) {
    const [id, ...rest] = part.split('=');
    if (id && rest.length) out[id.trim()] = rest.join('=').trim();
  }
  return out;
}

export function isRunnerPod(pod: Raw): boolean {
  const l = labels(pod);
  if (String(l['actions-ephemeral-runner'] || '').toLowerCase() === 'true') return true;
  if (
    l['app.kubernetes.io/component'] === 'runner' &&
    (l['actions.github.com/scale-set-name'] ||
      annotations(pod)['actions.github.com/runner-scale-set-name'])
  ) {
    return true;
  }
  return (meta(pod).ownerReferences || []).some((r: Raw) => r?.kind === 'EphemeralRunner');
}

function condition(o: Raw, type: string): string | undefined {
  return (o?.status?.conditions || []).find((c: Raw) => c?.type === type)?.status;
}

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

function makeJob(p: Partial<Job> & { name: string; runner_name: string; scale_set: string }): Job {
  const run = runUrl(p.repository, p.run_id);
  return {
    key: [p.repository || '', p.run_id || '', p.name, p.job_id || p.runner_name].join('|'),
    repository: p.repository || '',
    workflow: workflowName(p.workflow_ref),
    workflow_ref: p.workflow_ref || '',
    run_id: p.run_id ?? null,
    job_id: p.job_id ?? null,
    numeric_job_id: p.numeric_job_id ?? null,
    url: p.url || run,
    run_url: run,
    node_id: p.node_id ?? null,
    status: p.status || 'in_progress',
    conclusion: p.conclusion ?? null,
    started_at: p.started_at ?? null,
    completed_at: p.completed_at ?? null,
    name: p.name,
    runner_name: p.runner_name,
    scale_set: p.scale_set,
  };
}

function emptyNode(
  id: string,
  kind: NodeStatus['kind'],
  ready: boolean,
  os: string,
  aliases: Record<string, string>
): NodeStatus {
  return {
    id,
    display_name: aliases[id] || id,
    kind,
    ready,
    os,
    jobs: [],
    starting: [],
  };
}

/** Label and StatusLabel status for a node, honouring the optional state. */
export function nodeBadge(node: Pick<NodeStatus, 'ready' | 'state'>): {
  label: string;
  status: 'success' | 'warning' | 'error' | '';
} {
  switch (node.state) {
    case 'standby':
      return { label: 'standby', status: '' };
    case 'starting':
      return { label: 'starting', status: 'warning' };
    case 'busy':
      return { label: 'busy', status: 'success' };
    case 'online':
      return { label: 'online', status: 'success' };
    case 'offline':
      return { label: 'offline', status: 'error' };
    default:
      return node.ready
        ? { label: 'ready', status: 'success' }
        : { label: 'offline', status: 'error' };
  }
}

export function summarise(nodes: NodeStatus[], scaleSets: ScaleSetSummary[]): Status['summary'] {
  const starting = nodes.reduce((n, x) => n + x.starting.length, 0);
  const scalePending = scaleSets.reduce((n, s) => n + Number(s.pending || 0), 0);
  return {
    running_jobs: nodes.reduce((n, x) => n + x.jobs.length, 0),
    pending_runners: Math.max(starting, scalePending),
    nodes_ready: nodes.filter(n => n.ready).length,
    nodes_standby: nodes.filter(n => n.state === 'standby').length,
    nodes_total: nodes.length,
  };
}

function sortNodes(nodes: NodeStatus[]): NodeStatus[] {
  return [...nodes].sort(
    (a, b) =>
      Number(a.kind === 'external') - Number(b.kind === 'external') ||
      a.display_name.toLowerCase().localeCompare(b.display_name.toLowerCase())
  );
}

/** Port of the scanner's build_status(), Kubernetes-only. */
export function buildLocalStatus(input: ModelInput): Status {
  const aliases = input.nodeAliases || {};
  const nodes: Record<string, NodeStatus> = {};
  for (const n of input.nodes) {
    const id = meta(n).name;
    if (!id) continue;
    nodes[id] = emptyNode(
      id,
      'kubernetes',
      condition(n, 'Ready') === 'True',
      n.status?.nodeInfo?.operatingSystem || labels(n)['kubernetes.io/os'] || 'linux',
      aliases
    );
  }
  const ensure = (id: string) =>
    (nodes[id] ??= emptyNode(id, 'kubernetes', false, 'linux', aliases));

  const podsByName: Record<string, Raw> = {};
  for (const p of input.pods) if (meta(p).name) podsByName[meta(p).name] = p;
  const assigned = new Set<string>();

  for (const r of input.runners) {
    const name: string = meta(r).name || '';
    const st = r.status || {};
    const runnerName: string = st.runnerName || name;
    const pod = podsByName[name];
    if (pod) assigned.add(name);
    const nodeId: string | undefined = pod?.spec?.nodeName;
    const phase: string = st.phase || '';
    const startedAt = pod?.status?.startTime || meta(r).creationTimestamp || null;
    const scale = scaleSetOf(r);
    const hasJob = !!(st.jobDisplayName || st.jobRepositoryName || st.workflowRunId);
    if (!nodeId) continue;
    if (hasJob) {
      ensure(nodeId).jobs.push(
        makeJob({
          name: st.jobDisplayName || runnerName || name,
          repository: st.jobRepositoryName,
          workflow_ref: st.jobWorkflowRef,
          run_id: st.workflowRunId,
          job_id: st.jobId,
          runner_name: runnerName || name,
          scale_set: scale,
          node_id: nodeId,
          status: phaseStatus(phase || 'Running'),
          conclusion: phaseConclusion(phase),
          started_at: startedAt,
        })
      );
    } else {
      ensure(nodeId).starting.push({
        name: name || runnerName,
        runner_name: runnerName || name,
        scale_set: scale,
        phase: phase || pod?.status?.phase || 'Pending',
        started_at: startedAt,
      });
    }
  }

  for (const pod of input.pods) {
    const name = meta(pod).name;
    if (!name || assigned.has(name) || !isRunnerPod(pod) || !pod.spec?.nodeName) continue;
    ensure(pod.spec.nodeName).starting.push({
      name,
      runner_name: name,
      scale_set: scaleSetOf(pod),
      phase: pod.status?.phase || 'Pending',
      started_at: pod.status?.startTime || meta(pod).creationTimestamp,
    });
  }

  for (const w of input.externalWorkers) {
    const id = meta(w).name;
    if (!id) continue;
    const node = emptyNode(
      id,
      'external',
      !!w.status?.ready,
      w.spec?.operatingSystem || 'unknown',
      aliases
    );
    node.display_name = aliases[id] || w.spec?.displayName || id;
    node.best_effort = w.spec?.availability === 'best-effort' || !!w.spec?.personalMachine;
    node.description = w.spec?.description;
    nodes[id] = node;
  }

  const scaleSets: ScaleSetSummary[] = input.scaleSets
    .map(s => ({
      name:
        s.spec?.runnerScaleSetName ||
        annotations(s)['actions.github.com/runner-scale-set-name'] ||
        meta(s).name ||
        '',
      min_runners: s.spec?.minRunners,
      max_runners: s.spec?.maxRunners,
      current_runners: s.status?.currentRunners,
      pending: s.status?.pendingEphemeralRunners,
      running: s.status?.runningEphemeralRunners,
      phase: s.status?.phase,
      organisation: labels(s)['actions.github.com/organization'],
    }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const ordered = sortNodes(Object.values(nodes));
  return {
    generated_at: iso(input.now || new Date()),
    nodes: ordered,
    scale_sets: scaleSets,
    summary: summarise(ordered, scaleSets),
  };
}

const OVERLAY: (keyof Job)[] = [
  'url',
  'numeric_job_id',
  'status',
  'conclusion',
  'started_at',
  'completed_at',
];

/**
 * Overlay scanner enrichment (job URLs, GitHub-side status, external runners)
 * on the Kubernetes-derived status. Kubernetes stays the source of truth for
 * what exists; the endpoint only adds detail. With no ARC data at all the
 * endpoint's status is used as-is.
 */
export function mergeEnrichment(local: Status, remote: Status | null, arcPresent: boolean): Status {
  if (!remote) return local;
  if (!arcPresent && local.nodes.every(n => !n.jobs.length && !n.starting.length)) {
    return remote;
  }
  const remoteJobs = remote.nodes.flatMap(n => n.jobs);
  const byKey = new Map(remoteJobs.map(j => [j.key, j]));
  const byRunner = new Map(remoteJobs.map(j => [j.runner_name, j]));
  const nodes = local.nodes.map(n => {
    const remoteNode = remote.nodes.find(r => r.id === n.id);
    if (n.kind === 'external') {
      return remoteNode
        ? {
            ...n,
            ready: remoteNode.ready,
            state: remoteNode.state,
            state_reason: remoteNode.state_reason,
            jobs: remoteNode.jobs,
          }
        : n;
    }
    return {
      ...n,
      jobs: n.jobs.map(job => {
        const hit = byKey.get(job.key) || byRunner.get(job.runner_name);
        if (!hit) return job;
        const merged: Job = { ...job };
        for (const f of OVERLAY) {
          if (hit[f] !== undefined && hit[f] !== null) (merged as any)[f] = hit[f];
        }
        return merged;
      }),
    };
  });
  for (const rn of remote.nodes) {
    if (rn.kind === 'external' && !nodes.some(n => n.id === rn.id)) nodes.push(rn);
  }
  const ordered = sortNodes(nodes);
  return { ...local, nodes: ordered, summary: summarise(ordered, local.scale_sets) };
}

export interface Filters {
  nodes: string[];
  scaleSets: string[];
  terms: string[];
}

export function parseTerms(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function jobText(job: Job, node?: NodeStatus): string {
  return [
    job.name,
    job.repository,
    job.workflow,
    job.workflow_ref,
    job.runner_name,
    job.scale_set,
    node?.display_name,
    node?.id,
  ]
    .join(' ')
    .toLowerCase();
}

export function matchesJob(job: Job, node: NodeStatus | undefined, f: Filters): boolean {
  if (f.scaleSets.length && !f.scaleSets.includes(job.scale_set)) return false;
  const hay = jobText(job, node);
  return f.terms.every(t => hay.includes(t));
}

export function matchesStarting(s: Starting, node: NodeStatus, f: Filters): boolean {
  if (f.scaleSets.length && !f.scaleSets.includes(s.scale_set)) return false;
  const hay = [s.name, s.runner_name, s.scale_set, node.display_name].join(' ').toLowerCase();
  return f.terms.every(t => hay.includes(t));
}

export function ageSeconds(iso_: string | undefined | null, now = Date.now()): number | null {
  const t = iso_ ? Date.parse(iso_) : NaN;
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / 1000);
}

export function ago(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Derive the history URL from the status URL when none is configured. */
export function historyUrlFor(cfg: PluginConfig): string {
  if (cfg.historyUrl) return cfg.historyUrl;
  const s = cfg.statusUrl || '';
  return /status\.json(\?.*)?$/.test(s) ? s.replace(/status\.json/, 'history.json') : '';
}

export function isHistory(x: any): x is History {
  return !!x && Array.isArray(x.jobs);
}

export function isStatus(x: any): x is Status {
  return !!x && Array.isArray(x.nodes) && typeof x.generated_at === 'string';
}
