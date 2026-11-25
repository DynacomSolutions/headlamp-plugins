import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import type { Config } from '../config.js';
import { requestJson } from './transport.js';
import { StorageError } from './types.js';

export type OperatorVerb = 'get' | 'update' | 'approve';
export const STORAGE_RBAC_GROUP = 'storage.incidents.example.com';
const SELF_REVIEW_TIMEOUT_MS = 5_000;
const MAX_AUTH_BYTES = 32 * 3800;
const BEARER = /^Bearer ([A-Za-z0-9._~+\/=-]+)$/i;

export function bearer(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_AUTH_BYTES + 7 ? BEARER.exec(value)?.[1] : undefined;
}

export function tokenFile(file: string): () => string {
  return () => {
    try {
      const token = readFileSync(file, 'utf8').trim();
      return bearer(`Bearer ${token}`) ?? '';
    } catch {
      return '';
    }
  };
}

export function authenticatedMachine(req: IncomingMessage, expected: string): boolean {
  const token = bearer(req.headers.authorization);
  if (!token || !expected) return false;
  const candidate = Buffer.from(token);
  const configured = Buffer.from(expected);
  return candidate.length === configured.length && timingSafeEqual(candidate, configured);
}

function cookieBearer(header: string | undefined, cluster: string): string | undefined {
  const sanitized = cluster.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!header || !sanitized) return;
  const chunks = new Map<number, string>();
  const prefix = `headlamp-auth-${sanitized}.`;
  for (const field of header.split(';')) {
    const entry = field.trim();
    if (!entry.startsWith(prefix)) continue;
    const match = /^(0|[1-9]\d?)=([A-Za-z0-9._~+\/=-]*)$/.exec(entry.slice(prefix.length));
    if (!match) return;
    const index = Number(match[1]);
    if (index >= 32 || chunks.has(index) || match[2].length > 3800) return;
    chunks.set(index, match[2]);
  }
  const token: string[] = [];
  for (let index = 0; index < 32; index++) {
    const chunk = chunks.get(index);
    if (!chunk) break;
    token.push(chunk);
  }
  if (token.length !== chunks.size) return;
  return bearer(`Bearer ${token.join('')}`);
}

const identitySchema = z.object({
  status: z.object({
    userInfo: z.object({ username: z.string().min(1).max(1024), uid: z.string().max(1024).optional(), groups: z.array(z.string()).default([]) }),
  }),
});
const accessSchema = z.object({ status: z.object({ allowed: z.boolean(), denied: z.boolean().optional(), evaluationError: z.string().optional() }) });

const REVIEW_LIMIT = 64 * 1024;

export const SESSION_OPERATOR = 'headlamp-session';
const MAX_SESSION_CIDRS = 64;
const MIN_V4_PREFIX = 24;
const MIN_V6_PREFIX = 120;

export type SessionNetworks = { has(address: string | undefined): boolean };
/** Session trust applies only to requests that arrive on the dedicated session listener from a trusted peer. */
export type SessionTrust = { networks: SessionNetworks; port: number };

const headlampCookie = (header: string | undefined) => header !== undefined && /(?:^|;)\s*headlamp-auth-/.test(header);

