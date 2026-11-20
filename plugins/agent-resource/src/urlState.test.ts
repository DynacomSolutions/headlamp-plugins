import { describe, expect, it } from 'vitest';
import { defaultView, parseView, toggled, viewSearch } from './urlState';

describe('view state in the URL', () => {
  it('has no query for the default view', () => {
    expect(viewSearch('', defaultView())).toBe('');
    expect(parseView('')).toEqual(defaultView());
  });
  it('round-trips the filter and both lists', () => {
    const view = {
      filter: 'cargo build',
      collapsed: ['o:t3', 'p:t3:My project'],
      procs: ['t3code-claude-1.scope'],
    };
    expect(parseView(viewSearch('', view))).toEqual(view);
  });
  it('survives commas, percent signs and unicode in list items', () => {
    const view = {
      filter: 'a&b=c',
      collapsed: ['p:t3:one, two', 'p:t3:100%', 'p:herdr:café'],
      procs: ['x,y'],
    };
    const search = viewSearch('', view);
    expect(parseView(search)).toEqual(view);
    // The list is one query value: a comma inside an item never splits it.
    expect(new URLSearchParams(search).get('procs')).toBe('x%2Cy');
  });
  it('keeps other options and drops cleared ones', () => {
    const s = viewSearch('?kiosk=1&q=old&hide=a', { ...defaultView(), filter: 'new' });
    expect(new URLSearchParams(s).get('kiosk')).toBe('1');
    expect(new URLSearchParams(s).get('q')).toBe('new');
    expect(new URLSearchParams(s).has('hide')).toBe(false);
    expect(viewSearch('?q=old', defaultView())).toBe('');
  });
  it('reads a link with only some options', () => {
    expect(parseView('?hide=o%3At3')).toEqual({ filter: '', collapsed: ['o:t3'], procs: [] });
    expect(parseView('?q=')).toEqual(defaultView());
  });
  it('toggles list items', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggled(['a', 'b'], 'a')).toEqual(['b']);
  });
});
