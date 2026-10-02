import {
  registerPluginSettings,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import { CONFIG_KEY } from './model';
import { ChannelsPage, RoutesPage, StatusPage } from './pages';
import { Settings } from './settings';

registerSidebarEntry({
  parent: null,
  name: 'alerting',
  label: 'Alerting',
  url: '/alerting/channels',
  icon: 'mdi:bell-ring-outline',
});
registerSidebarEntry({
  parent: 'alerting',
  name: 'alerting-channels',
  label: 'Channels',
  url: '/alerting/channels',
});
registerSidebarEntry({
  parent: 'alerting',
  name: 'alerting-routes',
  label: 'Routes',
  url: '/alerting/routes',
});
registerSidebarEntry({
  parent: 'alerting',
  name: 'alerting-status',
  label: 'Status',
  url: '/alerting/status',
});

registerRoute({
  path: '/alerting/channels',
  sidebar: 'alerting-channels',
  name: 'alerting-channels',
  exact: true,
  component: ChannelsPage,
});
registerRoute({
  path: '/alerting/routes',
  sidebar: 'alerting-routes',
  name: 'alerting-routes',
  exact: true,
  component: RoutesPage,
});
registerRoute({
  path: '/alerting/status',
  sidebar: 'alerting-status',
  name: 'alerting-status',
  exact: true,
  component: StatusPage,
});

registerPluginSettings(CONFIG_KEY, Settings, true);
