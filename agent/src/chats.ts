import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from './agent/model.js';

export interface ChatStep {
  id: string;
  tool: string;
  reason: string;
  ok?: boolean;
  summary?: string;
  status: 'running' | 'done';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  status: 'done' | 'running' | 'failed' | 'cancelled';
  error?: string;
  model?: string;
  steps: ChatStep[];
  /** What the model saw and said in this turn, tool calls and results included. Never sent to clients. */
  trace?: Message[];
}

export interface Chat {
  id: string;
  title: string;
  /** The model of the last answer, or the one the operator picked. */
  model: string;
  /**
   * True when the operator picked the model: it is used as it is, with no fallback.
   * False means the default order applies and `model` is only the last one that answered.
   * Absent on chats saved before the default order existed: see `ChatService`.
   */
  modelPinned?: boolean;
  /** The first linked incident. Kept for clients that know one incident only. */
  diagnosisId?: string;
  /** Every linked incident, in the order the user chose. A chat about one incident has one entry. */
  diagnosisIds?: string[];
  /** The alert name of the group the operator chose, when the chat is about a group of incidents. */
  groupName?: string;
  /** The rest of a large group: incidents that the system prompt lists in one short line each. */
  summaryIds?: string[];
  /** How many older incidents of a very large group the client left out of both lists. */
  groupOmitted?: number;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

/** The incidents a chat is linked to. Reads old files that hold `diagnosisId` only. */
export function chatDiagnosisIds(chat: Pick<Chat, 'diagnosisId' | 'diagnosisIds'>): string[] {
  if (chat.diagnosisIds?.length) return chat.diagnosisIds;
  return chat.diagnosisId ? [chat.diagnosisId] : [];
}

export const DEFAULT_TITLE = 'New chat';

/**
 * Chats, kept until a user deletes one: no count limit drops them. With a data directory each chat is one JSON file,
 * `<dir>/chats/<id>.json`, written by atomic rename. Without one they live in
 * memory only. A turn that a restart interrupted is marked failed on load.
 */
export class ChatStore {
  private readonly chats = new Map<string, Chat>();
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = dataDir ? join(dataDir, 'chats') : '';
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const chat = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as Chat;
        if (!chat?.id || !Array.isArray(chat.messages)) continue;
        if (this.recover(chat)) this.writeFile(chat);
        this.chats.set(chat.id, chat);
      } catch {
        // A half-written or foreign file. Skip it.
      }
    }
  }

  /** Marks the running turn of a loaded chat as failed. True when something changed. */
  private recover(chat: Chat): boolean {
    let changed = false;
    for (const m of chat.messages) {
      if (m.status !== 'running') continue;
      m.status = 'failed';
      m.error = 'interrupted by restart';
      for (const s of m.steps) {
        if (s.status === 'running') {
          s.status = 'done';
          s.ok = false;
          s.summary = 'interrupted by restart';
        }
      }
      changed = true;
    }
    return changed;
  }

  private file(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  private writeFile(chat: Chat): void {
    if (!this.dir) return;
    const target = this.file(chat.id);
    const tmp = `${target}.tmp-${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(chat));
    renameSync(tmp, target);
  }

  create(fields: { model: string; modelPinned?: boolean; diagnosisId?: string; diagnosisIds?: string[]; groupName?: string; summaryIds?: string[]; groupOmitted?: number }): Chat {
    const now = new Date().toISOString();
    const ids = [...new Set([...(fields.diagnosisIds ?? []), ...(fields.diagnosisId ? [fields.diagnosisId] : [])])];
    const chat: Chat = {
      id: randomUUID(),
      title: DEFAULT_TITLE,
      model: fields.model,
      ...(fields.modelPinned !== undefined ? { modelPinned: fields.modelPinned } : {}),
      ...(ids.length ? { diagnosisId: ids[0], diagnosisIds: ids } : {}),
      ...(fields.groupName ? { groupName: fields.groupName } : {}),
      ...(fields.summaryIds?.length ? { summaryIds: [...new Set(fields.summaryIds)].filter(id => !ids.includes(id)) } : {}),
      ...(fields.groupOmitted ? { groupOmitted: fields.groupOmitted } : {}),
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.chats.set(chat.id, chat);
    this.save(chat);
    return chat;
  }

  get(id: string): Chat | undefined {
    return this.chats.get(id);
  }

  /** All chats, newest activity first. */
  list(): Chat[] {
    return [...this.chats.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Writes the chat. `touch` sets updatedAt to now. */
  save(chat: Chat, touch = true): void {
    if (!this.chats.has(chat.id)) return;
    if (touch) chat.updatedAt = new Date().toISOString();
    this.writeFile(chat);
  }

  delete(id: string): boolean {
    if (!this.chats.delete(id)) return false;
    if (this.dir && existsSync(this.file(id))) {
      try {
        unlinkSync(this.file(id));
      } catch {
        // Already gone.
      }
    }
    return true;
  }

  running(chat: Chat): boolean {
    return chat.messages.some(m => m.status === 'running');
  }
}
