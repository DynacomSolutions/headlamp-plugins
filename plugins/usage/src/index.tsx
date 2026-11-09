/// <reference types="@kinvolk/headlamp-plugin" />
/*
 * usage: pie-chart dashboard of CPU, memory, disk and network usage per
 * namespace, workload, Service, node, pod or label, from a Prometheus-compatible
 * metrics service. Adds a "Usage" sidebar entry and the /usage route.
 */
import { registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { UsagePage } from './UsagePage';

registerSidebarEntry({
  parent: null,
  name: 'usage',
  label: 'Usage',
  url: '/usage',
  icon: 'mdi:chart-donut',
});

registerRoute({
  path: '/usage',
  sidebar: 'usage',
  name: 'usage',
  exact: true,
  component: UsagePage,
});
