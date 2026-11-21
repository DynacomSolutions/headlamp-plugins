/*
 * The icon of an app, read from the app itself. The route that serves a check names a Service (see
 * `Backend` in routes.ts). The widget asks that Service for its start page through the Kubernetes Service
 * proxy (the same request path as the metrics calls), reads the `<link rel="icon">` tags and fetches the best
 * icon through the proxy again. The proxy rewrites the links of the page, so every icon address stays inside
 * the cluster API. The widget never loads an icon from an external host: an absolute `http(s)` address is
 * dropped, and a group without an icon gets an initial badge.
 *
 * The icon bytes are shown from an object URL in an `<img>`, never as inline markup, so an SVG cannot run
 * a script. The page and the icon are size-capped, a Service is asked once per page session (a failure is
 * asked again after `FAILURE_RETRY_MS`), and only `ICON_CONCURRENCY` requests run at the same time.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import type { Backend } from './routes';

/** The most bytes of the start page that are read. The icon links are in the head. */
export const PAGE_MAX_BYTES = 64 * 1024;
/** The largest icon that is accepted, in bytes. */
export const ICON_MAX_BYTES = 128 * 1024;
/** How long a Service with no icon is left alone before the next try. */
export const FAILURE_RETRY_MS = 5 * 60_000;
/** How many Services are asked at the same time. */
export const ICON_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 8_000;
/** The places a browser looks for an icon when a page names none. */
export const FALLBACK_ICONS = ['favicon.svg', 'favicon.png', 'favicon.ico'];

