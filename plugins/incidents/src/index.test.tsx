import { describe, expect, it, vi } from 'vitest';

const { registerRoute, registerSidebarEntry } = vi.hoisted(() => ({
  registerRoute: vi.fn(),
  registerSidebarEntry: vi.fn(),
}));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  registerRoute,
  registerSidebarEntry,
  registerPluginSettings: vi.fn(),
  ConfigStore: class {},
  ApiProxy: {},
  Router: { createRouteURL: () => '' },
}));
vi.mock('@kinvolk/headlamp-plugin/lib/CommonComponents', () => ({ SectionBox: () => null }));
vi.mock('./registerIcons', () => ({}));
vi.mock('./ChatPage', () => ({ ChatPage: () => null }));
vi.mock('./pages', () => ({ IncidentPage: () => null, IncidentsPage: () => null }));
vi.mock('./LaunchPages', () => ({ LaunchPage: () => null, LaunchesPage: () => null }));
vi.mock('./settings', () => ({ Settings: () => null }));

import './index';

describe('plugin routes', () => {
  const paths = () => registerRoute.mock.calls.map(c => c[0].path as string);

  it('registers the agent routes as path segments before /incidents/:id', () => {
    expect(paths()).toContain('/incidents/launches');
    expect(paths()).toContain('/incidents/launches/:id');
    const generic = paths().indexOf('/incidents/:id');
    expect(paths().indexOf('/incidents/launches')).toBeLessThan(generic);
    expect(paths().indexOf('/incidents/launches/:id')).toBeLessThan(generic);
  });

  it('names the routes the URL helpers use', () => {
    const names = registerRoute.mock.calls.map(c => c[0].name);
    expect(names).toContain('incidents-launches');
    expect(names).toContain('incidents-launch');
  });

  it('adds an Agents sidebar entry under Incidents', () => {
    const entry = registerSidebarEntry.mock.calls
      .map(c => c[0])
      .find(e => e.name === 'incidents-launches');
    expect(entry).toMatchObject({
      parent: 'incidents',
      label: 'Agents',
      url: '/incidents/launches',
    });
  });
});
