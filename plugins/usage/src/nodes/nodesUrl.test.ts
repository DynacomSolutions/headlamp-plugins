import { describe, expect, it } from 'vitest';
import { parseNodesUrl, serialiseNodesUrl } from './nodesUrl';

describe('nodesUrl', () => {
  it('round-trips a node and a path whose keys contain slashes', () => {
    const search = '?node=worker-1&path=t3/t3%2Fp%3Ax';
    const s = parseNodesUrl(search);
    expect(s).toEqual({ node: 'worker-1', path: ['t3', 't3/p:x'] });
    expect(serialiseNodesUrl(s)).toBe(search);
  });

  it('ignores unknown params', () => {
    expect(parseNodesUrl('?foo=bar&node=worker-1&x=1')).toEqual({ node: 'worker-1', path: [] });
  });

  it('parses an empty or missing path to []', () => {
    expect(parseNodesUrl('?node=worker-1&path=').path).toEqual([]);
    expect(parseNodesUrl('?node=worker-1').path).toEqual([]);
    expect(parseNodesUrl('').path).toEqual([]);
  });

  it('serialises the overview to nothing and drops a path without a node', () => {
    expect(serialiseNodesUrl({ node: null, path: [] })).toBe('');
    expect(serialiseNodesUrl({ node: null, path: ['k8s'] })).toBe('');
    expect(parseNodesUrl('?path=k8s')).toEqual({ node: null, path: [] });
  });

  it('round-trips awkward node names and keys', () => {
    const s = { node: 'worker 1&2', path: ['k8s', 'k8s/ns:a b', 'k8s/ns:a b/pod:x%y'] };
    expect(parseNodesUrl(serialiseNodesUrl(s))).toEqual(s);
  });

  it('survives bad percent-encoding', () => {
    expect(parseNodesUrl('?node=worker-1&path=a%ZZ/b')).toEqual({
      node: 'worker-1',
      path: ['a%ZZ', 'b'],
    });
  });

  it('decodes a plus in the node name as a space, as URLSearchParams does', () => {
    expect(parseNodesUrl('?node=worker+1').node).toBe('worker 1');
  });
});
