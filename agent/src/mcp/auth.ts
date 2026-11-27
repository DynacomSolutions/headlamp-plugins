import type { IncomingMessage } from 'node:http';
import { lookupBearer, tokensFromFile, type TokenEntry } from '../auth/scopes.js';
import { SCOPES, type Scope } from '../incidents/model.js';

export interface Principal {
  /** The client name of the token, or `anonymous`. */
  client: string;
  scopes: ReadonlySet<Scope>;
  anonymous: boolean;
  /** The SHA-256 digest of the token in hex. A session belongs to this digest, not to the client name. Empty for anonymous. */
  digest: string;
}

export type AuthFailure = 'missing' | 'invalid' | 'bad_scopes';

export const ANONYMOUS: Principal = { client: 'anonymous', scopes: new Set<Scope>(['registry:read']), anonymous: true, digest: '' };

/**
 * Bearer tokens from the shared token file (`AGENT_API_TOKENS_FILE`, see auth/scopes.ts and contract section 4.3).
 * The file is read again when it changes. A scope name that this contract does not know is ignored: it grants nothing,
 * and it is counted once for each client (contract section 4.3).
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

  /** The principal of the Authorization header, `undefined` when the token is unknown. */
  lookup(header: string | string[] | undefined): Principal | undefined {
    const entry = lookupBearer(this.read(), header);
    return entry ? this.principal(entry) : undefined;
  }

  private principal(entry: TokenEntry): Principal {
    const known = [...entry.scopes].filter(s => SCOPES.includes(s as Scope)) as Scope[];
    if (known.length !== entry.scopes.size && !this.reported.has(entry.name)) {
      this.reported.add(entry.name);
      this.onBadScopes();
    }
    return { client: entry.name, scopes: new Set(known), anonymous: false, digest: entry.digest.toString('hex') };
  }

  /** True while the token of `who` is in the file with at least the scopes that it had (contract section 1.1, rule 9). */
  stillValid(who: Principal): boolean {
    if (who.anonymous) return true;
    const entry = this.read().find(e => e.digest.toString('hex') === who.digest);
    if (!entry) return false;
    return [...who.scopes].every(s => entry.scopes.has(s));
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
