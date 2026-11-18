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

/** Friendly names of the apps above, by the same keys. Others use the humaniser. */
const NAMES: Record<string, string> = {
  node: 'Node.js',
  nodejs: 'Node.js',
  npm: 'npm',
  npx: 'npm',
  bun: 'Bun',
  deno: 'Deno',
  python: 'Python',
  go: 'Go',
  cargo: 'Rust',
  rustc: 'Rust',
  rust: 'Rust',
  java: 'Java',
  claude: 'Claude Code',
  anthropic: 'Anthropic',
  codex: 'Codex',
  kimi: 'Kimi',
  git: 'Git',
  gh: 'GitHub CLI',
  ssh: 'SSH',
  sshd: 'SSH server',
  bash: 'Bash',
  sh: 'Shell',
  zsh: 'Zsh',
  chromium: 'Chromium',
  chrome: 'Chrome',
  firefox: 'Firefox',
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  redis: 'Redis',
  'redis-server': 'Redis',
  nginx: 'nginx',
  caddy: 'Caddy',
  traefik: 'Traefik',
  grafana: 'Grafana',
  prometheus: 'Prometheus',
  'victoria-metrics': 'VictoriaMetrics',
  victoriametrics: 'VictoriaMetrics',
  vmagent: 'vmagent',
  vmalert: 'vmalert',
  headlamp: 'Headlamp',
  argocd: 'ArgoCD',
  argo: 'Argo',
  coredns: 'CoreDNS',
  containerd: 'containerd',
  kubelet: 'kubelet',
  kubectl: 'kubectl',
  sqlite: 'SQLite',
  sqlite3: 'SQLite',
  docker: 'Docker',
  dockerd: 'Docker',
  podman: 'Podman',
  buildah: 'Buildah',
  systemd: 'systemd',
  herdr: 'Herdr',
  t3code: 'T3 Code',
  t3: 'T3 Code',
  vite: 'Vite',
  esbuild: 'esbuild',
  tsc: 'TypeScript',
  tsx: 'TypeScript',
  playwright: 'Playwright',
  ffmpeg: 'FFmpeg',
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

/** The table key of a process: the program, or the program an interpreter runs. */
function processKey(command: string): string | undefined {
  const tokens = (command ?? '').trim().split(/\s+/).filter(Boolean);
  const program = baseName(tokens[0] ?? '');
  const own = lookup(program) ? program : undefined;
  if (!LAUNCHERS.has(program)) return own;
  // An interpreter or launcher: the program it runs says more (node .../codex.js, sh -c vite).
  for (const arg of tokens.slice(1, 6)) {
    if (arg.startsWith('-')) continue;
    const name = baseName(arg.replace(/^@[^/]+\//, ''));
    if (!LAUNCHERS.has(name) && lookup(name)) return name;
  }
  return own;
}

/** The icon of a process, from its command line (full paths and arguments are fine). */
export function iconForProcess(command: string): Icon {
  const key = processKey(command);
  return key ? APPS[key] : GENERIC.process;
}

/** The container key in the table: its name, then a part of it, then its namespace. */
function containerKey(container: string, namespace: string): string | undefined {
  const name = (container ?? '').toLowerCase();
  if (lookup(name)) return name;
  if (lookup(baseName(name))) return baseName(name);
  for (const part of name.split(/[-_.]/)) if (lookup(part)) return part;
  const ns = (namespace ?? '').toLowerCase();
  if (lookup(ns)) return ns;
  const bare = ns.replace(/^kube-/, '');
  return lookup(bare) ? bare : undefined;
}

/** The friendly name of a known app: for a container (name, namespace) or a process command. */
export function appName(container?: string, namespace?: string, command?: string): string | undefined {
  const key = command !== undefined ? processKey(command) : containerKey(container ?? '', namespace ?? '');
  return key ? NAMES[key] : undefined;
}

/** The icon of a container: its name first, then its namespace (argocd, monitoring, ...). */
export function iconForContainer(container: string, namespace = ''): Icon {
  const key = containerKey(container, namespace);
  return key ? APPS[key] : GENERIC.container;
}

/** The icon of a namespace: the app it is named after, else a grid. */
export function iconForNamespace(namespace: string): Icon {
  const ns = (namespace ?? '').toLowerCase();
  return lookup(ns) ?? lookup(ns.split('-')[0]) ?? GENERIC.namespace;
}
