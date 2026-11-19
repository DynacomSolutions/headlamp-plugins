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
  model: string;
  diagnosisId?: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export const DEFAULT_TITLE = 'New chat';

/**
 * Chats, capped at `max`. With a data directory each chat is one JSON file,
 * `<dir>/chats/<id>.json`, written by atomic rename. Without one they live in
 * memory only. A turn that a restart interrupted is marked failed on load.
 */
export class ChatStore {
  private readonly chats = new Map<string, Chat>();
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly max: number,
  ) {
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

  create(fields: { model: string; diagnosisId?: string }): Chat {
    const now = new Date().toISOString();
    const chat: Chat = { id: randomUUID(), title: DEFAULT_TITLE, model: fields.model, diagnosisId: fields.diagnosisId, createdAt: now, updatedAt: now, messages: [] };
    this.chats.set(chat.id, chat);
    this.save(chat);
    this.prune();
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

  /** Drops the oldest chats beyond the cap. A chat with a running turn stays. */
  private prune(): void {
    if (this.chats.size <= this.max) return;
    for (const chat of [...this.chats.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
      if (this.chats.size <= this.max) break;
      if (!this.running(chat)) this.delete(chat.id);
    }
  }
}
