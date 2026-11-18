/**
 * Masks secrets in everything the server returns: tool results, A2UI payloads,
 * diagnosis reports and log lines. Patterns lean towards masking, because a
 * masked word the model needed costs less than a leaked credential.
 */

export const MASK = '[masked]';

/** Names of fields, env vars and keys whose values are secret whatever they look like. */
const SECRET_NAME =
  /(passw(or)?d|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|authorization|^auth$|basic[_-]?auth|auth[_-]?token|cookie|session[_-]?id|signing[_-]?key|dsn|webhook[_-]?url|connection[_-]?string)/i;

/** Names that contain a secret word but describe a reference, not a value. */
const SAFE_NAME = /(secretname|secretref|secretkeyref|tokenpath|token_path|tokenfile|token_file|secretkey$|keyref|^tokenreviews?$|auth.*(mode|method|type|enabled)|serviceaccount)/i;

const PATTERNS: Array<[RegExp, string]> = [
  // PEM private keys and certificates' private parts, whole blocks.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, MASK],
  // JSON Web Tokens (Kubernetes service account tokens are JWTs).
  [/\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{6,}/g, MASK],
  // Tokens with a recognisable prefix.
  [/\b(sk|pk|rk)-(ant-|proj-|live_|test_)?[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\baisg_[A-Za-z0-9_-]{8,}/g, MASK],
  [/\btskey-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bnpm_[A-Za-z0-9]{30,}/g, MASK],
  [/\bAgE[A-Za-z0-9+/=]{40,}/g, MASK], // sealed-secrets ciphertext
  // Authorization headers and bearer tokens.
  [/\b(authorization|proxy-authorization|x-api-key|api-key)(\s*[:=]\s*)("?)(bearer |basic |token )?[^\s,;"]+/gi, `$1$2$3${MASK}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${MASK}`],
  // user:password@ in URLs.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, `$1:${MASK}@`],
  // Query parameters that carry credentials.
  [/([?&](?:access_token|token|key|api_key|apikey|sig|signature|password|secret|code)=)[^&\s"']+/gi, `$1${MASK}`],
  // key=value and key: value where the key says it is secret.
  [
    /\b([\w.-]*(?:passw(?:or)?d|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)[\w.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"'}\]]+)/gi,
    `$1$2${MASK}`,
  ],
];

export function maskText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function secretName(name: string): boolean {
  return SECRET_NAME.test(name) && !SAFE_NAME.test(name);
}

/**
 * Returns a deep copy of `value` with every string masked. Object fields whose
 * name says they are secret are masked whole, and Kubernetes `env` entries
 * (`{name, value}`) are masked by the variable's name.
 */
export function mask<T>(value: T): T {
  return walk(value, undefined) as T;
}

function walk(value: unknown, key: string | undefined): unknown {
  if (typeof value === 'string') {
    if (key && secretName(key) && value.length > 0) return MASK;
    return maskText(value);
  }
  if (Array.isArray(value)) return value.map(item => walk(item, undefined));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Kubernetes env var, header or generic name/value pair.
    if (typeof obj.name === 'string' && 'value' in obj && typeof obj.value === 'string' && secretName(obj.name)) {
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) copy[k] = k === 'value' ? MASK : walk(v, k);
      return copy;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v, k);
    return out;
  }
  return value;
}
