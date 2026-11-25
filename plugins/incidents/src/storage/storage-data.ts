import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import type { A2uiMessage } from '../a2ui';
import { useLoaded } from '../chat-data';
import { ChatMessage, parseChat } from '../chat-model';
import { backendUrl, storageRelayUrl, Settings } from '../model';

export interface StorageIncident {
  enabled: boolean;
  applyEnabled?: boolean;
  incident: { id: string; chatId: string; createdAt: string } | null;
  drives: Drive[];
  scans?: NodeScan[];
  notices: Notice[];
  notifications?: NotificationCoverage;
}

export interface NodeScan {
  node: string;
  status: 'pending' | 'running' | 'complete' | 'incomplete' | 'timeout' | 'error';
  completedAt?: string;
}

export interface Drive {
  id: string;
  node: string;
  mount: string;
  filesystemId: string;
  totalBytes: number;
  availableBytes: number;
  reserveBytes: number;
  scannedAt: string;
  status: 'healthy' | 'pressure' | 'critical' | 'incomplete';
  complete: boolean;
  applyEnabled?: boolean;
}

export interface Snapshot {
  id: string;
  scannedAt: string;
  totalBytes: number;
  availableBytes: number;
  reserveBytes: number;
  complete: boolean;
}

type MergeEvidence = 'verified' | 'unavailable';

export function mergeVerification(item: { category: string; mergeEvidence?: MergeEvidence }) {
  if (item.category !== 'linked-worktree' && item.category !== 'pod-task') return undefined;
  return item.mergeEvidence === 'verified' ? 'verified' : 'unavailable';
}

export interface Item {
  id: string;
  category: string;
  label: string;
  owner?: string;
  bytes: number;
  eligible: boolean;
  mergeEvidence?: MergeEvidence;
  reason: string;
  inUse?: boolean;
  holder?: string;
  keep?: boolean;
  deferUntil?: string;
}

export interface NotificationCoverage {
  enabled: boolean;
  status: 'disabled' | 'ready' | 'unavailable';
  registeredRecipients: number | null;
  revokedRecipients: number | null;
}

export interface NoticeDelivery {
  status:
    | 'private'
    | 'disabled'
    | 'authority_unavailable'
    | 'no_recipients'
    | 'revoked'
    | 'pending'
    | 'accepted'
    | 'failed'
    | 'partial';
  targetedRecipients: number;
  providerAccepted: number;
  failed: number;
  pending: number;
  clientReceived: number | null;
}

export interface NoticeAction {
  driveId: string;
  kind: 'question' | 'cleanup';
  id: string;
  chatId: string;
}

export interface Notice {
  id: string;
  driveId: string;
  kind: 'question' | 'cleanup';
  questionId?: string;
  eligibleCount?: number;
  action: NoticeAction;
  delivery?: NoticeDelivery;
}

export interface Question {
  id: string;
  itemId?: string;
  text: string;
  answer?: string;
}

export type InvestigationKind = 'inventory' | 'capacity' | 'eligibility';

export interface Child {
  id: string;
  kind: InvestigationKind;
  createdAt: string;
  summary: string;
  a2ui: A2uiMessage[];
  evidenceIds: string[];
  questionIds: string[];
}

export interface Evidence {
  id: string;
  itemIds: string[];
  summary: string;
}

export interface Decision {
  id: string;
  itemId: string;
  decision: 'keep' | 'defer';
  createdAt: string;
  until?: string;
}

export interface PlanItem {
  itemId: string;
  category: string;
  label: string;
  bytes: number;
  eligible: boolean;
  mergeEvidence?: MergeEvidence;
  reason: string;
}

export interface Plan {
  id: string;
  createdAt: string;
  expiresAt: string;
  items: PlanItem[];
}

export interface Receipt {
  id: string;
  planId: string;
  itemId: string;
  status: 'queued' | 'removed' | 'partial' | 'stale' | 'blocked' | 'failed';
  reason: string;
  bytes: number;
  updatedAt: string;
}

export function pausedCleanupPlans(receipts: Receipt[]) {
  return new Set(receipts.filter(receipt => receipt.status === 'partial').map(receipt => receipt.planId));
}

export interface DriveDetail {
  drive: Drive;
  current: Snapshot | null;
  history: Snapshot[];
  items: Item[];
  evidence: Evidence[];
  decisions: Decision[];
  questions: Question[];
  children: Child[];
  receipts: Receipt[];
  plans: Plan[];
}

