import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { applyResultSchema, scanSchema, type ApplyResult, type Scan } from './types.js';

export const SCAN_TIMEOUT_MS = 10 * 60_000;
export const APPLY_TIMEOUT_MS = 60_000;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

export interface Scanner {
  scan(node: string): Promise<Scan>;
  apply(node: string, planId: string, approvalId: string, itemIds: string[]): Promise<ApplyResult>;
}

/** Bound the full request and response, including a scan that takes minutes to send headers. */
export function requestJson(
  url: URL,
  options: { token: string; timeoutMs: number; body?: unknown; ca?: string; limit?: number },
): Promise<{ status: number; data?: unknown }> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(url, {
      method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(options.timeoutMs),
      ca: options.ca,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${options.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
      },
    }, res => {
      const status = res.statusCode ?? 500;
      res.on('error', reject);
      if (status < 200 || status >= 300) {
        res.destroy();
        resolve({ status });
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > (options.limit ?? MAX_SCAN_BYTES)) {
          reject(new Error('Response exceeds size limit'));
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          resolve({ status, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

export class HttpScanner implements Scanner {
  constructor(private readonly urls: ReadonlyMap<string, URL>, private readonly readToken: () => string) {}

  private async call<T>(node: string, path: string, schema: z.ZodType<T>, timeoutMs: number, body?: unknown): Promise<T> {
    const base = this.urls.get(node);
    const token = this.readToken();
    if (!base || !token) throw new Error('Scanner is not configured');
    const response = await requestJson(new URL(path, base), { token, body, timeoutMs });
    if (response.status !== 200) throw new Error('Scanner did not complete the request');
    return schema.parse(response.data);
  }

  async scan(node: string): Promise<Scan> {
    const scan = await this.call(node, '/v1/scan', scanSchema, SCAN_TIMEOUT_MS);
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
