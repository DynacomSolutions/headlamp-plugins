import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, useHistory, useLocation } from 'react-router-dom';
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
import { getRegistry } from './registry';
import { addTab, addWidget } from './spec/edit';
import { emptySpec } from './spec/model';
import { DATA_KEY, fromConfigMap } from './storage/storage';
import { registerBuiltinWidgets } from './widgets/builtin';

// jsdom has no layout, so the grid reports no size; it renders its children at its default width.
(globalThis as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let version = 1;
let spec = emptySpec('Ops');
/** When set, a PUT waits for it. */
let gate: Promise<void> | null = null;

function configMap() {
  return {
    metadata: { name: 'ops', namespace: 'headlamp-dashboards', resourceVersion: String(version) },
    data: { [DATA_KEY]: JSON.stringify(spec) },
  };
}

const Where = () => {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
};

const router = { history: null as ReturnType<typeof useHistory> | null };
const Hist = () => {
  router.history = useHistory();
  return null;
};

/** jsdom has no Touch, so a plain event carries the touch lists. */
function touch(type: string, x: number, y: number, t: number, target: EventTarget) {
  const e = new Event(type, { bubbles: true });
  const list = [{ clientX: x, clientY: y }];
  Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : list });
  Object.defineProperty(e, 'changedTouches', { value: list });
  Object.defineProperty(e, 'timeStamp', { value: t });
  act(() => {
    target.dispatchEvent(e);
  });
}

function swipe(target: EventTarget, fromX: number, toX: number, y = 300) {
  touch('touchstart', fromX, y, 0, target);
  touch('touchmove', (fromX + toX) / 2, y + 4, 60, target);
  touch('touchend', toX, y + 6, 120, target);
}

function mount(
  url: string,
  getUserConfirmation?: (message: string, callback: (ok: boolean) => void) => void
) {
  return render(
    <MemoryRouter initialEntries={[url]} getUserConfirmation={getUserConfirmation}>
      <Route path="/dashboards/:name/:tab?" component={DashboardPage} />
      <Where />
      <Hist />
    </MemoryRouter>
  );
}

beforeEach(() => {
  // A cached spec from an earlier test would show at once and hide the loading and waiting screens.
  localStorage.clear();
  resetLastGoodStore();
  registerBuiltinWidgets(getRegistry());
  version = 1;
  gate = null;
  const a = addTab(emptySpec('Ops'), 'Nodes', 'mdi:server');
  const tabId = a.spec.tabs[0].id;
  spec = addWidget(
    a.spec,
    tabId,
    a.spec.tabs[0].sections[0].id,
    'core.header',
    { w: 12, h: 2 },
    { text: 'Hello header', subtitle: '', style: 'both', size: 'medium', align: 'left' }
  ).spec;
  request.mockReset();
  request.mockImplementation(async (path: string, params?: any) => {
    if (path.startsWith('/apis/authorization')) return { status: { allowed: true } };
    if (path.startsWith('/api/v1/namespaces/headlamp-dashboards/configmaps/ops')) {
      if (params?.method === 'PUT') {
        if (gate) await gate;
        const body = JSON.parse(params.body);
        if (body.metadata.resourceVersion !== String(version))
          throw Object.assign(new Error('conflict'), { status: 409 });
        version += 1;
        spec = JSON.parse(body.data[DATA_KEY]);
        return configMap();
      }
      return configMap();
    }
    return { items: [] };
  });
});

afterEach(cleanup);

