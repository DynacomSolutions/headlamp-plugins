import type { Db } from '../store.js';

/** Alert severity groups a diagnosis push can be limited to. `other` is every severity that is not critical or warning, and none. */
export const SEVERITY_GROUPS = ['critical', 'warning', 'other'] as const;
export type SeverityGroup = (typeof SEVERITY_GROUPS)[number];

export interface PushSettings {
  /** Push when a diagnosis is ready. */
  diagnosis: boolean;
  /** Push when the agent has answered a chat question and the asking page is not visible. */
  chat: boolean;
  /** Only diagnoses with these severity groups send a push. */
  severities: SeverityGroup[];
}

export const DEFAULT_PUSH_SETTINGS: PushSettings = { diagnosis: true, chat: true, severities: ['warning', 'critical'] };

/** Paths the notification opens, with `{id}` in place of the diagnosis or chat id. The page builds them, so they hold the cluster. */
export interface PushUrls {
  incident: string;
  chat: string;
}

export interface PushSubscriptionRecord {
  /** `subscriptionId(endpoint)`. */
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  settings: PushSettings;
  urls: PushUrls;
  createdAt: string;
  updatedAt: string;
  lastSentAt?: string;
  /** `ok`, or the HTTP status of the last failed send. */
  lastResult?: string;
  /** The chat this device shows right now, while its page is visible. */
  watchingChat?: string;
  watchingUntil?: string;
}

/** The subscriptions of the agent. Nothing here is shared with the Alerting plugin. */
export interface PushStore {
  upsert(record: PushSubscriptionRecord): Promise<void>;
  get(id: string): Promise<PushSubscriptionRecord | undefined>;
  delete(id: string): Promise<boolean>;
  list(): Promise<PushSubscriptionRecord[]>;
  /** Marks the chat a device shows until `untilMs`, or clears it (`chatId` null). False when the subscription is gone. */
  setPresence(id: string, chatId: string | null, untilMs: number): Promise<boolean>;
  recordResult(id: string, atMs: number, result: string): Promise<void>;
}

export class MemoryPushStore implements PushStore {
  private readonly records = new Map<string, PushSubscriptionRecord>();

  async upsert(record: PushSubscriptionRecord): Promise<void> {
    const old = this.records.get(record.id);
    this.records.set(record.id, { ...record, createdAt: old?.createdAt ?? record.createdAt, lastSentAt: old?.lastSentAt, lastResult: old?.lastResult, watchingChat: old?.watchingChat, watchingUntil: old?.watchingUntil });
  }

  async get(id: string): Promise<PushSubscriptionRecord | undefined> {
    const r = this.records.get(id);
    return r && { ...r };
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  async list(): Promise<PushSubscriptionRecord[]> {
    return [...this.records.values()].map(r => ({ ...r }));
  }

  async setPresence(id: string, chatId: string | null, untilMs: number): Promise<boolean> {
    const r = this.records.get(id);
    if (!r) return false;
    if (chatId) {
      r.watchingChat = chatId;
      r.watchingUntil = new Date(untilMs).toISOString();
    } else {
      delete r.watchingChat;
      delete r.watchingUntil;
    }
    return true;
  }

  async recordResult(id: string, atMs: number, result: string): Promise<void> {
    const r = this.records.get(id);
    if (r) {
      r.lastSentAt = new Date(atMs).toISOString();
      r.lastResult = result;
    }
  }
}

export const PUSH_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id text PRIMARY KEY,
    endpoint text NOT NULL UNIQUE,
    p256dh text NOT NULL,
    auth text NOT NULL,
    label text NOT NULL DEFAULT '',
    settings jsonb NOT NULL,
    urls jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    last_sent_at timestamptz,
    last_result text,
    watching_chat text,
    watching_until timestamptz
  )`,
];

const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? new Date(v).toISOString() : undefined);

function fromRow(row: Record<string, unknown>): PushSubscriptionRecord {
  return {
    id: row.id as string,
    endpoint: row.endpoint as string,
    p256dh: row.p256dh as string,
    auth: row.auth as string,
    label: row.label as string,
    settings: row.settings as PushSettings,
    urls: row.urls as PushUrls,
    createdAt: iso(row.created_at) ?? '',
    updatedAt: iso(row.updated_at) ?? '',
    lastSentAt: iso(row.last_sent_at),
    lastResult: (row.last_result as string | null) ?? undefined,
    watchingChat: (row.watching_chat as string | null) ?? undefined,
    watchingUntil: iso(row.watching_until),
  };
}

/** Subscriptions in the shared PostgreSQL cluster, next to the diagnoses, so two pods see the same devices. */
export class PgPushStore implements PushStore {
  constructor(private readonly db: Pick<Db, 'query'>) {}

  async upsert(r: PushSubscriptionRecord): Promise<void> {
    // The settings, urls and label are the device's own; a re-subscribe keeps the history of sends.
    await this.db.query(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, settings, urls, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
       ON CONFLICT (id) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, label = EXCLUDED.label,
         settings = EXCLUDED.settings, urls = EXCLUDED.urls, updated_at = EXCLUDED.updated_at`,
      [r.id, r.endpoint, r.p256dh, r.auth, r.label, JSON.stringify(r.settings), JSON.stringify(r.urls), new Date(r.createdAt), new Date(r.updatedAt)],
    );
  }

  async get(id: string): Promise<PushSubscriptionRecord | undefined> {
    const r = await this.db.query('SELECT * FROM push_subscriptions WHERE id = $1', [id]);
    return r.rows[0] ? fromRow(r.rows[0]) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.db.query('DELETE FROM push_subscriptions WHERE id = $1', [id]);
    return (r.rowCount ?? 0) > 0;
  }

  async list(): Promise<PushSubscriptionRecord[]> {
    const r = await this.db.query('SELECT * FROM push_subscriptions ORDER BY created_at ASC, id ASC');
    return r.rows.map(fromRow);
  }

  async setPresence(id: string, chatId: string | null, untilMs: number): Promise<boolean> {
    const r = await this.db.query('UPDATE push_subscriptions SET watching_chat = $2, watching_until = $3 WHERE id = $1', [id, chatId, chatId ? new Date(untilMs) : null]);
    return (r.rowCount ?? 0) > 0;
  }

  async recordResult(id: string, atMs: number, result: string): Promise<void> {
    await this.db.query('UPDATE push_subscriptions SET last_sent_at = $2, last_result = $3 WHERE id = $1', [id, new Date(atMs), result]);
  }
}
