/*
 * registry: a Headlamp page listing container registry repositories and their
 * tags, read from a catalogue backend through the Kubernetes service proxy.
 */
import {
  registerPluginSettings,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import { CONFIG_KEY } from './model';
import { RegistryPage } from './pages';
import { Settings } from './settings';

registerSidebarEntry({
  parent: null,
  name: 'registry',
  label: 'Registry',
  url: '/registry',
  icon: 'mdi:docker',
});

registerRoute({
  path: '/registry',
  sidebar: 'registry',
  name: 'registry',
  exact: true,
  component: RegistryPage,
});

registerPluginSettings(CONFIG_KEY, Settings, true);
