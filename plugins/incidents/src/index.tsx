/*
 * incidents: lists the diagnoses of the headlamp-agent and renders each one
 * from its A2UI surface.
 */
import {
  registerPluginSettings,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import { CONFIG_KEY } from './model';
import { IncidentPage, IncidentsPage } from './pages';
import { Settings } from './settings';

registerSidebarEntry({
  parent: null,
  name: 'incidents',
  label: 'Incidents',
  url: '/incidents',
  icon: 'mdi:alert-circle-outline',
});

registerRoute({
  path: '/incidents',
  sidebar: 'incidents',
  name: 'incidents',
  exact: true,
  component: IncidentsPage,
});
registerRoute({
  path: '/incidents/:id',
  sidebar: 'incidents',
  name: 'incident',
  exact: true,
  component: IncidentPage,
});

registerPluginSettings(CONFIG_KEY, Settings, true);
