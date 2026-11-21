/* A page that stays open reads the saved spec again on each refresh tick and shows a change in place. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));
vi.mock('@kinvolk/headlamp-plugin/lib/CommonComponents', () => ({
  Loader: () => <div>loading</div>,
  SectionBox: (p: { children: React.ReactNode }) => <div>{p.children}</div>,
}));

import { readCachedDashboard, writeCachedDashboard } from './cache/dashboardCache';
import { lastGoodStore, resetLastGoodStore } from './cache/lastGood';
import { DashboardPage } from './DashboardPage';
import { useSpecWatch } from './hooks';
import { getRegistry } from './registry';
import { addTab, addWidget } from './spec/edit';
import { DashboardSpec, emptySpec } from './spec/model';
import { reuseEqual } from './spec/share';
import { DATA_KEY, fromConfigMap, StoredDashboard } from './storage/storage';
import { registerBuiltinWidgets } from './widgets/builtin';

(globalThis as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let version = 1;
let spec: DashboardSpec = emptySpec('Ops');
let reads = 0;
const mounts: Record<string, number> = {};
/** The config object of the probe widget at each of its renders. */
const seenConfigs: object[] = [];

const configMap = () => ({
  metadata: { name: 'ops', namespace: 'headlamp-dashboards', resourceVersion: String(version) },
  data: { [DATA_KEY]: JSON.stringify(spec) },
});

const header = (text: string) => ({
  text,
  subtitle: '',
  style: 'both',
  size: 'medium',
  align: 'left',
});

/** Adds a header widget and returns the new spec. */
const withHeader = (base: DashboardSpec, tab: number, text: string): DashboardSpec =>
  addWidget(
    base,
    base.tabs[tab].id,
    base.tabs[tab].sections[0].id,
    'core.header',
    { w: 12, h: 2 },
    header(text)
  ).spec;

/** Saved by someone else: the spec and the version change. */
const publish = (next: DashboardSpec) => {
  spec = next;
  version += 1;
};

const refreshNow = () => fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

function mount(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Route path="/dashboards/:name/:tab?" component={DashboardPage} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  resetLastGoodStore();
  registerBuiltinWidgets(getRegistry());
  getRegistry().registerWidget({
    type: 'test.probe',
    title: 'Probe',
    description: 'Counts its mounts and renders.',
    icon: 'mdi:flask',
    category: 'Test',
    defaultSize: { w: 3, h: 3 },
    minSize: { w: 1, h: 1 },
    defaultConfig: {},
    Component: ({ config }: { config: { label?: string } }) => {
      seenConfigs.push(config);
      React.useEffect(() => {
        mounts[config.label ?? '?'] = (mounts[config.label ?? '?'] ?? 0) + 1;
      }, [config.label]);
      return <span>probe {config.label}</span>;
    },
  } as any);
  for (const k of Object.keys(mounts)) delete mounts[k];
  seenConfigs.length = 0;
  version = 1;
  reads = 0;
  const a = addTab(emptySpec('Ops'), 'Nodes', 'mdi:server');
  spec = withHeader(a.spec, 0, 'Hello header');
  spec = addWidget(
    spec,
    spec.tabs[0].id,
    spec.tabs[0].sections[0].id,
    'test.probe',
    { w: 3, h: 3 },
    { label: 'one' }
  ).spec;
  request.mockReset();
  request.mockImplementation(async (path: string) => {
    if (path.startsWith('/apis/authorization')) return { status: { allowed: true } };
    if (path.startsWith('/api/v1/namespaces/headlamp-dashboards/configmaps/ops')) {
      reads += 1;
      return configMap();
    }
    return { items: [] };
  });
});

afterEach(cleanup);

describe('reuseEqual', () => {
  it('returns the old object for equal parts and the new object for changed parts', () => {
    const prev = { a: { x: 1 }, b: [{ id: 1 }, { id: 2 }], c: 'same' };
    const same = reuseEqual(prev, JSON.parse(JSON.stringify(prev)));
    expect(same).toBe(prev);
    const next = JSON.parse(JSON.stringify(prev));
    next.b[1].id = 3;
    const out = reuseEqual(prev, next);
    expect(out).not.toBe(prev);
    expect(out.a).toBe(prev.a);
    expect(out.b[0]).toBe(prev.b[0]);
    expect(out.b[1]).toEqual({ id: 3 });
  });
});

