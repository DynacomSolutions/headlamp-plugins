/**
 * The T3 Code orchestration protocol, version 2, as far as the agent uses it.
 * Every frame and payload that the client sends is built here, so a protocol
 * change shows up in one file and in the contract test (test/t3-contract.test.ts).
 */

/** orchestrationProtocolVersion of the T3 server. Other values get 400 (HTTP) or 426 (WebSocket). */
export const PROTOCOL = '2';
export const PROTOCOL_HEADER = 'x-t3-orchestration-protocol';
/** Query parameter of the WebSocket upgrade. Without it the server answers 426. */
export const CLIENT_CAPABILITIES = 'settingsSecretReferences';

export const TICKET_PATH = '/api/auth/websocket-ticket/rpc';
export const THREAD_PATH = (threadId: string): string => `/api/orchestration/threads/${encodeURIComponent(threadId)}`;

export const RPC_LAUNCH_THREAD = 'orchestration.launchThread';
export const RPC_DISPATCH_COMMAND = 'orchestration.dispatchCommand';

export interface ModelSelection {
  instanceId: string;
  model: string;
  /** Provider options such as `{ id: "effort", value: "low" }`. */
  options?: Array<{ id: string; value: string | number | boolean }>;
}

export type Frame = Record<string, unknown>;

export const requestFrame = (id: string, tag: string, payload: unknown): Frame => ({ _tag: 'Request', id, tag, payload, headers: [] });
export const pongFrame = (): Frame => ({ _tag: 'Pong' });

export interface LaunchThreadInput {
  commandId: string;
  threadId: string;
  messageId: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  text: string;
}

/**
 * Owner rules: full-access runtime, default interaction mode, the project root.
 * `generateTitle` is false so the server keeps the title given here.
 */
export function launchThreadPayload(i: LaunchThreadInput): Frame {
  return {
    commandId: i.commandId,
    creationSource: 'mcp',
    threadId: i.threadId,
    projectId: i.projectId,
    title: i.title,
    generateTitle: false,
    modelSelection: i.modelSelection,
    runtimeMode: 'full-access',
    interactionMode: 'default',
    workspaceStrategy: { type: 'root' },
    initialMessage: { messageId: i.messageId, text: i.text, attachments: [] },
  };
}

export interface MessageInput {
  commandId: string;
  threadId: string;
  messageId: string;
  text: string;
  /** `start_immediately` for an idle thread, `queue_after_active` while a run is active. */
  mode?: 'start_immediately' | 'queue_after_active';
}

/** The payload of dispatchCommand is the bare command object, without a wrapper. */
export function messageDispatchPayload(i: MessageInput): Frame {
  return {
    commandId: i.commandId,
    type: 'message.dispatch',
    createdBy: 'user',
    creationSource: 'mcp',
    threadId: i.threadId,
    messageId: i.messageId,
    text: i.text,
    attachments: [],
    dispatchMode: { type: i.mode ?? 'start_immediately' },
  };
}

/* ---------- What the server sends back (only the fields the agent reads) ---------- */

export const FINAL_RUN = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
export const ACTIVE_RUN = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);

export interface ThreadProjection {
  thread: { id: string; title?: string; deletedAt?: string | null; archivedAt?: string | null };
  runs: Array<{ id: string; ordinal?: number; status: string; requestedAt?: string; startedAt?: string | null; completedAt?: string | null }>;
  messages: Array<{ id: string; role: string; text: string; streaming?: boolean; createdAt?: string; runId?: string | null }>;
  turnItems: Array<Record<string, unknown>>;
  runtimeRequests: Array<{ status?: string; kind?: string }>;
}

export interface ThreadSnapshot {
  snapshotSequence?: number;
  projection: ThreadProjection;
}
