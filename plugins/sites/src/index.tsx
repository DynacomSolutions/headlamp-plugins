import { registerPluginSettings, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { CONFIG_KEY } from './data';
import { SitesPage } from './pages';
import { Settings } from './settings';

registerSidebarEntry({
  parent: null,
  name: 'sites',
  label: 'Sites',
  url: '/sites',
  icon: 'mdi:web',
});

registerRoute({
  path: '/sites',
  sidebar: 'sites',
  name: 'sites',
  exact: true,
  component: SitesPage,
});

registerPluginSettings(CONFIG_KEY, Settings, true);
