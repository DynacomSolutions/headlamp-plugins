/*
 * Row icons. A browser `<img>` cannot send the Headlamp login, so an icon is fetched through the
 * same request path as the panel JSON (the Kubernetes service proxy for a `service` source,
 * `fetch` with the cookies for a `url` source) and shown from an object URL. The answer must be
 * SVG or PNG and at most `ICON_MAX_BYTES`. The bytes are cached for the page session, once per
 * source and path, so a refresh or ten widgets never fetch an icon again. Object URLs are counted
 * by use and revoked when the last user lets go. A failed fetch gives null and is tried again
 * only after `FAILURE_RETRY_MS`. Nothing is logged.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { withTimeout } from './data';
import { iconUrl, PanelSource, sourceKey } from './sources';

/** The largest icon that is accepted, in bytes. */
export const ICON_MAX_BYTES = 64 * 1024;
/** How long a failed icon is left alone before the next try. */
export const FAILURE_RETRY_MS = 5 * 60_000;

const ACCEPTED = ['image/svg+xml', 'image/png'];

/** The media type of a Content-Type header, in lower case without parameters. */
export const mediaType = (header: string | null | undefined): string =>
  (header ?? '').split(';')[0].trim().toLowerCase();

interface Loaded {
  blob: Blob | null;
  at: number;
}

interface Use {
  count: number;
  url: string;
}

const loads = new Map<string, Promise<Loaded>>();
const uses = new Map<string, Use>();

const cacheKey = (source: PanelSource, path: string): string => `${sourceKey(source)} ${path}`;

/** The body of a response, read up to the size cap. Throws when it is larger. */
async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > ICON_MAX_BYTES) throw new Error('too large');
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > ICON_MAX_BYTES) throw new Error('too large');
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ICON_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function requestIcon(source: PanelSource, url: string, signal: AbortSignal): Promise<Blob> {
  const accept = ACCEPTED.join(', ');
  const res: Response =
    source.kind === 'service'
      ? await ApiProxy.request(url, { signal, isJSON: false, headers: { Accept: accept } })
      : await fetch(url, { credentials: 'include', headers: { Accept: accept }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = mediaType(res.headers.get('content-type'));
  if (!ACCEPTED.includes(type)) throw new Error('not an icon');
  const bytes = await readCapped(res);
  return new Blob([bytes], { type });
}

/** The icon bytes as a Blob, or null on any failure. One request per source and path while it is cached. */
export async function loadIcon(
  source: PanelSource,
  path: string,
  now: () => number = Date.now
): Promise<Blob | null> {
  const key = cacheKey(source, path);
  const known = loads.get(key);
  if (known) {
    const v = await known;
    // A success lasts for the page session. A failure is reused for a while.
    if (v.blob !== null || now() - v.at < FAILURE_RETRY_MS) return v.blob;
    if (loads.get(key) === known) loads.delete(key);
  }
  let entry = loads.get(key);
  if (!entry) {
    const url = iconUrl(source, path);
    entry = withTimeout(signal => requestIcon(source, url, signal)).then(
      (blob): Loaded => ({ blob, at: now() }),
      (): Loaded => ({ blob: null, at: now() })
    );
    loads.set(key, entry);
  }
  return (await entry).blob;
}

/**
 * Takes one use of an icon and gives its object URL, or null when it cannot be shown. Every
 * successful call must be paired with one `releaseIcon`.
 */
export async function acquireIcon(source: PanelSource, path: string): Promise<string | null> {
  const blob = await loadIcon(source, path);
  if (blob === null) return null;
  const key = cacheKey(source, path);
  const use = uses.get(key);
  if (use) {
    use.count += 1;
    return use.url;
  }
  const url = URL.createObjectURL(blob);
  uses.set(key, { count: 1, url });
  return url;
}

/** Gives one use back. The object URL is revoked with the last use. */
export function releaseIcon(source: PanelSource, path: string): void {
  const key = cacheKey(source, path);
  const use = uses.get(key);
  if (!use) return;
  use.count -= 1;
  if (use.count <= 0) {
    URL.revokeObjectURL(use.url);
    uses.delete(key);
  }
}

/** For tests: forgets every cached icon and revokes every object URL. */
export function clearIconCache(): void {
  for (const use of uses.values()) URL.revokeObjectURL(use.url);
  uses.clear();
  loads.clear();
}
