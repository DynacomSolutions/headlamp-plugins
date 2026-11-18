/*
 * Icons for the apps behind the arcs, from a local table (no network): a process by the program
 * in its command line, a container by its name and then its namespace. Brand icons are Simple
 * Icons, the rest Material Design Icons; both are bundled (see registerIcons.ts). Anything
 * unknown gets a generic icon for its kind.
 */
import type { SunNode } from './tree';

type Icon = NonNullable<SunNode['icon']>;

const brand = (name: string): Icon => ({ kind: 'simple-icons', name });
const mdi = (name: string): Icon => ({ kind: 'mdi', name });

/** Generic icons by kind, for names the table does not know. */
export const GENERIC = {
  process: mdi('cog-outline'),
  container: mdi('cube-outline'),
  pod: mdi('cube-outline'),
  namespace: mdi('view-grid-outline'),
  project: mdi('folder'),
  node: mdi('server'),
  thread: mdi('chat-processing-outline'),
} as const;

/** Program or container name (lower case) to icon. Add an alias here to cover a new app. */
const APPS: Record<string, Icon> = {
  node: brand('nodedotjs'),
  nodejs: brand('nodedotjs'),
  npm: brand('npm'),
  npx: brand('npm'),
  bun: brand('bun'),
  deno: brand('deno'),
  python: brand('python'),
  go: brand('go'),
  cargo: brand('rust'),
  rustc: brand('rust'),
  rust: brand('rust'),
  java: brand('openjdk'),
  claude: brand('claude'),
  anthropic: brand('anthropic'),
  codex: brand('openai'),
  kimi: brand('kimi'),
  git: brand('git'),
  gh: brand('github'),
  ssh: mdi('ssh'),
  sshd: mdi('ssh'),
  bash: brand('gnubash'),
  sh: brand('gnubash'),
  zsh: brand('zsh'),
  chromium: brand('googlechrome'),
  chrome: brand('googlechrome'),
  firefox: brand('firefox'),
  postgres: brand('postgresql'),
  postgresql: brand('postgresql'),
  redis: brand('redis'),
  'redis-server': brand('redis'),
  nginx: brand('nginx'),
  caddy: brand('caddy'),
  traefik: brand('traefikproxy'),
  grafana: brand('grafana'),
  prometheus: brand('prometheus'),
  'victoria-metrics': brand('victoriametrics'),
  victoriametrics: brand('victoriametrics'),
  vmagent: brand('victoriametrics'),
  vmalert: brand('victoriametrics'),
  headlamp: mdi('desk-lamp'),
  argocd: brand('argo'),
  argo: brand('argo'),
  coredns: mdi('dns'),
  containerd: brand('containerd'),
  kubelet: brand('kubernetes'),
  kubectl: brand('kubernetes'),
  sqlite: brand('sqlite'),
  sqlite3: brand('sqlite'),
  docker: brand('docker'),
  dockerd: brand('docker'),
  podman: brand('podman'),
  buildah: mdi('hammer-wrench'),
  systemd: mdi('linux'),
  herdr: mdi('sheep'),
  t3code: mdi('code-braces'),
  t3: mdi('code-braces'),
  vite: brand('vite'),
  esbuild: brand('esbuild'),
  tsc: brand('typescript'),
  tsx: brand('typescript'),
  playwright: brand('playwright'),
  ffmpeg: brand('ffmpeg'),
};

/** Every icon the table can return, for checks that all of them are bundled. */
export const ALL_APP_ICONS: Icon[] = [...Object.values(APPS), ...Object.values(GENERIC)];

/** Programs that start another program: look at what they run. */
const LAUNCHERS = new Set([
  'node',
  'bun',
  'deno',
  'python',
  'sh',
  'bash',
  'zsh',
  'npx',
  'npm',
  'env',
  'sudo',
  'uv',
  'uvx',
  'exec',
]);

/** The last path segment, without a script extension and without a trailing version. */
export function baseName(token: string): string {
  const last = token
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\/+$/, '').split('/').pop() ?? '';
  return last
    .toLowerCase()
    .replace(/\.(m?js|cjs|ts|py|sh)$/, '')
    .replace(/(?<=[a-z]{3})[-_]?\d+(\.\d+)*$/, '');
}

function lookup(name: string): Icon | undefined {
  return Object.prototype.hasOwnProperty.call(APPS, name) ? APPS[name] : undefined;
}

/** The icon of a process, from its command line (full paths and arguments are fine). */
export function iconForProcess(command: string): Icon {
  const tokens = (command ?? '').trim().split(/\s+/).filter(Boolean);
  const program = baseName(tokens[0] ?? '');
  const own = lookup(program);
  if (!LAUNCHERS.has(program)) return own ?? GENERIC.process;
  // An interpreter or launcher: the program it runs says more (node .../codex.js, sh -c vite).
  for (const arg of tokens.slice(1, 6)) {
    if (arg.startsWith('-')) continue;
    const name = baseName(arg.replace(/^@[^/]+\//, ''));
    const hit = LAUNCHERS.has(name) ? undefined : lookup(name);
    if (hit) return hit;
  }
  return own ?? GENERIC.process;
}

/** The icon of a container: its name first, then its namespace (argocd, monitoring, ...). */
export function iconForContainer(container: string, namespace = ''): Icon {
  const name = (container ?? '').toLowerCase();
  const direct = lookup(name) ?? lookup(baseName(name));
  if (direct) return direct;
  // A container is often named <app>-<role> (grafana-sc-dashboard, argocd-server).
  for (const part of name.split(/[-_.]/)) {
    const hit = lookup(part);
    if (hit) return hit;
  }
  const ns = (namespace ?? '').toLowerCase();
  return lookup(ns) ?? lookup(ns.replace(/^kube-/, '')) ?? GENERIC.container;
}

/** The icon of a namespace: the app it is named after, else a grid. */
export function iconForNamespace(namespace: string): Icon {
  const ns = (namespace ?? '').toLowerCase();
  return lookup(ns) ?? lookup(ns.split('-')[0]) ?? GENERIC.namespace;
}
