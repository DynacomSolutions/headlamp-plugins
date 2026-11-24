import { z } from 'zod';
import type { A2uiMessage } from '../a2ui/index.js';
import { maskText } from '../mask.js';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const name = z.string().min(1).max(256);
const itemKey = z.string().min(1).max(512).regex(/^[A-Za-z0-9._:-]+$/);
const label = z.string().min(1).max(4096).refine(value => !value.includes('\0'));
const mount = label.refine(value => value.startsWith('/'));
const filesystemId = z.string().min(1).max(4608).refine(value => !value.includes('\0'));
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const category = z.enum(['build-cache', 'linked-worktree', 'pod-task', 'host-temp']);
const mergeEvidence = z.enum(['verified', 'unavailable']);
export type MergeEvidence = z.infer<typeof mergeEvidence>;
export const needsMergeEvidence = (value: z.infer<typeof category>) => value === 'linked-worktree' || value === 'pod-task';

export const scanSchema = z.object({
  version: z.literal(1),
  node: name,
  scannedAt: z.iso.datetime(),
  execution: z.enum(['shadow', 'disposable']).optional(),
  filesystems: z.array(z.object({
    id: filesystemId,
    mount,
    aliases: z.array(z.object({ device: label, mountpoint: mount })).max(200).optional(),
    shared: z.boolean().optional(),
    device: label.optional(),
    majorMinor: name.optional(),
    fsType: name.optional(),
    totalBytes: count,
    availableBytes: count,
  }).refine(fs => fs.availableBytes <= fs.totalBytes)).max(500),
  items: z.array(z.object({
    id: itemKey,
    objectKey: itemKey.optional(),
    category,
    path: z.string().max(2000),
    owner: z.string().max(256),
    filesystemId,
    bytes: count,
    eligible: z.boolean(),
    mergeEvidence: mergeEvidence.optional(),
    reason: z.string().max(1000),
    visibility: z.enum(['local', 'jev', 'pcg']).default('local'),
    inUse: z.boolean().optional(),
    holder: z.string().max(256).optional(),
  })).max(30_000),
  complete: z.boolean(),
}).refine(scan => {
  const fsIds = scan.filesystems.map(fs => fs.id);
  const filesystems = new Set(fsIds);
  return filesystems.size === fsIds.length && unique(scan.items.map(item => item.id)) && scan.items.every(item => filesystems.has(item.filesystemId));
}, 'The scan contains duplicate or unknown IDs');

export const triggerSchema = z.object({
  node: name,
  filesystemId: filesystemId.optional(),
  device: label.optional(),
  mount: mount.optional(),
  reason: z.enum(['capacity', 'growth', 'forecast']),
  reserveBytes: count.optional(),
  criticalBytes: count.optional(),
}).strict().refine(t => (t.filesystemId === undefined ? t.device !== undefined && t.mount !== undefined : t.device === undefined && t.mount === undefined)
  && (t.reserveBytes === undefined || t.criticalBytes === undefined || t.criticalBytes <= t.reserveBytes));
export const reconcileSchema = z.object({ triggers: z.array(triggerSchema).max(500) }).strict();
export const receiptStatus = z.enum(['removed', 'stale', 'blocked', 'failed']);
export const applyResultSchema = z.object({
  planId: z.uuid(),
  approvalId: z.uuid(),
  node: name,
  receipts: z.array(z.object({ itemId: itemKey, status: receiptStatus, reason: z.string().max(1000), bytes: count })).max(30_000),
}).refine(response => unique(response.receipts.map(receipt => receipt.itemId)));

export const investigationSchema = z.object({ kind: z.enum(['inventory', 'capacity', 'eligibility']), itemId: z.uuid().optional() }).strict();
export const decisionSchema = z.object({
  itemId: z.uuid(),
  decision: z.enum(['keep', 'defer']),
  until: z.iso.datetime().optional(),
}).strict().refine(d => (d.decision === 'defer') === Boolean(d.until), 'Defer needs an end time');
export const answerSchema = z.object({ answer: z.string().trim().min(1).max(2000) }).strict();
export const messageSchema = z.object({ text: z.string().trim().min(1).max(8000), driveId: z.uuid().optional() }).strict();
export const approvalSchema = z.object({
  itemIds: z.array(z.uuid()).min(1).max(30_000).refine(unique, 'The subset contains a duplicate item'),
}).strict();

