/* Stale data and retry with backoff in the data hooks of the widgets. */
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
const streamResults = vi.fn();
vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: {
    request: (...a: unknown[]) => request(...a),
    streamResults: (...a: unknown[]) => streamResults(...a),
  },
  K8s: {
    useClustersConf: () => ({ main: {}, other: {} }),
    useCluster: () => null,
    ResourceClasses: {},
  },
  Router: { createRouteURL: () => '/x' },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
    get() {
      return undefined;
    }
  },
}));

import { defaultFilters } from '../spec/model';
import { DEFAULT_REPORT } from '../widgets/k8s/config';
import { k8sReportWidget } from '../widgets/k8s/K8sReportWidget';
import { clearPanelListCache } from '../widgets/panels/data';
import { panelWidget } from '../widgets/panels/PanelWidget';
import { DEFAULT_STAT, statWidget } from '../widgets/promql/StatWidget';
import { StaleContext } from './stale';

const PANEL = {
  version: 1,
  id: 'p',
  title: 'P',
  status: 'ok',
  summary: 'Fine',
  stats: [],
  rows: [],
  series: [],
  rings: [],
};
const LIST = {
  version: 1,
  panels: [{ id: 'p', title: 'P', description: '', plugin: 'x', link: '/x', refreshSeconds: 0 }],
};

/** Renders a widget in a frame stand-in that records the stale reports. */
function frameWith(ui: React.ReactNode, seen: Array<number | undefined>) {
  return (
    <MemoryRouter>
      <StaleContext.Provider value={s => void seen.push(s)}>{ui}</StaleContext.Provider>
    </MemoryRouter>
  );
}
const flush = async (ms = 0) => {
  await act(async () => {
    if (ms) await vi.advanceTimersByTimeAsync(ms);
    else await Promise.resolve();
  });
};

beforeEach(() => {
  request.mockReset();
  streamResults.mockReset();
  clearPanelListCache();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date(2026, 10, 21, 17, 55, 0));
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 300 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('panel widget during an outage', () => {
  const P = panelWidget.Component;
  const props = (refreshSignal: number) => ({
    instanceId: 'w1',
    config: { source: 'agent', panel: 'p' },
    filters: defaultFilters(),
    refreshSignal,
    reportRefreshed: vi.fn(),
    editing: false,
    kiosk: true,
  });

  it('keeps the last panel with no alert in a kiosk, reports the stale time, retries with backoff and recovers', async () => {
    let up = true;
    request.mockImplementation(async (url: string) => {
      if (!up) throw new Error('The source did not answer.');
      return String(url).endsWith('/api/widgets') ? LIST : PANEL;
    });
    const seen: Array<number | undefined> = [];
    const view = render(frameWith(<P {...props(0)} />, seen));
    await flush();
    expect(view.container.querySelector('[data-panel="p"]')).not.toBeNull();
    const okAt = Date.now();

    up = false;
    vi.setSystemTime(Date.now() + 60_000);
    view.rerender(frameWith(<P {...props(1)} />, seen));
    await flush();
    expect(view.container.querySelector('[data-panel="p"]')).not.toBeNull();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(seen.at(-1)).toBe(okAt);

    const calls = () =>
      request.mock.calls.filter(c => !String(c[0]).endsWith('/api/widgets')).length;
    const before = calls();
    await flush(2_100);
    expect(calls()).toBe(before + 1);
    // The next wait is 3.2 to 4 s (the delay doubles, with 20% spread), so nothing yet.
    await flush(1_000);
    expect(calls()).toBe(before + 1);
    await flush(3_000);
    expect(calls()).toBe(before + 2);

    up = true;
    await flush(8_100);
    expect(seen.at(-1)).toBeUndefined();
    expect(view.container.querySelector('[data-panel="p"]')).not.toBeNull();
    // After a good answer the retries stop.
    const after = calls();
    await flush(70_000);
    expect(calls()).toBe(after);
  });
});

describe('PromQL widget during an outage', () => {
  const S = statWidget.Component;
  const reply = (v: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'success',
      data: { resultType: 'vector', result: [{ metric: {}, value: [1, v] }] },
    }),
  });
  const props = (refreshSignal: number) => ({
    instanceId: 'w2',
    config: { ...DEFAULT_STAT, sparkline: false },
    filters: defaultFilters(),
    refreshSignal,
    reportRefreshed: vi.fn(),
    editing: false,
    kiosk: true,
  });

  it('keeps the last value, shows no error, reports the stale time and retries by itself', async () => {
    request.mockResolvedValue(reply('42'));
    const seen: Array<number | undefined> = [];
    const view = render(frameWith(<S {...props(0)} />, seen));
    await flush();
    expect(view.container.textContent).toContain('42');
    const okAt = Date.now();

    request.mockRejectedValue(new Error('Failed to fetch'));
    vi.setSystemTime(Date.now() + 30_000);
    view.rerender(frameWith(<S {...props(1)} />, seen));
    await flush();
    expect(view.container.textContent).toContain('42');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(seen.at(-1)).toBe(okAt);

    const n = request.mock.calls.length;
    request.mockResolvedValue(reply('43'));
    await flush(2_100);
    expect(request.mock.calls.length).toBe(n + 1);
    expect(view.container.textContent).toContain('43');
    expect(seen.at(-1)).toBeUndefined();
  });

  it('still shows the error when the very first fetch fails, and retries', async () => {
    request.mockRejectedValue(new Error('Failed to fetch'));
    const view = render(frameWith(<S {...props(0)} />, []));
    await flush();
    expect(view.container.textContent).toContain('Failed to fetch');
    request.mockResolvedValue(reply('7'));
    await flush(2_100);
    expect(view.container.textContent).toContain('7');
  });
});