const IMAGE_TYPES = [
  'image/svg+xml',
  'image/png',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/** The Service proxy path of a backend, with a trailing slash. */
export function proxyBase(b: Backend): string {
  const svc = `${b.scheme ? `${b.scheme}:` : ''}${b.name}${b.port ? `:${b.port}` : ''}`;
  return `/api/v1/namespaces/${encodeURIComponent(b.namespace)}/services/${svc}/proxy/`;
}

/** A stable key of a backend, for the cache and the effect dependencies. */
export function backendKey(b: Backend): string {
  return proxyBase(b);
}

export interface IconLink {
  href: string;
  /** Lower is better: SVG, then PNG, then ICO, then a touch icon. */
  rank: number;
  /** The larger side of the declared size, 0 when not declared. */
  size: number;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
};
const decodeEntities = (s: string): string =>
  s.replace(/&(?:amp|quot|#39|apos|lt|gt);/g, e => ENTITIES[e]);

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return decodeEntities((m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim());
}

/** The icon links of a start page, best first. A mask icon (one colour) and an empty `data:,` are left out. */
export function iconLinks(html: string): IconLink[] {
  const out: IconLink[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attr(tag, 'rel').toLowerCase().split(/\s+/);
    const touch = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
    if (!rel.includes('icon') && !touch) continue;
    const href = attr(tag, 'href');
    if (!href || href === 'data:,') continue;
    const type = attr(tag, 'type').toLowerCase();
    const path = href.split(/[?#]/)[0].toLowerCase();
    const svg =
      type === 'image/svg+xml' || path.endsWith('.svg') || href.startsWith('data:image/svg+xml');
    const png = type === 'image/png' || path.endsWith('.png') || href.startsWith('data:image/png');
    const rank = touch ? 3 : svg ? 0 : png ? 1 : 2;
    const sizes = /(\d+)x(\d+)/i.exec(attr(tag, 'sizes'));
    out.push({ href, rank, size: sizes ? Math.max(Number(sizes[1]), Number(sizes[2])) : 0 });
  }
  // Within a rank, the smallest icon that is at least 32 px, else the largest. An unknown size comes last.
  const fit = (l: IconLink): number => (l.size === 0 ? 1e6 : l.size >= 32 ? l.size : 1e3 - l.size);
  return out.sort((a, b) => a.rank - b.rank || fit(a) - fit(b));
}

/**
 * The address to fetch for an icon link, or undefined when the link must not load. A `data:` image is kept
 * as it is. An address on the Kubernetes API (`/api/v1/...`) is kept. Any other absolute path or relative
 * path is read against the Service proxy path of the app. A full `http(s)` address, a scheme-relative
 * address and a path with `..` are dropped, so the widget never calls an external site.
 */
export function resolveIconHref(href: string, base: string): string | undefined {
  const h = href.trim();
  if (/^data:image\/(svg\+xml|png)[;,]/i.test(h)) return h;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return undefined;
  if (h.split(/[?#]/)[0].split('/').includes('..')) return undefined;
  if (h.startsWith('/api/v1/')) return h;
  const root = base.endsWith('/') ? base : `${base}/`;
  return `${root}${h.replace(/^\.?\//, '').replace(/^\/+/, '')}`;
}

/** The media type of a Content-Type header, in lower case without parameters. */
export const mediaType = (header: string | null | undefined): string =>
  (header ?? '').split(';')[0].trim().toLowerCase();

async function readCapped(res: Response, max: number, truncate: boolean): Promise<Uint8Array> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > max) {
      if (truncate) return buf.slice(0, max);
      throw new Error('too large');
    }
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      if (!truncate) throw new Error('too large');
      break;
    }
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return all.slice(0, Math.min(total, max));
}

async function get(url: string, accept: string, signal: AbortSignal): Promise<Response> {
  // An app that redirects (to a login page, for example) sends the browser to an address of the API server
  // or to an external host. `manual` stops that redirect, so it counts as "no icon". An app answer of 401
  // must not log the user out of Headlamp.
  const res: Response = await ApiProxy.request(url, {
    signal,
    isJSON: false,
    redirect: 'manual',
    autoLogoutOnAuthError: false,
    headers: { Accept: accept },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await run(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

function dataUrlBlob(href: string): Blob | undefined {
  const m = /^data:(image\/(?:svg\+xml|png))(;base64)?,([\s\S]*)$/i.exec(href);
  if (!m) return undefined;
  try {
    const body = m[2] ? atob(decodeURIComponent(m[3])) : decodeURIComponent(m[3]);
    if (body.length > ICON_MAX_BYTES) return undefined;
    const bytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i);
    return new Blob([bytes], { type: m[1].toLowerCase() });
  } catch {
    return undefined;
  }
}

async function fetchIcon(url: string): Promise<Blob | null> {
  if (url.startsWith('data:')) return dataUrlBlob(url) ?? null;
  try {
    return await withTimeout(async signal => {
      const res = await get(url, IMAGE_TYPES.join(', '), signal);
      const type = mediaType(res.headers.get('content-type'));
      if (!IMAGE_TYPES.includes(type)) return null;
      return new Blob([await readCapped(res, ICON_MAX_BYTES, false)], { type });
    });
  } catch {
    return null;
  }
}

/** The best icon of one Service as a Blob, or null. At most three of its icon links are tried. */
export async function loadBackendIcon(b: Backend): Promise<Blob | null> {
  const base = proxyBase(b);
  let html: string;
  try {
    html = await withTimeout(async signal => {
      const res = await get(base, 'text/html', signal);
      return new TextDecoder().decode(await readCapped(res, PAGE_MAX_BYTES, true));
    });
  } catch {
    return null;
  }
  for (const link of iconLinks(html).slice(0, 3)) {
    const url = resolveIconHref(link.href, base);
    if (!url) continue;
    const blob = await fetchIcon(url);
    if (blob) return blob;
  }
  // The page names no icon that loads: the browser default places.
  for (const name of FALLBACK_ICONS) {
    const blob = await fetchIcon(`${base}${name}`);
    if (blob) return blob;
  }
  return null;
}

interface Entry {
  at: number;
  url: string | null;
}

const done = new Map<string, Entry>();
const pending = new Map<string, Promise<string | null>>();
let active = 0;
const waiting: (() => void)[] = [];

async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= ICON_CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve));
  active += 1;
  try {
    return await run();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/**
 * The object URL of the icon of a Service, or null when it has none. One request chain per Service for
 * the page session. The object URL lives as long as the page: a few small icons, shared by every widget.
 */
export function backendIconUrl(b: Backend, now: number = Date.now()): Promise<string | null> {
  const key = backendKey(b);
  const known = done.get(key);
  if (known && (known.url !== null || now - known.at < FAILURE_RETRY_MS))
    return Promise.resolve(known.url);
  const running = pending.get(key);
  if (running) return running;
  const p = slot(() => loadBackendIcon(b))
    .then(blob => (blob ? URL.createObjectURL(blob) : null))
    .catch(() => null)
    .then(url => {
      done.set(key, { at: Date.now(), url });
      pending.delete(key);
      return url;
    });
  pending.set(key, p);
  return p;
}

/** For tests: forgets every cached icon. */
export function clearIconCache(): void {
  for (const e of done.values()) if (e.url) URL.revokeObjectURL(e.url);
  done.clear();
  pending.clear();
}
