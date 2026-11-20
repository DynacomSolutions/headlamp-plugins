import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, useLocation } from 'react-router-dom';
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

import { DashboardPage } from './DashboardPage';
import { getRegistry } from './registry';
import { addTab, addWidget } from './spec/edit';
import { emptySpec } from './spec/model';
import { DATA_KEY } from './storage/storage';
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

function mount(
  url: string,
  getUserConfirmation?: (message: string, callback: (ok: boolean) => void) => void
) {
  return render(
    <MemoryRouter initialEntries={[url]} getUserConfirmation={getUserConfirmation}>
      <Route path="/dashboards/:name/:tab?" component={DashboardPage} />
      <Where />
    </MemoryRouter>
  );
}

beforeEach(() => {
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
