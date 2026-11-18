/* Short, readable labels for process arcs and systemd units. */

const LAUNCHERS = new Set([
  'node',
  'bun',
  'deno',
  'python',
  'python3',
  'bash',
  'sh',
  'zsh',
  'npx',
  'npm',
  'env',
  'sudo',
  'uv',
  'uvx',
]);
const UNIT_PREFIXES = ['app-t3code-agents-', 'app-t3code-', 'herdr-'];

const baseName = (s: string) => s.replace(/\/+$/, '').split('/').pop() ?? '';
// Strip a trailing @version (keeps a leading scope @).
const stripVersion = (s: string) => s.replace(/(?<=.)@[^@/]*$/, '');

/** The program name of a command line, looking through interpreters and launchers. */
export function processLabel(command: string): string {
  const tokens = (command ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '(unknown)';
  const program = baseName(tokens[0]);
  if (!program) return '(unknown)';
  if (!LAUNCHERS.has(program)) return program;
  const arg = tokens.slice(1).find(t => !t.startsWith('-'));
  if (!arg) return program;
  // The scope of a package (@scope/pkg) is part of its name: keep it, drop the version.
  const target = arg.startsWith('@') ? stripVersion(arg) : baseName(stripVersion(arg));
  return target ? `${program} ${target}` : program;
}

/** A systemd unit name without its type suffix and orchestrator prefix. */
export function unitLabel(name: string, orchestratorScopePrefix?: string): string {
  let s = name.replace(/\.(slice|scope|service)$/, '');
  const prefixes = orchestratorScopePrefix
    ? [orchestratorScopePrefix, ...UNIT_PREFIXES]
    : UNIT_PREFIXES;
  const hit = prefixes.find(p => s.startsWith(p) && s.length > p.length);
  if (hit) s = s.slice(hit.length);
  return s || name;
}