export type Scan = z.infer<typeof scanSchema>;
export type ScanItem = Scan['items'][number];
export type Trigger = z.infer<typeof triggerSchema>;
export type ApplyResult = z.infer<typeof applyResultSchema>;
export type Investigation = z.infer<typeof investigationSchema>;
export type DecisionRequest = z.infer<typeof decisionSchema>;
export type Parent = { id: string; chatId: string; createdAt: string };
export type Snapshot = {
export type ScanResult = 'complete' | 'incomplete' | 'timeout' | 'error';
export type NodeScan = { node: string; status: ScanResult | 'pending' | 'running'; completedAt?: string };
  id: string;
  scannedAt: string;
  totalBytes: number;
  availableBytes: number;
  reserveBytes: number;
  criticalBytes: number;
  complete: boolean;
  critical: boolean;
  itemCount: number;
  eligibleCount: number;
};
export type Drive = Snapshot & {
  id: string;
  node: string;
  filesystemId: string;
  mount: string;
  status: 'incomplete' | 'critical' | 'pressure' | 'healthy';
  applyEnabled: boolean;
};
export type InternalItem = {
  id: string;
  scannerId: string;
  category: ScanItem['category'];
  material: string;
  decisionMaterial: string;
  path?: string;
  owner?: string;
  reason: string;
  inUse?: boolean;
  holder?: string;
  bytes: number;
  eligible: boolean;
  mergeEvidence?: MergeEvidence;
  visibility: 'local' | 'jev';
};
export type DriveState = {
  drive: Drive;
  current: Snapshot;
  items: InternalItem[];
  execution: 'shadow' | 'disposable';
  shared: boolean;
};
export type Decision = DecisionRequest & { id: string; createdAt: string; by: string; material: string };
export type Question = { id: string; driveId: string; itemId?: string; text: string; createdAt: string; answer?: string; answeredAt?: string; answeredBy?: string };
export type Evidence = { id: string; kind: Investigation['kind']; createdAt: string; snapshotId: string; summary: string; itemIds: string[] };
export type Child = {
  id: string;
  driveId: string;
  kind: Investigation['kind'];
  createdAt: string;
  status: 'done';
  summary: string;
  evidenceIds: string[];
  questionIds: string[];
  a2ui: A2uiMessage[];
};
export type Notice = { id: string; driveId: string; kind: 'question' | 'cleanup'; createdAt: string; questionId?: string; eligibleCount?: number };
export type PlanItem = { itemId: string; category: InternalItem['category']; label: string; bytes: number; eligible: boolean; reason: string; mergeEvidence?: MergeEvidence };
export type Plan = { id: string; driveId: string; createdAt: string; expiresAt: string; items: PlanItem[] };
export type Check = { itemId: string; scannerId: string; material: string; visibility: InternalItem['visibility'] };
export type FrozenPlan = { public: Plan; checks: Check[]; node: string; filesystemId: string };
export type Approval = { id: string; planId: string; driveId: string; itemIds: string[]; by: string; createdAt: string };
export type Dispatch = { node: string; filesystemId: string; checks: Check[]; startedAt: string };
export type Receipt = {
  id: string;
  approvalId: string;
  planId: string;
  driveId: string;
  itemId: string;
  status: 'queued' | z.infer<typeof receiptStatus>;
  reason: string;
  bytes: number;
  updatedAt: string;
};
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  a2ui?: A2uiMessage[];
  evidenceIds?: string[];
  questionIds?: string[];
};
export type Checkpoint = { throughMessageId: string; messageCount: number; evidenceIds: string[]; questionIds: string[] };
export type Chat = { id: string; messages: ChatMessage[]; checkpoint: Checkpoint | null };

export class StorageError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const clean = (text: string) => maskText(text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim());
