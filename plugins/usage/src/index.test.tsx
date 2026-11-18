import { describe, expect, it, vi } from 'vitest';

const { registerRoute } = vi.hoisted(() => ({ registerRoute: vi.fn() }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  registerRoute,
  registerSidebarEntry: vi.fn(),
  registerPluginSettings: vi.fn(),
}));
vi.mock('./nodes/registerIcons', () => ({}));
vi.mock('./nodes/NodesPage', () => ({ NodesPage: () => null }));
vi.mock('./nodes/LegacyNodesRedirect', () => ({ LegacyNodesRedirect: () => null }));
vi.mock('./settings', () => ({ Settings: () => null }));
vi.mock('./UsagePage', () => ({ UsagePage: () => null }));

import './index';

describe('routes', () => {
  it('renders the dashboard and its legacy redirect at full width', () => {
    const byPath = (p: string) => registerRoute.mock.calls.map(c => c[0]).find(r => r.path === p);
    expect(byPath('/usage/dashboard/:zoom*').isFullWidth).toBe(true);
    expect(byPath('/usage/nodes').isFullWidth).toBe(true);
  });
});
