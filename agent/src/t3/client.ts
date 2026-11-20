import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { maskText } from '../mask.js';
import {
  CLIENT_CAPABILITIES,
  launchThreadPayload,
  messageDispatchPayload,
  pongFrame,
  PROTOCOL,
  PROTOCOL_HEADER,
  requestFrame,
  RPC_DISPATCH_COMMAND,
  RPC_LAUNCH_THREAD,
  THREAD_PATH,
  TICKET_PATH,
  type Frame,
  type LaunchThreadInput,
  type MessageInput,
  type ThreadProjection,
  type ThreadSnapshot,
} from './protocol.js';

/** A failed T3 call. `status` is the HTTP status when there was one. `transient` is true when a retry may help. */
export class T3Error extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly transient = true,
  ) {
    super(message);
  }
}

export interface T3Options {
  /** Base URL of the T3 server, for example `http://t3.example.com:3773`. */
  url: string;
  /** Returns the bearer token. Called for every request, so a rotated token file needs no restart. */
  readToken: () => string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** Creates ids for requests, commands, threads and messages. Tests pass a counter. */
  newId?: () => string;
  callTimeoutMs?: number;
}

/** Reads a token file: plain text, or the JSON that `t3 auth session issue --json` prints. */
export function tokenFromFile(file: string): () => string {
  return () => {
    const raw = readFileSync(file, 'utf8').trim();
    if (!raw) throw new T3Error('The T3 token file is empty', undefined, false);
    if (raw.startsWith('{')) {
      try {
        const token = (JSON.parse(raw) as { token?: unknown }).token;
        if (typeof token === 'string' && token) return token;
      } catch {
        // Not JSON after all: use the text as it is.
      }
    }
    return raw;
  };
}

