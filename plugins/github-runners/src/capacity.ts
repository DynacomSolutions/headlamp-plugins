/*
 * Pure functions for the Capacity tab: pools, per-node usage, demand versus
 * capacity, external runners and the policy check. No React, no network.
 */
import { isRunnerPod, parseAliases, scaleSetOf } from './model';
import type { NodeStatus, PluginConfig, Raw, Status } from './types';

const HOSTNAME = 'kubernetes.io/hostname';
const SCALE_SET_LABEL = 'actions.github.com/scale-set-name';

const meta = (o: Raw): Raw => o?.metadata ?? {};
const labels = (o: Raw): Raw => meta(o).labels ?? {};
const annotations = (o: Raw): Raw => meta(o).annotations ?? {};

/* ---------------------------------------------------------------- Quantity */

const SUFFIX: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

/** Kubernetes quantity ("500m", "1.5", "2Gi", "1e3", 4) to a number (cores or bytes). 0 if unparseable. */
export function parseQuantity(q: unknown): number {
  if (typeof q === 'number') return Number.isFinite(q) ? q : 0;
  if (typeof q !== 'string') return 0;
  const m = q.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/);
  if (!m || !(m[2] in SUFFIX)) return 0;
  const v = Number(m[1]) * SUFFIX[m[2]];
  return Number.isFinite(v) ? v : 0;
}

export interface Resources {
  cpu: number;
  memory: number;
}

const zero = (): Resources => ({ cpu: 0, memory: 0 });

function addTo(into: Resources, r: Resources, sign = 1): void {
  into.cpu += sign * r.cpu;
  into.memory += sign * r.memory;
}

/** Sum of container requests (plus restartable-init sidecars) of a pod spec. */
export function specRequests(spec: Raw | undefined): Resources {
  const out = zero();
  for (const c of spec?.containers || []) {
    out.cpu += parseQuantity(c?.resources?.requests?.cpu);
    out.memory += parseQuantity(c?.resources?.requests?.memory);
  }
  for (const c of spec?.initContainers || []) {
    if (c?.restartPolicy !== 'Always') continue;
    out.cpu += parseQuantity(c?.resources?.requests?.cpu);
    out.memory += parseQuantity(c?.resources?.requests?.memory);
  }
  return out;
}

export function formatCpu(cores: number): string {
  const v = Math.round(cores * 10) / 10;
  return `${v} CPU`;
}

