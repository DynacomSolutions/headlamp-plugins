/*
 * The whole view lives in URL query params so a URL reproduces it. Only
 * non-default values are serialised.
 */
import { DrillStep } from './model';
import { DEFAULT_RANGE, Range, RANGES, ResourceId, RESOURCES } from './resources';

export interface UsageState {
  range: Range;
  groupBy: string;
  resources: ResourceId[];
  namespaces: string[];
  nodes: string[];
  include: string[];
  exclude: string[];
  drill: DrillStep[];
}

export const DEFAULT_GROUP_BY = 'namespace';
const ALL_RESOURCES = RESOURCES.map(r => r.id);

export const defaultState = (): UsageState => ({
  range: DEFAULT_RANGE,
  groupBy: DEFAULT_GROUP_BY,
  resources: [...ALL_RESOURCES],
  namespaces: [],
  nodes: [],
  include: [],
  exclude: [],
  drill: [],
});

// Items are percent-encoded so a comma inside a label value or key survives the round trip.
const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const list = (v: string | null): string[] => (v ? v.split(',').filter(Boolean).map(safeDecode) : []);
const enc = (xs: string[]): string => xs.map(encodeURIComponent).join(',');

function validGroupBy(v: string | null): string {
  if (!v) {
    return DEFAULT_GROUP_BY;
  }
  return ['namespace', 'workload', 'service', 'node', 'pod'].includes(v) || (v.startsWith('label:') && v.length > 6) ? v : DEFAULT_GROUP_BY;
}

export function parseState(search: string): UsageState {
  const p = new URLSearchParams(search);
  const range = p.get('range');
  const res = p.get('res');
  const picked = list(res).filter(r => (ALL_RESOURCES as string[]).includes(r)) as ResourceId[];
  // At least one resource always stays selected.
  const resources = picked.length > 0 ? picked : [...ALL_RESOURCES];
  const drill = list(p.get('drill'))
    .map(s => {
      const i = s.indexOf('|');
      return i > 0 ? { groupBy: validGroupBy(s.slice(0, i)), key: s.slice(i + 1) } : null;
    })
    .filter((s): s is DrillStep => s !== null);
  return {
    range: (RANGES as readonly string[]).includes(range ?? '') ? (range as Range) : DEFAULT_RANGE,
    groupBy: validGroupBy(p.get('group')),
    resources,
    namespaces: list(p.get('ns')),
    nodes: list(p.get('node')),
    include: list(p.get('only')),
    exclude: list(p.get('skip')),
    drill,
  };
}

/** Returns a query string including the leading "?", or "" for the default view. */
export function serialiseState(s: UsageState): string {
  const d = defaultState();
  const p = new URLSearchParams();
  if (s.range !== d.range) p.set('range', s.range);
  if (s.groupBy !== d.groupBy) p.set('group', s.groupBy);
  const sameResources = s.resources.length === d.resources.length && d.resources.every(r => s.resources.includes(r));
  if (!sameResources) p.set('res', enc(s.resources));
  if (s.namespaces.length) p.set('ns', enc(s.namespaces));
  if (s.nodes.length) p.set('node', enc(s.nodes));
  if (s.include.length) p.set('only', enc(s.include));
  if (s.exclude.length) p.set('skip', enc(s.exclude));
  if (s.drill.length) p.set('drill', enc(s.drill.map(x => `${x.groupBy}|${x.key}`)));
  const out = p.toString();
  return out ? `?${out}` : '';
}
