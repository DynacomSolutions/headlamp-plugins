import { describe, expect, it, vi } from 'vitest';

const { registerRoute, registerSidebarEntry, registerPluginSettings } = vi.hoisted(() => ({
  registerRoute: vi.fn(),
  registerSidebarEntry: vi.fn(),
  registerPluginSettings: vi.fn(),
}));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ registerRoute, registerSidebarEntry, registerPluginSettings }));
vi.mock('./icons/registerIcons', () => ({}));
vi.mock('./DashboardPage', () => ({ DashboardPage: () => null }));
vi.mock('./DashboardsListPage', () => ({ DashboardsListPage: () => null }));
vi.mock('./settings', () => ({ Settings: () => null }));

import './index';

describe('plugin entry', () => {
  it('adds the sidebar entry, the list route and the dashboard route', () => {
    expect(registerSidebarEntry.mock.calls[0][0]).toMatchObject({ name: 'dashboards', label: 'Dashboards', url: '/dashboards' });
    const byPath = (p: string) => registerRoute.mock.calls.map(c => c[0]).find(r => r.path === p);
    expect(byPath('/dashboards')).toMatchObject({ exact: true, sidebar: 'dashboards' });
    expect(byPath('/dashboards/:name/:tab?')).toMatchObject({ exact: true, isFullWidth: true });
    expect(registerPluginSettings).toHaveBeenCalledWith('dashboards', expect.anything(), true);
  });

  it('installs the global registry with the built-in widgets', () => {
    const reg = window.headlampDashboards as any;
    expect(reg.stub).toBeUndefined();
    expect(['core.clock', 'core.note', 'core.header'].every(t => reg.get(t))).toBe(true);
  });
});