describe('dashboard page', () => {
  it('shows the first tab and its widgets, and switches tab with a pushed path', async () => {
    mount('/dashboards/ops');
    expect(await screen.findByText('Hello header')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Overview/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Nodes/ }));
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops/nodes')
    );
    expect(screen.queryByText('Hello header')).toBeNull();
  });

  it('pushes a history entry for each tab change, so Back restores the tab before', async () => {
    mount('/dashboards/ops?kiosk=0&range=24h');
    await screen.findByText('Hello header');
    fireEvent.click(screen.getByRole('tab', { name: /Nodes/ }));
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe(
        '/dashboards/ops/nodes?kiosk=0&range=24h'
      )
    );
    act(() => router.history?.goBack());
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops?kiosk=0&range=24h')
    );
    expect(await screen.findByText('Hello header')).toBeTruthy();
  });

  it('moves to the next and the previous tab with a swipe on the tab area, one history entry each', async () => {
    mount('/dashboards/ops');
    await screen.findByText('Hello header');
    const area = document.querySelector('[data-tab-area]') as HTMLElement;
    // The first tab has no previous tab.
    swipe(area, 100, 260);
    expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops');
    // A swipe to the left shows the next tab.
    swipe(area, 260, 100);
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops/nodes')
    );
    // The last tab has no next tab.
    swipe(area, 260, 100);
    expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops/nodes');
    // A swipe to the right shows the previous tab.
    swipe(area, 100, 260);
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops/overview')
    );
    // Back goes through the swipes: nodes, then the first entry.
    act(() => router.history?.goBack());
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops/nodes')
    );
    act(() => router.history?.goBack());
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops'));
  });

  it('leaves a swipe on a sideways scroll area, a short swipe and a swipe in edit mode alone', async () => {
    mount('/dashboards/ops');
    await screen.findByText('Hello header');
    const area = document.querySelector('[data-tab-area]') as HTMLElement;
    // A short swipe does nothing.
    swipe(area, 200, 160);
    expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops');
    // A wide table keeps the swipe for its own scroll.
    const wide = document.createElement('div');
    wide.style.overflowX = 'auto';
    Object.defineProperty(wide, 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(wide, 'clientWidth', { value: 300, configurable: true });
    area.appendChild(wide);
    swipe(wide, 260, 100);
    expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops');
    wide.remove();
    // The swipe belongs to the drag of widgets in edit mode.
    cleanup();
    mount('/dashboards/ops?edit=1');
    await screen.findByRole('toolbar', { name: 'Edit tools' });
    swipe(document.querySelector('[data-tab-area]') as HTMLElement, 260, 100);
    expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops?edit=1');
  });

  it('wraps the title bar at every width, so no control is drawn over another one', async () => {
    const Original = globalThis.ResizeObserver;
    const rect = Element.prototype.getBoundingClientRect;
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      for (const [width, level] of [
        [2560, '0'],
        [1300, '1'],
        [360, '2'],
      ] as const) {
        Element.prototype.getBoundingClientRect = function (this: Element) {
          return this.hasAttribute('data-title-bar')
            ? ({ width, height: 48, top: 0, left: 0, right: width, bottom: 48 } as DOMRect)
            : rect.call(this);
        };
        mount('/dashboards/ops');
        await screen.findByText('Hello header');
        const bar = document.querySelector('[data-title-bar]') as HTMLElement;
        expect(bar.getAttribute('data-title-bar-level')).toBe(level);
        // A wide bar has three parts, so the clock is in the middle. Each side wraps its own
        // controls. A narrower bar is one wrapping row.
        if (Number(level) < 2 && width >= 1280) {
          expect(getComputedStyle(bar).display).toBe('grid');
          expect(getComputedStyle(bar).gridTemplateColumns).toBe(
            'minmax(0, 1fr) auto minmax(0, 1fr)'
          );
          const left = bar.querySelector('[data-title-bar-left]') as HTMLElement;
          expect(getComputedStyle(left).flexWrap).toBe('wrap');
        } else {
          expect(getComputedStyle(bar).flexWrap).toBe('wrap');
        }
        // The filter row wraps too, and the Edit button, the header widgets and the full screen
        // button stay together at the end of the bar.
        expect(getComputedStyle(bar.querySelector('[role="search"]') as HTMLElement).flexWrap).toBe(
          'wrap'
        );
        const tail = bar.querySelector('[data-title-bar-tail]') as HTMLElement;
        expect(tail.querySelector('button[aria-label="Full screen"]')).not.toBeNull();
        expect(getComputedStyle(tail).flexWrap).toBe('wrap');
        cleanup();
      }
    } finally {
      Element.prototype.getBoundingClientRect = rect;
      globalThis.ResizeObserver = Original;
    }
  });

  it('keeps the tab area from panning the page sideways, and a wide table scrolls sideways', async () => {
    mount('/dashboards/ops');
    await screen.findByText('Hello header');
    const area = document.querySelector('[data-tab-area]') as HTMLElement;
    // jsdom drops the touch properties from computed styles, so read the rules of the style sheet.
    const css = Array.from(document.querySelectorAll('style'))
      .map(el => el.textContent ?? '')
      .join('\n')
      .replace(/\s+/g, '');
    const rules = (cls: string) =>
      Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
        .filter(m => m[1].split(',').some(sel => sel.includes(`.${cls}`)))
        .map(m => ({ selector: m[1], body: m[2] }));
    const own = area.className.split(' ').flatMap(rules);
    expect(own.some(r => !r.selector.includes('[') && r.body.includes('touch-action:pan-y'))).toBe(
      true
    );
    expect(own.some(r => r.body.includes('overscroll-behavior-x:none'))).toBe(true);
    // A wide table and a table widget inside the area take sideways pans again.
    const inner = own.filter(r => r.body.includes('touch-action:pan-xpan-y'));
    expect(inner.map(r => r.selector).join('|')).toContain('[data-table]');
    expect(inner.map(r => r.selector).join('|')).toContain('[role="table"]');
  });

  it('enters edit mode from the query string, with the edit toolbar', async () => {
    mount('/dashboards/ops?edit=1');
    expect(await screen.findByRole('toolbar', { name: 'Edit tools' })).toBeTruthy();
    expect(screen.getByLabelText('Settings for Header or divider')).toBeTruthy();
  });

  it('writes edit mode into the URL when Edit is pressed', async () => {
    mount('/dashboards/ops');
    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops?edit=1')
    );
  });

  it('saves with the resourceVersion and shows a conflict message when someone else saved', async () => {
    mount('/dashboards/ops?edit=1');
    fireEvent.click(await screen.findByRole('button', { name: /Add section/ }));
    version = 5; // someone else saved
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Someone else saved this dashboard/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Overwrite with my changes/ })).toBeTruthy();
  });

  it('saves and leaves edit mode when there is no conflict', async () => {
    mount('/dashboards/ops?edit=1');
    fireEvent.click(await screen.findByRole('button', { name: /Add section/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(version).toBe(2));
    expect(spec.tabs[0].sections).toHaveLength(2);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops'));
  });

  it('asks nothing when Save leaves edit mode or a change stays inside the dashboard', async () => {
    const confirm = vi.fn((_message: string, callback: (ok: boolean) => void) => callback(false));
    mount('/dashboards/ops?edit=1', confirm);
    fireEvent.click(await screen.findByRole('button', { name: /Add section/ }));
    // A tab change is a move inside the dashboard.
    fireEvent.click(screen.getByRole('tab', { name: /Nodes/ }));
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops/nodes?edit=1')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops/nodes')
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it('is read-only when the user may not write', async () => {
    request.mockImplementation(async (path: string) => {
      if (path.startsWith('/apis/authorization')) return { status: { allowed: false } };
      return configMap();
    });
    mount('/dashboards/ops?edit=1');
    expect(await screen.findByText(/read-only access to dashboards/)).toBeTruthy();
    expect(screen.queryByRole('toolbar', { name: 'Edit tools' })).toBeNull();
  });

  it('shows the kiosk overlay for ?kiosk=1 and leaves it with Exit', async () => {
    const { container } = mount('/dashboards/ops?kiosk=1');
    await screen.findByText('Hello header');
    expect(container.ownerDocument.querySelector('[data-kiosk-overlay]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops'));
  });

  it('keeps every widget mounted when the page enters and leaves full screen', async () => {
    let mounts = 0;
    let unmounts = 0;
    const Probe = () => {
      React.useEffect(() => {
        mounts += 1;
        return () => {
          unmounts += 1;
        };
      }, []);
      return <span>probe widget</span>;
    };
    getRegistry().registerWidget({
      type: 'test.probe',
      title: 'Probe',
      description: 'Counts its mounts.',
      icon: 'mdi:flask',
      category: 'Test',
      defaultSize: { w: 3, h: 3 },
      minSize: { w: 1, h: 1 },
      defaultConfig: {},
      Component: Probe,
    } as any);
    spec = addWidget(
      spec,
      spec.tabs[0].id,
      spec.tabs[0].sections[0].id,
      'test.probe',
      { w: 3, h: 3 },
      {}
    ).spec;
    mount('/dashboards/ops');
    await screen.findByText('probe widget');
    expect(mounts).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops?kiosk=1')
    );
    await screen.findByRole('button', { name: 'Exit full screen' });
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops'));
    await screen.findByRole('button', { name: 'Full screen' });
    expect(screen.getByText('probe widget')).toBeTruthy();
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });

  it('waits in a kiosk when the server is away at the start, with no error screen, and loads by itself', async () => {
    const real = request.getMockImplementation()!;
    let up = false;
    request.mockImplementation(async (path: string, params?: any) => {
      if (!up && path.startsWith('/api/v1/namespaces/headlamp-dashboards/configmaps/ops'))
        throw new TypeError('Failed to fetch');
      return real(path, params);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { container } = mount('/dashboards/ops?kiosk=1');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(container.ownerDocument.querySelector('[data-kiosk-waiting]')).not.toBeNull();
      expect(container.ownerDocument.querySelector('[role="alert"]')).toBeNull();
      expect(screen.queryByText('Hello header')).toBeNull();
      up = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      expect(screen.getByText('Hello header')).toBeTruthy();
      expect(container.ownerDocument.querySelector('[data-kiosk-waiting]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps showing the error for a refusal (not transient), also in a kiosk', async () => {
    const real = request.getMockImplementation()!;
    request.mockImplementation(async (path: string, params?: any) => {
      if (path.startsWith('/api/v1/namespaces/headlamp-dashboards/configmaps/ops'))
        throw Object.assign(new Error('forbidden'), { status: 403 });
      return real(path, params);
    });
    const { container } = mount('/dashboards/ops?kiosk=1');
    expect(await screen.findByText(/not allowed to read dashboards/)).toBeTruthy();
    expect(container.ownerDocument.querySelector('[data-kiosk-waiting]')).toBeNull();
  });

  describe('last good data', () => {
    const seedSpec = () =>
      writeCachedDashboard(
        lastGoodStore(),
        fromConfigMap(
          {
            metadata: { name: 'ops', resourceVersion: '1' },
            data: { [DATA_KEY]: JSON.stringify(spec) },
          },
          'headlamp-dashboards'
        )
      );

    it('draws the cached dashboard at once, before the cluster answers, with no waiting screen', async () => {
      seedSpec();
      let release: () => void = () => undefined;
      const hold = new Promise<void>(r => (release = r));
      const real = request.getMockImplementation()!;
      request.mockImplementation(async (path: string, params?: any) => {
        if (path.startsWith('/api/v1/namespaces/headlamp-dashboards/configmaps/ops')) await hold;
        return real(path, params);
      });
      const { container } = mount('/dashboards/ops?kiosk=1');
      // Nothing was awaited: the first render has the widgets of the cached spec.
      expect(screen.getByText('Hello header')).toBeTruthy();
      expect(container.ownerDocument.querySelector('[data-kiosk-waiting]')).toBeNull();
      release();
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('Hello header')).toBeTruthy();
    });

    it('draws the cached dashboard when the server is away, and does not show an error screen', async () => {
      seedSpec();
      request.mockImplementation(async () => {
        throw new Error('Failed to fetch');
      });
      const { container } = mount('/dashboards/ops?kiosk=1');
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('Hello header')).toBeTruthy();
      expect(container.ownerDocument.querySelector('[data-kiosk-waiting]')).toBeNull();
    });

    it('removes the black boot cover when the kiosk has drawn', async () => {
      const cover = document.createElement('div');
      cover.id = 'dashboards-kiosk-boot-cover';
      document.body.appendChild(cover);
      mount('/dashboards/ops?kiosk=1');
      await screen.findByText('Hello header');
      expect(document.getElementById('dashboards-kiosk-boot-cover')).toBeNull();
    });

    it('writes the loaded dashboard to the cache for the next load', async () => {
      mount('/dashboards/ops?kiosk=1');
      await screen.findByText('Hello header');
      expect(readCachedDashboard(lastGoodStore(), 'headlamp-dashboards', 'ops')?.spec.title).toBe(
        'Ops'
      );
    });

    it('does not allow edit mode on a cached spec: it has no resourceVersion to save with', async () => {
      seedSpec();
      let release: () => void = () => undefined;
      const hold = new Promise<void>(r => (release = r));
      const real = request.getMockImplementation()!;
      request.mockImplementation(async (path: string, params?: any) => {
        if (path.startsWith('/api/v1/namespaces/headlamp-dashboards/configmaps/ops')) await hold;
        return real(path, params);
      });
      mount('/dashboards/ops?edit=1');
      expect(screen.getByText('Hello header')).toBeTruthy();
      expect(screen.queryByLabelText('Add widget')).toBeNull();
      expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull();
      release();
      await act(async () => {
        await Promise.resolve();
      });
      await screen.findByText('Hello header');
    });

    it('does not ask for the namespace and node pick lists in a kiosk without filter fields', async () => {
      mount('/dashboards/ops?kiosk=1');
      await screen.findByText('Hello header');
      await act(async () => {
        await new Promise(r => setTimeout(r, 30));
      });
      const asked = request.mock.calls.map(c => String(c[0]));
      expect(asked.some(u => u === '/api/v1/namespaces' || u === '/api/v1/nodes')).toBe(false);
    });

    it('asks for the pick lists outside the kiosk, after the first data or a short wait', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        mount('/dashboards/ops');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
        const early = request.mock.calls.map(c => String(c[0]));
        expect(early.some(u => u === '/api/v1/namespaces')).toBe(false);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_100);
        });
        const late = request.mock.calls.map(c => String(c[0]));
        expect(late.some(u => u === '/api/v1/namespaces')).toBe(true);
        expect(late.some(u => u === '/api/v1/nodes')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('hides the filter bar in kiosk mode by default and keeps it outside kiosk', async () => {
    mount('/dashboards/ops');
    await screen.findByText('Hello header');
    expect(screen.getByRole('search', { name: 'Dashboard filters' })).toBeTruthy();
    cleanup();
    mount('/dashboards/ops?kiosk=1');
    await screen.findByText('Hello header');
    expect(screen.queryByRole('search', { name: 'Dashboard filters' })).toBeNull();
  });

  it('still applies URL filters and saved views in kiosk mode when the bar is hidden', async () => {
    getRegistry().registerWidget({
      type: 'test.filters',
      title: 'Filters echo',
      icon: 'mdi:server',
      category: 'Monitoring',
      defaultSize: { w: 4, h: 2 },
      defaultConfig: {},
      Component: (p: {
        filters: { namespaces: string[]; labelSelector: string; range: string };
      }) => (
        <span data-testid="echo">
          {p.filters.namespaces.join(',')}|{p.filters.labelSelector}|{p.filters.range}
        </span>
      ),
    });
    const base = addWidget(
      spec,
      spec.tabs[0].id,
      spec.tabs[0].sections[0].id,
      'test.filters',
      { w: 4, h: 2 },
      {}
    ).spec;
    spec = {
      ...base,
      views: [
        {
          id: 'wall',
          name: 'Wall',
          filters: { namespaces: ['prod'], nodes: [], labelSelector: 'tier=web', range: '6h' },
        },
      ],
    };
    mount('/dashboards/ops?kiosk=1&ns=a,b&sel=x%3Dy');
    expect((await screen.findByTestId('echo')).textContent).toBe('a,b|x=y|1h');
    expect(screen.queryByRole('search', { name: 'Dashboard filters' })).toBeNull();
    cleanup();
    mount('/dashboards/ops?kiosk=1&view=wall');
    await waitFor(() => expect(screen.getByTestId('echo').textContent).toBe('prod|tier=web|6h'));
    expect(screen.queryByRole('search', { name: 'Dashboard filters' })).toBeNull();
  });

  it('shows the filter bar in kiosk mode when the dashboard turns it on', async () => {
    spec = { ...spec, kioskShowFilters: true };
    mount('/dashboards/ops?kiosk=1');
    await screen.findByText('Hello header');
    expect(screen.getByRole('search', { name: 'Dashboard filters' })).toBeTruthy();
  });

  it('turns the kiosk filter option on in Dashboard settings and saves it', async () => {
    mount('/dashboards/ops?edit=1');
    fireEvent.click(await screen.findByRole('button', { name: /Dashboard settings/ }));
    const toggle = await screen.findByRole('checkbox', { name: 'Show filters in kiosk' });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(spec.kioskShowFilters).toBe(true));
  });

  it('puts the refresh interval in the URL in view mode, and shows the last refreshed text', async () => {
    mount('/dashboards/ops');
    await screen.findByText('Hello header');
    expect(document.querySelector('[data-last-refreshed]')?.textContent).toMatch(/^Refreshed /);
    fireEvent.mouseDown(screen.getByLabelText('Auto refresh'));
    fireEvent.click(await screen.findByRole('option', { name: '30 s' }));
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops?refresh=30')
    );
  });

  it('shows an error for a missing dashboard', async () => {
    request.mockImplementation(async (path: string) => {
      if (path.startsWith('/apis/authorization')) return { status: { allowed: true } };
      throw Object.assign(new Error('not found'), { status: 404 });
    });
    mount('/dashboards/nope');
    expect(await screen.findByText(/was not found/)).toBeTruthy();
  });

  it('saves only the view, not the other edits in the draft, when a view is saved in edit mode', async () => {
    mount('/dashboards/ops?edit=1');
    fireEvent.click(await screen.findByRole('button', { name: /Add section/ }));
    fireEvent.click(screen.getByRole('button', { name: /Views/ }));
    fireEvent.click(await screen.findByText(/Save the current filters as a view/));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('View name'), { target: { value: 'Mine' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(version).toBe(2));
    // The stored spec has the view and not the new section.
    expect(spec.views.map(v => v.name)).toEqual(['Mine']);
    expect(spec.tabs[0].sections).toHaveLength(1);
    // The draft is still there, with the view in it, and still unsaved.
    expect(await screen.findByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(version).toBe(3));
    expect(spec.tabs[0].sections).toHaveLength(2);
    expect(spec.views.map(v => v.name)).toEqual(['Mine']);
  });

  it('overwrites after a conflict on a view saved outside edit mode', async () => {
    mount('/dashboards/ops');
    await screen.findByText('Hello header');
    version = 5; // someone else saved
    fireEvent.click(screen.getByRole('button', { name: /Views/ }));
    fireEvent.click(await screen.findByText(/Save the current filters as a view/));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('View name'), { target: { value: 'Mine' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Someone else saved this dashboard/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Overwrite with my changes/ }));
    await waitFor(() => expect(version).toBe(6));
    expect(spec.views.map(v => v.name)).toEqual(['Mine']);
    await waitFor(() => expect(screen.queryByText(/Someone else saved/)).toBeNull());
  });

  it('ignores edits made while a save runs, and leaves edit mode with what was saved', async () => {
    mount('/dashboards/ops?edit=1');
    fireEvent.click(await screen.findByRole('button', { name: /Add section/ }));
    let release = () => {};
    gate = new Promise<void>(resolve => {
      release = resolve;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Saving…' });
    // The grid is read-only while the save runs.
    expect(screen.queryByLabelText('Settings for Header or divider')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Add section/ }));
    release();
    await waitFor(() => expect(version).toBe(2));
    expect(spec.tabs[0].sections).toHaveLength(2);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops'));
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('adds a panel source entry of the palette as the base type with the source set', async () => {
    getRegistry().registerWidget({
      type: 'agent.panel.my-app',
      title: 'Panel from My app',
      icon: 'mdi:server',
      category: 'Monitoring',
      defaultSize: { w: 4, h: 4 },
      defaultConfig: { source: 'my-app', panel: '' },
      Component: () => <span>panel</span>,
    });
    mount('/dashboards/ops?edit=1');
    fireEvent.click(await screen.findByRole('button', { name: 'Add widget' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Panel from My app' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close the palette' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(version).toBe(2));
    const added = spec.tabs[0].sections[0].widgets.find(w => w.type.startsWith('agent.'));
    expect(added?.type).toBe('agent.panel');
    expect(added?.config).toMatchObject({ source: 'my-app' });
  });
});