export interface RpcConnection {
  call(tag: string, payload: unknown, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

/** A minimal client for the T3 server: HTTP reads and WebSocket (Effect RPC) commands. No dependencies. */
export class T3Client {
  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly WS: typeof WebSocket;
  readonly newId: () => string;
  private readonly callTimeoutMs: number;

  constructor(private readonly options: T3Options) {
    this.url = options.url.replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.WS = options.WebSocket ?? globalThis.WebSocket;
    this.newId = options.newId ?? randomUUID;
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
  }

  private token(): string {
    try {
      return this.options.readToken();
    } catch (error) {
      if (error instanceof T3Error) throw error;
      throw new T3Error(`Cannot read the T3 token file: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
    }
  }

  private async http(path: string, init: RequestInit & { orchestration?: boolean } = {}): Promise<unknown> {
    const { orchestration, ...rest } = init;
    let res: Response;
    try {
      res = await this.fetchFn(this.url + path, {
        ...rest,
        headers: { authorization: `Bearer ${this.token()}`, ...(orchestration ? { [PROTOCOL_HEADER]: PROTOCOL } : {}) },
        signal: AbortSignal.timeout(this.callTimeoutMs),
      });
    } catch (error) {
      if (error instanceof T3Error) throw error;
      throw new T3Error(`T3 is not reachable: ${maskText(error instanceof Error ? error.message : String(error))}`);
    }
    const text = await res.text();
    if (!res.ok) {
      const body = maskText(text.slice(0, 300));
      throw new T3Error(`T3 answered ${res.status} for ${path.split('?')[0].replace(/[0-9a-f-]{36}/g, ':id')}: ${body}`, res.status, res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 429);
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new T3Error(`T3 sent a body that is not JSON for ${path.split('?')[0]}`, res.status);
    }
  }

  /** The thread projection: runs, messages and turn items. Needs the protocol header. */
  async thread(threadId: string): Promise<ThreadSnapshot> {
    const body = (await this.http(THREAD_PATH(threadId), { orchestration: true })) as ThreadSnapshot | null;
    const p = body?.projection as Partial<ThreadProjection> | undefined;
    if (!p || typeof p !== 'object' || !p.thread || !Array.isArray(p.runs)) throw new T3Error('T3 sent a thread projection in an unknown shape');
    return {
      snapshotSequence: body?.snapshotSequence,
      projection: { thread: p.thread, runs: p.runs, messages: p.messages ?? [], turnItems: p.turnItems ?? [], runtimeRequests: p.runtimeRequests ?? [] },
    };
  }

  /** Opens the WebSocket. A ticket lives 300 s and is fetched fresh for every connection. */
  async rpc(): Promise<RpcConnection> {
    const ticketBody = (await this.http(TICKET_PATH, { method: 'POST' })) as { ticket?: unknown } | null;
    if (!ticketBody || typeof ticketBody.ticket !== 'string') throw new T3Error('T3 sent no WebSocket ticket');
    const wsUrl = `${this.url.replace(/^http/, 'ws')}/ws?${new URLSearchParams({ wsTicket: ticketBody.ticket, orchestrationProtocol: PROTOCOL, clientCapabilities: CLIENT_CAPABILITIES })}`;
    const ws = new this.WS(wsUrl);
    const pending = new Map<string, (m: Frame) => void>();
    let seq = 0;
    // The handlers are set before the socket opens: the server's first Ping can arrive with the upgrade answer.
    ws.onmessage = event => {
      let m: Frame;
      try {
        m = JSON.parse(String(event.data)) as Frame;
      } catch {
        return;
      }
      if (m._tag === 'Ping') {
        ws.send(JSON.stringify(pongFrame()));
        return;
      }
      if (typeof m.requestId === 'string') pending.get(m.requestId)?.(m);
    };
    ws.onclose = () => {
      for (const settle of pending.values()) settle({ _tag: 'Exit', exit: { _tag: 'Failure', cause: 'socket closed' } });
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new T3Error('The T3 WebSocket did not open in time'));
      }, 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new T3Error('The T3 WebSocket could not connect'));
      };
    });
    const timeout = this.callTimeoutMs;
    return {
      close: () => ws.close(),
      call(tag, payload, timeoutMs = timeout) {
        const id = String(++seq);
        return new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new T3Error(`T3 did not answer ${tag} in time`));
          }, timeoutMs);
          pending.set(id, m => {
            if (m._tag !== 'Exit') return;
            clearTimeout(timer);
            pending.delete(id);
            const exit = m.exit as { _tag?: string; value?: unknown; cause?: unknown };
            if (exit?._tag === 'Success') resolve(exit.value);
            // A schema mistake is a Die defect, not a typed error. It will not heal on retry.
            else reject(new T3Error(`${tag} failed: ${maskText(JSON.stringify(exit?.cause ?? null).slice(0, 500))}`, undefined, false));
          });
          ws.send(JSON.stringify(requestFrame(id, tag, payload)));
        });
      },
    };
  }

  private async withRpc<T>(fn: (c: RpcConnection) => Promise<T>): Promise<T> {
    const c = await this.rpc();
    try {
      return await fn(c);
    } finally {
      c.close();
    }
  }

  /** Starts a thread with its first message. Returns the thread id the server used. */
  async launchThread(input: Omit<LaunchThreadInput, 'commandId' | 'messageId'>): Promise<{ threadId: string }> {
    const commandId = this.newId();
    const messageId = this.newId();
    const out = (await this.withRpc(c => c.call(RPC_LAUNCH_THREAD, launchThreadPayload({ ...input, commandId, messageId })))) as { threadId?: unknown } | null;
    return { threadId: typeof out?.threadId === 'string' ? out.threadId : input.threadId };
  }

  /** Sends a message to a thread. Returns the message id. */
  async sendMessage(threadId: string, text: string, mode?: MessageInput['mode']): Promise<{ messageId: string }> {
    const commandId = this.newId();
    const messageId = this.newId();
    await this.withRpc(c => c.call(RPC_DISPATCH_COMMAND, messageDispatchPayload({ commandId, threadId, messageId, text, mode })));
    return { messageId };
  }
}
