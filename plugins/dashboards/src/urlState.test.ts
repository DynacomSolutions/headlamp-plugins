import { describe, expect, it } from 'vitest';
import { saveView } from './spec/edit';
import { defaultFilters, emptySpec } from './spec/model';
import {
  baseFilters,
  buildPath,
  parseFocus,
  parsePath,
  parseQuery,
  pathBase,
  resolveFilters,
  serialiseQuery,
  widgetParam,
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

  it('keeps the params of widgets (w.<id>) and drops other unknown params', () => {
    const f = { ...base, namespaces: ['a'] };
    const s = serialiseQuery(
      { edit: false, kiosk: true, view: '', filters: f },
      base,
      '?kiosk=1&junk=1&w.runners-1=r%7Cmy-org%2Fmy-repo%2Cf%7Cx&w.b=%20&ns=old'
    );
    const p = new URLSearchParams(s);
    expect(p.get('w.runners-1')).toBe('r|my-org/my-repo,f|x');
    expect(p.get('w.b')).toBe(' ');
    expect(p.has('junk')).toBe(false);
    expect(p.get('kiosk')).toBe('1');
    expect(p.get('ns')).toBe('a');
    expect(parseQuery(s).filters.namespaces).toEqual(['a']);
  });

  it('writes the plain view for a query with no widget params, and keeps widget params alone', () => {
    expect(
      serialiseQuery({ edit: false, kiosk: false, view: '', filters: base }, base, '?junk=1')
    ).toBe('');
    expect(
      serialiseQuery({ edit: false, kiosk: false, view: '', filters: base }, base, '?w.a=1')
    ).toBe('?w.a=1');
    expect(widgetParam('a')).toBe('w.a');
    expect(widgetParam('a', 'hosted')).toBe('w.a.hosted');
    expect(
      serialiseQuery({ edit: false, kiosk: false, view: '', filters: base }, base, '?w.a.hosted=1')
    ).toBe('?w.a.hosted=1');
  });

  it('uses the spec filters when the view is unknown', () => {
    expect(baseFilters(emptySpec('x'), 'nope')).toEqual(base);
    expect(baseFilters(undefined, '')).toEqual(base);
  });
});

describe('focus segments', () => {
  it('reads the segments after the tab and decodes them', () => {
    expect(parseFocus('/dashboards/ops/incidents/group/Kube%2FDown')).toEqual([
      'group',
      'Kube/Down',
    ]);
    expect(parseFocus('/c/main/dashboards/ops/incidents/incident/d-1')).toEqual([
      'incident',
      'd-1',
    ]);
    expect(parseFocus('/dashboards/ops/incidents')).toEqual([]);
    expect(parseFocus('/dashboards/ops')).toEqual([]);
    expect(parseFocus('/dashboards')).toEqual([]);
  });
  it('leaves the name and the tab as they were', () => {
    expect(parsePath('/dashboards/ops/incidents/group/HighCPU')).toEqual({
      name: 'ops',
      tab: 'incidents',
    });
  });
  it('round trips a focus with spaces, slashes and percent signs', () => {
    for (const focus of [
      ['group', 'High CPU / 100%'],
      ['incident', 'a b'],
      ['group', 'ünï'],
    ]) {
      const path = buildPath({ name: 'o ps', tab: 'in cidents', focus }, '/c/main');
      expect(parseFocus(path)).toEqual(focus);
      expect(parsePath(path)).toEqual({ name: 'o ps', tab: 'in cidents' });
    }
    expect(buildPath({ name: 'ops', tab: 'nodes', focus: ['group', 'A'] })).toBe(
      '/dashboards/ops/nodes/group/A'
    );
  });
  it('writes no focus for an empty list, and keeps a path with no tab as it was', () => {
    expect(buildPath({ name: 'ops', tab: 'nodes', focus: [] })).toBe('/dashboards/ops/nodes');
    expect(buildPath({ name: 'ops', tab: '' })).toBe('/dashboards/ops');
  });
});
