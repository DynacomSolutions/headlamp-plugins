import { createECDH, createCipheriv, createPrivateKey, createPublicKey, createHash, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';

/**
 * Web Push from the agent: message encryption (RFC 8291, aes128gcm) and the VAPID header (RFC 8292).
 * Only node:crypto is used, so the agent needs no extra package. A push carries no secret: the caller passes
 * a short title, a short body and a path.
 */

export const b64url = (b: Buffer): string => b.toString('base64url');

/** Decodes base64url. Standard base64 and missing padding are accepted too. */
export function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export interface VapidKeys {
  /** The public key, 65 bytes uncompressed, base64url. Browsers need it to subscribe. */
  publicKey: string;
  /** The private scalar, 32 bytes, base64url. */
  privateKey: string;
  /** A `mailto:` or `https:` contact for the push service. */
  subject: string;
}

/** A new P-256 key pair in the form VAPID uses. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  const uncompressed = Buffer.concat([Buffer.from([4]), fromB64url(String(pub.x)), fromB64url(String(pub.y))]);
  return { publicKey: b64url(uncompressed), privateKey: String(jwk.d) };
}

function privateKeyObject(keys: VapidKeys) {
  const pub = fromB64url(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('The VAPID public key must be 65 bytes (uncompressed P-256)');
  return createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) } });
}

/** True when the private and public key belong together. Used at start-up so a wrong Secret turns push off, loudly. */
export function vapidKeysMatch(keys: VapidKeys): boolean {
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(fromB64url(keys.privateKey));
    return ecdh.getPublicKey().equals(fromB64url(keys.publicKey));
  } catch {
    return false;
  }
}

/** The `Authorization` header value for a push to `endpoint`. */
export function vapidHeader(endpoint: string, keys: VapidKeys, nowMs = Date.now()): string {
  const aud = new URL(endpoint).origin;
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: keys.subject })));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

export interface EncryptOptions {
  /** Fixed sender key and salt, for the RFC vector test. */
  senderPrivateKey?: Buffer;
  salt?: Buffer;
}

const RECORD_SIZE = 4096;
/** The largest plaintext that fits in one record: record size, minus tag (16), delimiter (1) and header (86). */
export const MAX_PLAINTEXT = RECORD_SIZE - 16 - 1 - 86;

/**
 * Encrypts `plaintext` for one subscription as one aes128gcm record. `uaPublic` is the 65-byte `p256dh` key and
 * `authSecret` the 16-byte `auth` secret of the subscription.
 */
export function encryptPayload(plaintext: Buffer, uaPublic: Buffer, authSecret: Buffer, options: EncryptOptions = {}): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('The push payload is too large');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('The subscription key is not a P-256 point');
  if (authSecret.length < 16) throw new Error('The subscription auth secret is too short');
  const ecdh = createECDH('prime256v1');
  if (options.senderPrivateKey) ecdh.setPrivateKey(options.senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = options.salt ?? randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** Push services the agent may send to. Any other host is refused, so a subscription cannot point the agent at an internal URL. */
const PUSH_HOSTS: Array<string | RegExp> = [
  'fcm.googleapis.com',
  // Chrome now hands out endpoints on numbered hosts of this form (for example `jmt17.google.com/fcm/send/...`).
  /^jmt\d{1,3}\.google\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

/** The endpoint is an https URL on a known push service, or on a host in `extraHosts` (exact names, for tests and special services). */
export function endpointAllowed(endpoint: string, extraHosts: string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return extraHosts.includes(host) || PUSH_HOSTS.some(h => (typeof h === 'string' ? h === host : h.test(host)));
}

/** The stable id of a subscription: a hash of its endpoint. The browser page computes the same value. */
export function subscriptionId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 32);
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendOptions {
  /** Seconds the push service keeps the message when the device is offline. */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: number;
}

export interface SendResult {
  status: number;
  /** The push service says the subscription is gone (404 or 410): the caller deletes it. */
  gone: boolean;
}

/** Sends one encrypted message. Throws on a network error. A 4xx or 5xx answer is a result, not an error. */
export async function sendWebPush(target: PushTarget, payload: unknown, keys: VapidKeys, options: SendOptions = {}): Promise<SendResult> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), fromB64url(target.p256dh), fromB64url(target.auth));
  const headers: Record<string, string> = {
    authorization: vapidHeader(target.endpoint, keys, options.now),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(options.ttl ?? 3600),
    urgency: options.urgency ?? 'normal',
  };
  if (options.topic && /^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) headers.topic = options.topic;
  const doFetch = options.fetch ?? fetch;
  // Never follow a redirect: the endpoint was checked, its redirect target was not.
  const res = await doFetch(target.endpoint, { method: 'POST', headers, body: new Uint8Array(body), redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
  await res.arrayBuffer().catch(() => undefined);
  return { status: res.status, gone: res.status === 404 || res.status === 410 };
}

/** The public key of a P-256 point, to check a subscription key before it is stored. */
export function validPublicKey(p256dh: string): boolean {
  try {
    const b = fromB64url(p256dh);
    if (b.length !== 65 || b[0] !== 4) return false;
    createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64url(b.subarray(1, 33)), y: b64url(b.subarray(33, 65)) } });
    return true;
  } catch {
    return false;
  }
}
