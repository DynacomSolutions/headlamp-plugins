/*
 * Friendly names for arcs. The raw id stays (it is what the details card shows under the name);
 * the name is what the chart, centre, breadcrumb and list show. Order, data first and guessing
 * last: a user override, then what the cluster says (a namespace's display-name annotation or
 * its app.kubernetes.io labels), then the app table (processes, containers), then a plain
 * humaniser. Nothing is invented beyond that.
 */
import { appName, baseName } from './appIcons';
import type { SunNode } from './tree';

export interface NameContext {
  /** id (or arc key) to name, from the plugin setting `displayNames`. Wins over everything. */
  overrides: Record<string, string>;
  /** Namespace to the name its labels or annotations give. */
  namespaces: ReadonlyMap<string, string>;
}

export const NO_NAMES: NameContext = { overrides: {}, namespaces: new Map() };

/** Ids whose whole name is known. Others go through the suffix and casing rules. */
const KNOWN_IDS: Record<string, string> = {
  default: 'Default',
  'kube-system': 'Kube system',
  'kube-public': 'Kube public',
  'kube-node-lease': 'Kube node lease',
  'cert-manager': 'cert-manager',
  'victoria-metrics': 'VictoriaMetrics',
  victoriametrics: 'VictoriaMetrics',
  argocd: 'ArgoCD',
  cloudnativepg: 'CloudNativePG',
  'cloudnative-pg': 'CloudNativePG',
  cnpg: 'CloudNativePG',
};

/** Casing of single words. */
const KNOWN_WORDS: Record<string, string> = {
  victoriametrics: 'VictoriaMetrics',
  argocd: 'ArgoCD',
  cloudnativepg: 'CloudNativePG',
  cnpg: 'CloudNativePG',
  headlamp: 'Headlamp',
  grafana: 'Grafana',
  prometheus: 'Prometheus',
  kubevirt: 'KubeVirt',
  k8s: 'Kubernetes',
  db: 'DB',
  api: 'API',
  ci: 'CI',
};

const SUFFIXES = ['runners', 'system', 'operator', 'controller', 'server'];

/** Title-cases an id: drops a common suffix, splits on - and _, applies known casing. */
export function humanise(id: string): string {
  const raw = (id ?? '').trim();
  if (!raw) return raw;
  const whole = KNOWN_IDS[raw.toLowerCase()];
  if (whole) return whole;
  // Only plain lower-case ids are touched: anything else already looks deliberate.
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(raw)) return raw;
  let words = raw.split(/[-_]+/).filter(Boolean);
  const last = words[words.length - 1];
  if (words.length > 1 && SUFFIXES.includes(last)) words = words.slice(0, -1);
  return words
    .map(w => KNOWN_WORDS[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Kubernetes' random name alphabet has no vowels and no 0, 1 or 3.
const RANDOM = '[bcdfghjklmnpqrstvwxz2456789]';

/** A pod's workload name: the ReplicaSet hash and the random pod suffix removed. */
export function stripPodHash(pod: string): string {
  return pod
    .replace(new RegExp(`-${RANDOM}{8,10}-${RANDOM}{5}$`), '')
    .replace(new RegExp(`-${RANDOM}{5}$`), '');
}

/** The name a namespace's own labels or annotations give, or undefined. */
export function namespaceDataName(meta: {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}): string | undefined {
  const a = meta.annotations ?? {};
  const l = meta.labels ?? {};
  const shown = a['app.kubernetes.io/display-name'] ?? a['openshift.io/display-name'];
  if (shown) return shown;
  const id = l['app.kubernetes.io/part-of'] ?? l['app.kubernetes.io/name'] ?? l['app.kubernetes.io/instance'];
  return id ? humanise(id) : undefined;
}

export function namespaceName(ns: string, ctx: NameContext): string {
  return ctx.overrides[ns] ?? ctx.namespaces.get(ns) ?? humanise(ns);
}

export function podName(pod: string, ctx: NameContext): string {
  return ctx.overrides[pod] ?? humanise(stripPodHash(pod));
}

export function containerName(container: string, namespace: string, ctx: NameContext): string {
  return ctx.overrides[container] ?? appName(container, namespace) ?? humanise(container);
}

export function processName(command: string, ctx: NameContext): string | undefined {
  const program = baseName(command.trim().split(/\s+/)[0] ?? '');
  return ctx.overrides[command] ?? ctx.overrides[program] ?? appName(undefined, undefined, command);
}

/** What to show for a node: its friendly name, else its label. */
export function nameOf(n: { label: string; displayName?: string }): string {
  return n.displayName ?? n.label;
}

/** The raw id of an arc, shown under its name in the details card. */
export function idOf(n: { label: string; command?: string }): string {
  return n.command ?? n.label;
}

/**
 * Makes the names of sibling arcs unique. Siblings that share a name (two namespaces with the
 * same display-name annotation, say) each show `name (id)`, with their own real id. A name that
 * is already unique stays as it is. Ids that are equal too cannot be told apart, so they stay.
 * Returns one name per entry, in the same order.
 */
export function uniqueNames(entries: { name: string; id: string }[]): string[] {
  const count = new Map<string, number>();
  for (const e of entries) count.set(e.name, (count.get(e.name) ?? 0) + 1);
  return entries.map(e =>
    (count.get(e.name) ?? 0) > 1 && e.id !== e.name ? `${e.name} (${e.id})` : e.name
  );
}

/** Kinds whose repeated names are normal (a process may run many times): left alone. */
const REPEATABLE: ReadonlySet<SunNode['kind']> = new Set(['process', 'unused']);

function disambiguate(n: SunNode): void {
  const kids = n.children.filter(c => !REPEATABLE.has(c.kind));
  const names = uniqueNames(kids.map(c => ({ name: nameOf(c), id: idOf(c) })));
  kids.forEach((c, i) => {
    if (names[i] !== nameOf(c)) c.displayName = names[i];
  });
  n.children.forEach(disambiguate);
}

/**
 * Sets `displayName` on every arc of a tree by its kind. `label` stays the raw id. The overrides
 * match an arc's raw id, its key, or (for a process) its program, and win over everything.
 */
export function applyNames(root: SunNode, ctx: NameContext): void {
  const walk = (n: SunNode, ns: string) => {
    let name: string | undefined;
    let here = ns;
    if (n.kind === 'namespace') {
      here = n.label;
      name = namespaceName(n.label, ctx);
    } else if (n.kind === 'pod') name = podName(n.label, ctx);
    else if (n.kind === 'container') name = containerName(n.label, ns, ctx);
    else if (n.kind === 'process' && n.command !== undefined) name = processName(n.command, ctx);
    const forced = ctx.overrides[n.key] ?? ctx.overrides[n.label];
    name = forced ?? name;
    if (name && name !== n.label) n.displayName = name;
    n.children.forEach(c => walk(c, here));
  };
  walk(root, '');
  disambiguate(root);
}