export type StorageChatMessage = ChatMessage & { a2ui?: A2uiMessage[]; questionIds: string[] };

function parseStorageChat(raw: unknown) {
  const chat = parseChat(raw);
  const source = raw as {
    checkpoint?: { messageCount?: number } | null;
    messages?: { a2ui?: A2uiMessage[]; questionIds?: string[] }[];
  } | null;
  const original = source?.messages;
  return {
    ...chat,
    hasEarlier: (source?.checkpoint?.messageCount ?? 0) > 0,
    messages: chat.messages.map((m, index): StorageChatMessage => {
      const message = original?.[index];
      return {
        ...m,
        a2ui: Array.isArray(message?.a2ui) ? message.a2ui : undefined,
        questionIds: Array.isArray(message?.questionIds) ? message.questionIds : [],
      };
    }),
  };
}

export const drivePath = (id: string) => `/incident/drives/${encodeURIComponent(id)}`;
export const chatPath = (id: string) => `/incident/chat/${encodeURIComponent(id)}`;
const directStorageUrl = (settings: Settings, path: string) => backendUrl(settings, `/api/storage${path}`);
const storageReadUrl = (path: string) => storageRelayUrl(path);

async function request(
  url: string,
  body?: unknown,
  unavailableMessage?: string,
  useRelay = false
): Promise<unknown> {
  try {
    const options: RequestInit | undefined = body === undefined
      ? useRelay
        ? { headers: {}, credentials: 'same-origin' as const, redirect: 'error' as const }
        : undefined
      : {
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
          body: JSON.stringify(body),
        };
    return await ApiProxy.request(
      url,
      options,
      false,
      !useRelay
    );
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 401)
      throw new Error('Sign in with a human operator token to access storage incidents.');
    if (status === 403) throw new Error('Storage operator permission required.');
    if (unavailableMessage) throw new Error(unavailableMessage);
    throw error;
  }
}

const relayRequest = (url: string, _body?: unknown, unavailableMessage?: string) =>
  request(url, undefined, unavailableMessage, true);

export function postStorage<T>(settings: Settings, path: string, body: unknown): Promise<T> {
  return request(directStorageUrl(settings, path), body) as Promise<T>;
}

export function useStorageIncident(settings: Settings) {
  return useLoaded(
    storageReadUrl('/incident'),
    raw => raw as StorageIncident,
    () => 10000,
    relayRequest
  );
}

export async function loadStorageTranscriptBefore(settings: Settings, id: string, before: string) {
  const query = new URLSearchParams({ before, limit: '24' });
  const unavailableMessage =
    'Earlier messages could not be loaded. Select Load earlier messages to try again.';
  const raw = await relayRequest(
    storageReadUrl(`${chatPath(id)}/transcript?${query}`),
    undefined,
    unavailableMessage
  );
  const page = raw as { messages?: unknown[]; nextBefore?: string | null } | null;
  const chat = parseStorageChat(raw);
  if (
    chat.id !== id ||
    !Array.isArray(page?.messages) ||
    chat.messages.some(m => !m.id || m.id === before) ||
    (page.nextBefore !== null &&
      page.nextBefore !== undefined &&
      page.nextBefore !== chat.messages[0]?.id)
  ) {
    throw new Error(unavailableMessage);
  }
  return { messages: chat.messages, hasMore: !!page.nextBefore };
}

export function useStorageDrive(settings: Settings, id?: string) {
  return useLoaded(
    id ? storageReadUrl(drivePath(id)) : '',
    raw => raw as DriveDetail,
    data => {
      if (!data) return 10000;
      const paused = pausedCleanupPlans(data.receipts);
      return data.receipts.some(receipt => receipt.status === 'queued' && !paused.has(receipt.planId))
        ? 2500
        : 10000;
    },
    relayRequest
  );
}

export function useStorageChat(settings: Settings, id?: string) {
  return useLoaded(
    id ? storageReadUrl(chatPath(id)) : '',
    parseStorageChat,
    () => 5000,
    relayRequest
  );
}

export function useStorageNotificationDevice(settings: Settings, id: string) {
  return useLoaded(
    directStorageUrl(settings, `/incident/notifications/${encodeURIComponent(id)}`),
    raw => raw as { subscriptionId: string; enabled: boolean },
    () => 10000,
    request
  );
}
