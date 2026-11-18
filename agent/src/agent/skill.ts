import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The skills directory, found from the source tree (src/agent) or the bundle
 * (dist), or set with SKILLS_DIR.
 */
export function skillsDir(): string {
  if (process.env.SKILLS_DIR) return process.env.SKILLS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', 'skills'), join(here, '..', '..', 'skills')]) {
    if (existsSync(join(candidate, 'incident-diagnosis', 'SKILL.md'))) return candidate;
  }
  throw new Error('Cannot find the skills directory; set SKILLS_DIR');
}

export function readSkill(name = 'incident-diagnosis'): { raw: string; body: string; description: string } {
  const raw = readFileSync(join(skillsDir(), name, 'SKILL.md'), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const front = match?.[1] ?? '';
  const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? '';
  return { raw, body: match ? raw.slice(match[0].length).trim() : raw, description };
}
