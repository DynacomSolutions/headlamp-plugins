/// <reference types="@kinvolk/headlamp-plugin" />
/*
 * usage: pie-chart dashboard of CPU, memory, disk and network usage per
 * namespace, workload, Service, node, pod or label, from a Prometheus-compatible
 * metrics service. Adds a "Usage" sidebar entry and the /usage route, and under it "Nodes"
 * (/usage/nodes): per-node CPU and memory sunbursts for a touch screen.
 */
import { registerPluginSettings, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
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
  name: 'usage-nodes',
  label: 'Nodes',
  url: '/usage/nodes',
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
  path: '/usage/nodes',
  sidebar: 'usage-nodes',
  name: 'usage-nodes',
  exact: true,
  component: NodesPage,
});

registerPluginSettings('usage', Settings, true);