describe('Kubernetes report during an outage', () => {
  const K = k8sReportWidget.Component;
  const pod = (name: string) => ({
    kind: 'Pod',
    metadata: { name, namespace: 'dev', uid: name },
    status: { phase: 'Running' },
  });
  const props = (refreshSignal: number) => ({
    instanceId: 'w3',
    config: DEFAULT_REPORT,
    filters: defaultFilters(),
    refreshSignal,
    reportRefreshed: vi.fn(),
    editing: false,
    kiosk: true,
  });

  it('keeps the rows when a stream fails after it was good, marks them stale and restarts the stream with backoff', async () => {
    let onError: ((e: Error) => void) | undefined;
    streamResults.mockImplementation(
      async (_url: string, cb: (i: unknown[]) => void, err: (e: Error) => void) => {
        onError = err;
        cb([pod('alpha-pod')]);
        return () => undefined;
      }
    );
    const seen: Array<number | undefined> = [];
    const view = render(frameWith(<K {...props(0)} />, seen));
    await flush();
    expect(view.container.textContent).toContain('alpha-pod');
    const okAt = Date.now();

    // The stream dies and the next stream cannot start: the rows stay.
    vi.setSystemTime(Date.now() + 20_000);
    streamResults.mockImplementation(
      async (_url: string, _cb: unknown, err: (e: Error) => void) => {
        err(Object.assign(new Error('Failed to fetch'), {}));
        return () => undefined;
      }
    );
    await act(async () => onError?.(new Error('socket closed')));
    await flush(2_100);
    expect(view.container.textContent).toContain('alpha-pod');
    expect(seen.at(-1)).toBe(okAt);
    const starts = streamResults.mock.calls.length;
    await flush(4_500);
    expect(streamResults.mock.calls.length).toBeGreaterThan(starts - 1);

    // The server is back.
    streamResults.mockImplementation(async (_url: string, cb: (i: unknown[]) => void) => {
      cb([pod('beta-pod')]);
      return () => undefined;
    });
    await flush(9_000);
    expect(view.container.textContent).toContain('beta-pod');
    expect(seen.at(-1)).toBeUndefined();
  });
});
