/* The PromQL widgets show the last good results of the browser cache at once, then fetch in the background. */
import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: (...a: unknown[]) => request(...a) },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));

import {
  createLastGoodStore,
  STALE_AFTER_MS,
  StorageLike,
  widgetCache,
} from '../../cache/lastGood';
import type { WidgetProps } from '../../contract';
import { defaultFilters } from '../../spec/model';
import { DEFAULT_STAT, statWidget } from './StatWidget';
import { resultsFromCache } from './useQueries';

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

const C = statWidget.Component;
const config = { ...DEFAULT_STAT, sparkline: false };
const filters = defaultFilters();
// The key that useQueries builds for an instant query with this config.
const keyFor = () => {
  const store = createLastGoodStore(memory());
  const cache = widgetCache(store, 's', 'w1');
  // Learn the key from a real write, so the test does not repeat the key format.
  return { store, cache };
};

function props(cache: ReturnType<typeof widgetCache>): WidgetProps<typeof config> {
  return {
    instanceId: 'w1',
    config,
    filters,
    refreshSignal: 0,
    reportRefreshed: vi.fn(),
    editing: false,
    kiosk: false,
    cache,
  };
}

beforeEach(() => {
  request.mockReset();
});
afterEach(cleanup);

describe('promql cache', () => {
  it('shows the cached value in the first render, then the fresh value, and writes it back', async () => {
    const { cache } = keyFor();
    // First run: no cache, the fetch fills it.
    request.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'success',
        data: { resultType: 'vector', result: [{ metric: {}, value: [1, '41'] }] },
      }),
    });
    const first = render(<C {...props(cache)} />);
    await waitFor(() =>
      expect(first.container.querySelector('[data-stat-value]')?.textContent).toBe('41')
    );
    first.unmount();
    expect(cache.read()).toBeDefined();

    // Second run: the server is slow. The cached 41 shows at once, with no waiting notice.
    let answer: (v: unknown) => void = () => undefined;
    request.mockReset();
    request.mockImplementation(() => new Promise(r => (answer = r)));
    const second = render(<C {...props(cache)} />);
    expect(second.container.querySelector('[data-stat-value]')?.textContent).toBe('41');
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    answer({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'success',
        data: { resultType: 'vector', result: [{ metric: {}, value: [1, '42'] }] },
      }),
    });
    await waitFor(() =>
      expect(second.container.querySelector('[data-stat-value]')?.textContent).toBe('42')
    );
  });

  it('ignores a cached entry of other queries', () => {
    const { cache } = keyFor();
    cache.write({ key: 'other|key', results: [] });
    expect(resultsFromCache(cache, 'instant|["up"]|{}')).toBeUndefined();
  });

  it('marks cached results as old only past the stale limit', () => {
    const { cache } = keyFor();
    cache.write({ key: 'k', results: [{ resultType: 'vector', result: [] }] }, Date.now() - 1_000);
    expect(resultsFromCache(cache, 'k')?.state.staleSince).toBeUndefined();
    cache.write(
      { key: 'k', results: [{ resultType: 'vector', result: [] }] },
      Date.now() - STALE_AFTER_MS - 5_000
    );
    expect(resultsFromCache(cache, 'k')?.state.staleSince).toBeDefined();
    expect(resultsFromCache(cache, 'k')?.state.cached).toBe(true);
  });

  it('treats a value of the wrong shape as no value', () => {
    const { cache } = keyFor();
    cache.write('text');
    expect(resultsFromCache(cache, 'k')).toBeUndefined();
    cache.write({ key: 'k', results: 'nope' });
    expect(resultsFromCache(cache, 'k')).toBeUndefined();
  });
});
