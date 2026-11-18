/** Minimal JSON Pointer (RFC 6901) helpers over plain JSON values. Updates never mutate. */

export function parsePointer(path: string): string[] {
  if (path === '' || path === '/') return [];
  const p = path.startsWith('/') ? path.slice(1) : path;
  return p.split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

export function getPointer(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const key of parsePointer(path)) {
    if (!isObj(cur)) return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(key)) return undefined;
      cur = cur[Number(key)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
      cur = cur[key];
    }
  }
  return cur;
}

/** Returns a copy of `data` with `value` at `path`; `undefined`/`null` deletes the key. */
export function setPointer(data: unknown, path: string, value: unknown): unknown {
  const keys = parsePointer(path);
  const remove = value === null || value === undefined;
  if (keys.length === 0) return remove ? {} : value;
  const walk = (node: unknown, i: number): unknown => {
    const key = keys[i];
    const last = i === keys.length - 1;
    if (Array.isArray(node) && /^\d+$/.test(key)) {
      const copy = node.slice();
      const idx = Number(key);
      if (last) {
        if (remove) copy.splice(idx, 1);
        else copy[idx] = value;
      } else {
        copy[idx] = walk(copy[idx], i + 1);
      }
      return copy;
    }
    const copy: Record<string, unknown> = isObj(node) && !Array.isArray(node) ? { ...node } : {};
    if (key === '__proto__') return copy;
    if (last) {
      if (remove) delete copy[key];
      else copy[key] = value;
    } else {
      copy[key] = walk(copy[key], i + 1);
    }
    return copy;
  };
  return walk(data, 0);
}
