/*
 * agent-resource: a Headlamp page showing the resource restrictions (systemd
 * slices and scopes) on an agent host: memory and CPU limits, usage against
 * them, kernel event counters, throttling, pressure and active alerts, and an
 * in-place editor for the limits. Data and changes go through a small backend
 * reached over the Kubernetes API service proxy. The old /agent-memory route
 * redirects to /agent-resource.
 */
import {
  registerPluginSettings,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import { LEGACY_ROUTE, LegacyRedirect, ROUTE } from './LegacyRedirect';
import { CONFIG_KEY } from './model';
import { AgentResourcePage } from './pages';
import { Settings } from './settings';

registerSidebarEntry({
  parent: null,
  name: 'agent-resource',
  label: 'Agent resources',
  url: ROUTE,
  icon: 'mdi:memory',
});

registerRoute({
  path: ROUTE,
  sidebar: 'agent-resource',
  name: 'agent-resource',
  exact: true,
  component: AgentResourcePage,
});

registerRoute({
  path: LEGACY_ROUTE,
  sidebar: 'agent-resource',
  name: 'agent-resource-legacy-redirect',
  exact: true,
  component: LegacyRedirect,
});

registerPluginSettings(CONFIG_KEY, Settings, true);
