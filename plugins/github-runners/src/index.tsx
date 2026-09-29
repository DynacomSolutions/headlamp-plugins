import { registerPluginSettings, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { CONFIG_KEY } from './data';
import { GitHubRunnersPage } from './pages';
import { Settings } from './settings';

registerSidebarEntry({
  parent: null,
  name: 'github-runners',
  label: 'GitHub Runners',
  url: '/github-runners',
  icon: 'mdi:github',
});

registerRoute({
  path: '/github-runners',
  sidebar: 'github-runners',
  name: 'github-runners',
  exact: true,
  component: GitHubRunnersPage,
});

registerPluginSettings(CONFIG_KEY, Settings, true);
