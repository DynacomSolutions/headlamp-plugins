import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/**
 * Scoped bearer tokens for the private API of the agent (the ACP endpoint now, the MCP endpoint next).
 * This module has no HTTP code, so the ACP and MCP endpoints share one token check.
 *
 * The tokens live in a Kubernetes Secret that is mounted as a JSON file (AGENT_API_TOKENS_FILE):
 *
 *   [{ "name": "ergon", "token": "<secret>", "scopes": ["agent:investigate"] }]
 *
 * An entry may carry "sha256" (64 hex characters, the SHA-256 of the token) instead of "token".
 * The file is read again when it changes, so a Secret update needs no restart.
 */

/** Scope names. The MCP contract adds its own names here. */
export const SCOPES = {
  /** Start an investigation and run a prompt on the incident agent. */
  investigate: 'agent:investigate',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export interface TokenEntry {
  /** A label for logs and metrics. It is never the token. */
  name: string;
  /** SHA-256 of the token. */
  digest: Buffer;
  scopes: ReadonlySet<string>;
}

export type AuthFailure = 'unconfigured' | 'missing' | 'invalid' | 'scope';

export type AuthResult =
  | { ok: true; name: string; scopes: string[] }
  | { ok: false; status: 401 | 403; reason: AuthFailure };

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Parses the Secret file. Entries that are not valid are dropped, so a bad entry never opens access. */
export function parseTokens(raw: unknown): TokenEntry[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { tokens?: unknown }).tokens) ? (raw as { tokens: unknown[] }).tokens : [];
  const out: TokenEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { name, token, sha256: hash, scopes } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !name || !Array.isArray(scopes)) continue;
    const scopeNames = scopes.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (!scopeNames.length) continue;
    let digest: Buffer | undefined;
    if (typeof token === 'string' && token.length >= 16) digest = sha256(token);
    else if (typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash)) digest = Buffer.from(hash, 'hex');
    if (!digest) continue;
    out.push({ name, digest, scopes: new Set(scopeNames) });
  }
  return out;
}

/** The token of an `Authorization: Bearer <token>` header, or undefined. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer[ ]+([^\s]+)$/i.exec(value?.trim() ?? '');
  return match?.[1];
}

/**
 * Checks a header against the tokens: 401 for a missing or unknown token, 403 for a known token without the scope.
 * With no token configured, every request fails with 401, so a missing Secret never opens the endpoint.
 */
export function checkBearer(entries: readonly TokenEntry[], header: string | string[] | undefined, scope: string): AuthResult {
  if (!entries.length) return { ok: false, status: 401, reason: 'unconfigured' };
  const token = bearerToken(header);
  if (!token) return { ok: false, status: 401, reason: 'missing' };
  const presented = sha256(token);
  let found: TokenEntry | undefined;
  // Every entry is compared, so the time does not show which entry matched.
  for (const entry of entries) if (timingSafeEqual(presented, entry.digest) && !found) found = entry;
  if (!found) return { ok: false, status: 401, reason: 'invalid' };
  if (!found.scopes.has(scope)) return { ok: false, status: 403, reason: 'scope' };
  return { ok: true, name: found.name, scopes: [...found.scopes] };
}

/** A reader for a token file that parses again only when the file changes. A missing or broken file gives no tokens. */
export function tokensFromFile(path: string): () => TokenEntry[] {
  let mtime = -1;
  let cached: TokenEntry[] = [];
  return () => {
    if (!path) return [];
    try {
      const stat = statSync(path);
      if (stat.mtimeMs !== mtime) {
        cached = parseTokens(JSON.parse(readFileSync(path, 'utf8')));
        mtime = stat.mtimeMs;
      }
    } catch {
      cached = [];
      mtime = -1;
    }
    return cached;
  };
}
