/*
 * incidents: lists the diagnoses of the headlamp-agent and renders each one
 * from its A2UI surface.
 */
import './registerIcons';
import './dashboardWidgets';
import {
  registerPluginSettings,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import { ChatPage } from './ChatPage';
import { LaunchesPage, LaunchPage } from './LaunchPages';
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

registerSidebarEntry({
  parent: 'incidents',
  name: 'incidents-list',
  label: 'Diagnoses',
  url: '/incidents',
});
registerSidebarEntry({
  parent: 'incidents',
  name: 'incidents-chat',
  label: 'Chat',
  url: '/incidents/chat',
});
registerSidebarEntry({
  parent: 'incidents',
  name: 'incidents-launches',
  label: 'Agents',
  url: '/incidents/launches',
});

registerRoute({
  path: '/incidents',
  sidebar: 'incidents-list',
  name: 'incidents',
  exact: true,
  component: IncidentsPage,
});
// The chat routes come before '/incidents/:id', so 'chat' is never read as a diagnosis id.
registerRoute({
  path: '/incidents/chat',
  sidebar: 'incidents-chat',
  name: 'incidents-chat',
  exact: true,
  component: ChatPage,
  isFullWidth: true,
});
registerRoute({
  path: '/incidents/chat/:id',
  sidebar: 'incidents-chat',
  name: 'incidents-chat-thread',
  exact: true,
  component: ChatPage,
  isFullWidth: true,
});
// The agent routes also come before '/incidents/:id'.
registerRoute({
  path: '/incidents/launches',
  sidebar: 'incidents-launches',
  name: 'incidents-launches',
  exact: true,
  component: LaunchesPage,
});
registerRoute({
  path: '/incidents/launches/:id',
  sidebar: 'incidents-launches',
  name: 'incidents-launch',
  exact: true,
  component: LaunchPage,
});
registerRoute({
  path: '/incidents/:id',
  sidebar: 'incidents-list',
  name: 'incident',
  exact: true,
  component: IncidentPage,
});

registerPluginSettings(CONFIG_KEY, Settings, true);
