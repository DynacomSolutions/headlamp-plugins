/*
 * The view state of the Agent resources page lives in the URL, so a link
 * reproduces the view. All of it is a query option, written with history
 * replace so that typing in the filter does not fill the back button:
 *   q=text        the filter box (left out when empty)
 *   hide=a,b      the collapsed tree groups, as tree row keys (left out for none)
 *   procs=a,b     the agents whose process tree is open, as unit names (left out for none)
 * Lists are comma joined with "%" and "," escaped inside an item. Other query
 * options in the URL are kept as they are.
 */

export interface ViewState {
  filter: string;
  /** Keys of the collapsed groups (host, orchestrator and project rows). */
  collapsed: string[];
  /** Names of the units whose process tree is open. */
  procs: string[];
}

export const defaultView = (): ViewState => ({ filter: '', collapsed: [], procs: [] });

const escapeItem = (s: string): string => s.replace(/%/g, '%25').replace(/,/g, '%2C');
const unescapeItem = (s: string): string => s.replace(/%(2C|25)/g, m => (m === '%2C' ? ',' : '%'));
const joinList = (xs: string[]): string => xs.map(escapeItem).join(',');
const splitList = (v: string | null): string[] =>
  v ? v.split(',').filter(Boolean).map(unescapeItem) : [];

/** The view of a location search string; missing or empty options take the default. */
export function parseView(search: string): ViewState {
  const p = new URLSearchParams(search);
  return {
    filter: p.get('q') ?? '',
    collapsed: splitList(p.get('hide')),
    procs: splitList(p.get('procs')),
  };
}

/** The search string for `view`: other options of `search` are kept, defaults are left out. */
export function viewSearch(search: string, view: ViewState): string {
  const p = new URLSearchParams(search);
  p.delete('q');
  p.delete('hide');
  p.delete('procs');
  if (view.filter !== '') p.set('q', view.filter);
  if (view.collapsed.length > 0) p.set('hide', joinList(view.collapsed));
  if (view.procs.length > 0) p.set('procs', joinList(view.procs));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Adds `item` to the list, or removes it when it is there. */
export function toggled(list: readonly string[], item: string): string[] {
  return list.includes(item) ? list.filter(x => x !== item) : [...list, item];
}