describe('a spec that changes while the page is open', () => {
  it('applies the new spec in place on the next refresh, keeps the tab and the other widgets', async () => {
    mount('/dashboards/ops/nodes');
    await screen.findByRole('tab', { name: /Nodes/ });
    // The tab "nodes" is empty at first. Move to the first tab, which has the widgets.
    fireEvent.click(screen.getByRole('tab', { name: /Overview/ }));
    await screen.findByText('Hello header');
    await screen.findByText('probe one');
    expect(mounts.one).toBe(1);

    publish(withHeader(spec, 0, 'A new widget'));
    expect(screen.queryByText('A new widget')).toBeNull();
    refreshNow();
    expect(await screen.findByText('A new widget')).toBeTruthy();
    // The old widgets stayed mounted: no new mount, no blank frame.
    expect(screen.getByText('Hello header')).toBeTruthy();
    expect(mounts.one).toBe(1);
    expect(screen.getByRole('tab', { name: /Overview/ }).getAttribute('aria-selected')).toBe(
      'true'
    );
  });

  it('removes a widget that the new spec leaves out', async () => {
    mount('/dashboards/ops');
    await screen.findByText('probe one');
    const next = JSON.parse(JSON.stringify(spec)) as DashboardSpec;
    next.tabs[0].sections[0].widgets = next.tabs[0].sections[0].widgets.filter(
      w => w.type !== 'test.probe'
    );
    publish(next);
    refreshNow();
    await waitFor(() => expect(screen.queryByText('probe one')).toBeNull());
    expect(screen.getByText('Hello header')).toBeTruthy();
  });

  it('gives an unchanged widget the same config object after a spec change, and none after an equal read', async () => {
    mount('/dashboards/ops');
    await screen.findByText('probe one');
    await act(async () => undefined);
    const first = seenConfigs[seenConfigs.length - 1];
    // A refresh with the same version reads the ConfigMap but changes nothing.
    const readsBefore = reads;
    refreshNow();
    await waitFor(() => expect(reads).toBeGreaterThan(readsBefore));
    await act(async () => undefined);
    expect(seenConfigs[seenConfigs.length - 1]).toBe(first);
    // Another widget is added: the probe keeps its config object, so React skips its props.
    publish(withHeader(spec, 0, 'Added'));
    refreshNow();
    await screen.findByText('Added');
    expect(seenConfigs[seenConfigs.length - 1]).toBe(first);
    expect(mounts.one).toBe(1);
  });

  it('never lets the browser cache win over a newer spec of the cluster', async () => {
    // The cache holds an old spec. The cluster has a newer one, and the first answer wins.
    const old = JSON.parse(JSON.stringify(spec)) as DashboardSpec;
    old.tabs[0].sections[0].widgets = [];
    writeCachedDashboard(
      lastGoodStore(),
      fromConfigMap(
        {
          metadata: { name: 'ops', resourceVersion: '1' },
          data: { [DATA_KEY]: JSON.stringify(old) },
        },
        'headlamp-dashboards'
      )
    );
    mount('/dashboards/ops');
    await screen.findByText('Hello header');
    // The cache has now the newest spec, so the next page load starts from it.
    const cached = readCachedDashboard(lastGoodStore(), 'headlamp-dashboards', 'ops');
    expect(JSON.stringify(cached?.spec)).toContain('Hello header');
    // A later change replaces what is shown, and the cache follows.
    publish(withHeader(spec, 0, 'Newest'));
    refreshNow();
    await screen.findByText('Newest');
    expect(
      JSON.stringify(readCachedDashboard(lastGoodStore(), 'headlamp-dashboards', 'ops')?.spec)
    ).toContain('Newest');
  });

  it('ignores a failed read and keeps the page as it is', async () => {
    mount('/dashboards/ops');
    await screen.findByText('Hello header');
    const real = request.getMockImplementation()!;
    request.mockImplementation(async (path: string, params?: any) => {
      if (path.includes('/configmaps/ops')) throw new TypeError('Failed to fetch');
      return real(path, params);
    });
    refreshNow();
    await act(async () => {
      await new Promise(r => setTimeout(r, 30));
    });
    expect(screen.getByText('Hello header')).toBeTruthy();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('edit mode', () => {
  it('keeps unsaved changes, shows a notice, and loads the saved dashboard on request', async () => {
    mount('/dashboards/ops?edit=1');
    fireEvent.click(await screen.findByRole('button', { name: /Add section/ }));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    publish(withHeader(spec, 0, 'Saved by someone else'));
    refreshNow();
    expect(await screen.findByText(/The saved dashboard changed/)).toBeTruthy();
    // The draft stays, and the new widget does not show.
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.queryByText('Saved by someone else')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Discard my changes and load it/ }));
    expect(await screen.findByText('Saved by someone else')).toBeTruthy();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(screen.queryByText(/The saved dashboard changed/)).toBeNull();
  });

  it('applies the waiting version when the user reverts the edits', async () => {
    mount('/dashboards/ops?edit=1');
    fireEvent.click(await screen.findByRole('button', { name: /Add section/ }));
    publish(withHeader(spec, 0, 'Waiting'));
    refreshNow();
    await screen.findByText(/The saved dashboard changed/);
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(await screen.findByText('Waiting')).toBeTruthy();
    expect(screen.queryByText(/The saved dashboard changed/)).toBeNull();
  });

  it('shows a change in place in edit mode when there are no unsaved changes', async () => {
    mount('/dashboards/ops?edit=1');
    await screen.findByRole('toolbar', { name: 'Edit tools' });
    publish(withHeader(spec, 0, 'Clean change'));
    refreshNow();
    expect(await screen.findByText('Clean change')).toBeTruthy();
    expect(screen.queryByText(/The saved dashboard changed/)).toBeNull();
  });
});

describe('useSpecWatch', () => {
  const stored = (rv: string, title = 'Ops'): StoredDashboard => ({
    name: 'ops',
    namespace: 'ns',
    resourceVersion: rv,
    spec: emptySpec(title),
    migrated: false,
  });

  function Probe(p: {
    get: () => Promise<StoredDashboard>;
    tick: number;
    hold?: boolean;
    set: (d: StoredDashboard) => void;
    data: StoredDashboard;
  }) {
    const loaded = {
      data: p.data,
      error: undefined,
      loading: false,
      fromCache: false,
      reload: () => undefined,
      set: p.set,
    };
    const w = useSpecWatch({ get: p.get } as any, 'ops', loaded, p.tick, !!p.hold);
    return <span data-testid="newer">{w.newer?.resourceVersion ?? ''}</span>;
  }

  it('changes nothing when the resourceVersion is the same, and applies a new one once', async () => {
    const set = vi.fn();
    const get = vi.fn(async () => stored('1'));
    const data = stored('1');
    const { rerender } = render(<Probe get={get} tick={0} set={set} data={data} />);
    // The first tick belongs to the page load.
    expect(get).not.toHaveBeenCalled();
    for (const tick of [1, 2, 3]) {
      rerender(<Probe get={get} tick={tick} set={set} data={data} />);
      await waitFor(() => expect(get).toHaveBeenCalledTimes(tick));
    }
    await act(async () => undefined);
    expect(set).not.toHaveBeenCalled();
    get.mockImplementation(async () => stored('2', 'Ops 2'));
    rerender(<Probe get={get} tick={4} set={set} data={data} />);
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0][0].resourceVersion).toBe('2');
  });

  it('does not apply while it holds, and keeps the version as newer', async () => {
    const set = vi.fn();
    const get = vi.fn(async () => stored('2'));
    const data = stored('1');
    const { rerender } = render(<Probe get={get} tick={0} hold set={set} data={data} />);
    rerender(<Probe get={get} tick={1} hold set={set} data={data} />);
    await waitFor(() => expect(screen.getByTestId('newer').textContent).toBe('2'));
    expect(set).not.toHaveBeenCalled();
  });

  it('lets the cluster win over a cached spec that has no resourceVersion', async () => {
    const set = vi.fn();
    const cached = { ...stored(''), spec: emptySpec('Old') };
    const get = vi.fn(async () => stored('7', 'New'));
    function Cached(p: { tick: number }) {
      const loaded = {
        data: cached,
        error: undefined,
        loading: true,
        fromCache: true,
        reload: () => undefined,
        set,
      };
      useSpecWatch({ get } as any, 'ops', loaded, p.tick, false);
      return null;
    }
    const { rerender } = render(<Cached tick={0} />);
    rerender(<Cached tick={1} />);
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0][0].spec.title).toBe('New');
  });
});
