/*
 * The panel widgets keep the last good panel: a cached panel shows at once with no spinner, a fresh
 * answer replaces it and is written back, an old cached panel is marked, and the panel list waits
 * for the panel (the load order).
 */
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request, clusterRequest } = vi.hoisted(() => ({
  request: vi.fn(),
  clusterRequest: vi.fn(),
}));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request, clusterRequest },
  K8s: { useClustersConf: () => ({ main: {} }), useCluster: () => null },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
    get() {
      return undefined;
    }
  },
}));
vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));

import {
  lastGoodStore,
  resetLastGoodStore,
  STALE_AFTER_MS,
  widgetCache,
} from '../../cache/lastGood';
import { WidgetFrame } from '../../components/WidgetFrame';
import { DashboardContext, DashboardContextValue } from '../../context';
import { getRegistry } from '../../registry';
import { defaultFilters } from '../../spec/model';
import { registerBuiltinWidgets } from '../builtin';
import { clearPanelListCache } from './data';

const SCOPE = 'dash-ns/ops';
const URL_PANEL = '/api/widgets/alerts';

const RAW_OLD = {
  version: 1,
  id: 'alerts',
  title: 'Alerts',
  summary: 'cached summary',
  rows: [{ label: 'Cached row' }],
};
const RAW_NEW = {
  version: 1,
  id: 'alerts',
  title: 'Alerts',
  summary: 'fresh summary',
  rows: [{ label: 'Fresh row' }],
};
const LIST = {
  version: 1,
  panels: [
    { id: 'alerts', title: 'Alerts', description: '', plugin: 'x', link: '/x', refreshSeconds: 30 },
  ],
};

const ctx = (over: Partial<DashboardContextValue> = {}): DashboardContextValue => ({
  filters: defaultFilters(),
  refreshSignal: 0,
  editing: false,
  kiosk: true,
  reportRefreshed: () => undefined,
  cacheScope: SCOPE,
  ...over,
});
const actions = { menu: () => undefined, settings: () => undefined };

const frame = (value: DashboardContextValue = ctx()) => (
  <MemoryRouter>
    <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
      <DashboardContext.Provider value={value}>
        <WidgetFrame
          sectionId="s"
          id="w-4"
          type="agent.panel"
          title="Alerts"
          config={{ source: 'agent', panel: 'alerts' }}
          selfScroll={undefined}
          actions={actions}
        />
      </DashboardContext.Provider>
    </ThemeProvider>
  </MemoryRouter>
);

const seed = (raw: unknown, at: number, url = URL_PANEL) => {
  // The widget keeps the address, so the entry belongs to the panel it came from.
  const probe = String(
    // The address that usePanel builds for the built-in agent source.
    `/api/v1/namespaces/headlamp-agent/services/headlamp-agent:80/proxy${url}`
  );
  widgetCache(lastGoodStore(), SCOPE, 'w-4').write({ url: probe, raw }, at);
};

let resolvePanel: (v: unknown) => void;
const calls = () => request.mock.calls.map(c => String(c[0]));

