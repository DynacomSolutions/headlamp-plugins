import { describe, expect, it } from 'vitest';
import { addTab } from '../spec/edit';
import { emptySpec } from '../spec/model';
import { DATA_KEY, fromConfigMap } from '../storage/storage';
import {
  readCachedDashboard,
  readCachedSourcesText,
  writeCachedDashboard,
  writeCachedSourcesText,
} from './dashboardCache';
import { createLastGoodStore, StorageLike } from './lastGood';

function memory(): StorageLike {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: i => [...map.keys()][i] ?? null,
    getItem: k => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: k => void map.delete(k),
  };
}

const configMap = (text: string | undefined) => ({
  metadata: { name: 'ops', resourceVersion: '12' },
  data: text === undefined ? {} : { [DATA_KEY]: text },
});

describe('dashboard spec cache', () => {
  const spec = addTab(emptySpec('Ops'), 'Nodes', 'mdi:server').spec;

  it('gives a loaded dashboard back with no resourceVersion and no ConfigMap', () => {
    const store = createLastGoodStore(memory());
    writeCachedDashboard(store, fromConfigMap(configMap(JSON.stringify(spec)), 'dash-ns'));
    const back = readCachedDashboard(store, 'dash-ns', 'ops');
    expect(back?.spec.title).toBe('Ops');
    expect(back?.spec.tabs.map(t => t.label)).toEqual(['Overview', 'Nodes']);
    expect(back?.resourceVersion).toBe('');
    expect(back?.raw).toBeUndefined();
    expect(back?.name).toBe('ops');
  });

  it('does not cache a dashboard that failed to load', () => {
    const store = createLastGoodStore(memory());
    writeCachedDashboard(store, fromConfigMap(configMap(undefined), 'dash-ns'));
    writeCachedDashboard(store, fromConfigMap(configMap('{ not json'), 'dash-ns'));
    expect(readCachedDashboard(store, 'dash-ns', 'ops')).toBeUndefined();
  });

  it('ignores a cached text that this plugin version cannot read', () => {
    const store = createLastGoodStore(memory());
    store.write('dash-ns/ops', '#spec', { name: 'ops', text: JSON.stringify({ version: 999 }) });
    expect(readCachedDashboard(store, 'dash-ns', 'ops')).toBeUndefined();
    store.write('dash-ns/ops', '#spec', { name: 7, text: 3 });
    expect(readCachedDashboard(store, 'dash-ns', 'ops')).toBeUndefined();
  });

  it('keeps the spec of one dashboard apart from another', () => {
    const store = createLastGoodStore(memory());
    writeCachedDashboard(store, fromConfigMap(configMap(JSON.stringify(spec)), 'dash-ns'));
    expect(readCachedDashboard(store, 'dash-ns', 'wall')).toBeUndefined();
    expect(readCachedDashboard(store, 'other-ns', 'ops')).toBeUndefined();
  });
});

describe('cluster sources text cache', () => {
  it('keeps the text per namespace', () => {
    const store = createLastGoodStore(memory());
    expect(readCachedSourcesText(store, 'dash-ns')).toBeUndefined();
    writeCachedSourcesText(store, 'dash-ns', '{"version":1,"sources":[]}');
    expect(readCachedSourcesText(store, 'dash-ns')).toBe('{"version":1,"sources":[]}');
    expect(readCachedSourcesText(store, 'other-ns')).toBeUndefined();
  });
});