/** Parses the CIDRs whose peers the agent trusts as the Headlamp session. Throws on any invalid entry. */
export function sessionNetworks(cidrs: readonly string[]): SessionNetworks | undefined {
  if (cidrs.length > MAX_SESSION_CIDRS) throw new Error('Too many session CIDRs');
  if (!cidrs.length) return;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const match = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(cidr);
    const family = match ? isIP(match[1]) : 0;
    if (!match || !family) throw new Error('Invalid session CIDR');
    const prefix = Number(match[2]);
    // A wide range would trust far more than the proxy hops.
    if (prefix > (family === 4 ? 32 : 128) || prefix < (family === 4 ? MIN_V4_PREFIX : MIN_V6_PREFIX)) throw new Error('Invalid session CIDR');
    list.addSubnet(match[1], prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return {
    has(address) {
      const plain = address?.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').replace(/%.*$/, '');
      const family = plain ? isIP(plain) : 0;
      return family !== 0 && list.check(plain!, family === 4 ? 'ipv4' : 'ipv6');
    },
  };
}

export type KubernetesIdentity = { username: string; uid: string | null };

export type Operator = {
  name: string;
  identity: KubernetesIdentity;
  /** True for the trusted Headlamp session, which no human token can claim. */
  session: boolean;
  checkBody(data: unknown): void;
  requireRead(): Promise<void>;
};

export function operatorAuth(
  config: Pick<Config, 'kubeApi' | 'kubeCaFile' | 'allowedOrigins'>,
  headlampCluster: string,
  humanGroups: ReadonlySet<string>,
  session?: SessionTrust,
) {
  const isMember = (groups: string[]) => groups.some(group => humanGroups.has(group));

  return async (req: IncomingMessage, verb: OperatorVerb): Promise<Operator> => {
    const explicit = req.headers['x-storage-operator-token'];
    const standard = req.headers.authorization;
    const direct = explicit ?? standard;
    const token = direct === undefined ? cookieBearer(req.headers.cookie, headlampCluster) : bearer(direct);
    if (
      session && explicit === undefined && standard === undefined && !headlampCookie(req.headers.cookie)
      && req.socket.localPort === session.port && session.networks.has(req.socket.remoteAddress)
    ) {
      // kube-apiserver strips the user's credentials on the service proxy, so the peer address on the
      // dedicated session port (never a forwarded header) is the only proof that Headlamp sent the request.
      if (verb !== 'get') {
        const origin = req.headers.origin;
        if (origin && !config.allowedOrigins.includes(origin)) throw new StorageError(403, 'Origin not allowed');
        if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
          throw new StorageError(415, 'The content type must be application/json');
        }
      }
      return {
        name: SESSION_OPERATOR,
        identity: { username: SESSION_OPERATOR, uid: null },
        session: true,
        requireRead: async () => {},
        checkBody() {},
      };
    }
    if (!token) throw new StorageError(401, 'Operator authentication required');
    if (!humanGroups.size) throw new StorageError(403, 'Operator membership is not configured');
    if (verb !== 'get') {
      const origin = req.headers.origin;
      if ((origin || direct === undefined) && (!origin || !config.allowedOrigins.includes(origin))) {
        throw new StorageError(403, 'Origin not allowed');
      }
      if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
        throw new StorageError(415, 'The content type must be application/json');
      }
    }
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
    const base = config.kubeApi || (host && `https://${host.includes(':') ? `[${host}]` : host}:${port}`);
    if (!base) throw new StorageError(503, 'Operator verification is unavailable');

    async function review(group: string, resource: string, kind: string, spec?: unknown) {
      try {
        const endpoint = new URL(`/apis/${group}/v1/${resource}`, base!);
        if (endpoint.protocol !== 'https:' && !(config.kubeApi && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname))) {
          throw new Error('The review endpoint requires HTTPS');
        }
        let ca: string | undefined;
        if (endpoint.protocol === 'https:' && config.kubeCaFile) {
          try {
            ca = readFileSync(config.kubeCaFile, 'utf8');
          } catch (error) {
            if (!config.kubeApi) throw error;
          }
        }
        return await requestJson(endpoint, {
          token: token!,
          body: { apiVersion: `${group}/v1`, kind, ...(spec ? { spec } : {}) },
          ca,
          timeoutMs: SELF_REVIEW_TIMEOUT_MS,
          limit: REVIEW_LIMIT,
        });
      } catch {
        throw new StorageError(503, 'Operator verification is unavailable');
      }
    }

    async function identity() {
      const response = await review('authentication.k8s.io', 'selfsubjectreviews', 'SelfSubjectReview');
      if (response.status === 401) throw new StorageError(401, 'Operator authentication failed');
      if (response.status === 403) throw new StorageError(403, 'Operator identity is not permitted');
      const parsed = identitySchema.safeParse(response.data);
      if (!parsed.success) throw new StorageError(503, 'Operator verification is unavailable');
      const user = parsed.data.status.userInfo;
      if (user.username === token || user.username === SESSION_OPERATOR || user.username.startsWith('system:') || !user.groups.includes('system:authenticated')
        || user.groups.some(group => group.startsWith('system:serviceaccounts')) || !isMember(user.groups)) {
        throw new StorageError(403, 'Approved human operator membership is required');
      }
      return { username: user.username, uid: user.uid || null };
    }

    async function authorise(requested: OperatorVerb) {
      const access = await review('authorization.k8s.io', 'selfsubjectaccessreviews', 'SelfSubjectAccessReview', {
        resourceAttributes: { group: STORAGE_RBAC_GROUP, resource: 'incidents', verb: requested },
      });
      if (access.status === 401) throw new StorageError(401, 'Operator authentication failed');
      if (access.status === 403) throw new StorageError(403, 'Operator permission required');
      const auth = accessSchema.safeParse(access.data);
      if (!auth.success || auth.data.status.evaluationError) throw new StorageError(503, 'Operator verification is unavailable');
      if (!auth.data.status.allowed || auth.data.status.denied) throw new StorageError(403, 'Operator permission required');
    }

    const verified = await identity();
    await authorise(verb);
    return {
      name: verified.username,
      identity: verified,
      session: false,
      requireRead: () => authorise('get'),
      checkBody(data: unknown) {
        if (JSON.stringify(data).includes(token)) throw new StorageError(400, 'Remove the login credential from the request');
      },
    };
  };
}
