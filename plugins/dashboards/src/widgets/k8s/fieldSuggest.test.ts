import { describe, expect, it } from 'vitest';
import { parseFieldPath } from './fields';
import { formatPath, suggestPaths } from './fieldSuggest';

describe('field suggestions', () => {
  it('writes paths that parse back, quoting odd keys', () => {
    const segs = ['metadata', 'labels', 'app.kubernetes.io/name'];
    expect(formatPath(segs)).toBe('.metadata.labels["app.kubernetes.io/name"]');
    expect(parseFieldPath(formatPath(segs))).toEqual(segs);
    expect(parseFieldPath(formatPath(['spec', 'containers', 0, 'image']))).toEqual([
      'spec',
      'containers',
      0,
      'image',
    ]);
  });
  it('lists leaf paths from a sample and skips managed fields', () => {
    const objs = [
      {
        metadata: { name: 'a', labels: { app: 'x' }, managedFields: [{ manager: 'k' }] },
        spec: { replicas: 2, containers: [{ image: 'i' }] },
      },
      { metadata: { name: 'b' }, spec: { replicas: 3 } },
    ];
    const paths = suggestPaths(objs);
    expect(paths).toContain('.metadata.name');
    expect(paths).toContain('.spec.replicas');
    expect(paths).toContain('.spec.containers[0].image');
    expect(paths).toContain('.metadata.labels.app');
    expect(paths.some(p => p.includes('managedFields'))).toBe(false);
  });
});
