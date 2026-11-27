import type { IncomingMessage } from 'node:http';
import { lookupBearer, tokensFromFile, type TokenEntry } from '../auth/scopes.js';
import { SCOPES, type Scope } from '../incidents/model.js';

export interface Principal {
  /** The client name of the token, or `anonymous`. */
  client: string;
  scopes: ReadonlySet<Scope>;
  anonymous: boolean;
}

export type AuthFailure = 'missing' | 'invalid' | 'bad_scopes';

export const ANONYMOUS: Principal = { client: 'anonymous', scopes: new Set<Scope>(['registry:read']), anonymous: true };

/**
 * Bearer tokens from the shared token file (`AGENT_API_TOKENS_FILE`, see auth/scopes.ts and contract section 4.3).
 * The file is read again when it changes. An entry with a scope name this contract does not know is refused.
 */
export class TokenStore {
  private readonly read: () => TokenEntry[];
  private reported = new Set<string>();

  constructor(
    path: string,
    private readonly onBadScopes: () => void = () => {},
    read?: () => TokenEntry[],
  ) {
    this.read = read ?? tokensFromFile(path);
  }

  /** The principal of the Authorization header, `undefined` when the token is unknown or has unknown scopes. */
  lookup(header: string | string[] | undefined): Principal | undefined {
    const entry = lookupBearer(this.read(), header);
    if (!entry) return undefined;
    const bad = [...entry.scopes].filter(s => !SCOPES.includes(s as Scope));
    if (bad.length) {
      if (!this.reported.has(entry.name)) {
        this.reported.add(entry.name);
        this.onBadScopes();
      }
      return undefined;
    }
    return { client: entry.name, scopes: entry.scopes as ReadonlySet<Scope>, anonymous: false };
  }
}

export type AuthResult = { ok: true; principal: Principal } | { ok: false; reason: AuthFailure };

/**
 * Who is calling. A request with a bearer header must carry a known token, else it fails in both modes.
 * Without a header, mode `optional` gives the anonymous principal (registry reads only), mode `required` fails.
 */
export function authenticate(req: IncomingMessage, tokens: TokenStore, mode: 'optional' | 'required'): AuthResult {
  const header = req.headers.authorization;
  if (header) {
    const principal = tokens.lookup(header);
    return principal ? { ok: true, principal } : { ok: false, reason: 'invalid' };
  }
  return mode === 'optional' ? { ok: true, principal: ANONYMOUS } : { ok: false, reason: 'missing' };
}
