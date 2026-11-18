import { describe, expect, it } from 'vitest';
import { defaultNodesUrl, parseNodesUrl, serialiseNodesUrl } from './nodesUrl';

describe('nodesUrl', () => {
  it('is empty for the default view', () => {
    expect(serialiseNodesUrl(defaultNodesUrl())).toBe('');
    expect(parseNodesUrl('')).toEqual(defaultNodesUrl());
  });

  it('re-serialises each param to the same string', () => {
    for (const search of [
      '?nodes=worker-1%2Cworker-2',
      '?cats=k8s%2Ct3',
      '?path=node%3Aworker-1%2Ck8s',
      '?sel=k8s%2Ck8s%2Fns%3Aa%2F%7Eunused',
      '?kiosk=1',
      '?nodes=worker-1&cats=k8s&path=k8s&sel=k8s%2Fns%3Aa&kiosk=1',
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
    expect(parseNodesUrl(serialiseNodesUrl(s))).toEqual(s);
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
      path: ['t3', 't3/p:x'],
      sel: [],
      kiosk: false,
    });
    expect(parseNodesUrl('?node=worker+1').nodes).toEqual(['worker 1']);
  });

  it('survives bad percent-encoding', () => {
    expect(parseNodesUrl('?nodes=a%ZZ').nodes).toEqual(['a%ZZ']);
  });
});
