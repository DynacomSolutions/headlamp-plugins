import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { SESSION_OPERATOR, tokenFile, type KubernetesIdentity } from './auth.js';
import { requestJson } from './transport.js';

const field = z.string().min(1).max(1024);
const identitySchema = z.object({ issuer: field, subject: field }).strict();
const kubernetesSchema = z.object({ username: field, uid: field.nullable() }).strict();
const entitlementSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('allowed'), version: field }).strict(),
  z.object({ status: z.literal('revoked') }).strict(),
]);
const resolveSchema = z.object({
  kubernetes: kubernetesSchema,
  recipient: identitySchema.nullable(),
  entitlement: entitlementSchema,
}).strict();
const checkSchema = z.object({
  decisions: z.array(z.object({ recipient: identitySchema, entitlement: entitlementSchema }).strict()).max(50),
}).strict();

export type Recipient = z.infer<typeof identitySchema>;
export type Entitlement = z.infer<typeof entitlementSchema>;
export const recipientKey = ({ issuer, subject }: Recipient) => JSON.stringify([issuer, subject]);

export type ResolvedRecipient = z.infer<typeof resolveSchema>;

/** The shape that the notification code needs from an authority, external or built in. */
export interface StorageNotificationAuthority {
  resolve(kubernetes: KubernetesIdentity): Promise<ResolvedRecipient | undefined>;
  check(recipients: Recipient[]): Promise<Map<string, Entitlement> | undefined>;
}

const SESSION_RECIPIENT: Recipient = { issuer: 'headlamp', subject: 'session' };
const SESSION_VERSION = '1';

/**
 * Built-in authority for a deployment that trusts the Headlamp session (`STORAGE_SESSION_PROXY_CIDRS`).
 * Only the `headlamp-session` operator is entitled, as one shared recipient. It makes no network call.
 */
export class SessionNotificationAuthority implements StorageNotificationAuthority {
  async resolve(kubernetes: KubernetesIdentity) {
    // Every other identity gets a clear revoked answer, so a human sees 403 and not an outage.
    if (kubernetes.username !== SESSION_OPERATOR || kubernetes.uid !== null) {
      return { kubernetes, recipient: null, entitlement: { status: 'revoked' as const } };
    }
    return {
      kubernetes,
      recipient: SESSION_RECIPIENT,
      entitlement: { status: 'allowed' as const, version: SESSION_VERSION },
    };
  }

  async check(recipients: Recipient[]) {
    const own = recipientKey(SESSION_RECIPIENT);
    return new Map<string, Entitlement>(recipients.map(recipient => [
      recipientKey(recipient),
      recipientKey(recipient) === own ? { status: 'allowed', version: SESSION_VERSION } : { status: 'revoked' },
    ]));
  }
}

export class NotificationAuthority implements StorageNotificationAuthority {
  constructor(private readonly url: URL, private readonly token: () => string, private readonly caFile?: string) {}

  private async request<T>(body: unknown, schema: z.ZodType<T>): Promise<T | undefined> {
    try {
      const token = this.token();
      if (!token) return;
      const ca = this.caFile ? readFileSync(this.caFile, 'utf8') : undefined;
      if (this.caFile && !ca?.includes('-----BEGIN CERTIFICATE-----')) return;
      const response = await requestJson(this.url, { token, ca, body, timeoutMs: 5_000, limit: 512 * 1024 });
      if (response.status === 200) return schema.parse(response.data);
    } catch {
      return undefined;
    }
  }

  async resolve(kubernetes: KubernetesIdentity) {
    const response = await this.request({ operation: 'resolve', kubernetes }, resolveSchema);
    if (response?.kubernetes.username !== kubernetes.username || response.kubernetes.uid !== kubernetes.uid) return;
    if (response.entitlement.status === 'allowed' && !response.recipient) return;
    return response;
  }

  async check(recipients: Recipient[]): Promise<Map<string, Entitlement> | undefined> {
    const expected = new Map(recipients.map(recipient => [recipientKey(recipient), recipient]));
    const response = await this.request({ operation: 'check', recipients: [...expected.values()] }, checkSchema);
    if (!response || response.decisions.length !== expected.size) return;
    const decisions = new Map<string, Entitlement>();
    for (const { recipient, entitlement } of response.decisions) {
      const key = recipientKey(recipient);
      if (!expected.has(key) || decisions.has(key)) return;
      decisions.set(key, entitlement);
    }
    return decisions;
  }
}

export function notificationAuthority(env: NodeJS.ProcessEnv): NotificationAuthority | undefined {
  const address = env.STORAGE_NOTIFICATION_AUTHORITY_URL;
  const token = env.STORAGE_NOTIFICATION_AUTHORITY_TOKEN_FILE;
  const ca = env.STORAGE_NOTIFICATION_AUTHORITY_CA_FILE;
  if (!address && !token && !ca) return;
  try {
    const url = new URL(address ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !token) throw new Error();
    return new NotificationAuthority(url, tokenFile(token), ca);
  } catch {
    throw new Error('Invalid storage notification authority configuration');
  }
}
