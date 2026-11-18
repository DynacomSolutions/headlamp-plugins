/*
 * Loads a `file` icon through Headlamp's API proxy (it needs auth headers, so a bare image
 * href would fail) and returns a blob object URL. A loaded icon is cached per src for the
 * session; a failure is retried after RETRY_MS, so one bad request does not hide it for good.
 * Returns null until loaded, and 'failed' while the last request failed.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { useEffect, useState } from 'react';

export const ICON_RETRY_MS = 60_000;

const inflight = new Map<string, Promise<string | null>>();
const resolved = new Map<string, string | null>();
const failedAt = new Map<string, number>();

function load(src: string): Promise<string | null> {
  const done = resolved.get(src);
  if (typeof done === 'string') return Promise.resolve(done);
  let p = inflight.get(src);
  if (!p) {
    p = Promise.resolve(ApiProxy.request(src, { isJSON: false }))
      .then(res => (res as Response).blob())
      .then(blob => URL.createObjectURL(blob))
      .catch(() => null)
      .then(url => {
        inflight.delete(src);
        resolved.set(src, url);
        if (url === null) failedAt.set(src, Date.now());
        else failedAt.delete(src);
        return url;
      });
    inflight.set(src, p);
  }
  return p;
}

/** Forgets every cached icon. For tests. */
export function resetIconCache(): void {
  inflight.clear();
  resolved.clear();
  failedAt.clear();
}

export function useIconUrl(src: string | undefined): string | null | 'failed' {
  const [tick, bump] = useState(0);
  useEffect(() => {
    if (!src || typeof resolved.get(src) === 'string') return undefined;
    let live = true;
    const run = () => {
      load(src).then(() => live && bump(n => n + 1));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (resolved.has(src)) {
      // The last request failed: try again once the retry delay has passed.
      const wait = (failedAt.get(src) ?? 0) + ICON_RETRY_MS - Date.now();
      timer = setTimeout(run, Math.max(0, wait));
    } else {
      run();
    }
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [src, tick]);
  if (!src) return 'failed';
  if (!resolved.has(src)) return null;
  return resolved.get(src) ?? 'failed';
}
