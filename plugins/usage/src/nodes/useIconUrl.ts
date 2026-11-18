/*
 * Loads a `file` icon through Headlamp's API proxy (it needs auth headers, so a bare image
 * href would fail) and returns a blob object URL. Results are cached per src for the session.
 * Returns null until loaded, and 'failed' if the request fails.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { useEffect, useState } from 'react';

const cache = new Map<string, Promise<string | null>>();
const resolved = new Map<string, string | null>();

function load(src: string): Promise<string | null> {
  let p = cache.get(src);
  if (!p) {
    p = Promise.resolve(ApiProxy.request(src, { isJSON: false }))
      .then(res => (res as Response).blob())
      .then(blob => URL.createObjectURL(blob))
      .catch(() => null);
    cache.set(src, p);
    p.then(url => resolved.set(src, url));
  }
  return p;
}

export function useIconUrl(src: string | undefined): string | null | 'failed' {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!src || resolved.has(src)) return;
    let live = true;
    load(src).then(() => live && bump(n => n + 1));
    return () => {
      live = false;
    };
  }, [src]);
  if (!src) return 'failed';
  if (!resolved.has(src)) return null;
  return resolved.get(src) ?? 'failed';
}
