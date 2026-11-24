import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { applyResultSchema, partialScanSchema, scanSchema, type ApplyResult, type ScannerScan } from './types.js';

export const SCAN_TIMEOUT_MS = 960_000;
export const APPLY_TIMEOUT_MS = 60_000;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

export class RequestDeadlineError extends Error {
  constructor() {
    super('Scanner request deadline exceeded');
  }
}

export interface Scanner {
  scan(node: string): Promise<ScannerScan>;
  apply(node: string, planId: string, approvalId: string, itemIds: string[]): Promise<ApplyResult>;
}

/** Bound the full request and response, including a scan that takes minutes to send headers. */
export function requestJson(
  url: URL,
  options: { token: string; timeoutMs: number; body?: unknown; ca?: string; limit?: number },
): Promise<{ status: number; data?: unknown }> {
  const deadline = performance.now() + options.timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  return new Promise<{ status: number; data?: unknown }>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const limit = options.limit ?? MAX_SCAN_BYTES;
    const expire = () => {
      const error = new RequestDeadlineError();
      reject(error);
      req.destroy(error);
    };
    const req = request(url, {
      method: body === undefined ? 'GET' : 'POST',
      ca: options.ca,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${options.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
      },
    }, res => {
      const status = res.statusCode ?? 500;
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Response stream was interrupted')));
      if (performance.now() >= deadline) return expire();
      if (status < 200 || status >= 300) {
        resolve({ status });
        res.destroy();
        return;
      }
      const tooLarge = () => {
        reject(new Error('Response exceeds size limit'));
        res.destroy();
      };
      if (Number(res.headers['content-length']) > limit) {
        tooLarge();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          tooLarge();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (performance.now() >= deadline) return expire();
        try {
          const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (performance.now() >= deadline) return expire();
          resolve({ status, data });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    timer = setTimeout(expire, Math.max(0, deadline - performance.now()));
    timer.unref();
    req.end(body);
  }).finally(() => clearTimeout(timer));
}

export class HttpScanner implements Scanner {
  constructor(
    private readonly urls: ReadonlyMap<string, URL>,
    private readonly readToken: () => string,
    private readonly partialNodes: ReadonlySet<string> = new Set(),
  ) {}

  private async call<T>(node: string, path: string, schema: z.ZodType<T>, timeoutMs: number, body?: unknown): Promise<T> {
    const base = this.urls.get(node);
    const token = this.readToken();
    if (!base || !token) throw new Error('Scanner is not configured');
    const response = await requestJson(new URL(path, base), { token, body, timeoutMs });
    if (response.status !== 200) throw new Error('Scanner did not complete the request');
    return schema.parse(response.data);
  }

  async scan(node: string): Promise<ScannerScan> {
    const scan = this.partialNodes.has(node)
      ? await this.call(node, '/v2/scan', partialScanSchema, SCAN_TIMEOUT_MS)
      : await this.call(node, '/v1/scan', scanSchema, SCAN_TIMEOUT_MS);
    if (scan.node !== node) throw new Error('Scan node did not match its configured identity');
    return scan;
  }

  async apply(node: string, planId: string, approvalId: string, itemIds: string[]): Promise<ApplyResult> {
    const result = await this.call(node, '/v1/apply', applyResultSchema, APPLY_TIMEOUT_MS, { planId, approvalId, itemIds });
    if (result.node !== node || result.planId !== planId || result.approvalId !== approvalId) throw new Error('Apply response did not match its request');
    const expected = new Set(itemIds);
    if (result.receipts.some(receipt => !expected.has(receipt.itemId))) throw new Error('Apply returned an item outside the approved subset');
    return result;
  }
}
