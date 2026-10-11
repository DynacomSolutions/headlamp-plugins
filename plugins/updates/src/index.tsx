import { registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { UpdatesPage } from './pages';

registerSidebarEntry({
  parent: null,
  name: 'updates',
  label: 'Updates',
  url: '/updates',
  icon: 'mdi:package-up',
});

// One route serves the list and the per-component detail (/updates/:id).
registerRoute({
  path: '/updates/:id?',
  sidebar: 'updates',
  name: 'updates',
  exact: true,
  component: UpdatesPage,
});
