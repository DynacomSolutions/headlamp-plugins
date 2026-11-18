import { describe, expect, it } from 'vitest';
import {
  buildNodesPath,
  defaultNodesUrl,
  legacyPathRedirect,
  parseNodesPath,
  parseNodesUrl,
  serialiseNodesUrl,
} from './nodesUrl';

describe('nodesUrl', () => {
  it('is empty for the default view', () => {
    expect(serialiseNodesUrl(defaultNodesUrl())).toBe('');
    expect(parseNodesUrl('')).toEqual(defaultNodesUrl());
  });

  it('re-serialises each param to the same string', () => {
    for (const search of [
      '?nodes=worker-1%2Cworker-2',
      '?cats=k8s%2Ct3',
      '?sel=k8s%2Ck8s%2Fns%3Aa%2F%7Eunused',
      '?kiosk=1',
      '?nodes=worker-1&cats=k8s&sel=k8s%2Fns%3Aa&kiosk=1',
    ]) {
      expect(serialiseNodesUrl(parseNodesUrl(search))).toBe(search);
    }
  });

  it('round-trips the kiosk flag', () => {
    const s = { ...defaultNodesUrl(), kiosk: true };
    expect(serialiseNodesUrl(s)).toBe('?kiosk=1');
    expect(parseNodesUrl('?kiosk=1').kiosk).toBe(true);
    expect(parseNodesUrl('?kiosk=0').kiosk).toBe(false);
  });

  it('round-trips awkward values: comma, slash, colon, space, percent and unicode', () => {
    const s = {
      nodes: ['worker 1,a/b:c', 'nœud-é 日本', '100%'],
      cats: ['k8s', 'herdr'],
      path: ['node:worker 1,a/b:c', 'k8s/ns:a b/pod:x%y,z', 'ünï'],
      sel: ['node:worker 1,a/b:c', 'k8s/ns:a b/~unused'],
      kiosk: true,
    };
    const pathname = buildNodesPath('/c/main/usage/dashboard', s.path);
    expect(parseNodesUrl(serialiseNodesUrl(s), pathname)).toEqual(s);
  });

  it('omits the category filter when every category is selected', () => {
    const all = ['k8s', 't3', 'herdr', 'other', 'system'];
    expect(serialiseNodesUrl({ ...defaultNodesUrl(), cats: all })).toBe('');
    expect(parseNodesUrl('?cats=k8s,t3,herdr,other,system').cats).toEqual([]);
  });

  it('drops unknown categories and ignores unknown params', () => {
    expect(parseNodesUrl('?foo=1&cats=nope,k8s').cats).toEqual(['k8s']);
  });

  it('maps an old ?node= link to nodes, keeping its slash separated path', () => {
    expect(parseNodesUrl('?node=worker-1&path=t3/t3%2Fp%3Ax')).toEqual({
      nodes: ['worker-1'],
      cats: [],
      path: [],
      sel: [],
      kiosk: false,
    });
    expect(parseNodesUrl('?node=worker+1').nodes).toEqual(['worker 1']);
  });

  it('survives bad percent-encoding', () => {
    expect(parseNodesUrl('?nodes=a%ZZ').nodes).toEqual(['a%ZZ']);
  });

  describe('path segments', () => {
    const base = '/c/main/usage/dashboard';
    const keys = ['system/cg:user.slice', 'a b', '100%', 'x,y', 'ünï', 'k8s/ns:a b/pod:x%y,z'];

    it('encodes each key as one segment', () => {
      expect(buildNodesPath(base, ['system/cg:user.slice'])).toBe(
        `${base}/system%2Fcg%3Auser.slice`
      );
      expect(buildNodesPath(base, [])).toBe(base);
      expect(buildNodesPath(`${base}/`, ['a'])).toBe(`${base}/a`);
    });

    it('round-trips keys with slash, colon, percent, space and comma', () => {
      for (const k of keys) {
        const got = parseNodesPath(buildNodesPath(base, [k, 'k8s']));
        expect(got).toEqual({ base, path: [k, 'k8s'] });
      }
      expect(parseNodesPath(buildNodesPath(base, keys)).path).toEqual(keys);
    });

    it('handles a trailing slash, an empty path and empty segments', () => {
      expect(parseNodesPath(base)).toEqual({ base, path: [] });
      expect(parseNodesPath(`${base}/`)).toEqual({ base, path: [] });
      expect(parseNodesPath(`${base}/a//b/`).path).toEqual(['a', 'b']);
      expect(parseNodesPath('/usage/dashboard/a').base).toBe('/usage/dashboard');
    });
  });

  describe('legacyPathRedirect', () => {
    const base = '/c/main/usage/dashboard';
    it('is null without a path param', () => {
      expect(legacyPathRedirect(base, '?nodes=a&sel=b')).toBeNull();
    });

    it('moves ?path=a,b to segments and keeps the other params', () => {
      expect(legacyPathRedirect(base, '?nodes=w1&path=node%3Aw1%2Ck8s&kiosk=1')).toEqual({
        pathname: `${base}/node%3Aw1/k8s`,
        search: '?nodes=w1&kiosk=1',
      });
    });

    it('moves an old ?node= link with its slash separated path', () => {
      expect(legacyPathRedirect(base, '?node=w1&path=t3/t3%2Fp%3Ax')).toEqual({
        pathname: `${base}/t3/t3%2Fp%3Ax`,
        search: '?node=w1',
      });
    });
  });
});
