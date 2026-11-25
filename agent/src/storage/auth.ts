import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
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
const tokenReviewSchema = z.object({
  status: z.object({
    authenticated: z.boolean().optional(),
    user: z.object({
      username: z.string().min(1).max(1024),
      uid: z.string().max(1024).optional(),
      groups: z.array(z.string()).default([]),
      extra: z.record(z.string(), z.array(z.string())).optional(),
    }).optional(),
    audiences: z.array(z.string()).default([]),
  }),
});
const accessSchema = z.object({ status: z.object({ allowed: z.boolean(), denied: z.boolean().optional(), evaluationError: z.string().optional() }) });

const REVIEW_LIMIT = 64 * 1024;

export type KubernetesIdentity = { username: string; uid: string | null };

export type Operator = {
  name: string;
  identity: KubernetesIdentity;
  checkBody(data: unknown): void;
  requireRead(): Promise<void>;
};

export function operatorAuth(
  config: Pick<Config, 'kubeApi' | 'kubeTokenFile' | 'kubeCaFile' | 'allowedOrigins'>,
  headlampCluster: string,
  humanGroups: ReadonlySet<string>,
  headlampServiceAccount: string,
  relayAudience = '',
) {
  const isMember = (groups: string[]) => groups.some(group => humanGroups.has(group));

  return async (req: IncomingMessage, verb: OperatorVerb, allowServerRead = false): Promise<Operator> => {
    const explicit = req.headers['x-storage-operator-token'];
    const standard = req.headers.authorization;
    const direct = explicit ?? standard;
    const token = direct === undefined ? cookieBearer(req.headers.cookie, headlampCluster) : bearer(direct);
    if (!token) throw new StorageError(401, 'Operator authentication required');
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
    let relayUser: z.infer<typeof tokenReviewSchema>['status']['user'];
    let relayReviewer: string | undefined;

    async function review(group: string, resource: string, kind: string, spec?: unknown, credential = token!) {
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
        const result = await requestJson(endpoint, {
          token: credential,
          body: { apiVersion: `${group}/v1`, kind, ...(spec ? { spec } : {}) },
          ca,
          timeoutMs: SELF_REVIEW_TIMEOUT_MS,
          limit: REVIEW_LIMIT,
        });
        return result;
      } catch {
        throw new StorageError(503, 'Operator verification is unavailable');
      }
    }

    async function relayIdentity(): Promise<KubernetesIdentity | undefined> {
      if (!allowServerRead || !relayAudience || explicit !== undefined || !standard) return;
      const reviewer = tokenFile(config.kubeTokenFile)();
      if (!reviewer) throw new StorageError(503, 'Operator verification is unavailable');
      const response = await review('authentication.k8s.io', 'tokenreviews', 'TokenReview', {
        token,
        audiences: [relayAudience],
      }, reviewer);
      if (response.status !== 201) return;
      const parsed = tokenReviewSchema.safeParse(response.data);
      const status = parsed.success ? parsed.data.status : undefined;
      if (!status?.authenticated || !status.user || status.user.username !== headlampServiceAccount
        || !status.user.groups.includes('system:authenticated')
        || !status.user.groups.some(group => group.startsWith('system:serviceaccounts'))
        || status.audiences.length !== 1 || status.audiences[0] !== relayAudience) return;
      relayUser = status.user;
      relayReviewer = reviewer;
      return { username: status.user.username, uid: status.user.uid || null };
    }

    async function identity() {
      const response = await review('authentication.k8s.io', 'selfsubjectreviews', 'SelfSubjectReview');
      if (response.status === 401) throw new StorageError(401, 'Operator authentication failed');
      if (response.status === 403) throw new StorageError(403, 'Operator identity is not permitted');
      const parsed = identitySchema.safeParse(response.data);
      if (!parsed.success) throw new StorageError(503, 'Operator verification is unavailable');
      const user = parsed.data.status.userInfo;
      const isHeadlampServiceAccount = user.username === headlampServiceAccount
        && user.groups.includes('system:authenticated')
        && user.groups.some(group => group.startsWith('system:serviceaccounts'));
      const isServiceAccount = user.username.startsWith('system:serviceaccount:')
        || user.groups.some(group => group.startsWith('system:serviceaccounts'));
      if (user.username === token || !user.groups.includes('system:authenticated')
        || (!isHeadlampServiceAccount && (user.username.startsWith('system:') || isServiceAccount || !isMember(user.groups)))) {
        throw new StorageError(403, 'Approved human operator membership is required');
      }
      return { username: user.username, uid: user.uid || null };
    }

    async function authorise(requested: OperatorVerb) {
      const resourceAttributes = { group: STORAGE_RBAC_GROUP, resource: 'incidents', verb: requested };
      const access = relayUser
        ? await review('authorization.k8s.io', 'subjectaccessreviews', 'SubjectAccessReview', {
          user: relayUser.username,
          ...(relayUser.uid ? { uid: relayUser.uid } : {}),
          groups: relayUser.groups,
          ...(relayUser.extra ? { extra: relayUser.extra } : {}),
          resourceAttributes,
        }, relayReviewer!)
        : await review('authorization.k8s.io', 'selfsubjectaccessreviews', 'SelfSubjectAccessReview', { resourceAttributes });
      if (access.status === 401) throw new StorageError(401, 'Operator authentication failed');
      if (access.status === 403) throw new StorageError(403, 'Operator permission required');
      const auth = accessSchema.safeParse(access.data);
      if (!auth.success || auth.data.status.evaluationError) throw new StorageError(503, 'Operator verification is unavailable');
      if (!auth.data.status.allowed || auth.data.status.denied) throw new StorageError(403, 'Operator permission required');
    }

    const relay = await relayIdentity();
    const verified = relay ?? await identity();
    const serverAccount = verified.username === headlampServiceAccount;
    if (serverAccount && allowServerRead && relayAudience && !relay) {
      throw new StorageError(403, 'Headlamp relay credential is required');
    }
    if (serverAccount && (!allowServerRead || verb !== 'get')) {
      throw new StorageError(403, 'Headlamp service account is read-only for shared views');
    }
    if (!serverAccount && !humanGroups.size) throw new StorageError(403, 'Operator membership is not configured');
    await authorise(verb);
    return {
      name: verified.username,
      identity: verified,
      requireRead: () => authorise('get'),
      checkBody(data: unknown) {
        if (JSON.stringify(data).includes(token)) throw new StorageError(400, 'Remove the login credential from the request');
      },
    };
  };
}
