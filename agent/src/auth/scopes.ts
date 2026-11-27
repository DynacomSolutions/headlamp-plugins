import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/**
 * Scoped bearer tokens for the private API of the agent (the ACP endpoint now, the MCP endpoint next).
 * This module has no HTTP code, so the ACP and MCP endpoints share one token check.
 *
 * The tokens live in a Kubernetes Secret that is mounted as a JSON file (AGENT_API_TOKENS_FILE):
 *
 *   [{ "name": "example-client", "token": "<secret>", "scopes": ["agent:investigate"] }]
 *
 * An entry may carry "sha256" (64 hex characters, the SHA-256 of the token) instead of "token".
 * The file is read again when it changes, so a Secret update needs no restart.
 */

/** Scope names. The MCP contract adds its own names here. */
export const SCOPES = {
  /** Start an investigation and run a prompt on the incident agent. */
  investigate: 'agent:investigate',
  /** The MCP contract (docs/mcp-contract.md section 4.2). */
  registryRead: 'registry:read',
  incidentsRead: 'incidents:read',
  incidentsWrite: 'incidents:write',
  incidentsResolve: 'incidents:resolve',
  storageRead: 'storage:read',
  settingsRead: 'settings:read',
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

/**
 * Parses the Secret file. Entries that are not valid are dropped, so a bad entry never opens access.
 * `warn` gets one message for each dropped entry. A message names the entry and the cause. It never holds a token value.
 */
export function parseTokens(raw: unknown, warn: (message: string) => void = () => undefined): TokenEntry[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { tokens?: unknown }).tokens) ? (raw as { tokens: unknown[] }).tokens : [];
  const out: TokenEntry[] = [];
  if (!list.length && raw !== undefined) warn('the token file holds no entries (expected a JSON array, or an object with a "tokens" array)');
  list.forEach((item, index) => {
    const label = item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string' && (item as { name: string }).name ? `"${(item as { name: string }).name}"` : `#${index + 1}`;
    const drop = (why: string) => warn(`token entry ${label} ignored: ${why}`);
    if (!item || typeof item !== 'object') return drop('it is not an object');
    const { name, token, sha256: hash, scopes } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !name) return drop('it has no name');
    // `anonymous` is the name of callers without a token: no token entry may use it (contract section 4.3).
    if (name.toLowerCase() === 'anonymous') return drop('its name is reserved');
    if (!Array.isArray(scopes)) return drop('it has no scopes list');
    const scopeNames = scopes.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (!scopeNames.length) return drop('it has no scope');
    let digest: Buffer | undefined;
    if (typeof token === 'string' && token.length >= 16) digest = sha256(token);
    else if (typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash)) digest = Buffer.from(hash, 'hex');
    if (!digest) return drop('it has no token of at least 16 characters and no valid sha256');
    out.push({ name, digest, scopes: new Set(scopeNames) });
  });
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

/** The entry that a header names, or undefined. For callers that need the scopes of the token, not one scope check. */
export function lookupBearer(entries: readonly TokenEntry[], header: string | string[] | undefined): TokenEntry | undefined {
  const token = bearerToken(header);
  if (!token || !entries.length) return undefined;
  const presented = sha256(token);
  let found: TokenEntry | undefined;
  for (const entry of entries) if (timingSafeEqual(presented, entry.digest) && !found) found = entry;
  return found;
}

/**
 * A reader for a token file that parses again only when the file changes. A missing or broken file gives no tokens.
 * `warn` hears about a file that cannot be read and about each entry that is dropped, once for each change of the file.
 */
export function tokensFromFile(path: string, warn: (message: string) => void = () => undefined): () => TokenEntry[] {
  let mtime = -1;
  let cached: TokenEntry[] = [];
  let failed = false;
  return () => {
    if (!path) return [];
    try {
      const stat = statSync(path);
      if (stat.mtimeMs !== mtime) {
        cached = parseTokens(JSON.parse(readFileSync(path, 'utf8')), warn);
        mtime = stat.mtimeMs;
        failed = false;
      }
    } catch (error) {
      // The cause names the problem (a missing file, bad JSON), not the content. A broken file warns once, not for each request.
      if (!failed) warn(`the token file cannot be used, so every request is refused: ${(error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.name : 'error')}`);
      failed = true;
      mtime = -1;
      cached = [];
    }
    return cached;
  };
}