beforeEach(() => {
  localStorage.clear();
  resetLastGoodStore();
  clearPanelListCache();
  registerBuiltinWidgets(getRegistry());
  request.mockReset();
  request.mockImplementation((url: string) => {
    if (url.endsWith(URL_PANEL)) return new Promise(r => (resolvePanel = r));
    if (url.endsWith('/api/widgets')) return Promise.resolve(LIST);
    return Promise.reject(new Error(`unexpected ${url}`));
  });
});
afterEach(cleanup);

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe('a cached panel', () => {
  it('shows at once with no spinner, while the fetch is still running', async () => {
    seed(RAW_OLD, Date.now() - 60_000);
    const { container } = render(frame());
    // The first render already has the rows: nothing waits for the network.
    expect(container.textContent).toContain('Cached row');
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    await flush();
    expect(calls().some(u => u.endsWith(URL_PANEL))).toBe(true);
    expect(container.textContent).toContain('Cached row');
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('has no stale mark while it is younger than the limit', async () => {
    seed(RAW_OLD, Date.now() - 60_000);
    const { container } = render(frame());
    await flush();
    expect(container.querySelector('[data-stale-since]')).toBeNull();
  });

  it('shows a "Cached" mark with the time when it is older than the limit, and not before', async () => {
    const at = Date.now() - STALE_AFTER_MS - 60_000;
    seed(RAW_OLD, at);
    const { container } = render(frame());
    await flush();
    const mark = container.querySelector('[data-stale-since]');
    expect(mark?.getAttribute('data-stale-since')).toBe(String(at));
    expect(mark?.hasAttribute('data-stale-cached')).toBe(true);
    expect(mark?.textContent).toMatch(/^Cached /);
  });

  it('is replaced by the fresh answer, which is written to the cache, and the mark goes', async () => {
    seed(RAW_OLD, Date.now() - STALE_AFTER_MS - 60_000);
    const reportRefreshed = vi.fn();
    const { container } = render(frame(ctx({ reportRefreshed })));
    await flush();
    expect(container.querySelector('[data-stale-since]')).not.toBeNull();
    await act(async () => {
      resolvePanel(RAW_NEW);
    });
    await flush();
    expect(container.textContent).toContain('Fresh row');
    expect(container.textContent).not.toContain('Cached row');
    expect(container.querySelector('[data-stale-since]')).toBeNull();
    expect(reportRefreshed).toHaveBeenCalled();
    const kept = widgetCache(lastGoodStore(), SCOPE, 'w-4').read<{ raw: { summary: string } }>();
    expect(kept?.value.raw.summary).toBe('fresh summary');
    expect(kept && Date.now() - kept.at < 5_000).toBe(true);
  });

  it('keeps the cached panel and says "Stale since" when the first fetch fails', async () => {
    seed(RAW_OLD, Date.now() - 120_000);
    const { container } = render(frame());
    await flush();
    await act(async () => {
      resolvePanel(Promise.reject(new Error('HTTP 502')));
    });
    await flush();
    expect(container.textContent).toContain('Cached row');
    expect(container.querySelector('[data-stale-since]')?.textContent).toMatch(/^Stale since /);
  });

  it('is ignored when it belongs to another panel address', async () => {
    seed(RAW_OLD, Date.now() - 1_000, '/api/widgets/other-panel');
    const { container } = render(frame());
    expect(container.textContent).not.toContain('Cached row');
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('is ignored when the stored value does not parse as a panel', async () => {
    seed('not a panel', Date.now() - 1_000);
    const { container } = render(frame());
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('is not used without a cache scope, and then the widget shows its spinner as before', async () => {
    seed(RAW_OLD, Date.now() - 1_000);
    const { container } = render(frame(ctx({ cacheScope: undefined })));
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('tells the header the age of the cached data', async () => {
    const at = Date.now() - 90_000;
    seed(RAW_OLD, at);
    const reportCached = vi.fn();
    render(frame(ctx({ reportCached })));
    await flush();
    expect(reportCached).toHaveBeenCalledWith(at);
  });
});

describe('load order', () => {
  it('asks for the panel first, and for the panel list only after the panel answered', async () => {
    render(frame());
    await flush();
    expect(calls().filter(u => u.endsWith('/api/widgets'))).toHaveLength(0);
    expect(calls().some(u => u.endsWith(URL_PANEL))).toBe(true);
    await act(async () => {
      resolvePanel(RAW_NEW);
    });
    await flush();
    await flush();
    const order = calls();
    expect(order.findIndex(u => u.endsWith('/api/widgets'))).toBeGreaterThan(
      order.findIndex(u => u.endsWith(URL_PANEL))
    );
    expect(order.filter(u => u.endsWith('/api/widgets'))).toHaveLength(1);
  });

  it('does not ask for the list while only cached data is on screen', async () => {
    seed(RAW_OLD, Date.now() - 60_000);
    render(frame());
    await flush();
    expect(calls().filter(u => u.endsWith('/api/widgets'))).toHaveLength(0);
  });
});
