/*
 * URL state of the Nodes page: ?node=<name>&path=<key/key/…>, so a cabinet browser can boot into a
 * fixed view. Tree keys contain "/" themselves, so each key is percent-encoded and the keys are
 * joined with a literal "/". That is why the query is read and written by hand, not with
 * URLSearchParams (which would decode %2F before the split).
 */

export interface NodesUrlState {
  node: string | null;
  path: string[];
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Raw (still encoded) values of the query string, by name; the first occurrence wins. */
function rawParams(search: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const name = decode((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' '));
    if (!out.has(name)) out.set(name, i < 0 ? '' : part.slice(i + 1));
  }
  return out;
}

export function parseNodesUrl(search: string): NodesUrlState {
  const p = rawParams(search);
  const rawNode = p.get('node');
  const node = rawNode ? decode(rawNode.replace(/\+/g, ' ')) : null;
  if (!node) return { node: null, path: [] };
  const rawPath = p.get('path') ?? '';
  const path = rawPath
    .split('/')
    .filter(Boolean)
    .map(k => decode(k.replace(/\+/g, ' ')));
  return { node, path };
}

/** Returns a query string including the leading "?", or "" for the overview. */
export function serialiseNodesUrl(s: NodesUrlState): string {
  if (!s.node) return '';
  let out = `?node=${encodeURIComponent(s.node)}`;
  if (s.path.length) out += `&path=${s.path.map(encodeURIComponent).join('/')}`;
  return out;
}
