/*
 * agent-memory: a Headlamp page showing the memory restrictions (systemd
 * slices and scopes) on an agent host, with their usage against the soft and
 * hard limits, kernel event counters, pressure and active alerts, and an
 * in-place editor for the limits. Data and changes go through a small backend
 * reached over the Kubernetes API service proxy.
 */
import {
  registerPluginSettings,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import { CONFIG_KEY } from './model';
import { AgentMemoryPage } from './pages';
import { Settings } from './settings';

registerSidebarEntry({
  parent: null,
  name: 'agent-memory',
  label: 'Agent memory',
  url: '/agent-memory',
  icon: 'mdi:memory',
});

registerRoute({
  path: '/agent-memory',
  sidebar: 'agent-memory',
  name: 'agent-memory',
  exact: true,
  component: AgentMemoryPage,
});

registerPluginSettings(CONFIG_KEY, Settings, true);
