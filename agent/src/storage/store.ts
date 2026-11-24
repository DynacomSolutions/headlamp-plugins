import { randomUUID } from 'node:crypto';
import type { Db } from '../store.js';
import type { StorageNotice } from './inventory.js';
import type { CoverageStatus, Delivery, Registration } from './notifications.js';
import type { Approval, ChatMessage, Checkpoint, Dispatch, DriveState, FrozenPlan, NodeScan, Parent, Receipt, ScanResult, Snapshot } from './types.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS storage_incident_push_registrations (
    subscription_id text PRIMARY KEY REFERENCES push_subscriptions ON DELETE CASCADE,
    until_at timestamptz NOT NULL,
    data jsonb NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS storage_incident_push_coverage (
    notice_id uuid PRIMARY KEY,
    status text NOT NULL,
    evaluated_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS storage_incident_push_deliveries (
    notice_id uuid NOT NULL REFERENCES storage_incident_push_coverage,
    subscription_id text NOT NULL,
    grant_id uuid NOT NULL,
    status text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    at timestamptz NOT NULL,
    result text,
    PRIMARY KEY (notice_id, subscription_id)
  )`,
  `CREATE TABLE IF NOT EXISTS storage_incident_push_attempts (
    notice_id uuid NOT NULL,
    subscription_id text NOT NULL,
    attempt integer NOT NULL,
    started_at timestamptz NOT NULL,
    result text,
    PRIMARY KEY (notice_id, subscription_id, attempt),
    FOREIGN KEY (notice_id, subscription_id) REFERENCES storage_incident_push_deliveries
  )`,
  'CREATE INDEX IF NOT EXISTS storage_incident_push_due ON storage_incident_push_deliveries (status, at)',
  `CREATE TABLE IF NOT EXISTS storage_incident_parent (
    singleton boolean PRIMARY KEY CHECK (singleton),
    data jsonb NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS storage_incident_drives (
    id uuid PRIMARY KEY,
    scope text NOT NULL UNIQUE,
    data jsonb NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS storage_incident_snapshots (
    id uuid PRIMARY KEY,
    drive_id uuid NOT NULL REFERENCES storage_incident_drives,
    scanned_at timestamptz NOT NULL,
    data jsonb NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS storage_incident_snapshots_drive ON storage_incident_snapshots (drive_id, scanned_at DESC, id DESC)',
  `CREATE TABLE IF NOT EXISTS storage_incident_items (
    drive_id uuid NOT NULL REFERENCES storage_incident_drives,
    object_key text NOT NULL,
    id uuid NOT NULL,
    PRIMARY KEY (drive_id, object_key)
  )`,
  `CREATE TABLE IF NOT EXISTS storage_incident_records (
    seq bigint GENERATED ALWAYS AS IDENTITY,
    id uuid PRIMARY KEY,
    drive_id uuid NOT NULL REFERENCES storage_incident_drives,
    kind text NOT NULL,
    data jsonb NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS storage_incident_records_drive ON storage_incident_records (drive_id, kind, seq DESC)',
  `CREATE TABLE IF NOT EXISTS storage_incident_plans (
    id uuid PRIMARY KEY,
    drive_id uuid NOT NULL REFERENCES storage_incident_drives,
    created_at timestamptz NOT NULL,
    data jsonb NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS storage_incident_plans_drive ON storage_incident_plans (drive_id, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS storage_incident_approvals (
    id uuid PRIMARY KEY,
    plan_id uuid NOT NULL UNIQUE REFERENCES storage_incident_plans,
    data jsonb NOT NULL,
    dispatch jsonb
  )`,
  `CREATE TABLE IF NOT EXISTS storage_incident_receipts (
    id uuid PRIMARY KEY,
    approval_id uuid NOT NULL REFERENCES storage_incident_approvals,
    status text NOT NULL,
    data jsonb NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS storage_incident_receipts_approval ON storage_incident_receipts (approval_id)',
  "CREATE INDEX IF NOT EXISTS storage_incident_pending_receipts ON storage_incident_receipts (approval_id) WHERE status = 'queued'",
  `CREATE TABLE IF NOT EXISTS storage_incident_messages (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    data jsonb NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS storage_incident_checkpoints (
    singleton boolean PRIMARY KEY CHECK (singleton),
    through_seq bigint NOT NULL,
    data jsonb NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS storage_incident_scans (
    node text PRIMARY KEY,
    last_full_at timestamptz,
    lease_owner uuid,
    lease_until timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS storage_incident_aliases (
  'ALTER TABLE storage_incident_scans ADD COLUMN IF NOT EXISTS result text, ADD COLUMN IF NOT EXISTS completed_at timestamptz',
    node text PRIMARY KEY,
    data jsonb NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS storage_incident_cooldowns (
    scope text PRIMARY KEY,
    scanned_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS storage_incident_reconcile (
    singleton boolean PRIMARY KEY CHECK (singleton),
    succeeded_at timestamptz NOT NULL
  )`,
];

type Query = Db['query'];
type RecordKind = 'evidence' | 'decision' | 'question' | 'child' | 'notice';
type StoredApproval = { data: Approval; dispatch: Dispatch | null };
type MessageRow = { seq: string; data: ChatMessage };

type ScanState = NodeScan & { lastFullAt: number };
function json(value: unknown): string {
  return JSON.stringify(value);
}

export class StorageQueries {
  constructor(readonly query: Query) {}

  async parent(): Promise<Parent> {
    return (await this.query('SELECT data FROM storage_incident_parent WHERE singleton')).rows[0].data as Parent;
  }

  async lock(key: string): Promise<void> {
    await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`storage-incident:${key}`]);
  }

  async driveSummaries(): Promise<Array<Omit<DriveState, 'items'>>> {
    return this.records<Omit<DriveState, 'items'>>("SELECT data - 'items' AS data FROM storage_incident_drives ORDER BY data->'drive'->>'node', data->'drive'->>'mount'");
  }

  async drive(id: string, lock = false): Promise<DriveState | undefined> {
    return this.record<DriveState>(`SELECT data FROM storage_incident_drives WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  }

  async scopesOnNode(node: string): Promise<string[]> {
    const rows = (await this.query("SELECT scope FROM storage_incident_drives WHERE data->'drive'->>'node' = $1", [node])).rows;
    return rows.map(row => String(row.scope));
  }

  async byScope(scope: string): Promise<DriveState | undefined> {
    return this.record<DriveState>('SELECT data FROM storage_incident_drives WHERE scope = $1', [scope]);
  }

  async putDrive(scope: string, data: DriveState): Promise<void> {
    await this.query('INSERT INTO storage_incident_drives (id, scope, data) VALUES ($1,$2,$3) ON CONFLICT (scope) DO UPDATE SET data = EXCLUDED.data', [data.drive.id, scope, json(data)]);
  }

  async itemIds(driveId: string, keys: string[]): Promise<Map<string, string>> {
    if (!keys.length) return new Map();
    const input = keys.map(key => ({ key, id: randomUUID() }));
    const result = await this.query(`INSERT INTO storage_incident_items (drive_id, object_key, id)
      SELECT $1, item->>'key', (item->>'id')::uuid FROM jsonb_array_elements($2::jsonb) AS item
      ON CONFLICT (drive_id, object_key) DO UPDATE SET object_key = EXCLUDED.object_key RETURNING object_key, id`, [driveId, json(input)]);
    return new Map(result.rows.map(row => [String(row.object_key), String(row.id)]));
  }

  async putSnapshot(driveId: string, snapshot: Snapshot): Promise<void> {
    await this.query('INSERT INTO storage_incident_snapshots (id, drive_id, scanned_at, data) VALUES ($1,$2,$3,$4)', [snapshot.id, driveId, snapshot.scannedAt, json(snapshot)]);
  }

  async history(driveId: string): Promise<Snapshot[]> {
    return this.records<Snapshot>('SELECT data FROM storage_incident_snapshots WHERE drive_id = $1 ORDER BY scanned_at DESC, id DESC LIMIT 100', [driveId]);
  }

  async insert(driveId: string, kind: RecordKind, data: { id: string }): Promise<void> {
    await this.query('INSERT INTO storage_incident_records (id, drive_id, kind, data) VALUES ($1,$2,$3,$4)', [data.id, driveId, kind, json(data)]);
  }

  async updateRecord(kind: RecordKind, data: { id: string }): Promise<void> {
    await this.query('UPDATE storage_incident_records SET data = $3 WHERE id = $1 AND kind = $2', [data.id, kind, json(data)]);
  }

  async get<T>(kind: RecordKind, id: string, lock = false): Promise<T | undefined> {
    return this.record<T>(`SELECT data FROM storage_incident_records WHERE kind = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [kind, id]);
  }

  async clearNotice(id: string): Promise<void> {
    await this.query("DELETE FROM storage_incident_records WHERE kind = 'notice' AND id = $1", [id]);
  }

  async list<T>(kind: RecordKind, driveId?: string): Promise<T[]> {
    return this.records<T>(`SELECT data FROM storage_incident_records WHERE kind = $1${driveId ? ' AND drive_id = $2' : ''} ORDER BY seq DESC`, driveId ? [kind, driveId] : [kind]);
  }

  async savePlan(plan: FrozenPlan): Promise<void> {
    await this.query('INSERT INTO storage_incident_plans (id, drive_id, created_at, data) VALUES ($1,$2,$3,$4)', [plan.public.id, plan.public.driveId, plan.public.createdAt, json(plan)]);
  }

  async plan(id: string, lock = false): Promise<FrozenPlan | undefined> {
    return this.record<FrozenPlan>(`SELECT data FROM storage_incident_plans WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  }

  async plans(driveId: string): Promise<FrozenPlan[]> {
    return this.records<FrozenPlan>('SELECT data FROM storage_incident_plans WHERE drive_id = $1 ORDER BY created_at DESC LIMIT 100', [driveId]);
  }

  async approvalFor(planId: string): Promise<Approval | undefined> {
    return this.record<Approval>('SELECT data FROM storage_incident_approvals WHERE plan_id = $1', [planId]);
  }

  async approval(id: string, lock = false): Promise<StoredApproval | undefined> {
    return (await this.query(`SELECT data, dispatch FROM storage_incident_approvals WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0] as StoredApproval | undefined;
  }

  async putApproval(approval: Approval): Promise<void> {
    await this.query('INSERT INTO storage_incident_approvals (id, plan_id, data) VALUES ($1,$2,$3)', [approval.id, approval.planId, json(approval)]);
  }

  async putDispatch(id: string, dispatch: Dispatch): Promise<void> {
    await this.query('UPDATE storage_incident_approvals SET dispatch = $2 WHERE id = $1 AND dispatch IS NULL', [id, json(dispatch)]);
  }

  async putReceipts(receipts: Receipt[]): Promise<void> {
    if (!receipts.length) return;
    await this.query(`INSERT INTO storage_incident_receipts (id, approval_id, status, data)
      SELECT (r->>'id')::uuid, (r->>'approvalId')::uuid, r->>'status', r FROM jsonb_array_elements($1::jsonb) AS r
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data
      WHERE storage_incident_receipts.status = 'queued'`, [json(receipts)]);
  }

  async receipts(approvalId: string): Promise<Receipt[]> {
    return this.records<Receipt>("SELECT data FROM storage_incident_receipts WHERE approval_id = $1 ORDER BY data->>'itemId'", [approvalId]);
  }

  async driveReceipts(driveId: string): Promise<Receipt[]> {
    return this.records<Receipt>(`SELECT r.data FROM storage_incident_receipts r
      JOIN storage_incident_approvals a ON r.approval_id = a.id
      JOIN storage_incident_plans p ON a.plan_id = p.id
      WHERE p.drive_id = $1 ORDER BY r.data->>'updatedAt' DESC, r.id`, [driveId]);
  }

  async pending(): Promise<string[]> {
    return (await this.query("SELECT DISTINCT approval_id FROM storage_incident_receipts WHERE status = 'queued'")).rows.map(row => row.approval_id as string);
  }

  async addMessage(message: ChatMessage): Promise<void> {
    await this.query('INSERT INTO storage_incident_messages (data) VALUES ($1)', [json(message)]);
  }

  async messages(through: string): Promise<MessageRow[]> {
    return (await this.query('SELECT seq, data FROM storage_incident_messages WHERE seq > $1 ORDER BY seq', [through])).rows as MessageRow[];
  }

  async checkpoint(): Promise<{ through_seq: string; data: Checkpoint } | undefined> {
    return (await this.query('SELECT through_seq, data FROM storage_incident_checkpoints WHERE singleton')).rows[0] as { through_seq: string; data: Checkpoint } | undefined;
  }

  async putCheckpoint(through: string, checkpoint: Checkpoint): Promise<void> {
    await this.query('INSERT INTO storage_incident_checkpoints (singleton, through_seq, data) VALUES (true,$1,$2) ON CONFLICT (singleton) DO UPDATE SET through_seq = EXCLUDED.through_seq, data = EXCLUDED.data', [through, json(checkpoint)]);
  }

  async scanStates(nodes: string[], now: number): Promise<ScanState[]> {
    const { rows } = await this.query('SELECT node, last_full_at, lease_until, result, completed_at FROM storage_incident_scans WHERE node = ANY($1::text[])', [nodes]);
    const byNode = new Map(rows.map(row => [row.node, row]));
    return nodes.map(node => {
      const row = byNode.get(node);
      const lastFullAt = row?.last_full_at ? new Date(row.last_full_at as string).getTime() : 0;
      const result = (row?.result as ScanResult | null) ?? (lastFullAt ? 'complete' : 'pending');
      const status = row?.lease_until ? (new Date(row.lease_until as string).getTime() > now ? 'running' : 'timeout') : result;
      return { node, status, lastFullAt, completedAt: row?.completed_at ? new Date(row.completed_at as string).toISOString() : undefined };
    });
  }

  async scanState(node: string, now: number): Promise<ScanState> {
    return (await this.scanStates([node], now))[0];
  }

  async leaseScan(node: string, owner: string, now: number, ttlMs: number): Promise<boolean> {
    const claim = await this.query(`INSERT INTO storage_incident_scans (node, lease_owner, lease_until) VALUES ($1,$2,$3)
      ON CONFLICT (node) DO UPDATE SET lease_owner = EXCLUDED.lease_owner, lease_until = EXCLUDED.lease_until
      WHERE storage_incident_scans.lease_until IS NULL OR storage_incident_scans.lease_until <= $4`, [node, owner, new Date(now + ttlMs), new Date(now)]);
    return (claim.rowCount ?? claim.rows.length) > 0;
  }

  async ownsScan(node: string, owner: string, now: number): Promise<boolean> {
    const result = await this.query('SELECT node FROM storage_incident_scans WHERE node = $1 AND lease_owner = $2 AND lease_until > $3 FOR UPDATE', [node, owner, new Date(now)]);
    return result.rows.length > 0;
  }

  async finishScan(node: string, owner: string, result: ScanResult, now: number, fullAt?: number): Promise<void> {
    await this.query(`UPDATE storage_incident_scans SET lease_owner = NULL, lease_until = NULL,
      result = $3, completed_at = $4, last_full_at = COALESCE($5, last_full_at) WHERE node = $1 AND lease_owner = $2`,
    [node, owner, result, new Date(now), fullAt === undefined ? null : new Date(fullAt)]);
  }

  async aliases(node: string): Promise<Array<[string, string]>> {
    return (await this.record<Array<[string, string]>>('SELECT data FROM storage_incident_aliases WHERE node = $1', [node])) ?? [];
  }

  async putAliases(node: string, aliases: Array<[string, string]>): Promise<void> {
    await this.query('INSERT INTO storage_incident_aliases (node, data) VALUES ($1,$2) ON CONFLICT (node) DO UPDATE SET data = EXCLUDED.data', [node, json(aliases)]);
  }

  async cooldown(scope: string): Promise<number> {
    const row = (await this.query('SELECT scanned_at FROM storage_incident_cooldowns WHERE scope = $1', [scope])).rows[0];
    return row?.scanned_at ? Date.parse(String(row.scanned_at)) : 0;
  }

  async markCooldown(scope: string, now: number): Promise<void> {
    await this.query('INSERT INTO storage_incident_cooldowns (scope, scanned_at) VALUES ($1,$2) ON CONFLICT (scope) DO UPDATE SET scanned_at = GREATEST(storage_incident_cooldowns.scanned_at, EXCLUDED.scanned_at)', [scope, new Date(now)]);
  }

  async markReconcile(now: number): Promise<void> {
    await this.query('INSERT INTO storage_incident_reconcile (singleton, succeeded_at) VALUES (true,$1) ON CONFLICT (singleton) DO UPDATE SET succeeded_at = GREATEST(storage_incident_reconcile.succeeded_at, EXCLUDED.succeeded_at)', [new Date(now)]);
  }

  async metrics(): Promise<{ scans: { node: string; at: number }[]; receipts: { status: string; count: number }[]; lastSuccess: number }> {
    const scans = (await this.query('SELECT node, EXTRACT(EPOCH FROM last_full_at) AS at FROM storage_incident_scans WHERE last_full_at IS NOT NULL')).rows;
    const receipts = (await this.query('SELECT status, count(*) FROM storage_incident_receipts GROUP BY status')).rows;
    const reconcile = (await this.query('SELECT EXTRACT(EPOCH FROM succeeded_at) AS at FROM storage_incident_reconcile')).rows[0];
    return {
      scans: scans.map(row => ({ node: String(row.node), at: Number(row.at) })),
      receipts: receipts.map(row => ({ status: String(row.status), count: Number(row.count) })),
      lastSuccess: Number(reconcile?.at ?? 0),
    };
  }

  registration(id: string): Promise<Registration | undefined> {
    return this.record<Registration>('SELECT data FROM storage_incident_push_registrations WHERE subscription_id = $1', [id]);
  }

  registrations(at: number): Promise<Registration[]> {
    return this.records<Registration>('SELECT data FROM storage_incident_push_registrations WHERE until_at > $1', [new Date(at)]);
  }

  async saveRegistration(row: Registration): Promise<void> {
    await this.query(`INSERT INTO storage_incident_push_registrations (subscription_id, until_at, data)
      VALUES ($1,$2,$3) ON CONFLICT (subscription_id) DO UPDATE SET until_at = EXCLUDED.until_at, data = EXCLUDED.data`,
    [row.subscriptionId, row.until, json(row)]);
  }

  async removeRegistration(subscriptionId: string): Promise<void> {
    await this.query('DELETE FROM storage_incident_push_registrations WHERE subscription_id = $1', [subscriptionId]);
  }

  unresolvedCoverage(canSend: boolean): Promise<StorageNotice[]> {
    return this.records<StorageNotice>(`SELECT n.data FROM storage_incident_records n LEFT JOIN storage_incident_push_coverage c ON n.id = c.notice_id
      WHERE n.kind = 'notice' AND (c.notice_id IS NULL OR ($1 AND c.status IN ('private', 'disabled', 'no_recipients')
        AND n.data->>'external' = 'true')) ORDER BY n.seq`, [canSend]);
  }

  async evaluateNotice(id: string, status: CoverageStatus, at: number): Promise<void> {
    await this.query(`INSERT INTO storage_incident_push_coverage (notice_id, status, evaluated_at)
      VALUES ($1,$2,$3) ON CONFLICT (notice_id) DO UPDATE SET status = EXCLUDED.status, evaluated_at = EXCLUDED.evaluated_at`,
    [id, status, new Date(at)]);
  }

  async addTargets(noticeId: string, recipients: Registration[], at: number): Promise<void> {
    await this.query(`INSERT INTO storage_incident_push_deliveries (notice_id, subscription_id, grant_id, status, at)
      SELECT $1, r->>'subscriptionId', (r->>'grant')::uuid, 'pending', $2 FROM jsonb_array_elements($3::jsonb) AS r
      ON CONFLICT (notice_id, subscription_id) DO NOTHING`, [noticeId, new Date(at), json(recipients)]);
  }

  async deliverySummaries(noticeIds: string[]): Promise<Array<{ id: string; evaluated: boolean; accepted: number; failed: number; pending: number }>> {
    if (!noticeIds.length) return [];
    const rows = (await this.query(`SELECT c.notice_id, count(d.status) FILTER (WHERE d.status = 'accepted') AS accepted,
      count(d.status) FILTER (WHERE d.status = 'failed') AS failed,
      count(d.status) FILTER (WHERE d.status IN ('pending','sending')) AS pending
      FROM storage_incident_push_coverage c LEFT JOIN storage_incident_push_deliveries d ON c.notice_id = d.notice_id
      WHERE c.notice_id = ANY($1::uuid[]) GROUP BY c.notice_id`, [noticeIds])).rows;
    return rows.map(row => ({ id: String(row.notice_id), evaluated: true, accepted: Number(row.accepted), failed: Number(row.failed), pending: Number(row.pending) }));
  }

  async deliveryCounts(): Promise<Map<string, number>> {
    const rows = (await this.query('SELECT status, count(*) FROM storage_incident_push_deliveries GROUP BY status')).rows;
    return new Map(rows.map(row => [String(row.status), Number(row.count)]));
  }

  async dueDeliveries(at: number): Promise<Delivery[]> {
    const result = await this.query(`SELECT notice_id AS "noticeId", subscription_id AS "subscriptionId", grant_id AS grant, status, attempts, at
      FROM storage_incident_push_deliveries WHERE status = 'pending' AND at <= $1 ORDER BY at LIMIT 50`, [new Date(at)]);
    return result.rows as Delivery[];
  }

  async claimDelivery(delivery: Delivery, at: number): Promise<Delivery | undefined> {
    const result = await this.query(`WITH claim AS (
        UPDATE storage_incident_push_deliveries SET status = 'sending', attempts = attempts + 1, at = $3
        WHERE notice_id = $1 AND subscription_id = $2 AND status = 'pending' AND at <= $3 AND attempts = $4
        RETURNING notice_id, subscription_id, grant_id, status, attempts, at
      ), audit AS (
        INSERT INTO storage_incident_push_attempts (notice_id, subscription_id, attempt, started_at)
        SELECT notice_id, subscription_id, attempts, at FROM claim
      ) SELECT notice_id AS "noticeId", subscription_id AS "subscriptionId", grant_id AS grant, status, attempts, at FROM claim`,
    [delivery.noticeId, delivery.subscriptionId, new Date(at), delivery.attempts]);
    return result.rows[0] as Delivery | undefined;
  }

  async finishDelivery(delivery: Delivery, status: Delivery['status'], result: string, at: number): Promise<void> {
    await this.query(`WITH finished AS (
        UPDATE storage_incident_push_deliveries SET status = $4, result = $5, at = $6
        WHERE notice_id = $1 AND subscription_id = $2 AND attempts = $3 AND status = 'sending'
        RETURNING notice_id, subscription_id, attempts
      ) UPDATE storage_incident_push_attempts a SET result = $5 FROM finished f
        WHERE a.notice_id = f.notice_id AND a.subscription_id = f.subscription_id AND a.attempt = f.attempts`,
    [delivery.noticeId, delivery.subscriptionId, delivery.attempts, status, result, new Date(at)]);
  }

  async expireAttempts(cutoff: number): Promise<void> {
    await this.query(`WITH expired AS (
        UPDATE storage_incident_push_deliveries SET status = 'failed', result = 'delivery_unverified' WHERE status = 'sending' AND at < $1
        RETURNING notice_id, subscription_id, attempts
      ) UPDATE storage_incident_push_attempts a SET result = 'delivery_unverified' FROM expired e
        WHERE a.notice_id = e.notice_id AND a.subscription_id = e.subscription_id AND a.attempt = e.attempts`, [new Date(cutoff)]);
  }

  private async record<T>(statement: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.query(statement, params)).rows[0]?.data as T | undefined;
  }

  private async records<T>(statement: string, params: unknown[] = []): Promise<T[]> {
    return (await this.query(statement, params)).rows.map(row => row.data as T);
  }
}

export class StorageStore extends StorageQueries {
  constructor(private readonly db: Db) {
    super(db.query);
  }

  transaction<T>(callback: (tx: StorageQueries) => Promise<T>): Promise<T> {
    return this.db.transaction(tx => callback(new StorageQueries(tx.query)));
  }

  async init(now: number): Promise<void> {
    await this.transaction(async tx => {
      await tx.lock('schema');
      for (const statement of SCHEMA) await tx.query(statement);
      const parent: Parent = { id: randomUUID(), chatId: randomUUID(), createdAt: new Date(now).toISOString() };
      await tx.query('INSERT INTO storage_incident_parent (singleton, data) VALUES (true,$1) ON CONFLICT DO NOTHING', [json(parent)]);
    });
  }
}
