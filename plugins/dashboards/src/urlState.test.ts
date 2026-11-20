import { describe, expect, it } from 'vitest';
import { saveView } from './spec/edit';
import { defaultFilters, emptySpec } from './spec/model';
import {
  baseFilters,
  buildPath,
  parsePath,
  parseQuery,
  pathBase,
  resolveFilters,
  serialiseQuery,
} from './urlState';

describe('paths', () => {
  it('parses the list, a dashboard and a tab', () => {
    expect(parsePath('/dashboards')).toEqual({ name: '', tab: '' });
    expect(parsePath('/dashboards/')).toEqual({ name: '', tab: '' });
    expect(parsePath('/dashboards/ops')).toEqual({ name: 'ops', tab: '' });
    expect(parsePath('/dashboards/ops/nodes')).toEqual({ name: 'ops', tab: 'nodes' });
    expect(parsePath('/dashboards/o%20ps/n%2Fx')).toEqual({ name: 'o ps', tab: 'n/x' });
  });
  it('builds what it parses', () => {
    for (const p of [
      { name: '', tab: '' },
      { name: 'ops', tab: '' },
      { name: 'ops', tab: 'a b' },
    ]) {
      expect(parsePath(buildPath(p))).toEqual(p);
    }
    expect(buildPath({ name: 'ops', tab: 'nodes' })).toBe('/dashboards/ops/nodes');
  });
  it('keeps the Headlamp cluster prefix', () => {
    expect(pathBase('/dashboards/ops')).toBe('');
    expect(pathBase('/c/main/dashboards')).toBe('/c/main');
    expect(pathBase('/c/main/dashboards/ops/nodes')).toBe('/c/main');
    expect(parsePath('/c/main/dashboards')).toEqual({ name: '', tab: '' });
    expect(parsePath('/c/main/dashboards/ops')).toEqual({ name: 'ops', tab: '' });
    expect(parsePath('/c/main/dashboards/ops/nodes')).toEqual({ name: 'ops', tab: 'nodes' });
    expect(buildPath({ name: '', tab: '' }, '/c/main')).toBe('/c/main/dashboards');
    expect(buildPath({ name: 'ops', tab: 'nodes' }, '/c/main')).toBe(
      '/c/main/dashboards/ops/nodes'
    );
  });
  it('reads a cluster that is called dashboards', () => {
    expect(parsePath('/c/dashboards/dashboards/ops')).toEqual({ name: 'ops', tab: '' });
    expect(pathBase('/c/dashboards/dashboards/ops')).toBe('/c/dashboards');
  });
});

describe('query', () => {
  const base = defaultFilters();

  it('parses view options', () => {
    const q = parseQuery(
      '?edit=1&kiosk=1&view=team&refresh=30&ns=a,b&node=n1&sel=app%3Dweb&range=6h'
    );
    expect(q).toMatchObject({ edit: true, kiosk: true, view: 'team', refresh: 30 });
    expect(q.filters).toEqual({
      namespaces: ['a', 'b'],
      nodes: ['n1'],
      labelSelector: 'app=web',
      range: '6h',
    });
  });

  it('ignores invalid values', () => {
    const q = parseQuery('?range=1y&refresh=7&kiosk=0');
    expect(q.kiosk).toBe(false);
    expect(q.refresh).toBeUndefined();
    expect(q.filters).toEqual({});
  });

  it('writes only differences from the base', () => {
    expect(serialiseQuery({ edit: false, kiosk: false, view: '', filters: base }, base)).toBe('');
    const s = serialiseQuery(
      {
        edit: true,
        kiosk: true,
        view: 'v',
        refresh: 0,
        filters: { ...base, namespaces: ['a,b', 'c'], range: '7d' },
      },
      base
    );
    const q = parseQuery(s);
    expect(q).toMatchObject({ edit: true, kiosk: true, view: 'v', refresh: 0 });
    expect(q.filters.namespaces).toEqual(['a,b', 'c']);
    expect(q.filters.range).toBe('7d');
  });

  it('round trips filters through the URL with a base', () => {
    const f = { namespaces: ['x'], nodes: [], labelSelector: 'a in (b,c)', range: '24h' as const };
    const q = parseQuery(serialiseQuery({ edit: false, kiosk: false, view: '', filters: f }, base));
    expect(resolveFilters(base, q.filters)).toEqual(f);
  });

  it('lets an empty URL value clear a saved view value', () => {
    const spec = saveView(emptySpec('x'), 'Team', { ...base, namespaces: ['a'] });
    const view = spec.views[0];
    const viewBase = baseFilters(spec, view.id);
    expect(viewBase.namespaces).toEqual(['a']);
    const search = serialiseQuery(
      { edit: false, kiosk: false, view: view.id, filters: { ...viewBase, namespaces: [] } },
      viewBase
    );
    expect(search).toContain('ns=');
    expect(resolveFilters(viewBase, parseQuery(search).filters).namespaces).toEqual([]);
  });

  it('uses the spec filters when the view is unknown', () => {
    expect(baseFilters(emptySpec('x'), 'nope')).toEqual(base);
    expect(baseFilters(undefined, '')).toEqual(base);
  });
});
