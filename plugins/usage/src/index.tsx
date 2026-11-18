/// <reference types="@kinvolk/headlamp-plugin" />
/*
 * usage: pie-chart dashboard of CPU, memory, disk and network usage per
 * namespace, workload, Service, node, pod or label, from a Prometheus-compatible
 * metrics service. Adds a "Usage" sidebar entry and the /usage route, and under it "Dashboard"
 * (/usage/dashboard): the Usage dashboard, CPU and memory sunbursts for a touch screen. The old
 * /usage/nodes URL redirects to it.
 */
import './nodes/registerIcons';
import { registerPluginSettings, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { LegacyNodesRedirect } from './nodes/LegacyNodesRedirect';
import { NodesPage } from './nodes/NodesPage';
import { Settings } from './settings';
import { UsagePage } from './UsagePage';

registerSidebarEntry({
  parent: null,
  name: 'usage',
  label: 'Usage',
  url: '/usage',
  icon: 'mdi:chart-donut',
});

registerSidebarEntry({
  parent: 'usage',
  name: 'usage-dashboard',
  label: 'Dashboard',
  url: '/usage/dashboard',
  icon: 'mdi:server',
});

registerRoute({
  path: '/usage',
  sidebar: 'usage',
  name: 'usage',
  exact: true,
  component: UsagePage,
});

registerRoute({
  path: '/usage/dashboard',
  sidebar: 'usage-dashboard',
  name: 'usage-dashboard',
  exact: true,
  component: NodesPage,
  isFullWidth: true,
});

registerRoute({
  path: '/usage/nodes',
  sidebar: 'usage-dashboard',
  name: 'usage-nodes-redirect',
  exact: true,
  component: LegacyNodesRedirect,
  isFullWidth: true,
});

registerPluginSettings('usage', Settings, true);
