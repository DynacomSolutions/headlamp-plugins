/*
 * URL state of the Usage dashboard, so a cabinet browser can boot into a fixed view and a URL
 * reproduces the whole view. Every view option is a query param, written with history replace,
 * and a default is left out:
 *   nodes=a,b   the selected nodes (left out for all)
 *   cats=k8s,t3 the selected categories (left out for all)
 *   path=k,k    the zoom path, as arc keys from the root
 *   sel=k,k     the selected segment, as arc keys from the root (it may differ from the zoom)
 *   kiosk=1     full screen kiosk view
 * Lists are comma joined with "%" and "," escaped inside an item, and URLSearchParams does the
 * rest, so names and keys with commas, slashes, colons, spaces or unicode survive. The old
 * ?node=<name>&path=<key/key> links still work: they map to nodes=<name>.
 */
import { CATEGORIES } from './tree';

export interface NodesUrlState {
  /** Selected node names; [] means every node. */
  nodes: string[];
  /** Selected category ids; [] means every category. */
  cats: string[];
  /** Zoom path: arc keys from the root (it starts with the node key when the node ring shows). */
  path: string[];
  /** Selected segment: arc keys from the root; [] for none. */
  sel: string[];
  kiosk: boolean;
}

export const defaultNodesUrl = (): NodesUrlState => ({
  nodes: [],
  cats: [],
  path: [],
  sel: [],
  kiosk: false,
});

const escapeItem = (s: string): string => s.replace(/%/g, '%25').replace(/,/g, '%2C');
const unescapeItem = (s: string): string => s.replace(/%(2C|25)/g, m => (m === '%2C' ? ',' : '%'));
const joinList = (xs: string[]): string => xs.map(escapeItem).join(',');
const splitList = (v: string | null): string[] =>
  v ? v.split(',').filter(Boolean).map(unescapeItem) : [];

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

/** The path of an old ?node= link: keys percent-encoded and joined with a literal "/". */
function legacyPath(search: string): string[] {
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (part.startsWith('path=')) return part.slice(5).split('/').filter(Boolean).map(decode);
  }
  return [];
}

export function parseNodesUrl(search: string): NodesUrlState {
  const p = new URLSearchParams(search);
  const legacy = p.get('node');
  const known = CATEGORIES.map(c => c.id);
  const cats = [...new Set(splitList(p.get('cats')))].filter(c => known.includes(c));
  return {
    nodes: p.has('nodes') ? [...new Set(splitList(p.get('nodes')))] : legacy ? [legacy] : [],
    cats: cats.length === known.length ? [] : cats,
    path: p.has('nodes') || !legacy ? splitList(p.get('path')) : legacyPath(search),
    sel: splitList(p.get('sel')),
    kiosk: p.get('kiosk') === '1',
  };
}

/** Returns a query string including the leading "?", or "" for the default view. */
export function serialiseNodesUrl(s: NodesUrlState): string {
  const p = new URLSearchParams();
  if (s.nodes.length) p.set('nodes', joinList(s.nodes));
  if (s.cats.length && s.cats.length < CATEGORIES.length) p.set('cats', joinList(s.cats));
  if (s.path.length) p.set('path', joinList(s.path));
  if (s.sel.length) p.set('sel', joinList(s.sel));
  if (s.kiosk) p.set('kiosk', '1');
  const q = p.toString();
  return q ? `?${q}` : '';
}