export function formatMemory(bytes: number): string {
  const gi = bytes / 1024 ** 3;
  if (Math.abs(gi) >= 1) return `${Math.round(gi * 10) / 10} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

/* ---------------------------------------------------------------- Settings */

export function parseList(text?: unknown): string[] {
  return String(text ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** "a=b,c=d" to a map. */
export function parsePairs(text?: unknown): Record<string, string> {
  return parseAliases(String(text ?? ''));
}

/** "owner/repo=32,..." to a map of numbers (invalid entries are dropped). */
export function parseCaps(text?: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsePairs(text))) {
    const n = Number(v);
    if (k && Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

export interface Policy {
  configured: boolean;
  preferredNodes: string[];
  spillNodes: string[];
  repoCap: number;
  repoCaps: Record<string, number>;
}

export function parsePolicy(cfg: PluginConfig): Policy {
  const preferredNodes = parseList(cfg.policyPreferredNodes);
  const spillNodes = parseList(cfg.policySpillNodes);
  const repoCaps = parseCaps(cfg.policyRepoCaps);
  const rawCap = cfg.policyRepoCap;
  const hasCap = rawCap !== undefined && rawCap !== null && String(rawCap).trim() !== '';
  const cap = Number(rawCap);
  return {
    configured: preferredNodes.length > 0 || spillNodes.length > 0 || hasCap || Object.keys(repoCaps).length > 0,
    preferredNodes,
    spillNodes,
    repoCap: hasCap && Number.isFinite(cap) && cap >= 0 ? cap : 3,
    repoCaps,
  };
}

/* --------------------------------------------------------------- Placement */

export interface Placement {
  /** Preferred node ids, highest weight first. */
  preferred: { node: string; weight: number }[];
  /** True when required affinity or nodeSelector limits which hostnames are allowed. */
  restricted: boolean;
  canRunOn: (node: string) => boolean;
}

function hostnameExprs(term: Raw): Raw[] {
  return (term?.matchExpressions || []).filter((e: Raw) => e?.key === HOSTNAME);
}

/** Derive preferred and allowed hostnames from a pod template spec. */
export function placementOf(spec: Raw | undefined): Placement {
  const aff = spec?.affinity?.nodeAffinity;
  const preferred: { node: string; weight: number }[] = [];
  for (const p of aff?.preferredDuringSchedulingIgnoredDuringExecution || []) {
    for (const e of hostnameExprs(p?.preference)) {
      if (e.operator !== 'In') continue;
      for (const node of e.values || []) preferred.push({ node, weight: Number(p.weight) || 0 });
    }
  }
  preferred.sort((a, b) => b.weight - a.weight);

  const terms: Raw[] = aff?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms || [];
  const termConstrains = terms.map(t => hostnameExprs(t).length > 0);
  // A term with no hostname expression allows every hostname, so only constrain when all terms do.
  const requiredRestricts = terms.length > 0 && termConstrains.every(Boolean);
  const pinned: string | undefined = spec?.nodeSelector?.[HOSTNAME];
  const canRunOn = (node: string): boolean => {
    if (pinned && pinned !== node) return false;
    if (terms.length === 0) return true;
    return terms.some(t =>
      hostnameExprs(t).every(e => {
        const values: string[] = e.values || [];
        if (e.operator === 'In') return values.includes(node);
        if (e.operator === 'NotIn') return !values.includes(node);
        return true;
      })
    );
  };
  const notInUsed = terms.some(t => hostnameExprs(t).some(e => e.operator === 'NotIn'));
  return { preferred, restricted: !!pinned || requiredRestricts || notInUsed, canRunOn };
}

/* ----------------------------------------------------------- Pending reason */

const WAITING_REASONS: Record<string, string> = {
  ImagePullBackOff: 'image pull',
  ErrImagePull: 'image pull',
  InvalidImageName: 'image pull',
  CrashLoopBackOff: 'crash loop',
  CreateContainerConfigError: 'container config error',
  CreateContainerError: 'container create error',
  ContainerCreating: 'starting containers',
  PodInitializing: 'starting containers',
};

/** Short human reason a Pending pod is waiting, or '' when nothing is known. */
export function pendingReason(pod: Raw): string {
  const out: string[] = [];
  const add = (r: string) => {
    if (r && !out.includes(r)) out.push(r);
  };
  const sched = (pod?.status?.conditions || []).find(
    (c: Raw) => c?.type === 'PodScheduled' && c?.status === 'False'
  );
  if (sched) {
    const msg = String(sched.message || '');
    if (/Insufficient cpu/i.test(msg)) add('not enough CPU');
    if (/Insufficient memory/i.test(msg)) add('not enough memory');
    if (/Insufficient ephemeral-storage/i.test(msg)) add('not enough disk');
    if (/Too many pods/i.test(msg)) add('node pod limit reached');
    if (/node affinity|node selector/i.test(msg)) add('no node matches affinity');
    if (/untolerated taint/i.test(msg)) add('node taints not tolerated');
    if (/PersistentVolumeClaim|volume node affinity/i.test(msg)) add('volume not available');
    if (!out.length) add(sched.reason === 'Unschedulable' || msg ? 'unschedulable' : '');
  }
  const statuses = [
    ...(pod?.status?.initContainerStatuses || []),
    ...(pod?.status?.containerStatuses || []),
  ];
  for (const s of statuses) {
    const r = s?.state?.waiting?.reason;
    if (r) add(WAITING_REASONS[r] || String(r));
  }
  return out.join(', ');
}

/* ------------------------------------------------------------------- Types */

export interface PoolRow {
  name: string;
  namespace: string;
  /** Display text for the repo or organisation served. */
  serves: string;
  /** owner/repo when known, used for the per-repo cap. */
  repo: string | null;
  cap: number;
  running: number;
  pending: number;
  pendingReason: string;
  preferred: string[];
  spill: string[];
  /** True when any node not listed is allowed too. */
  spillAny: boolean;
  perRunner: Resources;
  placement: Placement;
  starved: boolean;
  violations: string[];
}

export interface NodePoolCount {
  pool: string;
  count: number;
}

export interface NodeUsage {
  id: string;
  name: string;
  ready: boolean;
  allocatable: Resources;
  runner: Resources;
  other: Resources;
  free: Resources;
  pools: NodePoolCount[];
}

export interface Demand {
  demand: Resources;
  capacity: Resources;
  short: { cpu: boolean; memory: boolean };
}

export interface ExternalRow {
  id: string;
  name: string;
  os: string;
  online: boolean;
  busy: boolean;
  state: string;
  reason: string;
}

export interface Capacity {
  pools: PoolRow[];
  nodes: NodeUsage[];
  demand: Demand;
  external: ExternalRow[];
  policy: Policy;
  violationCount: number;
  repoTotals: Record<string, { total: number; cap: number }>;
}

export interface CapacityInput {
  nodes: Raw[];
  pods: Raw[];
  runners: Raw[];
  scaleSets: Raw[];
  externalWorkers: Raw[];
  status: Status | null;
  cfg: PluginConfig;
}

/* ------------------------------------------------------------------- Build */

function poolName(s: Raw): string {
  return (
    s.spec?.runnerScaleSetName ||
    annotations(s)['actions.github.com/runner-scale-set-name'] ||
    meta(s).name ||
    ''
  );
}

/** What a pool serves: a repo (owner/repo) or an organisation (with runner group). */
export function poolServes(s: Raw, name: string, poolRepos: Record<string, string>): { text: string; repo: string | null } {
  const l = labels(s);
  const org: string = l['actions.github.com/organization'] || '';
  const repoLabel: string = l['actions.github.com/repository'] || '';
  if (repoLabel) {
    const repo = repoLabel.includes('/') || !org ? repoLabel : `${org}/${repoLabel}`;
    return { text: repo, repo };
  }
  if (poolRepos[name]) return { text: poolRepos[name], repo: poolRepos[name] };
  const url = String(s.spec?.githubConfigUrl || '');
  const path = url.replace(/^https?:\/\/[^/]+\/?/, '').split('/').filter(Boolean);
  if (path.length >= 2) {
    const repo = `${path[0]}/${path[1]}`;
    return { text: repo, repo };
  }
  const owner = org || path[0] || '';
  const group = annotations(s)['actions.github.com/runner-group-name'] || s.spec?.runnerGroup || '';
  const text = [owner, group ? `group ${group}` : ''].filter(Boolean).join(', ');
  return { text: text || '-', repo: null };
}

/** Runner pod of a pool: ARC listener pods carry the scale-set label too but are not runners. */
const poolOfRunnerPod = (p: Raw): string => (isRunnerPod(p) ? labels(p)[SCALE_SET_LABEL] || '' : '');

const isTerminated = (p: Raw) => p?.status?.phase === 'Succeeded' || p?.status?.phase === 'Failed';

export function buildCapacity(input: CapacityInput): Capacity {
  const { cfg } = input;
  const aliases = parseAliases(cfg.nodeAliases);
  const disp = (id: string) => aliases[id] || id;
  const policy = parsePolicy(cfg);
  const poolRepos = parsePairs(cfg.poolRepos);
  const k8sNodes = input.nodes.filter(n => meta(n).name);
  const nodeIds = k8sNodes.map(n => meta(n).name as string);

  const podsByPool = new Map<string, Raw[]>();
  for (const p of input.pods) {
    const pool = poolOfRunnerPod(p);
    if (!pool || isTerminated(p)) continue;
    podsByPool.set(pool, [...(podsByPool.get(pool) || []), p]);
  }
  const runnersByPool = new Map<string, Raw[]>();
  for (const r of input.runners) {
    const pool = scaleSetOf(r);
    if (pool) runnersByPool.set(pool, [...(runnersByPool.get(pool) || []), r]);
  }

  const pools: PoolRow[] = input.scaleSets
    .map(s => {
      const name = poolName(s);
      const spec = s.spec?.template?.spec;
      const placement = placementOf(spec);
      const runners = runnersByPool.get(name) || [];
      const pods = podsByPool.get(name) || [];
      const phase = (r: Raw) => r.status?.phase || 'Pending';
      const runningRunners = runners.filter(r => phase(r) === 'Running').length;
      const pendingRunners = runners.filter(r => phase(r) === 'Pending').length;
      const pendingPods = pods.filter(p => p.status?.phase === 'Pending');
      const running = Math.max(Number(s.status?.runningEphemeralRunners) || 0, runningRunners);
      const pending = Math.max(
        Number(s.status?.pendingEphemeralRunners) || 0,
        pendingRunners,
        pendingPods.length
      );
      const reasons: string[] = [];
      for (const p of pendingPods) {
        for (const r of pendingReason(p).split(', ').filter(Boolean)) {
          if (!reasons.includes(r)) reasons.push(r);
        }
      }
      const preferredIds = placement.preferred.map(p => p.node).filter((n, i, a) => a.indexOf(n) === i);
      const spillIds = nodeIds.filter(n => placement.canRunOn(n) && !preferredIds.includes(n));
      const serves = poolServes(s, name, poolRepos);
      return {
        name,
        namespace: meta(s).namespace || '',
        serves: serves.text,
        repo: serves.repo,
        cap: Number(s.spec?.maxRunners) || 0,
        running,
        pending,
        pendingReason: reasons.join(', '),
        preferred: preferredIds.map(disp),
        spill: spillIds.map(disp),
        spillAny: !placement.restricted,
        perRunner: specRequests(spec),
        placement,
        starved: pending > 0 && running === 0,
        violations: [] as string[],
      };
    })
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  /* Policy */
  const repoTotals: Capacity['repoTotals'] = {};
  for (const p of pools) {
    if (!p.repo) continue;
    const cap = policy.repoCaps[p.repo] ?? policy.repoCap;
    repoTotals[p.repo] = { total: (repoTotals[p.repo]?.total || 0) + p.cap, cap };
  }
  if (policy.configured) {
    for (const p of pools) {
      const prefIds = p.placement.preferred;
      const missingPref = policy.preferredNodes.filter(n => !prefIds.some(x => x.node === n));
      if (missingPref.length) p.violations.push(`does not prefer ${missingPref.map(disp).join(', ')}`);
      const blocked = policy.spillNodes.filter(n => !p.placement.canRunOn(n));
      if (blocked.length) p.violations.push(`not allowed on spill node ${blocked.map(disp).join(', ')}`);
      const refWeights = prefIds.filter(x => policy.preferredNodes.includes(x.node)).map(x => x.weight);
      const ref = policy.preferredNodes.length ? (refWeights.length ? Math.min(...refWeights) : 0) : Infinity;
      const spillPref = prefIds.filter(x => policy.spillNodes.includes(x.node) && x.weight >= ref);
      if (spillPref.length) {
        p.violations.push(`prefers spill node ${spillPref.map(x => disp(x.node)).join(', ')} at equal or higher weight`);
      }
      const rt = p.repo ? repoTotals[p.repo] : undefined;
      if (p.repo && rt && rt.total > rt.cap) {
        p.violations.push(`repo ${p.repo} totals ${rt.total} runners, over its cap of ${rt.cap}`);
      }
    }
  }

  /* Per-node usage */
  const usage = new Map<string, NodeUsage>();
  for (const n of k8sNodes) {
    const id = meta(n).name as string;
    const alloc = n.status?.allocatable || {};
    const allocatable = { cpu: parseQuantity(alloc.cpu), memory: parseQuantity(alloc.memory) };
    usage.set(id, {
      id,
      name: disp(id),
      ready: (n.status?.conditions || []).some((c: Raw) => c?.type === 'Ready' && c?.status === 'True'),
      allocatable,
      runner: zero(),
      other: zero(),
      free: { ...allocatable },
      pools: [],
    });
  }
  for (const p of input.pods) {
    const nodeName = p.spec?.nodeName;
    const u = nodeName ? usage.get(nodeName) : undefined;
    if (!u || isTerminated(p)) continue;
    const req = specRequests(p.spec);
    const pool = poolOfRunnerPod(p);
    if (pool) {
      addTo(u.runner, req);
      const hit = u.pools.find(x => x.pool === pool);
      if (hit) hit.count += 1;
      else u.pools.push({ pool, count: 1 });
    } else {
      addTo(u.other, req);
    }
  }
  const nodes = [...usage.values()]
    .map(u => ({
      ...u,
      free: { cpu: u.allocatable.cpu - u.runner.cpu - u.other.cpu, memory: u.allocatable.memory - u.runner.memory - u.other.memory },
      pools: u.pools.sort((a, b) => a.pool.localeCompare(b.pool)),
    }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  /* Demand versus capacity */
  const demand = zero();
  for (const p of pools) {
    demand.cpu += p.cap * p.perRunner.cpu;
    demand.memory += p.cap * p.perRunner.memory;
  }
  const capacity = zero();
  for (const u of usage.values()) {
    const node = k8sNodes.find(n => meta(n).name === u.id);
    if (node?.spec?.unschedulable) continue;
    if (!pools.some(p => p.placement.canRunOn(u.id))) continue;
    capacity.cpu += Math.max(0, u.allocatable.cpu - u.other.cpu);
    capacity.memory += Math.max(0, u.allocatable.memory - u.other.memory);
  }

  return {
    pools,
    nodes,
    demand: {
      demand,
      capacity,
      short: { cpu: demand.cpu > capacity.cpu, memory: demand.memory > capacity.memory },
    },
    external: externalRows(input.status?.nodes || [], input.externalWorkers),
    policy,
    violationCount: pools.filter(p => p.violations.length > 0).length,
    repoTotals,
  };
}

/** External runners from the (merged) status plus ExternalWorker CRs. */
export function externalRows(nodes: NodeStatus[], workers: Raw[]): ExternalRow[] {
  const busyByName = new Map<string, boolean>();
  for (const w of workers) if (meta(w).name) busyByName.set(meta(w).name, !!w.status?.busy);
  return nodes
    .filter(n => n.kind === 'external')
    .map(n => {
      const state = n.state || '';
      const online = state ? state === 'online' || state === 'busy' || state === 'starting' : n.ready;
      const busy = n.jobs.length > 0 || state === 'busy' || !!busyByName.get(n.id);
      return {
        id: n.id,
        name: n.display_name,
        os: n.os,
        online,
        busy,
        state,
        reason: n.state_reason || '',
      };
    });
}
