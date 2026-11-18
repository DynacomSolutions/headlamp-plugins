/*
 * URL of the Usage dashboard, so a cabinet browser can boot into a fixed view and a URL
 * reproduces the whole view. Content and view options are split as follows:
 *   /usage/dashboard/<key>/<key>  the zoom path, one encodeURIComponent segment per arc key.
 *                                 A zoom change is a history push, so Back goes up one level.
 * Filters and view options are query params, written with history replace, and a default is
 * left out:
 *   nodes=a,b   the selected nodes (left out for all)
 *   cats=k8s,t3 the selected categories (left out for all)
 *   sel=k,k     the selected segment, as arc keys from the root (it may differ from the zoom)
 *   kiosk=1     full screen kiosk view
 * Lists are comma joined with "%" and "," escaped inside an item, and URLSearchParams does the
 * rest, so names and keys with commas, slashes, colons, spaces or unicode survive.
 * Old links redirect: ?path=a,b and ?node=<name>&path=<key/key> move to the segment form.
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
function legacyNodePath(search: string): string[] {
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (part.startsWith('path=')) return part.slice(5).split('/').filter(Boolean).map(decode);
  }
  return [];
}

const DASHBOARD = /^(.*?\/usage\/dashboard)(?:\/(.*))?$/;

/**
 * Splits a location pathname into the dashboard base (any prefix such as /c/<cluster>, up to and
 * including /usage/dashboard) and the zoom path. A trailing slash and empty segments are ignored.
 */
export function parseNodesPath(pathname: string): { base: string; path: string[] } {
  const m = DASHBOARD.exec(pathname);
  if (!m) return { base: pathname.replace(/\/+$/, ''), path: [] };
  const rest = m[2] ?? '';
  return { base: m[1], path: rest.split('/').filter(Boolean).map(decode) };
}

/** The pathname for a zoom path under a base: each key is one encodeURIComponent segment. */
export function buildNodesPath(base: string, path: string[]): string {
  return [base.replace(/\/+$/, ''), ...path.map(encodeURIComponent)].join('/');
}

export function parseNodesUrl(search: string, pathname = ''): NodesUrlState {
  const p = new URLSearchParams(search);
  const legacy = p.get('node');
  const known = CATEGORIES.map(c => c.id);
  const cats = [...new Set(splitList(p.get('cats')))].filter(c => known.includes(c));
  return {
    nodes: p.has('nodes') ? [...new Set(splitList(p.get('nodes')))] : legacy ? [legacy] : [],
    cats: cats.length === known.length ? [] : cats,
    path: parseNodesPath(pathname).path,
    sel: splitList(p.get('sel')),
    kiosk: p.get('kiosk') === '1',
  };
}

/** Returns the query string including the leading "?", or "" for the default view. */
export function serialiseNodesUrl(s: NodesUrlState): string {
  const p = new URLSearchParams();
  if (s.nodes.length) p.set('nodes', joinList(s.nodes));
  if (s.cats.length && s.cats.length < CATEGORIES.length) p.set('cats', joinList(s.cats));
  if (s.sel.length) p.set('sel', joinList(s.sel));
  if (s.kiosk) p.set('kiosk', '1');
  const q = p.toString();
  return q ? `?${q}` : '';
}

/**
 * The target of an old ?path= link, or null when the URL has no such param. The zoom moves to
 * path segments and the other params stay. A path already in the segments wins over the query.
 */
export function legacyPathRedirect(
  pathname: string,
  search: string
): { pathname: string; search: string } | null {
  const p = new URLSearchParams(search);
  if (!p.has('path')) return null;
  const { base, path: segments } = parseNodesPath(pathname);
  const queryPath = p.has('nodes') || !p.has('node') ? splitList(p.get('path')) : legacyNodePath(search);
  p.delete('path');
  const q = p.toString();
  return {
    pathname: buildNodesPath(base, segments.length ? segments : queryPath),
    search: q ? `?${q}` : '',
  };
}
