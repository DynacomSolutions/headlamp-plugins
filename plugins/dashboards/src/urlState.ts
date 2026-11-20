/*
 * The whole view lives in the URL, so the URL alone reproduces it.
 *
 *   /dashboards                       the list
 *   /dashboards/<name>                a dashboard, first tab
 *   /dashboards/<name>/<tab>          a dashboard, one tab
 *
 * Content identity (dashboard and tab) is in the path and changes with history push. View
 * options are in the query and change with history replace:
 *
 *   edit=1      edit mode
 *   kiosk=1     full screen
 *   view=<id>   a saved view of filter values
 *   refresh=<s> automatic refresh in seconds (0 for off); without it the dashboard's own setting
 *   ns=a,b      namespaces        node=a,b   nodes
 *   sel=<text>  label selector    range=<r>  time range
 *
 * A filter key that is in the URL overrides the saved view (or the dashboard default), even
 * with an empty value, so "no namespace" can be told from "not set". Items are percent
 * encoded, so a comma inside a value survives the round trip.
 */
import type { DashboardFilters } from './contract';
import { DashboardSpec, defaultFilters, REFRESH_OPTIONS, TIME_RANGES } from './spec/model';

export const BASE_PATH = '/dashboards';

export interface DashboardPath {
  /** The dashboard (ConfigMap) name, or '' on the list page. */
  name: string;
  /** The tab id, or '' for the first tab. */
  tab: string;
}

export interface DashboardQuery {
  edit: boolean;
  kiosk: boolean;
  /** Saved view id, or ''. */
  view: string;
  /** Automatic refresh in seconds given in the URL, or undefined to use the dashboard's own. */
  refresh: number | undefined;
  /** Filter keys given in the URL. A missing key follows the view or the default. */
  filters: Partial<DashboardFilters>;
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Headlamp puts every cluster route under /c/<cluster>. The pattern keeps that prefix apart. */
const PATH_PATTERN = /^((?:\/c\/[^/]+)?)\/dashboards(?:\/(.*))?$/;

/** The part of the path before /dashboards: "/c/<cluster>" in Headlamp, or "" outside a cluster. */
export function pathBase(pathname: string): string {
  return PATH_PATTERN.exec(pathname)?.[1] ?? '';
}

export function parsePath(pathname: string): DashboardPath {
  const rest = PATH_PATTERN.exec(pathname)?.[2] ?? '';
  const [name = '', tab = ''] = rest.split('/').filter(Boolean).map(safeDecode);
  return { name, tab };
}

/** A path to the list or to a dashboard. `base` is the cluster prefix from `pathBase`. */
export function buildPath(p: DashboardPath, base = ''): string {
  if (!p.name) return `${base}${BASE_PATH}`;
  const tab = p.tab ? `/${encodeURIComponent(p.tab)}` : '';
  return `${base}${BASE_PATH}/${encodeURIComponent(p.name)}${tab}`;
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const list = (v: string): string[] => (v ? v.split(',').filter(Boolean).map(safeDecode) : []);
const enc = (xs: string[]): string => xs.map(encodeURIComponent).join(',');

export function parseQuery(search: string): DashboardQuery {
  const p = new URLSearchParams(search);
  const filters: Partial<DashboardFilters> = {};
  if (p.has('ns')) filters.namespaces = list(p.get('ns') ?? '');
  if (p.has('node')) filters.nodes = list(p.get('node') ?? '');
  if (p.has('sel')) filters.labelSelector = p.get('sel') ?? '';
  const range = p.get('range');
  if (range && (TIME_RANGES as ReadonlyArray<string>).includes(range)) filters.range = range as DashboardFilters['range'];
  const r = p.get('refresh');
  const refresh = r !== null && /^\d+$/.test(r) && REFRESH_OPTIONS.some(o => o.seconds === Number(r)) ? Number(r) : undefined;
  return { edit: p.get('edit') === '1', kiosk: p.get('kiosk') === '1', view: p.get('view') ?? '', refresh, filters };
}

/** The filter values a query gives, on top of a base (the saved view or the spec default). */
export function resolveFilters(base: DashboardFilters, given: Partial<DashboardFilters>): DashboardFilters {
  return {
    namespaces: given.namespaces ?? base.namespaces,
    nodes: given.nodes ?? base.nodes,
    labelSelector: given.labelSelector ?? base.labelSelector,
    range: given.range ?? base.range,
  };
}

/** The base for a query: the named saved view's filters, else the dashboard default. */
export function baseFilters(spec: DashboardSpec | undefined, view: string): DashboardFilters {
  if (!spec) return defaultFilters();
  return spec.views.find(v => v.id === view)?.filters ?? spec.filters;
}

/** A query string with the leading "?", or "" for the plain view. Only differences are written. */
export function serialiseQuery(
  q: { edit: boolean; kiosk: boolean; view: string; refresh?: number; filters: DashboardFilters },
  base: DashboardFilters
): string {
  const p = new URLSearchParams();
  if (q.edit) p.set('edit', '1');
  if (q.kiosk) p.set('kiosk', '1');
  if (q.view) p.set('view', q.view);
  if (q.refresh !== undefined) p.set('refresh', String(q.refresh));
  if (!sameList(q.filters.namespaces, base.namespaces)) p.set('ns', enc(q.filters.namespaces));
  if (!sameList(q.filters.nodes, base.nodes)) p.set('node', enc(q.filters.nodes));
  if (q.filters.labelSelector !== base.labelSelector) p.set('sel', q.filters.labelSelector);
  if (q.filters.range !== base.range) p.set('range', q.filters.range);
  const out = p.toString();
  return out ? `?${out}` : '';
}
