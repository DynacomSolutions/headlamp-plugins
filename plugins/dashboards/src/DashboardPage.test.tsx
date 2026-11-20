import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function configMap() {
  return { metadata: { name: 'ops', namespace: 'headlamp-dashboards', resourceVersion: String(version) }, data: { [DATA_KEY]: JSON.stringify(spec) } };
}

const Where = () => {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
};

function mount(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Route path="/dashboards/:name/:tab?" component={DashboardPage} />
      <Where />
    </MemoryRouter>
  );
}

beforeEach(() => {
  registerBuiltinWidgets(getRegistry());
  version = 1;
  const a = addTab(emptySpec('Ops'), 'Nodes', 'mdi:server');
  const tabId = a.spec.tabs[0].id;
  spec = addWidget(a.spec, tabId, a.spec.tabs[0].sections[0].id, 'core.header', { w: 12, h: 2 }, { text: 'Hello header', subtitle: '', style: 'both', size: 'medium', align: 'left' }).spec;
  request.mockReset();
  request.mockImplementation(async (path: string, params?: any) => {
    if (path.startsWith('/apis/authorization')) return { status: { allowed: true } };
    if (path.startsWith('/api/v1/namespaces/headlamp-dashboards/configmaps/ops')) {
      if (params?.method === 'PUT') {
        const body = JSON.parse(params.body);
        if (body.metadata.resourceVersion !== String(version)) throw Object.assign(new Error('conflict'), { status: 409 });
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
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops/nodes'));
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
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops?edit=1'));
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

  it('puts the refresh interval in the URL in view mode, and shows the last refreshed text', async () => {
    mount('/dashboards/ops');
    await screen.findByText('Hello header');
    expect(document.querySelector('[data-last-refreshed]')?.textContent).toMatch(/^Refreshed /);
    fireEvent.mouseDown(screen.getByLabelText('Auto refresh'));
    fireEvent.click(await screen.findByRole('option', { name: '30 s' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops?refresh=30'));
  });

  it('shows an error for a missing dashboard', async () => {
    request.mockImplementation(async (path: string) => {
      if (path.startsWith('/apis/authorization')) return { status: { allowed: true } };
      throw Object.assign(new Error('not found'), { status: 404 });
    });
    mount('/dashboards/nope');
    expect(await screen.findByText(/was not found/)).toBeTruthy();
  });
});
